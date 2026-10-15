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
| 5 | Page-level visual regression | Render pages, compare original against compressed output | Completed (`87cc150`) |
| 6 | Text-layer preservation | Compare raw payloads for `Tj`, `TJ`, `'` and `"` per page, per mode | Committed (`d6011db`) |
| 7 | Visual-policy recalibration | Re-check lossy bounds against real user documents | Committed (`d6011db`) |
| 8 | Output determinism | Prove or disprove reproducibility, and explain any difference | Resolved — deterministic; see below |
| 9 | Performance profiling | Locate the bottleneck before optimising anything | Committed (`825b188`) |
| 10 | Resize kernel | 60.8 % of an image pass was spent resizing under inherited library defaults | Measured and changed — **uncommitted** |
| 11 | Fidelity blind spot | The fidelity suite silently skipped every resized image | Fixed — **uncommitted** |

### Verified suite results

Measured on the current working tree, Maximum mode included.

| Suite | Result |
| --- | --- |
| `check` | 0 errors, 0 warnings |
| `test:engine` | 32 passed, 0 failed, 5 skipped |
| `test:pipeline` | 42 passed, 0 failed |
| `test:integrity` | 290 passed, 0 failed (37 fixtures) |
| `test:fidelity` | 56 passed, 0 failed, **64** raster comparisons (8 against a downscaled original) |
| `test:fidelity-control` | 6 detected, 0 missed, 6 skipped |
| `test:text-extract` | 47 passed, 0 failed |
| `test:text-integrity` | 115 passed, 0 failed, 150 page comparisons |
| `test:visual-comparator` | 32 passed, 0 failed |
| `test:visual` | 111 passed, 0 failed, 150 page comparisons |
| `test:browser` | 72 passed, 0 failed |
| `test:live` | 16 passed — describes the deployed build, which predates stages 10–11 |

### Bugs this work actually found

Five defects, each invisible to the checks that existed at the time:

1. `/Filter [/FlateDecode /DCTDecode]` was never decoded — stored bytes are
   Flate-wrapped JPEG, so all 33 images on a real document silently failed.
2. ICC-tagged RGB (`/N 3`) was excluded — 31 of 34 images discarded needlessly.
3. Image dictionaries were found by a backwards search for `<<`, which grabbed a
   nested `/DecodeParms` dict, so `/Length` was never updated.
4. **Deduplication blanked pages.** A duplicate image object was deleted without
   repointing the page that referenced it. The output passed `qpdf --check`,
   every structural assertion, and image fidelity — while rendering blank. Found
   only by the visual stage.
5. **The fidelity suite never compared a resized image.** Output images were
   matched back to inputs by exact dimensions, so any image the pipeline also
   downscaled matched nothing and was dropped with no row, no assertion and no
   failure. All 33 images of the 32-page book were unexamined, and the suite
   could report "56 passed" while the images that mattered most went unchecked.
   Found only because a fidelity comparison count moved for an unrelated reason.

The fifth is the most instructive: it was a *verification* defect, not a
compression defect, and no amount of running the suite would have surfaced it.

## 2. Immediate roadmap

| Priority | Stage | Work to do | Status |
| --- | --- | --- | --- |
| **P0** | **Output determinism** | Prove reproducibility and explain any difference | **Done** — deterministic, no fix needed |
| P1 | Commit the text-layer stage | Review and commit verified work | **Done** (`d6011db`) |
| P2 | Performance profiling | Measure before optimising | **Done** — bottleneck found and addressed |
| P3 | `verify:file` command | One command running structural, text and visual checks | Written — **not yet run** |
| P4 | Deploy stages 10–11 | The resize change reaches users only on deploy | Awaiting authorisation |
| P5 | Stale-codec hypothesis | Explain a download that differs from every fresh run | Blocked on two deploys |

### P0 — resolved, and how

Two runs of the live site on identical input differed in exactly **32 bytes**,
0.0021 %, all of it the second element of the trailer `/ID`. The first element,
every object, every stream, every image payload and the text layer were
byte-identical. ISO 32000-1 §14.4 defines that element to change when a file is
modified, so this is conformant behaviour.

**The compressor is deterministic. No fix was required and none was made.**

One loose end remains unexplained: an earlier download of the same document was
1,533,838 B while fresh runs produced 1,534,266 B, differing in 7,126 ranges. The
leading hypothesis is a browser tab left open across a deploy, holding the
lazily-cached codec chunk. Testing it requires two deploys, so it is P5 rather
than a claim.

### P2 — what profiling found, and what it cost to fix

Baseline on the 32-page book, Maximum: mean 26,497 ms, output 1,531,324 B.

Profiling the orchestrator required forwarding `Candidate.ms`, which the pipeline
already measured and then discarded.

The first hypothesis was wrong, and worth recording so it is not re-derived: the
two Maximum attempts use **different** `maxLongEdge` values (1700 and 2480), so
their resizes do not even target the same dimensions. There was no duplicated
resize work to share. On this document the q78 attempt does not resize at all.

Resizing was 60.8 % of the expensive image pass — 291 ms per 3.24-megapixel
image — because `@jsquash/resize` was called as `resize(image, {width, height})`
and silently inherited its defaults: `lanczos3`, `premultiply`, `linearRGB`.
None of those was ever chosen by this project.

| kernel | speed | output | MAE on a downscaled scan |
| --- | --- | --- | --- |
| `triangle`, defaults off | 2.91× | −7.5 % | **5.50** (best) |
| `mitchell`, defaults off | 2.64× | −6.6 % | 5.63 |
| `catrom`, defaults off | 1.00× | −3.3 % | 5.68 |
| `lanczos3`, defaults off | 0.76× | −0.0 % | 6.31 |
| `lanczos3` + linearRGB | 0.76× | −1.8 % | 9.11 |

Result on the 32-page book: mean 26,497 ms → 18,245 ms (**31 % faster**), output
1,531,324 B → 1,437,194 B (**6.1 % smaller**), byte-identical across five runs.
Steady-state is ~17 s; the first run is slower through WASM/JIT warm-up.

`linearRGB` was tested because linear-light resampling genuinely preserves
brightness relationships better. It is measurably the worst option here, roughly
doubling the error on photographic scans, so it stays off.

`premultiply` stays off for a structural reason rather than a preference: every
pixel reaching the resizer came from a JPEG decoder, which always yields alpha
255, and premultiplying an image whose alpha is uniformly 255 is the identity.

## 3. Longer-term roadmap

| Priority | Stage | Scope | Planned result |
| --- | --- | --- | --- |
| P6 | PDF feature preservation | Links, bookmarks, forms, annotations, page geometry, font references, metadata, attachments | Detect unintended loss of document functionality |
| P7 | Encoding and Unicode coverage | `/ToUnicode` mappings, font encoding, text extraction — separate from raw-byte preservation | Stronger guarantees for searchable and extractable text |
| P8 | Malformed-input hardening | Truncated PDFs, invalid references, unusual streams, resource exhaustion, failure recovery | Fail safely, never return corrupted output |
| P9 | Memory and performance optimisation | Remaining redundancy and buffer use, guided by measured cost | Faster without destabilising candidate selection |
| P10 | Browser compatibility | Upload, WASM loading, progress, cancellation, download across supported browsers | Reliable behaviour on explicitly supported browsers |
| P11 | Privacy and UX hardening | Local-only handling, honest errors, clear loss warnings, accessibility, no-savings cases | Trustworthy UX without misleading compression claims |
| P12 | CI and release gate | Structural, fidelity, text, browser and build checks before release | Reproducible quality checks for future changes |
| P13 | Stable release | Document limitations, supported browsers, privacy, signature behaviour | A maintainable, well-documented public release |

## 4. Project rules

Constraints the project holds itself to. Not aspirations.

| Rule | Requirement |
| --- | --- |
| Local processing | PDF contents stay in the browser. Never send files to a remote compression API. |
| Candidate validation | A smaller file is not acceptable unless it passes the relevant validation. |
| Safe fallback | Return the original when no acceptable candidate is better. |
| Honest compression | Lossy image re-encoding is always identified as lossy. |
| Text preservation | Text-layer integrity stays a separate check from visual integrity. |
| Negative controls | Every detector needs proof it can fail, or it proves nothing. |
| Signatures | Warn that rewriting a signed PDF invalidates its signature. |
| Dependencies | Add a dependency only when its benefit justifies the cost. |
| Performance | Benchmark before claiming an improvement, on an unloaded machine. |
| Threshold discipline | Never move a threshold to reach green; re-derive it from measurement and say why. |
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
- The fidelity suite's `downscaled` limits were derived from five fixtures. They
  are measured, not assumed, but the corpus for downscaled photographic scans is
  small and `triangle` was not compared against higher-quality kernels on
  text-heavy *scans* rendered as pages — only on image-level MAE.
- Resizing never enlarges, and only ever targets `maxLongEdge`. There is no
  fixture where a declared `/Width` disagrees with the decoded image, except
  `graphic-q75`, where the pipeline silently corrects the declaration.