/**
 * What each fixture is, and what the engine is expected to do with it.
 *
 * This is a test fixture *and* the documentation of the corpus. Keeping the
 * expectations in one table means a new fixture cannot be added without
 * declaring whether it should be re-encoded, skipped, or rejected - which is
 * exactly the question the compression stage has to keep answering honestly.
 *
 * `valid: false` fixtures are not documents. They exist to prove that the
 * engine reports a clear error instead of a fake success.
 *
 * `jpeg`      - how many /DCTDecode images the fixture contains
 * `reencodable` - how many of those the lossy path is allowed to touch.
 *                Equal to `jpeg` only for 8-bit DeviceRGB/DeviceGray.
 */

export const FIXTURES = {
	/* ── the original savings corpus ─────────────────────────────────────── */
	'photo-q90.pdf': {
		category: 'image',
		notes: 'Single high-quality photo. Nothing to deduplicate, so Lossless has no move.',
		jpeg: 1, reencodable: 1, images: 1, pages: 1
	},
	'photo-q35.pdf': {
		category: 'image',
		notes: 'Single heavily-compressed photo. Re-encoding at a higher quality can still shrink it.',
		jpeg: 1, reencodable: 1, images: 1, pages: 1
	},
	'scan-300dpi-q80.pdf': {
		category: 'image',
		notes: 'Three pages carrying byte-identical scans. The canonical lossless win.',
		jpeg: 3, reencodable: 3, images: 3, pages: 3
	},
	'graphic-q75.pdf': {
		category: 'image',
		notes: 'Two identical graphics. Dedupe should collapse them.',
		jpeg: 2, reencodable: 2, images: 2, pages: 2
	},
	'oversized-600dpi.pdf': {
		category: 'image',
		notes: 'One very large photo. Lossless has nothing to do; lossy modes resize it.',
		jpeg: 1, reencodable: 1, images: 1, pages: 1
	},
	'photo-flate-p0.pdf': {
		category: 'image',
		notes: 'Flate image, not JPEG. The lossy path must never touch it, so there is no gain in any mode.',
		jpeg: 0, reencodable: 0, images: 1, pages: 1
	},
	'photo-flate-p1.pdf': {
		category: 'image',
		notes: 'Same as p0. Kept as the standing example of a correct zero-gain result.',
		jpeg: 0, reencodable: 0, images: 1, pages: 1
	},
	'alpha-smask.pdf': {
		category: 'image',
		notes: 'Flate image plus a soft mask. Transparency must survive every mode.',
		jpeg: 0, reencodable: 0, images: 2, pages: 2, smask: true
	},

	/* ── basic documents ─────────────────────────────────────────────────── */
	'text-1page.pdf': { category: 'basic', notes: 'Minimal text document.', jpeg: 0, reencodable: 0, images: 0, pages: 1 },
	'text-3page.pdf': { category: 'basic', notes: 'Page count and order must survive.', jpeg: 0, reencodable: 0, images: 0, pages: 3 },
	'vector-shapes.pdf': { category: 'basic', notes: 'Path drawing only. Guards against anything rasterising content.', jpeg: 0, reencodable: 0, images: 0, pages: 1 },
	'mixed-page-sizes.pdf': { category: 'basic', notes: 'Portrait, landscape and square pages in one document.', jpeg: 0, reencodable: 0, images: 0, pages: 3, mediaBoxes: [[0, 0, 612, 792], [0, 0, 842, 595], [0, 0, 400, 400]] },
	'rotated-pages.pdf': { category: 'basic', notes: '/Rotate must be preserved exactly.', jpeg: 0, reencodable: 0, images: 0, pages: 2, rotate: 90 },
	'cropbox.pdf': { category: 'basic', notes: 'CropBox differs from MediaBox.', jpeg: 0, reencodable: 0, images: 0, pages: 1, cropBox: [10, 20, 500, 700] },

	/* ── document features ───────────────────────────────────────────────── */
	'annotations.pdf': {
		category: 'feature',
		notes: 'Link + Text + Square annotations. Count, subtypes and the link target must survive.',
		jpeg: 0, reencodable: 0, images: 0, pages: 1,
		annotSubtypes: ['Link', 'Text', 'Square'], linkUris: ['https://example.org/docs']
	},
	'links.pdf': {
		category: 'feature',
		notes: 'Two link annotations: proves order and multiplicity are kept, not just presence.',
		jpeg: 0, reencodable: 0, images: 0, pages: 1,
		annotSubtypes: ['Link', 'Link'], linkUris: ['https://a.example', 'https://b.example']
	},
	'outlines.pdf': {
		category: 'feature',
		notes: 'Two-level bookmark tree. Titles and order must survive.',
		jpeg: 0, reencodable: 0, images: 0, pages: 2,
		outlines: true, outlineTitles: ['Chapter One', 'Section 1.1', 'Chapter Two']
	},
	'metadata.pdf': { category: 'feature', notes: '/Info dictionary present.', jpeg: 0, reencodable: 0, images: 0, pages: 1, info: true },
	'xmp-metadata.pdf': { category: 'feature', notes: 'XMP /Metadata stream present.', jpeg: 0, reencodable: 0, images: 0, pages: 1, metadata: true },
	'acroform.pdf': {
		category: 'feature',
		notes: 'AcroForm with a text field and a checkbox.',
		jpeg: 0, reencodable: 0, images: 0, pages: 1,
		acroform: true, formFields: ['fullName', 'subscribe']
	},
	'transparency.pdf': {
		category: 'feature',
		notes: 'ExtGState alpha. No images involved, so no mode may change what is drawn.',
		jpeg: 0, reencodable: 0, images: 0, pages: 1
	},

	/* Composite fonts ------------------------------------------------------- *
	 * The corpus previously had NO fixture with a Type0 font, so the whole
	 * Unicode layer was untestable: the text suite compares font-encoded bytes,
	 * which for these fonts are CIDs that mean nothing without the /ToUnicode
	 * CMap. These carry real mappings in both CMap forms.
	 */
	'type0-bfchar.pdf': {
		category: 'feature',
		notes: 'Type0 /Identity-H with a /ToUnicode CMap in bfchar form. Two pages.',
		jpeg: 0, reencodable: 0, images: 0, pages: 2,
		toUnicode: 1, cmapMappings: 15
	},
	'type0-bfrange.pdf': {
		category: 'feature',
		notes: 'Type0 /Identity-H whose CMap mixes scalar and array bfrange forms.',
		jpeg: 0, reencodable: 0, images: 0, pages: 1,
		toUnicode: 1, cmapMappings: 15
	},
	'type0-compressed-cmap.pdf': {
		category: 'feature',
		notes: 'Flate-wrapped /ToUnicode with a surrogate-pair target. Decodes to Α Ж 😀 é.',
		jpeg: 0, reencodable: 0, images: 0, pages: 1,
		toUnicode: 1, cmapMappings: 4, compressedCMap: true
	},

	/* Structural forms -------------------------------------------------------- *
	 * Measured across the 40 fixtures that existed before this section: bare
	 * string objects 0, bare array objects 0, indirect /Resources 0, /Contents
	 * arrays 0. Real documents have all four, and the gap is why parseObjects
	 * could drop 80 of 197 objects on a real file with no test failing.
	 */
	'struct-bare-objects.pdf': {
		category: 'structure',
		notes: 'Contains bare string and bare array objects: bodies with no dictionary.',
		jpeg: 0, reencodable: 0, images: 0, pages: 1,
		bareObjects: true
	},
	'struct-indirect-resources.pdf': {
		category: 'structure',
		notes: '/Resources by reference, and /Contents as an array of streams.',
		jpeg: 0, reencodable: 0, images: 0, pages: 1,
		indirectResources: true, contentsArray: true
	},

	/* ── image-focused ───────────────────────────────────────────────────── */
	'jpeg-rgb.pdf': { category: 'image', notes: 'Plain DeviceRGB DCTDecode.', jpeg: 1, reencodable: 1, images: 1, pages: 1 },
	'jpeg-gray.pdf': { category: 'image', notes: 'DeviceGray DCTDecode - eligible, single component.', jpeg: 1, reencodable: 1, images: 1, pages: 1 },
	'jpeg-flat.pdf': { category: 'image', notes: 'Large flat areas: catches banding and colour drift.', jpeg: 1, reencodable: 1, images: 1, pages: 1 },
	'jpeg-thumbnail.pdf': { category: 'image', notes: '12x10 thumbnail, already efficient.', jpeg: 1, reencodable: 1, images: 1, pages: 1 },
	'jpeg-large.pdf': {
		category: 'image',
		notes: '320x240 noise: worst case for a re-encode.',
		hostile: true,
		jpeg: 1, reencodable: 1, images: 1, pages: 1
	},
	'jpeg-cmyk-declared.pdf': {
		category: 'image',
		notes: 'CMYK-declared image. MUST be skipped and its bytes preserved. See FIXTURES.md: the payload is RGB data because this toolchain has no CMYK encoder, so this proves the skip, not colour fidelity.',
		jpeg: 1, reencodable: 0, images: 1, pages: 1
	},
	'jpeg-bpc1.pdf': {
		category: 'image',
		notes: 'BitsPerComponent 1. MUST be skipped and its bytes preserved.',
		jpeg: 1, reencodable: 0, images: 1, pages: 1
	},
	'jpeg-icc.pdf': {
		category: 'image',
		notes: 'ICCBased colour space whose profile declares no /N, so the component count cannot be determined. MUST be skipped.',
		jpeg: 1, reencodable: 0, images: 1, pages: 1
	},
	'jpeg-flate-wrapped.pdf': {
		category: 'image',
		hostile: true,
		notes: '/Filter [/FlateDecode /DCTDecode] plus a nested /DecodeParms dict. The stored bytes are a Flate-compressed JPEG, and the nested dict breaks any backwards search for the image dictionary. Both are real-world shapes; this fixture is why the engine records the dict offset at discovery and unwraps the payload before decoding.',
		jpeg: 1, reencodable: 1, images: 1, pages: 1
	},
	'jpeg-icc-rgb.pdf': {
		category: 'image',
		hostile: true,
		notes: 'ICCBased profile with /N 3 and /Alternate /DeviceRGB: the samples are RGB, so re-encoding is safe and the profile stays valid.',
		jpeg: 1, reencodable: 1, images: 1, pages: 1
	},
	'jpeg-icc-cmyk.pdf': {
		category: 'image',
		notes: 'ICCBased profile with /N 4: possibly CMYK, where Adobe APP14 inversion must be reproduced exactly. MUST be skipped and left byte-identical.',
		jpeg: 1, reencodable: 0, images: 1, pages: 1
	},
	'jpeg-corrupt.pdf': {
		category: 'invalid', valid: false,
		notes: 'DCTDecode payload with a destroyed quantisation table. `qpdf --check` rejects it, which is itself a finding worth keeping: this QPDF build decodes JPEG streams during --check, so corrupt image data cannot pass candidate validation. The engine must therefore report failure, never a successful compression.',
		jpeg: 1, reencodable: 0, images: 0, pages: 0
	},

	/* ── deduplication ───────────────────────────────────────────────────── */
	'shared-image.pdf': {
		category: 'dedupe',
		notes: 'Two pages referencing ONE shared image object. Nothing to collapse, but nothing may break.',
		jpeg: 1, reencodable: 1, images: 1, pages: 2
	},
	'near-duplicate-images.pdf': {
		category: 'dedupe',
		notes: 'Two images that render identically and differ only inside a JPEG comment segment. MUST NOT be deduplicated: the dedupe check is byte equality, not visual similarity.',
		jpeg: 2, reencodable: 2, images: 2, pages: 2, dedupeable: false
	},
	'identical-content-diff-resources.pdf': {
		category: 'dedupe',
		hostile: true,
		notes: 'Byte-identical content streams drawing DIFFERENT images via per-page resources. Deduplicating them would silently corrupt page 2.',
		jpeg: 2, reencodable: 2, images: 2, pages: 2, dedupeable: false
	},
	'text-and-image.pdf': { category: 'image', notes: 'Text and an image on one page.', jpeg: 1, reencodable: 1, images: 1, pages: 1 },
	'mixed-aspect-images.pdf': {
		category: 'image',
		notes: 'Two images, different resolutions and aspect ratios. One is a 1px checkerboard, which no JPEG encoder can preserve.',
		hostile: true,
		jpeg: 2, reencodable: 2, images: 2, pages: 1
	},

	/* ── deliberately broken ──────────────────────────────────────────────── */
	'truncated.pdf': {
		category: 'invalid', valid: false,
		notes: 'A valid document cut off at 60%. Must produce a clear error, never a fake success.',
		jpeg: 0, reencodable: 0, images: 0, pages: 0
	},
	'not-a-pdf.pdf': {
		category: 'invalid', valid: false,
		notes: 'Plain text. Must be rejected before any strategy runs.',
		jpeg: 0, reencodable: 0, images: 0, pages: 0
	}
};

/** Fixtures that are real documents, in a stable order. */
export const VALID_NAMES = Object.entries(FIXTURES)
	.filter(([, f]) => f.valid !== false)
	.map(([n]) => n)
	.sort();

export const INVALID_NAMES = Object.entries(FIXTURES)
	.filter(([, f]) => f.valid === false)
	.map(([n]) => n)
	.sort();