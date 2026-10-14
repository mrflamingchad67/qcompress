# Test fixture corpus

37 PDFs under `scripts/fixtures/`. All are generated locally and committed, so
the suites run identically everywhere and never touch a network.

Regenerate with:

```bash
bun run fixtures    # make-fixtures.mjs, then make-integrity-fixtures.mjs
```

`scripts/lib/fixture-manifest.mjs` is the **single source of truth** for what
each fixture is and what the engine is expected to do with it. A new fixture
cannot be added without declaring whether it should be re-encoded, skipped, or
rejected — which is the question the engine has to keep answering honestly.

## The two generators

| Script | Needs | Produces |
| --- | --- | --- |
| `generate/make-fixtures.mjs` | Chromium (canvas encoders) | The 8 original savings fixtures |
| `generate/make-integrity-fixtures.mjs` | Bun only (jSquash) | The 29 integrity fixtures |

The integrity fixtures deliberately avoid Chromium so they regenerate in a
fraction of a second with no browser involved.

## Categories

### Savings corpus (8)

Realistic documents with genuine JPEG/PNG bytes, the ones the headline
benchmark numbers are measured against.

| Fixture | What it is |
| --- | --- |
| `photo-q90.pdf` | Single high-quality photo. Nothing to deduplicate, so Lossless has no move. |
| `photo-q35.pdf` | Heavily-compressed photo. |
| `scan-300dpi-q80.pdf` | Three pages carrying byte-identical scans — the canonical lossless win. |
| `graphic-q75.pdf` | Two identical graphics. |
| `oversized-600dpi.pdf` | One very large photo (2480×3508). |
| `photo-flate-p0.pdf`, `photo-flate-p1.pdf` | Flate image, not JPEG. **No gain in any mode is the correct answer.** |
| `alpha-smask.pdf` | Flate image plus a soft mask; transparency must survive. |

### Basic documents (6)

`text-1page`, `text-3page`, `vector-shapes`, `mixed-page-sizes` (portrait +
landscape + square), `rotated-pages` (`/Rotate 90` and `270`), `cropbox`
(CropBox ≠ MediaBox).

### Document features (7)

`annotations` (Link + Text + Square), `links` (two links — proves order and
multiplicity, not just presence), `outlines` (two-level bookmark tree),
`metadata` (`/Info`), `xmp-metadata` (XMP stream), `acroform` (text field +
checkbox), `transparency` (ExtGState alpha, no images).

### Image encodings (11)

| Fixture | Expected |
| --- | --- |
| `jpeg-rgb`, `jpeg-gray`, `jpeg-flat`, `jpeg-large` | Re-encodable |
| `jpeg-thumbnail` | 12×10, already efficient — often no gain, which is fine |
| `jpeg-flate-wrapped` | **Re-encodable** — see below |
| `jpeg-icc-rgb` | **Re-encodable** — see below |
| `jpeg-cmyk-declared` | Skipped: CMYK |
| `jpeg-bpc1` | Skipped: not 8-bit |
| `jpeg-icc` | Skipped: ICC profile with no `/N` |
| `jpeg-icc-cmyk` | Skipped: `/N 4` could be CMYK |

### Deduplication (4)

`shared-image` (two pages, one image), `near-duplicate-images` (visually
identical, differ only in a JPEG comment — must **not** be merged),
`identical-content-diff-resources` (byte-identical content streams drawing
*different* images — the dangerous case), `mixed-aspect-images`.

### Deliberately invalid (3)

`truncated.pdf`, `not-a-pdf.pdf`, `jpeg-corrupt.pdf`. These must produce a
clear error or an unchanged original, **never** a claimed saving. The benchmark
flags them as `!! INVALID` and excludes them from the totals.

## Two fixtures that earned their keep

Both were found by running the engine on a real 32-page document, not by
guessing. See README § "Real-document bugs".

**`jpeg-flate-wrapped`** — `/Filter [/FlateDecode /DCTDecode]`. Filters apply
left to right when recovering samples, so what is stored is the output of the
*first* filter: a **Flate-compressed JPEG**, not a JPEG. The engine used to
hand those bytes straight to the JPEG decoder, which failed on every image.
It also carries a nested `/DecodeParms [ null << /Quality 60 >> ]`, which broke
the backwards search for the image dictionary.

**`jpeg-icc-rgb`** — `/ColorSpace [/ICCBased n 0 R]` where the profile declares
`/N 3`. The policy accepted only the literal names `DeviceRGB`/`DeviceGray`, so
ICC-tagged RGB was excluded — 31 of 34 images in that real document.
`jpeg-icc-cmyk` is the negative case that must stay excluded.

## Two caveats worth stating plainly

**`jpeg-cmyk-declared.pdf`** declares `/ColorSpace /DeviceCMYK` but carries
three-component RGB data. This toolchain has no CMYK JPEG encoder, so the
fixture cannot be colour-accurate. It tests exactly what needs testing — that
the engine *skips* a CMYK image and preserves its bytes — and it doubles as a
malformed-image case. It is **not** evidence about CMYK colour fidelity.

**`jpeg-corrupt.pdf`** has a destroyed quantisation table. `qpdf --check` decodes
DCTDecode streams, so it rejects the file outright. That is itself a useful
finding: corrupt image data cannot pass candidate validation.

## Content that fights JPEG

Fixtures marked `hostile: true` in the manifest contain noise or a 1px
checkerboard. No JPEG encoder preserves either — a checkerboard simply *is*
high-frequency detail. The fidelity suite holds those to a much looser bound,
documented in `scripts/test/test-fidelity.mjs`.