# scripts/

Everything that builds, measures or verifies the engine. Nothing here ships:
the production bundle is `src/` only.

```
scripts/
  lib/        shared modules, imported by the suites and tools
  generate/   fixture generators
  test/       the suites (bun run test runs these)
  tools/      benchmarks and diagnostics you run by hand
  probe/      one-off investigations kept for the record
  fixtures/   the 37 committed PDFs the suites read
```

## `lib/`

Not run directly.

| File | What it is |
| --- | --- |
| `engine.mjs` | A `QpdfRunner` bound to the vendored WASM build, plus the jSquash codec and zlib, so the suites exercise the same code the app does. |
| `fixtures.mjs` | Programmatic PDF builders (`textPdf`, `imagePdf`, …) and the `build()` helper. |
| `named-build.mjs` | PDF builder with symbolic `${objectName}` references, so fixtures cannot end up with dangling references. |
| `fixture-manifest.mjs` | **What each fixture is and what must happen to it.** The single source of truth; adding a fixture without an entry here fails the suite. |
| `compare.mjs` | Semantic diff between two PDFs. Object numbers are never compared — a changed number is not a defect; a missing page is. |
| `visual.mjs` | Page-level visual comparator: metrics, geometry checks, mode policies. Pure, so the Node unit tests and the browser renderer share one implementation. |
| `textlayer.mjs` | Content-stream tokenizer and text-payload extractor. Reuses `structure.ts` for page traversal; inflate is injected, so no dependency and no Node-only API. |
| `textcompare.mjs` | Compares two text signatures and produces the failure diagnostics. |
| `render.mjs` | Runs PDF.js inside Chromium and compares rendered pages. Serves its own blank page; does not need the app built. |
| `visual-page.mjs` | The in-page half of the renderer. Loaded by Chromium; owns the PDF.js document and canvas lifecycle. |

## `generate/`

| Command | Needs | Produces |
| --- | --- | --- |
| `bun run fixtures` | both | all 45 fixtures |
| `bun scripts/generate/make-fixtures.mjs` | Chromium | the 8 savings fixtures |
| `bun scripts/generate/make-integrity-fixtures.mjs` | Bun only | the 29 integrity fixtures |

The integrity generator deliberately avoids Chromium so it runs in about a
second with no browser. See [FIXTURES.md](FIXTURES.md).

## `test/`

Run through the package scripts; running one directly works too.

| Script | Command | Covers |
| --- | --- | --- |
| `test-compression.mjs` | `bun run test:engine` | QPDF behaviour, options, exit codes |
| `test-pipeline.mjs` | `bun run test:pipeline` | orchestrator contracts, savings corpus |
| `test-integrity.mjs` | `bun run test:integrity` | structural + semantic preservation, all fixtures |
| `test-fidelity.mjs` | `bun run test:fidelity` | decoded-pixel fidelity (`--measure` to print the table) |
| `test-visual-comparator.mjs` | `bun run test:visual-comparator` | the visual comparator's own logic, plus negative controls. No browser, no rendering, runs in a second. |
| `test-visual.mjs` | `bun run test:visual` | rendered-page comparison of original vs compressed, per fixture per mode |
| `test-text-extract.mjs` | `bun run test:text-extract` | content-stream tokenizer grammar + comparator controls. No engine, no browser. |
| `test-text-integrity.mjs` | `bun run test:text-integrity` | text payload preserved per page, per mode, through the real pipeline |
| `test-cmap.mjs` | `bun run test:cmap` | `/ToUnicode` CMap parser: codespacerange, `bfchar`, both `bfrange` forms |
| `test-unicode-integrity.mjs` | `bun run test:unicode-integrity` | every CMap mapping survives compression, unchanged |
| `test-unicode-extraction.mjs` | `bun run test:unicode-extraction` | the characters a page actually renders as, per mode |
| `test-parser-realism.mjs` | `bun run test:parser-realism` | the object indexer against the body forms real documents use |

### Parser realism

`parseObjects` once lost 80 of 197 objects on a real 10-page document, including
all 16 of its `/ToUnicode` maps, because it searched forward for the next `<<`
past objects whose body is a bare string or array. No suite noticed: across the
40 fixtures that existed at the time, those forms occurred **zero** times, so the
failing path was unreachable rather than merely untested.

The assertion is deliberately stronger than "the expected objects are present":

```
for every fixture:
    index the RAW bytes
    assert no dictionary object was skipped
```

That holds for document shapes nobody has thought of yet, which the weaker form
cannot.

It runs on **raw bytes, not QPDF-flattened text** — flattening silently deletes
bare string and array objects, so a check on flattened output passes having never
examined them. A control asserts that deletion really happens, so the reason
cannot quietly stop being true.

Its two regression controls feed the scanner a body layout in memory and were
each verified to **fail under the previous implementation**. One was decorative
when first written (it asserted object count, but the defect truncated a
dictionary in place and left the count intact) and was rewritten to target the
actual symptom.

### Text-layer preservation

`test:text-extract` is the fast one — pure grammar and comparison rules, no PDF
and no browser. It is where the tokenizer's handling of escapes, hex strings,
comments, nested arrays and inline images is pinned down, and where the
comparator is proven to reject a changed, missing, added or reordered string.

`test-text-integrity` runs the real compressor over every fixture in every mode
and compares the extracted text payload page by page. Its negative controls
corrupt **actual fixture PDFs** and assert the result still passes `qpdf --check`,
so they prove text detection rather than merely proving qpdf rejects broken
files.

### Visual regression

`test-visual-comparator` runs in a second and needs nothing but Bun: it proves
the comparator and policy logic respond correctly at known boundaries,
including at boundaries that **must** fail.

`test-visual` is the slow one. It starts Chromium, renders the original and the
compressed output of every fixture through the same pinned PDF.js, and compares
them page by page. It needs Chromium (Playwright) and `pdfjs-dist`, both
dev-only. Run `--measure` to print the metric table without asserting — that is
how the thresholds in `visual.mjs` were calibrated. Run `--diagnose` to write
`original | candidate | difference` PNGs to `.visual-diagnostics/` when a page
fails; the directory is removed again unless you ask for it.

It found a real bug: deduplication was blanking pages while every other suite
called the output correct. See the README section "The bug only rendering could
find".
| `test-browser.mjs` | `bun run test:browser` | real Chromium |
| `test-live.mjs` | `bun run test:live` | the deployed site |

## `tools/`

| Command | Purpose |
| --- | --- |
| `bun run bench` | Orchestrator over every fixture × mode, with per-file detail |
| `bun run bench:legacy` | The old single-pass engine, for comparison |
| `bun run explain <file.pdf> [mode]` | **Why a document did or did not shrink**, image by image |
| `bun run verify:live-file <file.pdf> [mode]` | Run a real document against the deployed site |
| `bun run screenshots` | Capture every UI state to `.screenshots/` |
| `pwsh scripts/tools/set-defender-exclusions.ps1` | Quiet Defender during heavy builds (self-elevates; `-Remove` undoes it). Windows-only, needs admin. |

`explain` is the one to reach for when a real document comes back with a tiny
saving: it prints every image, whether it was eligible, and if not the reason.

## `probe/`

Investigations, kept because the findings are quoted in the README. Not part of
`bun run test`, and not expected to stay working as the engine changes.

| Script | What it established |
| --- | --- |
| `probe-qpdf-wasm.mjs` | Engine version and capability |
| `probe-structure.mjs` | What the structure reader can extract |
| `probe-stages.mjs` | What each pipeline stage receives and returns |
| `probe-dupes.mjs` | How many fixtures hold duplicate streams |
| `probe-image.mjs` | JPEG byte-identity through QPDF |
| `probe-codec.mjs` | jSquash decode/resize/encode |
| `probe-json.mjs` | Which `--json` keys this build accepts |
| `dump-image.mjs` | Image dictionaries before and after |