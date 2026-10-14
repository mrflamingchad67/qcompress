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

## `generate/`

| Command | Needs | Produces |
| --- | --- | --- |
| `bun run fixtures` | both | all 37 fixtures |
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