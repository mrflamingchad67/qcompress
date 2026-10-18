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
| 10 | Resize kernel | 60.8 % of an image pass was spent resizing under inherited library defaults | Committed (`04ea5c3`) |
| 11 | Fidelity blind spot | The fidelity suite silently skipped every resized image | Committed (`04ea5c3`) |
| 12 | Deployment | CI could not publish; a later fix published an empty site | Committed (`f047754`) |
| 13 | Semantic structure comparison | The per-page block of `compareStructure` was unreachable, so annotations, links and page geometry were never compared | Committed (`0779cfb`) |
| 14 | Unicode coverage | `/ToUnicode` CMaps parsed and compared; extracted characters preserved per mode | Committed (`de6c6bf`) |
| 15 | Object indexer completeness | Lost 80 of 197 objects on a real document, including all 16 `/ToUnicode` maps | Committed (`d8cdbfb`) |
| 16 | Corpus realism | Every structural form that broke the parser was absent from all fixtures — unreachable, not under-tested | Committed (`parser-realism` suite) |
| 17 | Resource limits | An uncapped inflate could allocate gigabytes from a small file and take the worker down | Committed (`fc469be`) |
| 18 | Image replacement cost | The document was rebuilt once per image; each rebuild flattened the whole string | Committed (`fdc844c`) |
| 19 | Browser matrix | The browser suite ran in Chromium only, so two WASM modules and `DecompressionStream` were verified in one engine | Committed — 225 passed across 3 engines |

Stages are numbered continuously in this table only. The "P" labels in sections 2
and 3 are a separate, earlier numbering and are **not** stage numbers — `P6` in
section 2 and `P6` in section 3 mean different things, which is a trap for
anyone reading this as a single sequence.

### Verified suite results

Measured on the current working tree, Maximum mode included.

| Suite | Result |
| --- | --- |
| `check` | 0 errors, 0 warnings |
| `test:engine` | 32 passed, 0 failed, 5 skipped |
| `test:pipeline` | 42 passed, 0 failed |
| `test:integrity` | 320 passed, 0 failed (42 fixtures) |
| `test:structure-control` | 12 controls behaved correctly, 0 did not |
| `test:fidelity` | 56 passed, 0 failed, **64** raster comparisons (8 against a downscaled original) |
| `test:fidelity-control` | 6 detected, 0 missed, 6 skipped |
| `test:text-extract` | 47 passed, 0 failed |
| `test:text-integrity` | 130 passed, 0 failed, 168 page comparisons |
| `test:cmap` | 45 passed, 0 failed |
| `test:parser-realism` | 53 passed, 0 failed (42 fixtures, 0 dictionary objects lost) |
| `test:resource-limits` | 11 passed, 0 failed (400 MB and 1000 MB decodes refused, heap +0 MB) |
| `test:unicode-integrity` | 131 passed, 0 failed (9 CMaps, 102 mappings) |
| `test:unicode-extraction` | 128 passed, 0 failed (12 pages, 117 characters; 156 pages not decodable, excluded and counted) |
| `test:visual-comparator` | 32 passed, 0 failed |
| `test:visual` | 126 passed, 0 failed, 168 page comparisons |
| `test:browser` | 225 passed, 0 failed — 75 each in Chromium, Firefox and WebKit |
| `test:live` | 16 passed — describes the deployed build, which predates stages 10–11 |

### Bugs this work actually found

Twelve defects, each invisible to the checks that existed at the time. Five found
by running the engine on real documents and comparing rendered output; four by
the text and Unicode stages; three by asking whether a passing suite could have
passed for the wrong reason:

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

6. The per-page block of `compareStructure` was unreachable behind an early
   return, so annotations, link targets and page geometry were never compared.
7. `parseCMap` handled `bfrange` correctly only for the array form; the scalar
   form silently clobbered the entry before it.
8. The code-space fingerprint omitted `codespacerange`, so two documents with an
   identical mapping table under different code spaces compared **equal**.
9. `extractTextOps` recorded no active font, so a page whose `/F1` switched
   mid-stream produced one signature for two different glyph sets.
10. `fontCMapsForPage` looked for `/Font` in the page dictionary only. Real
    producers put `/Resources` behind a reference — one real document does this on
    all 10 pages, so **no** CMap was found and every page decoded to nothing. Zero
    decoded characters compare equal to zero decoded characters, so the Unicode
    suite passed on a document where extraction was completely broken.
11. `verify-file-unicode` paired pages by array position against a *filtered*
    list, so it compared page 20 against page 1 and reported three pages changed
    where nothing had.
12. **`parseObjects` lost 80 of 197 objects on a real document.** It searched
    forward for the next `<<` to find each object's dictionary, so any object
    whose body is a bare string or array made it swallow everything up to the next
    dictionary — including all 16 `/ToUnicode` maps. That document decoded **0 of
    10** pages. Three further faults sat in the same function: braces inside string
    literals were counted, one malformed object made it abandon the rest of the
    file, and the `endstream` fallback took the first match — which lands inside a
    compressed payload routinely.
13. **An inflate with no ceiling could take the tab down.** Flate expands by
    ~1032:1 and `makeZip().inflate` decompressed to completion before any check
    could run, so the whole decoded payload was allocated first. Measured through
    the real pipeline on a document QPDF accepted: a 100 KB stream decoded to
    100 MB and added 156 MB of heap. Scaling that, a 10 MB PDF asks for ~10 GB —
    an allocation failure, not a catchable error, so no candidate validation ever
    ran. Now capped at 128 MB per stream and **skipped rather than truncated**:
    a truncated JPEG prefix is a corrupt file, which is the one outcome that must
    never be produced.

Defects 12 and 13 were found by asking what happens when an input is *hostile*
rather than merely unusual. Both had been invisible to every suite, because
every fixture was either valid or rejected by QPDF before the tool ran.

The last three are the pattern that matters, and they share one root cause. The
corpus did not represent the documents:

| Form | In the 40 fixtures | In that real document |
| --- | --- | --- |
| bare string objects | 0 | 32 |
| bare array objects | 0 | 32 |
| indirect `/Resources` | 0 | 10 |
| `/Contents` as an array | 0 | 10 |

Zero occurrences. Those paths were not under-tested — they were **unreachable**,
and a user's file was the first thing to walk them. Two of the four forms came
from a *second* real document, which is why stage 16 measures the corpus instead
of trusting it.

The same stage turned up three checks that could have passed while measuring
nothing: a negative control built on `JSON.stringify(Map)`, which is always
`{}`; a lone-surrogate assertion that iterated code points and so flagged
correctly recombined pairs; and a completeness check run on QPDF-flattened text,
where **flattening deletes bare string and array objects before the parser sees
them** — so it passed on the very fixture built to test it. Each was caught by
running it and asking whether it could fail.

## 2. Immediate roadmap

| Priority | Stage | Work to do | Status |
| --- | --- | --- | --- |
| **P0** | **Output determinism** | Prove reproducibility and explain any difference | **Done** — deterministic, no fix needed |
| P1 | Commit the text-layer stage | Review and commit verified work | **Done** (`d6011db`) |
| P2 | Performance profiling | Measure before optimising | **Done** — bottleneck found and addressed |
| P3 | `verify:file` command | One command running structural, text and visual checks | Written — **not yet run** |
| P4 | Deploy stages 10–11 | The resize change reaches users only on deploy | **Done** — CI deploys on push |
| P5 | Repository secrets | `deploy.yml` cannot deploy without them, so every push fails at publish | **Done** — both configured |
| P6 | Deployment published nothing | The site was returning 404 for every path | **Done** — see below |
| P7 | Stale-codec hypothesis | Explain a download that differs from every fresh run | **Closed** — disproved; see P0 |

### P0 — resolved, and how

Two runs of the live site on identical input differed in exactly **32 bytes**,
0.0021 %, all of it the second element of the trailer `/ID`. The first element,
every object, every stream, every image payload and the text layer were
byte-identical. ISO 32000-1 §14.4 defines that element to change when a file is
modified, so this is conformant behaviour.

**The compressor is deterministic. No fix was required and none was made.**

An earlier download of the same document was 1,533,838 B while fresh runs
produced 1,534,266 B. The hypothesis was a browser tab open across a deploy,
holding a lazily-cached codec chunk. **That hypothesis is now dead**, disproved
by the local-vs-live comparison below: all 33 image payloads are byte-identical
after inflate, so the two runtimes ran the same codec, not different builds.

### The deployment that published nothing

Worth recording in full, because the failure mode was invisible by construction.

The workflow built in one job and deployed in another, shipping the site through
`actions/upload-pages-artifact`. That artifact contains a top-level `build/`
entry, so downloading it into `build/` produced `build/build/…`. Wrangler was
pointed at `build/`, uploaded a single directory, and **reported success**:

```
manual deploy    Uploaded 6 files (22 already uploaded)
CI deploy        Uploaded 1 files
```

Every deploy replaced the working site with one containing no site, and the live
domain returned 404 for every path.

What made this hard to see: the CDN kept serving cached copies of the last good
deployment, so every remote check returned `cf-cache-status: HIT` and reported a
healthy site. The 404s only became visible once the cache aged out, two days
later. A long detour followed into a **non-existent** missing-`_headers`
problem — preview branches, Cache Rules, wrangler output names, `noindex` — all
of it inferred from cached responses of a site that was already down. The
headers were never wrong.

Two guards now exist because of this, and both assert on outcomes rather than on
command exit codes:

- **Check the build output is a complete site** — requires `build/index.html` and
  a plausible file and asset count, before anything is published. Wrangler
  exiting zero says nothing about whether it uploaded a site.
- **Verify the live site serves** — fetches the production domain after
  deploying and fails unless it returns 200.

The workflow also became a single job, so `build/` is on disk where it was
produced and there is no artifact round trip left to get wrong.

The general lesson, recorded because it recurred: **when every check returns a
cached response, the checks are measuring nothing.** Verify that the thing you
are measuring is live before drawing conclusions from it.

### Local harness versus the live site

Comparing a local `verify:file` run with a `verify-live-file` run of the same
32-page document exposed a standing difference:

```
local (Node, zlib level 9)          1,437,194 B
live  (browser, CompressionStream) 1,440,496 B    +3,302 B
```

Fully accounted for:

| | |
| --- | --- |
| 33 image streams — identical JPEGs, weaker deflate | +3,310 B |
| XRef stream — contains the differing `/ID` | −8 B |

Every image inflates to a **byte-identical** JPEG on both sides, so the codec
agrees exactly. The size difference is the container: Node uses
`zlib.deflateSync(level: 9)`, while the browser's `CompressionStream('deflate')`
exposes no level control. Re-deflating the same JPEG both ways reproduces the
observed per-object deltas (for example 38,773 B locally against 38,937 B
through `CompressionStream`, an observed +164 B).

Two consequences worth stating plainly:

- The suites run on Node, so they measure the **smaller** of the two outputs. A
  browser user gets roughly 0.23 % more bytes from identical pixels.
- This is a platform limitation, not a defect. `CompressionStream` offers no
  level parameter, so the browser cannot be brought to parity without a WASM
  deflate implementation.

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
| P6 | PDF feature preservation | Links, bookmarks, forms, annotations, page geometry, font references, metadata, attachments | **Done** — stages 13 and 14 |
| P7 | Encoding and Unicode coverage | `/ToUnicode` mappings, font encoding, text extraction — separate from raw-byte preservation | **Done** — `d8cdbfb` |
| P8 | Malformed-input hardening | Truncated PDFs, invalid references, unusual streams, resource exhaustion, failure recovery | Fail safely, never return corrupted output |
| P8b | Corpus realism | Fixtures derived from real documents, so parser paths are reachable rather than absent | **Done** — `test:parser-realism` |
| P9 | Memory and performance optimisation | Remaining redundancy and buffer use, guided by measured cost | Faster without destabilising candidate selection |
| P10 | Browser compatibility | Upload, WASM loading, progress, cancellation, download across supported browsers | **In progress** — 3 engines green; no version floor, no mobile, Safari unverified |
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