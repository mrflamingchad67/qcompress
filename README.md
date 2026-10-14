# PDF Compressor

A minimal, browser-based PDF compressor. The PDF is read, compressed and
packaged **entirely on the visitor's device** using QPDF compiled to
WebAssembly. There is no backend, no upload endpoint and no third-party
service — the production build is a static site.

```bash
bun install
bun run dev       # local dev server
bun run build     # static production build into ./build
bun run preview   # serve the production build
```

---

## Deploying

The build output is a plain static site in `build/` (adapter-static,
`ssr = false`, `prerender = true`). `static/_headers` sets immutable caching for
the hashed assets and the WASM binary. No server, no environment variables, no
runtime configuration.

### Cloudflare Pages (free)

Either connect the repository in the dashboard:

| Setting | Value |
| --- | --- |
| Framework preset | None |
| Build command | `bun run build` |
| Build output directory | `build` |
| Root directory | *(repo root)* |
| Environment variables | *(none)* |

…or let `.github/workflows/deploy.yml` do it. Add two repository secrets
(**Settings → Secrets and variables → Actions**):

- `CLOUDFLARE_API_TOKEN` — a token with **Cloudflare Pages: Edit**
- `CLOUDFLARE_ACCOUNT_ID` — shown in the Cloudflare dashboard sidebar

Pushing to `main` then builds, type-checks, runs the engine tests and deploys.

To deploy from a terminal instead:

```bash
bunx wrangler login
bun run build
bunx wrangler pages deploy build --project-name=qcompress
```

> The Pages build image does not include Bun by default. If you set the build
> command in the dashboard, either use `npm install && npm run build`
> (requires a `package-lock.json`) or add `curl -fsSL https://bun.sh/install | bash`
> as a first build command. The GitHub workflow installs Bun explicitly and has
> no such caveat.

---

## What it actually does

The engine is an **orchestrator**. It builds several candidate files, validates
each one, and keeps the smallest that passes. Nothing is presented as a
success unless it is both smaller and structurally valid.

| Strategy | Lossless | What it does |
| --- | --- | --- |
| `structural` | yes | QPDF object streams, Flate recompression, decode-level sweep |
| `linearize` | yes | Restructure for fast web viewing |
| `dedupe` | yes | Collapse byte-identical duplicate streams into one shared object |
| `image-aware` | **no** | Re-encode JPEG images, then re-run structural compression |
| `dedupe+image` | **no** | Both of the above, in sequence |

### The three modes

| Mode | Strategies considered | Degrades images? |
| --- | --- | --- |
| **Lossless** | `structural`, `linearize`, `dedupe` | **Never** |
| **Balanced** | the above + image re-encode at quality 78 | Yes |
| **Maximum** | the above + image re-encode at quality 55, 1700 px cap | Yes, visibly |

Two details that are easy to get wrong and are handled explicitly:

* **Maximum is not simply "quality 55".** A harder setting does not reliably
  produce a smaller file — a downscale can resample artefacts that cost more
  bits, and an already-compressed source can come out smaller when re-encoded at
  a *higher* quality. Maximum therefore tries both its own setting and the
  Balanced one, and keeps whichever actually wins. `Maximum` can never return a
  larger file than `Balanced` would have.
* **Lossless is not "a smaller lossless result at any cost".** When nothing
  beats the input, the **original bytes are returned unchanged** and the UI says
  "No size reduction achieved". A larger output is never presented as a win.

### What is never touched

| Concern | Behaviour |
| --- | --- |
| Text / vector content | **Never rasterised** |
| Image alpha | `/SMask` objects are never re-encoded; transparency survives |
| CMYK JPEGs | **Skipped** — Adobe APP14 inversion is not handled, so they are left alone rather than corrupted |
| Non-8-bit images | **Skipped** |
| Non-JPEG images | **Skipped** — Flate, JPX, JBIG2 and CCITT are never routed through the JPEG encoder |
| ICC profiles with `/N 4` | **Skipped** — could be CMYK, same reason |
| Forms, annotations, bookmarks, attachments, metadata | Preserved |
| Digital signatures | **Invalidated** by any rewrite — the UI says so |

### Which image encodings can be re-encoded

A JPEG is re-encoded when **all** of these hold:

| Condition | Why |
| --- | --- |
| `/Filter /DCTDecode` | It is a JPEG at all |
| `/Filter [/FlateDecode /DCTDecode]` | Stored bytes are a **Flate-compressed** JPEG; unwrapped first, re-wrapped after |
| `/BitsPerComponent 8` | Anything else is a different data layout |
| `/ColorSpace /DeviceRGB` or `/DeviceGray` | Directly known |
| `/ColorSpace [/ICCBased n 0 R]` with `/N 3` (or 1) | The profile says how three components are *interpreted*, not what they are; it stays valid after the JPEG is replaced |
| …with `/N 4`, or no `/N` | Cannot be shown to be RGB, so it is left alone |

Anything not matching is **left byte-identical**, and the result panel now says
*why* ("3 images left alone: ICCBased colour space") rather than the unhelpful
"unchanged as-is".

> Deduplication deliberately excludes page **content streams**. Two pages can
> carry byte-identical content that draws different things, because the
> resources they name live in each page's own resource dictionary. Only objects
> whose dictionary alone determines their appearance (images, font programs,
> embedded files, metadata) are collapsed.

### Engine

| | |
| --- | --- |
| Structure | QPDF **12.4.2** |
| Build | Emscripten (`--closure 1`, `EXPORT_ES6`, `MODULARIZE`) |
| Source | [`le0pard/qpdf-wasm`](https://github.com/le0pard/qpdf-wasm) (MIT) — vendored binary |
| Images | [`@jsquash/jpeg`](https://github.com/jamsinclair/jSquash) + `@jsquash/resize` (Apache-2.0) |
| Runtime | Web Worker, instantiated per operation |

The vendored `src/lib/vendors/qpdf.js` + `qpdf.wasm` are taken unmodified from
the upstream repository (see `.reference/qpdf-wasm-LICENSE`). QPDF itself is
published under the Apache License 2.0.

The jSquash codec is **lazily imported**. Lossless mode never downloads it, and
neither does a lossy run on a document with no JPEG images.

---

## Verified numbers

Measured by `bun run bench` over the committed fixture corpus (37 PDFs; see
[scripts/FIXTURES.md](scripts/FIXTURES.md)). Every output is independently
re-validated with `qpdf --check`, and the three deliberately-invalid fixtures
are **excluded from the totals** rather than counted as wins.

| Mode | In | Out | Reduction | Smaller | Unchanged | Larger | Failed |
| --- | --- | --- | --- | --- | --- | --- | --- |
| Lossless | 3,487,746 | 2,377,285 | **31.84%** | 12 | 24 | 0 | 4 |
| Balanced | 3,487,746 | 1,876,857 | **46.19%** | 22 | 15 | 0 | 3 |
| Maximum | 3,487,746 | 1,343,414 | **61.48%** | 22 | 15 | 0 | 3 |

(The four Lossless "failures" against three for the others is `jpeg-corrupt.pdf`:
`qpdf --check` decodes DCTDecode streams, so Lossless's validation of the
*original* rejects it before any strategy runs. The lossy modes touch the image
and the candidate is discarded for being larger. Either way it is correctly
never counted as a win.)

These are **byte-weighted** (total in vs total out), not a mean of per-file
percentages — which matters, because `scan-300dpi` alone is ~46% of the corpus.
For tiny files a few hundred bytes swings the percentage hard, which is why the
counts of unchanged files are reported next to the headline number.

`bun run bench` prints the breakdown per fixture, including which strategy won
and why any candidate was rejected. It also reports elapsed time, but that is an
informal single run, not a benchmark.

### Two rows that are 0% on purpose

`photo-flate-p0/p1.pdf` hold a single Flate image with no duplicates. There is
no lossless move, and the lossy path does not apply to non-JPEG images. The
engine returns the original bytes and says "No size reduction achieved". Same
for `jpeg-cmyk-declared`, `jpeg-bpc1`, `jpeg-icc` and `jpeg-icc-cmyk`, which
exist precisely to prove unsupported images are left alone.

## Real-document bugs this stage found

Running the engine against a real 32-page document (3.05 MB, images 93.7% of the
file) exposed two defects that no synthetic fixture had:

1. **`/Filter [/FlateDecode /DCTDecode]` was never decoded.** Filters apply left
   to right, so what is stored is the output of the *first* filter — a
   **Flate-compressed JPEG**. The engine fed those bytes to the JPEG decoder,
   every decode failed, and the run reported "images unchanged". All 33 images
   were skipped.
2. **ICC-tagged RGB was excluded.** `/ColorSpace [/ICCBased n 0 R]` with `/N 3`
   describes RGB data; the policy accepted only the literal names
   `DeviceRGB`/`DeviceGray`. 31 of 34 images were discarded for no safety reason.

Fixing them, plus a third bug found on the way (a backwards search for `<<`
grabbed a nested `/DecodeParms` dictionary, so `/Length` was never updated and
the stream was corrupted), moved that document from **1.1% to 49.7%**:

| | Before | After |
| --- | --- | --- |
| Size | 3,048,657 B | 1,534,266 B |
| Reduction | 1.1% | **49.7%** |
| Images re-encoded | 0 of 33 | 33 of 33 |

The browser has no `zlib`, so the unwrapping uses the platform's native
`CompressionStream` / `DecompressionStream` — no dependency, no bundle weight.
Both paths have dedicated browser tests.

### Before the orchestrator

The engine before this was a single `qpdf` structural pass: **0.15%** over the
same fixtures, and it made **5 of 8 files larger**.

| | Before | After (lossless) |
| --- | --- | --- |
| Total reduction | 0.15% | 31.84% |
| Fixtures that got larger | 5 of 8 | 0 of 37 |
| Strategies tried | 1 | up to 6 |

---

## Test suite

| Command | What it covers | Result |
| --- | --- | --- |
| `bun run check` | Type checking | 0 errors, 0 warnings |
| `bun run test:engine` | QPDF behaviour, options, exit codes | 32 passed, 5 skipped |
| `bun run test:pipeline` | Orchestrator contracts on the savings corpus | 42 passed |
| `bun run test:integrity` | **288 assertions** across all 37 fixtures | 288 passed |
| `bun run test:fidelity` | **57 raster comparisons**, decoded pixels | 56 passed |
| `bun run test:browser` | Real Chromium: UI, privacy, lazy loading, modes, wrapped/ICC images | 72 passed |
| `bun run test:live` | The deployed site | 16 passed |
| `bun run bench` | The numbers above | — |

The 5 skips in `test:engine` are QPDF diagnostics assertions that need a runtime
intercepting stdout. Bun cannot (the glue links nodefs), so they are covered by
the browser suite instead.

### What "integrity" actually means here

Three dimensions are kept apart, because passing one says nothing about the
others:

**Structural validity** — every output passes `%PDF-`, `%%EOF` and a real
`qpdf --check`, and its page tree is readable with the right page count.

**Semantic preservation** — `src/lib/qpdf/structure.ts` reads the catalog, page
tree, per-page geometry and rotation, annotation subtypes and link targets,
outline titles, form field names and metadata, and `scripts/lib/compare.mjs`
compares input against output. Lossless is asserted to change none of it.

> Object numbers are never compared. QPDF renumbers freely, and a changed
> object number is not a defect; a missing page or a lost link is.

**Visual fidelity** — `test-fidelity.mjs` decodes the image as it was in the
input and as it is in the output and compares the raster: mean absolute error,
worst single-channel difference, and the share of channels differing by more
than 32. Lossless is asserted **pixel-identical**, not merely close.

### What is *not* verified

Stated plainly rather than glossed over:

* **No page-level rendering.** There is no PDF rasteriser in this toolchain, and
  adding one purely for tests was judged not worth the dependency. Visual
  checks therefore cover *images*, not composed pages: font rendering, text
  positioning and page compositing are not compared visually. To check by hand,
  run `bun run explain <file.pdf>` then open both files side by side.
* **Extractable text is not compared.** Content streams are never rewritten, so
  the risk is low, but it is not asserted.
* **Digital signatures are not tested**, only disclosed as invalidated.
* Optional content (layers) has no fixture; it is unverified.
* Thresholds in `test-fidelity.mjs` are **regression bounds**, not a
  perceptual-quality score. A number below does not mean "looks acceptable".

---

## Engine flags

The orchestrator builds its argv from `src/lib/qpdf/options.ts`, and every flag
below was verified against this exact WASM build by `bun run test:engine`.
Flags the build rejects (such as `--json-key=object-streams`, invalid in 12.4.2)
are not used.

### Structural pass

| Flag | Reason |
| --- | --- |
| `--object-streams=generate` | Pack objects into compressed object streams |
| `--compression-level=9` | Maximum zlib effort |
| `--stream-data=compress` | Flate uncompressed streams |
| `--decode-level=generalized` | Recompute filters where it is safe to |
| `--recompress-flate` | Re-encode already-Flate streams |

### Applied to every run

| Flag | Reason |
| --- | --- |
| `--no-warn` | Suppress routine warnings |
| `--warning-exit-0` | A recoverable warning must not be reported as a failure |
| `--password-file=<tmp>` / `--decrypt` | Only when the document is encrypted |

The `--linearize` candidate uses only `--linearize`. It is kept as a candidate
because it sometimes wins on documents QPDF cannot otherwise shrink, even though
it usually makes the file slightly larger.

> The password is written to the worker's **in-memory** filesystem and passed by
> path. It is never part of a command line, never logged, and never leaves the
> worker.

---

## Candidate validation

Every candidate must pass before it is allowed to win:

1. at least 32 bytes, a `%PDF-` header, and a `%%EOF` trailer
2. a real `qpdf --check` (exit 0, or 3 for warnings only)
3. **smaller than or equal to the input** — a candidate that grows the file is discarded
4. **lossy candidates are excluded from Lossless mode** — enforced at the point
   the candidate is created, and re-asserted when selecting the winner

`scripts/test/test-pipeline.mjs` proves rule 4 is real rather than decorative: it
wraps the runner so that the `structural` strategy returns a truncated file,
then asserts that candidate is marked invalid, that it was *not* selected, and
that the file that was returned still validates.

---

## Honest error handling

| Situation | What happens |
| --- | --- |
| Not a PDF | Rejected before the engine runs, with a clear message |
| Empty / over 200 MB | Rejected with the actual size shown |
| Encrypted, needs password | A password field appears; QPDF reports `invalid password` |
| Wrong password | Probed before compressing, reported as a password error, **Retry** offered |
| Damaged / unsupported | QPDF's own diagnostic is surfaced verbatim |
| Nothing beat the input | **"No size reduction achieved"** with the real numbers |
| Processing failed | **Retry**, **Choose another file**, **Download original** |

The original input bytes are retained in memory for the lifetime of the loaded
file, so a failed run can be retried or the original downloaded without
re-selecting anything.

### A note on `--warning-exit-0`

This flag is applied to every generation pass, which means QPDF will happily
"repair" a malformed image instead of failing. That is the right behaviour for
a compressor, but it is worth knowing: **a damaged document may come out
cleaner-looking than it went in**. The engine suite covers this case explicitly
rather than leaving it as an undocumented surprise.

### A note on `--json`

`qpdf --check` is a *structural* check. It reports that a file is parseable —
it is **not** proof of semantic fidelity. The app therefore uses
`--json=latest --json-key=encrypt --json-key=pages` for inspection (encryption
status and page count) rather than treating a clean check as a guarantee.

---

## Privacy

* No PDF bytes are uploaded. The app is a static site with no server.
* Processing happens in a Web Worker; only the processed bytes and a few size
  and status integers return to the page.
* No accounts, analytics, ads, tracking, cookies or third-party runtime
  scripts. No CDN dependencies — everything is served from the same origin.
* No persistent storage of documents. Nothing is written to IndexedDB, Cache
  Storage or `localStorage`.
* The QPDF WASM binary (1.5 MB) is fetched **only when a file is selected**, and
  only once — the worker caches it and answers further requests from memory.
* The JPEG codec is fetched **only when a lossy mode runs**, and only then.
  Lossless mode never downloads it.
* Object URLs are revoked when a result is replaced or reset; temporary files in
  the WASM in-memory filesystem are unlinked in a `finally` block.
* Document bytes never appear in URLs, logs or the DOM.

`scripts/test/test-browser.mjs` asserts the privacy property directly: it records
every network request and fails if a *second* compression issues any request.

---

## Known limitations

* **Lossless gains are document-specific.** Deduplication needs repeated
  content. A PDF with one image and no repeats will save nothing in Lossless
  mode, and the UI will say exactly that.
* **Only JPEG is re-encoded.** Flate, JPX, JBIG2 and CCITT images are left
  alone in every mode. Lossless has no way to shrink an already-compressed
  format, and re-encoding the others would need decoders this build does not
  carry.
* **CMYK JPEGs are skipped**, and so are ICC profiles with four components. The
  re-encode would have to reproduce Adobe's APP14 inversion exactly, and getting
  it wrong silently swaps colours.
* **Downscaling uses a pixel cap, not true DPI.** Maximum caps the long edge at
  1700 px rather than parsing the content stream for the placement matrix. That
  is safe and predictable, but it is a fixed rule, not a resolution-aware one.
* **Encryption is handled, not added.** Encrypted documents can be decrypted
  with a password, but the tool cannot create encrypted output.
* **Digital signatures are invalidated** by any rewrite.
* **Very large files.** The 200 MB guard is a UI limit, not an engine limit.
  Image re-encoding holds one decoded raster at a time, but a very large scan
  can still exhaust device memory. Failures are reported, not swallowed.
* **Slow on many large images.** Re-encoding three 1240×1754 scans takes ~12 s
  in Chromium on this machine; a 32-page, 33-image document took **26 s** on the
  deployed site. The UI shows an indeterminate bar because no honest percentage
  is available.
* **No page-level visual regression testing** — see § "What is not verified".
* **Password entry is not persisted** — it is held in a worker variable only
  for the duration of one operation.
* Requires WebAssembly, Web Worker and (for Flate-wrapped images) Compression
  Streams. Where the last is missing those images are skipped safely rather than
  mangled.

---

## Interface

The layout follows the reference UI (`convert.to.it`): a single centred start
card, then a compact working view. There is no file tray — the selected file is
shown in the drop card itself, and the footer is only a meta bar.

```
┌ PDF Compressor ────────────────────────────── (small wordmark)
│
│      ┌ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ┐
│      │           (upload)            │   empty state — dashed card
│      │   Click to select a file     │   centred, like the reference
│      │      or drag and drop        │
│      └ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ┘
│   Compressed in your browser. Nothing is uploaded.
│
│  ┌ PDF Compressor ──────────────────────────────
│  [ file.pdf · 30 KB · 8 pages ]          after a file is chosen the same
│           [ Compress PDF ]              element collapses to a file row
│  MODE
│  ( Lossless )  ( Balanced )  ( Maximum )
│  Lossless work first, then re-encodes JPEG photos at a high quality…
│
└ © 2026, mrflamingchad67                        < > Source
```

* **Empty state** — one centred dashed card with the wordmark, an upload badge,
  "Click to select a file", "or drag and drop". Clicking or pressing
  Enter/Space opens the native picker; files can also be dropped anywhere on it.
* **Working view** — the same element becomes a compact file row (name, size,
  page count, PDF version, encryption), followed by the Compress action and the
  three modes with a plain-language note about what each one does. Clicking the
  file row opens the picker again to replace the file.
* **Processing** — an indeterminate bar plus a truthful status line. QPDF gives
  no incremental progress, so no percentage is invented.
* **Result** — output filename, the real byte/percentage change, and an honest
  account of what the engine actually did:

  | Row | Example |
  | --- | --- |
  | Mode | Balanced |
  | Images | 2 of 2 re-encoded (lossy) |
  | Method | images re-encoded and duplicates removed |

  When nothing beat the input it reads *"no strategy improved this file —
  original returned"* rather than claiming a saving. A note that rewriting
  invalidates any digital signature is shown underneath.

### Theme

**Dark only.** One palette, no toggle, no `prefers-color-scheme` branch, no
stored preference — fewer states to maintain and nothing to persist.

---

## Icons

[Lucide](https://lucide.dev) (`@lucide/svelte`), bundled locally — no CDN, no
runtime download, no webfont. Icons are imported individually and the package
is `sideEffects: false`, so the production bundle contains **exactly the seven
components used** and nothing else:

| Icon | Used for | Size / stroke |
| --- | --- | --- |
| `FileUp` | upload badge on the drop card | 22 / 1.8 |
| `FileText` | file row and output row | 14–18 / 1.8–2 |
| `LoaderCircle` | processing state (spins) | 16 / 2 |
| `CircleAlert` | error and "no size reduction" | 14–15 / 2 |
| `CircleCheck` | successful completion | 15–18 / 2 |
| `Download` | Download PDF | 16 / 2 |
| `RotateCcw` | Compress another | 14 / 2 |

`CheckCircle` and `AlertCircle` were **removed in Lucide v1**; their current
equivalents are `CircleCheck` and `CircleAlert`, which is what is used here.

Accessibility: every icon sits next to a text label and is `aria-hidden`, so
screen readers announce "Download PDF", not a stray graphic. There are no
icon-only controls. Svelte's CSS scoping cannot reach into a child component,
so icon styling is applied through the parent (`.verdict :global(svg)` and
friends) rather than a class handed to the icon.

Verify with:

```bash
bun run build
rg -o 'name:`[a-z0-9-]+`,size:24,node:\[\[' build/_app/immutable -r '' | sort -u
```

---

## Project layout

```
src/
  app.css                  design tokens (light + dark), base styles
  app.html
  lib/
    format.ts              byte/delta/percent formatting
    qpdf/
      pipeline.ts          the orchestrator: candidates, validation, selection
      images.ts            JPEG XObject discovery, eligibility, byte replacement
      dedupe.ts            lossless duplicate-stream collapse
      xref.ts              object scanning + cross-reference rebuilding
      structure.ts         read-only PDF reader (pages, annots, outlines, forms)
      bytes.ts             latin1 <-> bytes (no Buffer/TextDecoder)
      options.ts           the verified option set -> qpdf argv
      protocol.ts          worker message types
      worker.ts            engine in the worker: runner, codec, orchestration
      client.ts            worker lifecycle, original-bytes retention
    vendors/
      qpdf.js              Emscripten glue  (vendored, unmodified)
      qpdf.wasm            QPDF 12.4.2      (vendored, unmodified)
      qpdf.d.ts            hand-written types for the minified glue
  routes/
    +layout.svelte
    +layout.ts             ssr = false, prerender = true
    +page.svelte           the entire interface
scripts/
  lib/fixtures.mjs         generated PDF fixtures + build() helper
  lib/named-build.mjs      PDF builder with symbolic ${objectName} references
  lib/fixture-manifest.mjs what each fixture is and what must happen to it
  lib/compare.mjs          semantic diff between two PDFs
  lib/engine.mjs           QPDF runner + jSquash codec + zlib for Node/Bun tests
  generate/                fixture generators (see scripts/README.md)
  test/                    the six suites
  tools/                   benchmarks, explain, screenshots
  probe/                   one-off engine investigations
  fixtures/                37 committed PDFs; see scripts/FIXTURES.md
  README.md                how the scripts folder is laid out
  FIXTURES.md              fixture corpus documentation
```

The entry points are all named in `package.json`; `scripts/README.md` explains
what each one is for.
```

### How the image path works

1. **Flatten.** QPDF runs with `--object-streams=disable --stream-data=preserve`,
   so every image stream becomes a top-level object with a direct `/Length`.
2. **Find.** JPEG (`/DCTDecode`) XObjects are located by brace-matching the
   dictionary, not by regex — a regex would happily match `3 0 obj` inside a
   binary stream.
3. **Re-encode.** Each eligible image is decoded, optionally downscaled, and
   re-encoded one at a time, so decoded buffers are released immediately rather
   than all held at once.
4. **Splice.** Only the re-encoded bytes and the `/Length` (and `/Width`,
   `/Height` when downscaled) are replaced. Every other byte of the document is
   left exactly as QPDF wrote it.
5. **Rebuild the xref.** Changed stream lengths invalidate every recorded byte
   offset, and QPDF refuses to read such a file. The table is regenerated while
   preserving the original trailer (`/Root`, `/ID`, `/Info`).
6. **Re-run.** A structural pass reclaims whatever the image rewrite exposed.

Each step is verified rather than assumed: `qpdf --check` must return 0 or 3,
and the test suite decodes every replaced image to prove the splice produced
valid JPEG data.

## Scripts

| Command | Purpose |
| --- | --- |
| `bun run dev` | Dev server |
| `bun run build` | Static production build |
| `bun run check` | `svelte-check` type checking |
| `bun run fixtures` | Regenerate the 37 committed fixtures |
| `bun run bench` | Orchestrator over every fixture × mode, with per-file detail |
| `bun run bench:legacy` | The old single-pass engine, for comparison |
| `bun run explain <file.pdf> [mode]` | Why a document did or did not shrink, image by image |
| `bun run verify:live-file <file.pdf> [mode]` | Run a real document against the deployed site |
| `bun run test:engine` | QPDF behaviour and exit codes |
| `bun run test:pipeline` | Orchestrator contracts on the savings corpus |
| `bun run test:integrity` | Structural + semantic preservation across all fixtures |
| `bun run test:fidelity` | Decoded-pixel fidelity for the lossy modes |
| `bun run test:browser` | Build + verify the real UI in Chromium |
| `bun run test:live` | Verify the deployed site end-to-end |
| `bun run test` | All of the above |
| `bun run screenshots` | Capture every UI state to `.screenshots/` |
| `bun run wasm:probe` | Report the engine version and capability |

Scripts live under `scripts/{lib,generate,test,tools,probe}/`; see
[scripts/README.md](scripts/README.md).

### Engine findings worth knowing

These were established by running the WASM build directly and are the reason the
worker is shaped the way it is:

1. **`Module.print` is ignored.** This build writes diagnostics straight to the
   console. Worse, the glue binds `console.log` / `console.error` **once, when
   the module is first evaluated**. Swapping the console around `callMain` is
   therefore too late — and because ESM `import`s are hoisted above the module
   body, a static import would evaluate the glue before any wrapper could be
   installed. The worker installs its console wrappers at module scope and
   loads the glue with a **dynamic `import()`**. This was the single biggest
   bug found: without it, qpdf's own error text never reached the UI.
2. **`--json` cannot be reused on a long-lived instance.** The second call fails
   with `QPDFLogger: called setSave on standard output after standard output has
   already been used`. The worker therefore creates a fresh module instance per
   operation (~15 ms, measured).
3. **`Module.wasmBinary` is not implemented** in this build; the runtime always
   re-fetches the binary. Since each operation builds a new instance, the
   worker caches the 1.5 MB `ArrayBuffer` and answers just that one request
   itself, so it touches the network exactly once per session.
4. **`FS.readFile` returns an exact-size `Uint8Array` here**, but the output is
   copied into a fresh buffer anyway, so a subarray of the WASM heap can never
   be transferred to the page — transferring it would detach Emscripten's
   memory.
5. `--json-key` accepts only
   `acroform, attachments, encrypt, objectinfo, objects, outlines, pagelabels, pages, qpdf`
   in 12.4.2.
6. Svelte 5 `$state` objects are proxies and **cannot be structured-cloned**, so
   the mode string is sent as a plain value across the worker boundary.
7. **A `fetch` interceptor scoped by extension is a trap.** Caching the QPDF
   binary by matching `url.endsWith('.wasm')` looked harmless — it was written
   when QPDF was the only WASM in the worker. Adding the lazy jSquash codec
   introduced a second `.wasm` consumer, and the interceptor began serving the
   1.5 MB QPDF binary to `mozjpeg_enc-*.wasm`. The codec failed to instantiate,
   the load was swallowed by a `.catch(() => null)`, and **both lossy modes
   silently did nothing** — while every Bun test passed, because Bun does not
   take this code path. The cache is now keyed on the exact QPDF URL. This is
   the clearest argument for having a real browser suite at all.
8. **`qpdf --json` is invisible under Bun.** The engine writes it straight to
   file descriptor 1 via nodefs, so `diagnostics` comes back empty even on exit
   0. Semantic comparisons therefore cannot rely on it outside a browser, which
   is why `structure.ts` reads the document directly instead.
9. **`qpdf --check` decodes DCTDecode streams.** A JPEG with a damaged
   quantisation table fails `--check` outright. Useful: corrupt image data
   cannot slip through candidate validation.

## Licence

Project code: MIT. Vendored QPDF WASM build: MIT (`le0pard/qpdf-wasm`).
QPDF itself: Apache-2.0.