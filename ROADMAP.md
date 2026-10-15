# QCompress — Roadmap

Reconstructed from the engineering record. Statuses reflect what has actually
been verified, not what was planned.

## 1. Completed and current work

| Phase | Stage | Scope | Status |
| --- | --- | --- | --- |
| 0 | Browser foundation | Local PDF processing, WASM integration, upload-to-download workflow | Established |
| 1 | Compression orchestrator | Generate candidates, validate them, select the smallest acceptable result, fall back to the original | Completed (`dec62cd`) |
| 2 | Compression modes | Lossless stream deduplication; Balanced and Maximum lossy image optimization | Implemented |
| 3 | Structural integrity | Validate candidates, reject invalid output, preserve the original when necessary | Completed (`81d1cfe`) |
| 4 | Visual fidelity | Raster comparisons for real image-handling regressions | Implemented |
| 5 | Page-level visual regression | Render pages, compare original against compressed output | Completed (`87cc150`) — sweep verified green |
| 6 | Text-layer preservation | Compare raw payloads for `Tj`, `TJ`, `'` and `"` per page, per mode | Implemented — **sweep verified green, not yet committed** |
| 7 | Visual-policy recalibration | Re-check lossy bounds against real user documents | Completed — real documents now pass |

### Verified suite results

| Suite | Result |
| --- | --- |
| `check` | 0 errors, 0 warnings |
| `test:engine` | 32 passed, 5 skipped |
| `test:pipeline` | 42 passed |
| `test:integrity` | 290 passed (37 fixtures) |
| `test:fidelity` | 56 passed, 57 raster comparisons |
| `test:text-extract` | 47 passed |
| `test:text-integrity` | 115 passed, 150 page comparisons |
| `test:visual-comparator` | 32 passed |
| `test:visual` | 111 passed, 150 page comparisons |
| `test:browser` | 72 passed |
| `test:live` | 16 passed |

### Bugs this work actually found

Four defects, each invisible to the checks that existed at the time:

1. `/Filter [/FlateDecode /DCTDecode]` was never decoded — stored bytes are
   Flate-wrapped JPEG, so all 33 images on a real document silently failed.
2. ICC-tagged RGB (`/N 3`) was excluded — 31 of 34 images discarded needlessly.
3. Image dictionaries were found by a backwards search for `<<`, which grabbed a
   nested `/DecodeParms` dict, so `/Length` was never updated.
4. **Deduplication blanked pages.** A duplicate image object was deleted without
   repointing the page that referenced it. The output passed `qpdf --check`,
   every structural assertion, and image fidelity — while rendering blank. Found
   only by the visual stage.

## 2. Immediate roadmap

| Priority | Stage | Work to do | Completion criteria |
| --- | --- | --- | --- |
| **P0** | **Output determinism** | Compress the same PDF repeatedly in Bun and in the browser worker; record output hashes, byte sizes, and the candidate chosen each time. Investigate the 2,514-byte discrepancy. | Repeated runs are reproducible within each environment, or any remaining difference is explained and documented. |
| P1 | Commit the text-layer stage | Review and commit the verified, uncommitted work. | Completed work is recorded in Git. |
| P2 | Performance profiling | Investigate the ~24 s runtime on the 32-page book. Measure candidate generation, compression, validation, and peak memory. | Reproducible benchmark identifies the bottleneck before optimisation. |
| P3 | `verify:file` command | Run one local PDF through structural, text and visual checks in a single command. | One command, clear pass/fail, useful diagnostics. |

### P0 — why determinism first

| Observation | Value |
| --- | --- |
| Downloaded file | 1,533,838 B |
| Current engine, same input | 1,531,324 B |
| Difference | **2,514 B** |
| Reported savings | ~49.7% both |
| Text comparison | identical both |
| Root cause | **not established** |

**Method.** Compress the identical input several times in each environment and
hash every output. Three outcomes matter:

- Bun varies between runs → an internal ordering or state bug.
- Bun and the browser worker each vary → concurrency or timing dependence.
- Both stable, but they differ from each other → the two code paths genuinely
  differ, and the difference must be explained rather than hidden.

Candidate selection must be compared alongside the hashes: two candidates of
similar size can both validate, and which one wins may not be stable.

Do **not** assume `CompressionStream` is responsible before measuring it. The
goal is reproducibility plus an explanation — not forcing identical bytes by
suppressing a legitimate difference.

## 3. Longer-term roadmap

Planned future work. None of this exists in the repository yet.

| Priority | Stage | Scope | Planned result |
| --- | --- | --- | --- |
| P4 | PDF feature preservation | Links, bookmarks, forms, annotations, page geometry, font references, metadata, attachments | Detect unintended loss of document functionality |
| P5 | Encoding and Unicode coverage | `/ToUnicode` mappings, font encoding, text extraction — separate from raw-byte preservation | Stronger guarantees for searchable and extractable text |
| P6 | Malformed-input hardening | Truncated PDFs, invalid references, unusual streams, resource exhaustion, failure recovery | Fail safely, never return corrupted output |
| P7 | Memory and performance optimisation | Reduce buffers and duplicate processing, guided by P2 profiling | Faster without destabilising candidate selection |
| P8 | Browser compatibility | Upload, WASM loading, progress, cancellation, download across supported browsers | Reliable behaviour on explicitly supported browsers |
| P9 | Privacy and UX hardening | Local-only handling, honest errors, clear loss warnings, accessibility, no-savings cases | Trustworthy UX without misleading compression claims |
| P10 | CI and release gate | Structural, fidelity, visual, text, browser and build checks before release | Reproducible quality checks for future changes |
| P11 | Stable release | Document limitations, supported browsers, privacy, signature behaviour | A maintainable, well-documented public release |

## 4. Project rules

These are constraints the project holds itself to. They are not aspirations.

| Rule | Requirement |
| --- | --- |
| Local processing | PDF contents stay in the browser. Never send files to a remote compression API. |
| Candidate validation | A smaller file is not acceptable unless it passes the relevant validation. |
| Safe fallback | Return the original when no acceptable candidate is better. |
| Honest compression | Lossy image re-encoding is always identified as lossy. |
| Text preservation | Text-layer integrity stays a separate check from visual integrity. |
| Signatures | Warn that rewriting a signed PDF invalidates its signature. |
| Dependencies | Add a dependency only when its benefit justifies the cost. |
| Performance | Benchmark before claiming an improvement. |
| Release discipline | Never describe an unrun suite as passed, or uncommitted work as released. |

## 5. Known limitations

Stated plainly rather than hidden. See the README for detail.

- Damage smaller than ~5 % of a photographic page is not detectable by pixel
  metrics. Real limit of the approach, not a tunable threshold.
- The text-layer check compares **font-encoded bytes**, not Unicode. It does not
  prove correct extraction, reading order, tagged-PDF validity, `/ToUnicode`
  preservation, or screen-reader support.
- Font rendering is renderer-dependent. Both sides of a comparison share one
  environment, so a difference means the PDF changed — but a document relying on
  an absent font renders differently elsewhere.
- Annotations are checked structurally, never rendered.
- Optional content (layers) has no fixture.
- Digital signatures are disclosed as invalidated, not tested.
- Thresholds in `test:fidelity` and `test:visual` are regression bounds, not
  perceptual-quality scores.