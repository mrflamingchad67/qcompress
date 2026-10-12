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

## What it actually does

Compression here means **structural** PDF optimisation only. The engine
rewrites the file structure and re-encodes uncompressed streams:

| Concern | Behaviour |
| --- | --- |
| Object streams | Packed into compressed object streams |
| Uncompressed streams | Flate-compressed |
| Already-Flate streams | Re-encoded (optional) |
| Images | **Untouched** — never re-encoded, downsampled or re-compressed |
| Text / vector content | **Untouched** — never rasterised |
| Document features | **Untouched** — forms, annotations, metadata, attachments, bookmarks are preserved |

This is the same trade-off the native `qpdf` tool makes. It is *not* a
"shrink 90% by degrading quality" compressor. Already-optimised PDFs may come
out unchanged or slightly **larger**, and the app reports that honestly rather
than hiding it.

### Engine

| | |
| --- | --- |
| Engine | QPDF **12.4.2** |
| Build | Emscripten (`--closure 1`, `EXPORT_ES6`, `MODULARIZE`) |
| Source | [`le0pard/qpdf-wasm`](https://github.com/le0pard/qpdf-wasm) (MIT) — vendored binary |
| Runtime | Web Worker, instantiated per operation |

The vendored `src/lib/vendors/qpdf.js` + `qpdf.wasm` are taken unmodified from
the upstream repository (see `.reference/qpdf-wasm-LICENSE`). QPDF itself is
published under the Apache License 2.0.

---

## Supported options

Every option below is exposed in the UI **because it was verified against this
exact WASM build** by `bun run test:engine`. Options that the build rejects
(`--json-key=object-streams`, for example, is not valid in 12.4.2) are not
offered.

### Compress mode

| UI control | qpdf flag | Values |
| --- | --- | --- |
| Object streams | `--object-streams=` | `generate` (default), `preserve`, `disable` |
| Compression level | `--compression-level=` | `0`–`9` (default `9`) |
| Stream data | `--stream-data=` | `compress` (default), `preserve`, `uncompress` |
| Decode level | `--decode-level=` | `generalized` (default), `all`, `specialized`, `none` |
| Recompress Flate streams | `--recompress-flate` | on (default) / off |

### Web optimize mode

| UI control | qpdf flag |
| --- | --- |
| Web optimize | `--linearize` |

Linearisation restructures the file for fast web viewing. It usually makes the
file **slightly larger**, and the UI says so.

### Applied to every run

| Flag | Reason |
| --- | --- |
| `--no-warn` | Suppress routine warnings |
| `--warning-exit-0` | A recoverable warning must not be reported as a failure |
| `--password-file=<tmp>` / `--decrypt` | Only when the document is encrypted |

---

## Honest error handling

| Situation | What happens |
| --- | --- |
| Not a PDF | Rejected before qpdf runs, with a clear message |
| Empty / over 200 MB | Rejected with the actual size shown |
| Encrypted, needs password | A password field appears; QPDF reports `invalid password` |
| Wrong password | Reported as a password error, with **Retry** offered |
| Damaged / unsupported | QPDF's own diagnostic is surfaced verbatim |
| Output not larger or equal | **"No size reduction achieved"**, with the real numbers |
| Processing failed | **Retry**, **Choose another file**, **Download original** |

The original input bytes are retained in memory for the lifetime of the loaded
file, so a failed run can be retried or the original downloaded without
re-selecting anything.

### A note on `--json`

`qpdf --check` is a *structural* check. It reports that a file is parseable —
it is **not** proof of semantic fidelity. The app therefore uses
`--json=latest --json-key=encrypt --json-key=pages` for inspection (encryption
status and page count) rather than treating a clean check as a guarantee.

---

## Privacy

* No PDF bytes are uploaded. The app is a static site with no server.
* Processing happens in a Web Worker; only the processed bytes and two integers
  return to the page.
* No accounts, analytics, ads, tracking, cookies or third-party runtime
  scripts. No CDN dependencies — everything is served from the same origin.
* No persistent storage of documents. Nothing is written to IndexedDB, Cache
  Storage or `localStorage`.
* The WASM binary (1.5 MB) is fetched **only when a file is selected**, and
  only once — the worker caches it and answers further requests from memory.
* Object URLs are revoked when a result is replaced or reset; temporary files in
  the WASM in-memory filesystem are unlinked in a `finally` block.
* Document bytes never appear in URLs, logs or the DOM.

`scripts/test-browser.mjs` asserts the privacy property directly: it records
every network request and fails if any request occurs after the page load.

---

## Known limitations

* **Encryption is handled, not added.** Encrypted documents can be decrypted
  with a password, but the tool cannot create encrypted output.
* **Not a lossy compressor.** Scan-heavy documents (already JPEG-compressed)
  typically shrink very little — by design. See the `image-heavy` case in the
  engine tests, which saves ~0.02%.
* **Very large files.** The 200 MB guard is a UI limit, not an engine limit;
  processing a very large PDF blocks the worker and may exhaust device memory.
  Failures are reported, not swallowed.
* **No page rasterisation, ever.** Output size is bounded below by the size of
  the embedded images.
* **Password entry is not persisted** — it is held in a worker variable only
  for the duration of one operation.
* Requires WebAssembly and Web Worker support. Without them the app shows a
  plain message rather than a broken interface.

---

## Interface

The layout follows the reference UI (`convert.to.it`): a single centred start
card, then a compact working view, then a dense full-width settings grid, with
the selected file in a bottom tray.

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
│  [ file.pdf · 30 KB · 8 pages ]          after a file is chosen the same
│           [ Compress PDF ]              element collapses to a file row
│  SETTINGS
│  ( Compress )  ( Web optimize )
│  ┌──────────┬──────────┬──────────┬──────────┬──────────┐
│  │ OBJECT   │ COMPRESS │ STREAM   │ DECODE   │ ☐ RECOMP │
│  │ STREAMS  │ LEVEL    │ DATA     │ LEVEL    │   FLATE  │
│  └──────────┴──────────┴──────────┴──────────┴──────────┘
│
├ [ file.pdf 30 KB × ] ───────────────────────── bottom tray
```

* **Empty state** — one centred dashed card with the wordmark, an upload badge,
  "Click to select a file", "or drag and drop". Clicking or pressing
  Enter/Space opens the native picker; files can also be dropped anywhere on it.
* **Working view** — the same element becomes a compact file row (name, size,
  page count, PDF version, encryption), followed by the Compress action and the
  settings grid.
* **Processing** — an indeterminate bar plus a truthful status line. QPDF gives
  no incremental progress, so no percentage is invented.
* **Result** — output filename, the real byte/percentage change, and the
  download action. "No size reduction achieved" when that is the truth.

### Theme

**Dark only.** One palette, no toggle, no `prefers-color-scheme` branch, no
stored preference — fewer states to maintain and nothing to persist.

---

## Icons

[Lucide](https://lucide.dev) (`@lucide/svelte`), bundled locally — no CDN, no
runtime download, no webfont. Icons are imported individually and the package
is `sideEffects: false`, so the production bundle contains **exactly the eight
components used** and nothing else:

| Icon | Used for | Size / stroke |
| --- | --- | --- |
| `FileUp` | upload badge on the drop card | 22 / 1.8 |
| `FileText` | file row and tray chip | 14–18 / 1.8–2 |
| `X` | remove file (tray chip) | 13 / 2 |
| `LoaderCircle` | processing state (spins) | 16 / 2 |
| `CircleAlert` | error and "no size reduction" | 14–15 / 2 |
| `CircleCheck` | successful completion | 15–18 / 2 |
| `Download` | Download PDF | 16 / 2 |
| `RotateCcw` | Compress another | 14 / 2 |

`CheckCircle` and `AlertCircle` were **removed in Lucide v1**; their current
equivalents are `CircleCheck` and `CircleAlert`, which is what is used here.

Accessibility: every icon sits next to a text label and is `aria-hidden`, so
screen readers announce "Download PDF", not a stray graphic. The one icon-only
control (remove file) carries an `aria-label`. Svelte's CSS scoping cannot reach
into a child component, so icon styling is applied through the parent
(`.verdict :global(svg)` and friends) rather than a class handed to the icon.

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
      options.ts           the verified option set -> qpdf argv
      protocol.ts          worker message types
      worker.ts            QPDF in the worker (inspect + process)
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
  lib/fixtures.mjs         generated PDF fixtures
  probe-*.mjs              engine investigations (see below)
  test-compression.mjs     engine verification
  test-browser.mjs         real-browser end-to-end verification
```

## Scripts

| Command | Purpose |
| --- | --- |
| `bun run dev` | Dev server |
| `bun run build` | Static production build |
| `bun run check` | `svelte-check` type checking |
| `bun run test:engine` | Verify QPDF behaviour and compression against fixtures |
| `bun run test:browser` | Build + verify the real UI in Chromium |
| `bun run test` | All of the above |
| `bun run screenshots` | Capture every UI state to `.screenshots/` |
| `bun run wasm:probe` | Report the engine version and capability |

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
   the options object is rebuilt as a plain object before it is posted to the
   worker.

### Verified numbers

| Document | In | Out | Change |
| --- | --- | --- | --- |
| text-heavy, 8 pages, uncompressed | 30,839 B | 3,183 B | −89.7% |
| already Flate-compressed, 6 pages | 3,061 B | 2,332 B | −23.8% |
| image-heavy (random RGB), 3 pages | 601,397 B | 601,264 B | −0.02% |
| tiny 1-page | 591 B | 695 B | **+17.6% (grows)** |
| `BB Circular.pdf` (real) | 488,609 B | 480,615 B | −1.6% |
| `LSG Citizen manual.pdf` (real) | 1,708,298 B | 1,631,130 B | −4.5% |

The image-heavy and real-world rows are the point: already-optimised files
barely shrink, and the UI says so rather than inventing a saving.

## Licence

Project code: MIT. Vendored QPDF WASM build: MIT (`le0pard/qpdf-wasm`).
QPDF itself: Apache-2.0.