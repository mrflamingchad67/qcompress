# QCompress

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

MIT licensed. See [LICENSE](LICENSE), [CHANGELOG](CHANGELOG.md),
[SECURITY](SECURITY.md) and [CONTRIBUTING](CONTRIBUTING.md).

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

With those two secrets in place, pushing to `main` builds, type-checks, runs the
engine tests and deploys.

**Without them the workflow still runs the build, the type check and every
verification suite — and then fails at the publish step.** So a green-looking
push is not evidence that the site was updated. Check the deploy step, or
`gh run list`, before assuming a push went live. On a repository with no
secrets configured every push fails this way, and the live site stays where it
was without saying so.

To deploy from a terminal instead — this publishes your **working tree**, not a
commit, so confirm `git status` is clean first:

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

Measured by `bun run bench` over the committed fixture corpus (42 valid PDFs; see
[scripts/FIXTURES.md](scripts/FIXTURES.md)). Every output is independently
re-validated with `qpdf --check`, and the three deliberately-invalid fixtures
are **excluded from the totals** rather than counted as wins.

| Mode | In | Out | Reduction | Smaller | Unchanged | Larger | Failed |
| --- | --- | --- | --- | --- | --- | --- | --- |
| Lossless | 3,494,272 | 2,382,648 | **31.81%** | 16 | 25 | 0 | 4 |
| Balanced | 3,494,272 | 1,795,031 | **48.63%** | 26 | 16 | 0 | 3 |
| Maximum | 3,494,272 | 1,316,904 | **62.31%** | 26 | 16 | 0 | 3 |

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

### The bug only rendering could find

A fourth defect, found by the page-level visual suite rather than by any fixture
or byte comparison: **Lossless was silently blanking pages.**

`graphic-q75.pdf` page 2, and pages 2 and 3 of `scan-300dpi-q80.pdf`, rendered
**completely blank** — 0.000% ink against an original 50% / 99.99% — while
passing `qpdf --check`, all 288 structural assertions, and the image fidelity
suite — all of which are still there and still pass. The image payloads that
survived were byte-identical; nothing about the
file was malformed. Every existing check was correct about what it measured, and
none of them measured whether the page still had anything on it.

Deduplication collapsed a duplicate image object but deleted its definition
instead of repointing the reference to it, so the page kept
`/Im0 8 0 R` while object 8 no longer existed and the image was never drawn.

```
ORIGINAL  obj 4 (page 2): /XObject << /Im0 8 0 R >>      obj 8: IMAGE
OUTPUT    obj 4 (page 2): /XObject << /Im0 8 0 R >>      obj 8: gone
```

The obvious repair — leave object 8 in place holding `6 0 R` — is also wrong
here, and fails the same way: the structural QPDF pass collapses such an alias
down to a bare integer, leaving object 8 holding the number `6`, which resolves
to nothing. The fix is to repoint every surviving reference at the kept copy
and drop the duplicate outright.

Savings were unaffected — marginally better, in fact, since no alias headers
are kept. This is a correctness fix, not a compression trade.

### The bug no fixture could reach

A real 10-page Bengali document decoded **0 of 10 pages** of text. The object
indexer underneath the Unicode decoder was at fault: it searched forward for the
next `<<` to find each object's dictionary, so any object whose body is a *bare
string or array* made it swallow everything up to the next dictionary.

```
  87 0 obj                 88 0 obj
  (Adobe)                  [ -988 -486 988 808 ]
  endobj                   endobj
```

That document has 32 of each, and the index found **117 of its 197 objects** —
every one lost was a string, array or stream, and all **16 of its `/ToUnicode`
maps** were among them.

Three more faults in the same function were reachable from ordinary files: braces
inside string *literals* were counted, so one `(...)` containing `>>` corrupted
every dictionary after it; one malformed object made the scanner `break` and
abandon the rest of the file; and the `endstream` fallback took the *first* match,
which lands inside a compressed payload often enough to be routine.

Now **197 of 197**, and the document's **10,932 Bengali characters are identical
across all three modes**.

The reason no suite caught it is the part worth keeping. Measured across the 40
fixtures that existed at the time:

| Form | In the corpus | In that document |
| --- | --- | --- |
| bare string objects | 0 | 32 |
| bare array objects | 0 | 32 |
| indirect `/Resources` | 0 | 10 |
| `/Contents` as an array | 0 | 10 |

Zero. Those paths were not *under*-tested — they were **unreachable**, and a
user's file was the first thing to walk them. Two of the four came from a second
real document, so the corpus now grows from measurements rather than guesses.

`test:parser-realism` asserts the general rule rather than the specific case: for
every fixture, **no dictionary object may be skipped**. That catches document
shapes nobody has thought of yet, which a per-fixture "the expected objects are
present" check cannot.

One detail that nearly hid the fix: the suites read QPDF-flattened text, and
**flattening silently deletes bare string and array objects**. A completeness
check run on flattened output passes having never examined them, so that suite
runs on raw bytes instead — with a control asserting the deletion really happens,
so the reason cannot quietly stop being true.

### Before the orchestrator

The engine before this was a single `qpdf` structural pass: **0.15%** over the
same fixtures, and it made **5 of 8 files larger**.

| | Before | After (lossless) |
| --- | --- | --- |
| Total reduction | 0.15% | 31.81% |
| Fixtures that got larger | 5 of 8 | 0 of 42 |
| Strategies tried | 1 | up to 6 |

---

## Test suite

| Command | What it covers | Result |
| --- | --- | --- |
| `bun run check` | Type checking | 0 errors, 0 warnings |
| `bun run test:engine` | QPDF behaviour, options, exit codes | 32 passed, 5 skipped |
| `bun run test:pipeline` | Orchestrator contracts on the savings corpus | 42 passed |
| `bun run test:integrity` | **320 assertions** across 42 fixtures | 320 passed |
| `bun run test:structure-control` | Proves the structure comparison can fail. It once couldn't — the per-page block was unreachable | 12 controls, 0 wrong |
| `bun run test:fidelity` | **64 raster comparisons**, decoded pixels | 56 passed |
| `bun run test:text-extract` | Text extractor grammar + comparator controls | 47 passed |
| `bun run test:text-integrity` | **168 page comparisons**, text payload per mode, through the real pipeline | 130 passed |
| `bun run test:cmap` | `/ToUnicode` CMap parser: codespacerange, `bfchar`, both `bfrange` forms | 45 passed |
| `bun run test:parser-realism` | Object indexer vs. the body forms real documents use. Runs on raw bytes | 56 passed |
| `bun run test:resource-limits` | A decompression bomb is refused, never honoured | 11 passed |
| `bun run test:unicode-integrity` | Every `/ToUnicode` mapping survives compression unchanged | 131 passed — 9 CMaps, 102 mappings |
| `bun run test:unicode-extraction` | The characters each page renders as, per mode | 128 passed — 12 pages, 117 characters |
| `bun run test:visual-comparator` | Visual comparator logic + negative controls. No browser | 32 passed |
| `bun run test:visual` | **168 page comparisons**, original vs compressed, rendered | 126 passed |

The visual suite is included in `bun run test` because its runtime is reasonable
(roughly a minute). It needs Chromium via Playwright, which `test:browser`
already requires.
| `bun run test:browser` | **Chromium, Firefox and WebKit**: UI, privacy, lazy loading, modes, wrapped/ICC images, accessibility | 92 per engine, 276 total |
| `bun run test:mobile` | **3 engines × 3 viewports**: overflow, tap targets, phone upload | 99 passed |
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

**Image fidelity** — `test-fidelity.mjs` decodes the image as it was in the
input and as it is in the output and compares the raster: mean absolute error,
worst single-channel difference, and the share of channels differing by more
than 32. Lossless is asserted **pixel-identical**, not merely close.

**Page-level visual fidelity** — `test:visual` renders the original *and* the
compressed output through the same pinned PDF.js, in the same browser, at the
same scale, and compares the resulting pages. See below.

### Page-level visual regression

Image fidelity asks whether a photo survived re-encoding. It says nothing
about the page that photo sits on. A document can keep every page, every object
and every decoded image pixel, and still render differently — a font that
stopped embedding, a heading that moved, a crop that appeared.

`test:visual` closes that gap. For each fixture and each mode it renders both
documents and compares page by page.

**Why PDF.js, and why in a browser.** PDF.js is Mozilla's renderer — the same
one Firefox uses to display PDFs — and it is pinned to `6.4.299` as a
**devDependency**, so it costs the production bundle nothing. It runs inside the
Chromium that Playwright already drives, rather than in Node: rendering in Node
would need a native canvas binding, which is platform-specific and behaves
differently on a Windows dev box than on the Linux CI runner. The trade-off is
that this suite requires Chromium, and is skipped only by being unable to run,
never by weakening an assertion.

**What is measured.** Per page, on identical rasters:

| Metric | Meaning |
| --- | --- |
| `changedPct` | % of pixels where any channel differs by more than `EPSILON` (2) |
| `hardPct` | % of pixels differing by **≥ 96** — a saturated, high-contrast change |
| `mae` | Mean absolute per-channel error, 0–255 |
| `max` | Largest single-channel difference anywhere |
| `norm` | `mae / 255`, normalised so page sizes stay comparable |

`hardPct` exists because a whole-page mean is the wrong tool for localised
damage. On a full-page photograph, `changedPct` reaches 65% while `hardPct`
stays under 4% — every pixel drifts slightly. A blanked region or a dropped
block instead produces a compact area of *maximal* deltas. The two metrics
disagree exactly where it matters, so both are bounded.

Page geometry (count, rendered size, MediaBox, rotation, blank pages) is
checked **separately from** pixels, so a size mismatch is reported as a
structural failure instead of being averaged into a similarity score.

**Acceptance policy**, in `scripts/lib/visual.mjs`:

* **`identical`** — Lossless, *and* any mode on a document with no eligible
  image. Exact match, zero tolerance. Measured: all 50 lossless page
  comparisons returned exactly `0.000` on every metric, which is what justifies
  having no tolerance at all — PDF.js is deterministic.
* **`lossy`** — Balanced and Maximum may re-encode JPEGs. Bounds were calibrated
  from `bun run test:visual -- --measure`, not chosen:

  | Group | `changedPct` | `hardPct` | `mae` | `max` | Worst fixture |
  | --- | --- | --- | --- | --- | --- |
  | normal | ≤ 70 | ≤ 5 | ≤ 16 | ≤ 250 | `oversized-600dpi` (65.03 / 3.92 / 14.59 / 239) |
  | hostile | ≤ 80 | ≤ 8 | ≤ 20 | ≤ 255 | `jpeg-large` (15.84 / 0.86 / 5.07 / 187) |

  `hostile` is *looser*, not tighter, because measurement did not support
  tightening it — those fixtures are small images and move less of the page.

Thresholds are regression bounds, not perceptual quality scores, and the
acceptance policy never consults the candidate's own measured error.

**Diagnostics.** `--diagnose` writes `original | candidate | difference` PNGs to
`.visual-diagnostics/`, with high-contrast changes painted magenta. Only on
request or on failure; the directory is deleted otherwise and is gitignored.

**Negative controls** live in `test-visual-comparator.mjs` and are not
optional — a suite that only ever reports passes cannot be distinguished from
one broken to always pass. They prove identical rasters score zero, a 1-unit
change is *not* a change, threshold boundaries hold exactly at and just past
the limit, a lost heading is rejected, a 10% dropped block is caught by
`hardPct` where `mae` passes, a blanked page fails even the loosest bound, and
a shifted element, wrong dimensions, missing page, extra page and changed
rotation are all detected.

**The suite found a real bug.** `graphic-q75.pdf` page 2 rendered **blank**
(0.000% ink) after Lossless, as did pages 2 and 3 of `scan-300dpi-q80.pdf` —
while passing `qpdf --check`, all 288 structural assertions, and the image
fidelity suite. Deduplication deleted a duplicate image object without
repointing the page that referenced it, so the page drew nothing. The fix and
the reasoning are in `src/lib/qpdf/dedupe.ts`; two regression tests were added
to `test:integrity`.

### What is *not* verified

Stated plainly rather than glossed over:

* **Damage smaller than ~5% of a photographic page is not detectable** by these
  pixel metrics. On a page that is mostly image, a small blemish is diluted
  past both `mae` and `hardPct`. This is a real limit of pixel comparison, not
  a threshold that could be tuned away. Text and layout are covered instead by
  the `identical` policy — every document with no eligible image is held to an
  exact match, and those are the pages where text damage would show.
* **Extracted characters are compared, not reading order.** Characters are
  derived from the document's *own* `/ToUnicode` maps and compared per page
  across all three modes (see [Text-layer preservation](#text-layer-preservation)).
  That proves compression doesn't alter what the document's own map says. It does
  **not** prove the map is *correct* — if a document's `/ToUnicode` is wrong,
  these suites agree with the wrong answer. Reading order, tagged-PDF correctness
  and screen-reader support are unverified.
* **156 of 168 pages have no usable CMap and cannot be checked this way.** They
  are excluded and counted, never assumed to be empty. Character coverage is
  therefore 12 pages of the corpus, not all of it.
* **The byte-level text payloads are compared separately**, so a change invisible
  to the CMap is caught too. Neither comparison implies the other: bytes can be
  identical while a mapping was altered, or vice versa.
* **Resource limits are enforced per inflate, not per document.** A single
  Flate stream may decode to at most 128 MB. Flate expands by ~1032:1, so
  without that ceiling a 10 MB PDF could ask for ~10 GB — an allocation failure
  rather than a catchable error, which in a worker takes the tab down instead of
  failing a candidate. Past the ceiling the payload is **skipped, never
  truncated**: a truncated prefix of a JPEG is a corrupt file, the one outcome
  this project must not produce. The ceiling is far above any legitimate image
  (a 600 DPI A4 scan is ~26 MB). See `test:resource-limits`.
* **Font behaviour is renderer-dependent.** Both sides share one renderer and
  one font environment, so a difference means the PDF changed — but a document
  relying on a font absent from this environment renders differently on a
  machine that has it. PDF.js is pinned to reduce this; it is not eliminated.
* **Digital signatures are not tested**, only disclosed as invalidated.
* Optional content (layers) has no fixture; it is unverified.
* **Three document forms are still unverified**, and are named rather than
  covered. `test:parser-realism` measures the parser against every body form the
  real documents in this repo's history exhibited, but it has no fixture for:
  * **compressed object streams** (`/ObjStm`) — objects packed into a stream,
  * so an object indexer that reads the file linearly never sees them;
  * **cross-reference streams** — the table itself lives in a stream;
  * **inline images** (`BI…ID…EI`).

  No example of any exists in the two real documents this coverage was derived
  from, so a fixture would be written from the specification rather than from
  something observed. QPDF handles all three during compression, which is why
  the risk is confined to the *test-side* object indexer and not to the
  compressor itself.

  This was checked, not assumed: both real documents were flattened and
  surveyed. Object counts came out **0** in each — no `/ObjStm`, no
  `/Type /XRef`. That is a fact about *those two files*, not about PDFs.

  Practical consequence: a document using compressed object streams would have
  its text and font objects hidden from `test:parser-realism`'s index, so that
  suite would report fewer objects and still pass. The compressor itself is
  unaffected — QPDF reads and rewrites these forms, which is the same reason
  the stage's real-document results are trustworthy.

* **Bare string and array objects are not indexed, by design.**
  `5 0 obj (Adobe) endobj` has no dictionary to store, so the indexer steps over
  it. What is asserted is that *nothing after it is lost* — which is the defect
  that lost 80 objects in 197 on a real document. Worth knowing separately
  because the tool used by the test suites (QPDF flattening) silently deletes
  these objects, so a completeness check run on flattened output would appear to
  pass while never having examined them.
* **Annotations are not rendered.** PDF.js is configured not to draw them, so a
  changed annotation is caught structurally but not visually.
* Thresholds in `test-fidelity.mjs` and `test:visual` are **regression bounds**,
  not perceptual-quality scores. A number below does not mean "looks
  acceptable".

### CI behaviour

`test:visual-comparator` and `test:integrity` both run in the deploy workflow.
The comparator is the guard on the detector itself — if it ever stopped
detecting, the rendered-page suite would go green while proving nothing.
`test:visual` itself is **not** in CI: it needs Chromium, which the runner
would have to install on every push. It runs in `bun run test` locally and is
the gate before a release. Playwright can be provisioned with
`bunx playwright install --with-deps chromium` if you want it in CI too.

### Which browsers this is verified in

`bun run test:browser` runs the whole browser suite in **Chromium, Firefox and
WebKit**, and each engine must pass. Measured, same fixtures, byte-identical
output in all three:

| engine | version tested | result |
| --- | --- | --- |
| Chromium | Playwright full build | 92 passed, 0 failed |
| Firefox | 157.0 | 92 passed, 0 failed |
| WebKit | 27.2 (Playwright build) | 92 passed, 0 failed |

That covers both WASM modules loading, the worker, `DecompressionStream`, and a
stream that must be cancelled — the parts that decide whether a PDF can be
compressed at all. WebKit is slower: 1.7–2.9× Chromium on identical input and
identical output.

### Browser support policy

**Safari is unverified.** Playwright's WebKit is not Safari. It shares an engine
but not a release process, a memory model or an update cadence, and it is not a
proxy for one. No Mac was available to test on, so this project makes no claim
about Safari in either direction. Treat it as untested rather than as supported.

The table above records the **current** Playwright build of each engine, not a
version range. Nothing below has been tested at a pinned version.

For a floor, the binding constraint is `color-mix()` in the stylesheet's derived
tokens — not WebAssembly or the Worker API, both of which are far older:

| feature | used for | lands in |
| --- | --- | --- |
| `color-mix()` | `--primary-soft`, `--danger-soft` | Safari 16.2 · Chrome 111 · Firefox 113 |
| `DecompressionStream` / `CompressionStream` | Flate encode and decode | Safari 16.4 · Chrome 80 · Firefox 113 |
| `Array.prototype.at()` | vendored QPDF glue | Safari 15.4 |

So the derived floor is **Safari 16.4 · Chrome 111 · Firefox 113**. This is
computed from feature availability and is **not measured** — the suite was never
run on those exact versions. Read it as a reason not to assume older browsers
work, not as a tested claim.

Absent `DecompressionStream` the app does not throw. `src/lib/qpdf/zip.ts`
checks for it and returns `null`, so compression is skipped rather than the file
failing.

### Accessibility

`test:browser` asserts these in every engine, against the rendered DOM:

| property | assertion |
| --- | --- |
| Compression progress is spoken | `role="status"`, `aria-live="polite"`, and it announces **changing** text rather than one static string |
| Failures are spoken assertively | `role="alert"` carrying real text, not an empty shell |
| The mode selector is a real control | `role="radiogroup"`, three named radios, exactly one checked |
| Failure lands on the keyboard | the alert carries `tabindex="-1"` and receives focus when it appears |
| Completion is spoken | a separate, permanently mounted live region. The progress panel lives inside `{#if busy}` and is destroyed when compression ends, so without this the whole operation finished in silence — measured at **0 announcements** |
| The busy spinner stops moving | under `prefers-reduced-motion: reduce` nothing loops forever. It is removed, not merely slowed |
| Errors name your file, not the engine's | the raw diagnostic is kept but QPDF's scratch name (`in_<random>_0.pdf`) is replaced with the file you chose |

**What this is not.** These assertions read the accessibility tree and the live
region's text. They are strong evidence the markup is correct, but they are not
a substitute for a run with a real screen reader, which has not been done.

### Mobile

`bun run test:mobile` runs the same three engines at three viewports — 360×740,
390×844 and 320×568 — and asserts:

* **no horizontal overflow**, checked on load, with the options panel open, and
  on the result panel
* **tap targets of at least 44 px** (WCAG 2.5.5, enhanced) for the drop area, the
  primary action, the mode chips and the download link
* **upload through the file input** — the route a phone actually uses, since
  there is no drag and drop on a touchscreen
* a complete upload through to a downloadable result

It found two real defects on its first run, both invisible to the 225 desktop
assertions: the primary action was **39 px** tall and the mode chips **30 px**, at
every viewport in every engine. Both now carry `min-height: 44px`.

**This is not a device lab.** Viewports, not hardware: no touch physics, no
mobile Safari, no Android Chrome, no throttled CPU or slow network. Playwright's
desktop engines at phone dimensions is not the same claim as "works on a phone".
A mid-range phone is several times slower than any of these, and nothing here
measures whether a Maximum run on a large document is tolerable there.

### What this does not establish, stated plainly:

* **Playwright's WebKit is not Safari.** It is an open-source WebKit build
  without Apple's proprietary additions. Passing there is evidence about the
  WebKit engine, not a guarantee for Safari on macOS or iOS.
* **No mobile Safari or Android Chrome has been tested** — see above.
* **No minimum versions are claimed.** One build of each engine was tested, so
  there is no floor. Playwright ships older builds, so establishing one is
  straightforward work, not research.
* Chromium derivatives (Edge, Brave, Opera) are untested.

Where a required API is missing the app **degrades rather than breaks**:
`makeZip()` returns `null` when `CompressionStream`/`DecompressionStream` are
absent, and such images are skipped instead of corrupted. An old browser would
therefore produce a *larger* file rather than an error.

### Upgrading PDF.js

Pinned deliberately. A version change alters rendering and can invalidate every
threshold. To upgrade: change the pin, then run
`bun run test:visual-comparator && bun run test:visual -- --measure`. Compare
the `--measure` table against the calibration table above. A regression in
`identical` (anything above exactly 0.000) is a **real** rendering difference,
not threshold drift — investigate it before touching a bound.

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
┌ QCompress ─────────────────────────────────────── (small wordmark)
│
│      ┌ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ┐
│      │           (upload)            │   empty state — dashed card
│      │   Click to select a file     │   centred, like the reference
│      │      or drag and drop        │
│      └ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ┘
│   Compressed in your browser. Nothing is uploaded.
│
│  ┌ QCompress ───────────────────────────────────────
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

## Text-layer preservation

A page can render perfectly while its text has been destroyed underneath. Search
finds nothing, copy yields nothing, a screen reader has nothing to read. Visual
equality cannot see that, so the text layer is checked separately.

**The invariant**

> Compression must not remove or alter the ordered string payloads supplied to a
> page's text-showing operators.

The four operators inspected are `Tj`, `TJ`, `'` and `"`. The numeric
positioning values inside a `TJ` array, and the two spacing numbers `"` takes,
are **not** text and are excluded — they move glyphs, and the visual suite owns
rendered position.

**How it works** (`scripts/lib/textlayer.mjs`)

1. Each document is flattened with `--object-streams=disable` and walked with the
   existing `structure.ts` reader — the same page traversal the structural suite
   uses, not a second parser.
2. Each page's `/Contents` is resolved. Both shapes are supported: a single
   stream, and an array of streams whose content is concatenated in order.
3. Streams are inflated where `/FlateDecode` is present, using the same
   `makeZip()` helper the image path uses. Any *other* filter is reported as
   unsupported rather than guessed at — scanning still-encoded bytes for `Tj`
   would manufacture operators that are not in the document.
4. A real tokenizer parses the content stream. **Not a regex.** The bytes `Tj`
   occur constantly inside JPEG data, comments and string literals; nine corpus
   fixtures already contain `)` followed by `"` purely by accident inside image
   payloads. A regex would report those as text-showing operators.

The tokenizer handles delimiters, comments, literal strings with balanced
parentheses and every escape form (including octal and backslash-newline
continuation), hex strings with embedded whitespace and odd digit counts, arrays,
numbers, names, dictionaries, and inline images — whose payload is skipped
wholesale rather than scanned.

**String normalization.** A literal string and a hex string representing the same
bytes produce the same payload, so a candidate that re-spells a string is not
reported as changed. Escapes are decoded per the PDF grammar. No font encoding is
applied: the bytes are preserved as-is.

**The signature and the equality rule.** Per page: the ordered text-showing
operations, each with its decoded string segments (`TJ` keeps its segments
distinct, so a removed segment is visible rather than absorbed), plus the
concatenated bytes. Two pages match when **both** the concatenated bytes and the
per-operation segment boundaries are identical.

Requiring both is defensible for a specific reason: QCompress documents that it
never rewrites content streams, so re-segmentation is not something this
compressor does. A boundary difference with matching bytes would be a genuine
finding. The rule was fixed **before** the corpus was run — changing it after a
fixture failed would be fitting the test to the output.

Comparison is direct byte comparison, never hash equality: a digest would be
weaker evidence and harder to read when it fails.

**No silent emptiness.** A page whose content could not be decoded is
`unsupported`, never "no text". Conflating them is how corruption becomes a
silent pass. An original page *with* text whose candidate yields none is a
failure. An original page *without* text whose candidate also has none is a
pass — a scanned or blank page is legitimate, and the requirement is
preservation, not the presence of a text layer.

**Coverage.** All 42 valid fixtures × all three modes: 126 document comparisons,
168 page comparisons. 51 of those runs carry text, 75 are image-only or blank and
are expected to carry none. The three deliberately-broken fixtures are excluded as
not being renderable documents, each reason stated in code.

**Negative controls.** `test:text-extract` covers the grammar (27 cases:
escapes, octal, hex, comments, inline images, nested arrays, malformed input) and
the comparator (20 cases: changed byte, removed string, shortened string, extra
string, reordering, page count, empty candidate, page merging).
`test:text-integrity` then corrupts **real fixture PDFs** and runs them through
the identical path — and asserts the corrupted file still passes `qpdf --check`,
so the control proves text detection rather than merely proving qpdf rejects
broken files.

**Unicode is a separate axis, and is checked separately.** The bytes above are
*font-encoded*, not Unicode. Mapping them to characters needs the font's encoding
and its `/ToUnicode` CMap, so `test:unicode-integrity` and
`test:unicode-extraction` cover that on its own:

* **mappings** — every `bfchar` / `bfrange` entry in every `/ToUnicode` map, from
  all 9 CMaps in the corpus (102 mappings), must survive all three modes.
* **characters** — for the 12 pages whose fonts carry a usable CMap (117
  characters), the decoded string must be identical across modes.

The remaining **156 pages are not decodable**. They are excluded *and counted*,
never treated as empty — treating "no CMap" as "no text" is how a document with
every mapping destroyed compares equal to itself. This distinction was not
cosmetic: `fontCMapsForPage` once looked for `/Font` only in the page dictionary,
so a real document that puts `/Resources` behind a reference yielded zero CMaps,
every page decoded to nothing, and the suite passed.

What Unicode coverage still does **not** prove: that a document's own
`/ToUnicode` map is *correct*. These suites prove compression doesn't alter what
the document says its characters are. If the map is wrong, they agree with the
wrong answer. Reading order, tagged-PDF correctness and screen-reader support
are unverified.

**What the byte-level suite does NOT prove.** It is an operand-preservation
regression suite, not an accessibility validator. Comparing these operands does
**not** prove correct reading order, tagged-PDF correctness, or screen-reader
support. Two documents with different encodings can render identically and differ
here. All three suites are needed:

| Visual | Text bytes | Characters | Meaning |
| --- | --- | --- | --- |
| Pass | Pass | Pass | All three checked properties preserved within their policies |
| Pass | **Fail** | — | Looks right, text changed — reject the candidate |
| Pass | Pass | **Fail** | Bytes identical, but a `/ToUnicode` mapping was altered |
| **Fail** | Pass | Pass | Text intact, rendered output changed — existing visual policy |
| Fail | Fail | — | Both invariants violated |

## Page-level visual regression

Rendered pages are compared directly, not just structure and image payloads.
See [Test suite](#test-suite) for metrics, thresholds and negative controls.

Quick reference:

```bash
bun run test:visual-comparator      # comparator logic + negative controls (1s, no browser)
bun run test:visual                 # render and compare every fixture x mode
bun run test:visual:measure         # print the metric table, assert nothing
bun run test:visual -- --diagnose   # write diff PNGs on failure
```

PDF.js is pinned to **6.4.299** and is a **devDependency** — it is never
bundled and never reaches the deployed site.

`test:visual` is the slowest suite here, because it renders every fixture in
every mode through a real browser. Expect roughly a minute, and expect Chromium
processes to appear while it runs. On a busy machine `bun run test:visual --
<fixture.pdf>` narrows it to the fixtures you care about.

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
      zip.ts               bounded Flate codec (shared by the worker and its tests)
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
  lib/visual.mjs           visual comparator: metrics, geometry, mode policies
  lib/textlayer.mjs        content-stream tokenizer + text-payload extractor
  lib/textcompare.mjs      text-signature comparison and diagnostics
  lib/cmap.mjs             /ToUnicode CMap parser (codespacerange, bfchar, both bfrange forms)
  lib/unicode.mjs          /ToUnicode lookup + character extraction per page
  lib/fixture-manifest.mjs  what each fixture is and what must happen to it  (above)
  lib/render.mjs           PDF.js-in-Chromium rendering harness
  lib/visual-page.mjs      in-page half of the renderer
  generate/                fixture generators (see scripts/README.md)
  test/                    the suites
  tools/                   benchmarks, explain, screenshots
  probe/                   one-off engine investigations
  fixtures/                45 committed PDFs (42 valid, 3 deliberately invalid); see scripts/FIXTURES.md
  README.md                how the scripts folder is laid out
  FIXTURES.md              fixture corpus documentation
```

The entry points are all named in `package.json`; `scripts/README.md` explains
what each one is for.

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
| `bun run fixtures` | Regenerate the 45 committed fixtures |
| `bun run bench` | Orchestrator over every fixture × mode, with per-file detail |
| `bun run bench:legacy` | The old single-pass engine, for comparison |
| `bun run explain <file.pdf> [mode]` | Why a document did or did not shrink, image by image |
| `bun run verify:live-file <file.pdf> [mode]` | Run a real document against the deployed site |
| `bun run test:engine` | QPDF behaviour and exit codes |
| `bun run test:pipeline` | Orchestrator contracts on the savings corpus |
| `bun run test:integrity` | Structural + semantic preservation across all fixtures |
| `bun run test:fidelity` | Decoded-pixel fidelity for the lossy modes |
| `bun run test:text-extract` | Text extractor grammar + comparator negative controls (no engine, no browser) |
| `bun run test:text-integrity` | Text payload preserved per page, per mode, across the corpus |
| `bun run test:structure-control` | Proves the structure comparison can fail |
| `bun run test:cmap` | `/ToUnicode` CMap parser |
| `bun run test:parser-realism` | Object indexer vs. the body forms real documents use |
| `bun run test:resource-limits` | Decompression-bomb refusal, end to end |
| `bun run test:unicode-integrity` | Every `/ToUnicode` mapping survives compression |
| `bun run test:unicode-extraction` | Characters a page renders as, per mode |
| `bun run verify:file <file.pdf> [mode]` | Run a real document locally, with per-check output |
| `bun run test:visual-comparator` | Visual comparator logic + negative controls (no browser) |
| `bun run test:visual` | Rendered-page comparison, original vs compressed, per mode |
| `bun run test:visual -- --measure` | Print every measured page metric, assert nothing |
| `bun run test:visual -- --diagnose` | Write original / candidate / diff PNGs on failure |
| `bun run test:browser` | Build + verify the real UI in Chromium, Firefox and WebKit |
| `bun run test:browser -- webkit` | Verify in one engine only |
| `bun run test:mobile` | Verify at three phone viewports in all three engines |
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