/**
 * Integrity fixtures: the awkward documents.
 *
 * The original eight fixtures in `scripts/fixtures/` exercise the *savings*
 * path. These exercise everything else - the paths where the correct answer is
 * often "leave it alone", and the document features a compressor is most
 * likely to silently drop.
 *
 * Every fixture is small and generated locally. JPEGs come from jSquash under
 * Bun rather than Chromium's canvas encoder, so this corpus regenerates in a
 * fraction of a second with no browser involved.
 *
 * Object references are symbolic (`${link1}`), never hand-numbered. A fixture
 * with a dangling reference still parses, so the mistake is invisible until
 * something follows it - which is exactly the bug this stage exists to catch.
 *
 * Two fixtures carry an honesty caveat, documented in FIXTURES.md:
 *
 *   jpeg-cmyk-declared  The dictionary declares /DeviceCMYK but the payload is
 *                       three-component RGB data. This toolchain has no CMYK
 *                       JPEG encoder, so the fixture cannot be colour-accurate.
 *                       It tests exactly what needs testing - that the engine
 *                       *skips* a CMYK image and preserves its bytes - and it
 *                       doubles as a malformed-image case.
 *   jpeg-corrupt        A DCTDecode stream whose payload is deliberately
 *                       damaged, to exercise the rejection path.
 *
 * Run: bun scripts/generate/make-integrity-fixtures.mjs
 */
import { mkdir, writeFile } from 'node:fs/promises';
import zlib from 'node:zlib';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { encode } from '@jsquash/jpeg';
import { buildNamed } from '../lib/named-build.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const outDir = path.join(here, '..', 'fixtures');
const report = (...a) => process.stdout.write(a.join(' ') + '\n');
const assert = (cond, msg) => {
	if (!cond) throw new Error(msg);
};

/* ── deterministic pixel sources ──────────────────────────────────────────── */

/**
 * Small, reproducible pixel data. Each `kind` is a deliberate stress pattern,
 * chosen so a broken re-encode shows up as a specific symptom:
 *   flat      large uniform areas  -> banding / colour drift
 *   detail    1px checkerboard     -> high-frequency mush
 *   gradient  smooth ramp          -> banding at low quality
 *   random    noise                -> worst case for a compressor
 */
function pixels(kind, w, h, seed = 0x2545f491) {
	const data = new Uint8ClampedArray(w * h * 4);
	let s = seed >>> 0;
	const rnd = () => {
		s ^= s << 13; s >>>= 0;
		s ^= s >> 17;
		s ^= s << 5; s >>>= 0;
		return s / 4294967296;
	};

	for (let y = 0; y < h; y++) {
		for (let x = 0; x < w; x++) {
			const i = (y * w + x) * 4;
			let r, g, b;
			switch (kind) {
				case 'flat':
					r = 200; g = 40; b = 90;
					break;
				case 'detail':
					r = (x % 2) * 255;
					g = (y % 2) * 255;
					b = ((x + y) % 3) * 85;
					break;
				case 'gradient': {
					const t = x / w;
					r = Math.round(255 * t);
					g = Math.round(255 * (1 - t));
					b = Math.round(255 * ((x + y) / (w + h)));
					break;
				}
				default:
					r = rnd() * 255; g = rnd() * 255; b = rnd() * 255;
			}
			data[i] = r; data[i + 1] = g; data[i + 2] = b; data[i + 3] = 255;
		}
	}
	return { data, width: w, height: h };
}

/** Grayscale: jSquash emits a single-component JPEG. */
function grayPixels(w, h) {
	const src = pixels('gradient', w, h);
	const data = new Uint8ClampedArray(w * h * 4);
	for (let i = 0, j = 0; j < w * h; i += 4, j++) {
		const y = src.data[i], u = src.data[i + 1], v = src.data[i + 2];
		const g = Math.round(0.299 * y + 0.587 * u + 0.114 * v);
		data[j * 4] = g; data[j * 4 + 1] = g; data[j * 4 + 2] = g; data[j * 4 + 3] = 255;
	}
	return { data, width: w, height: h };
}

/** jSquash reads `data`, `width`, `height` off the object it is given. */
const jpeg = async ({ data, width, height }, quality) =>
	new Uint8Array(await encode({ data, width, height }, { quality }));

/* ── shared fragments ─────────────────────────────────────────────────────── */

const CONTENT = 'BT /F1 12 Tf 20 100 Td (Hello) Tj ET\n';
const FONT = '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>';

const imgDict = (w, h, cs = '/DeviceRGB', filter = '/DCTDecode', extra = '') =>
	`<< /Type /XObject /Subtype /Image /Width ${w} /Height ${h} /ColorSpace ${cs} ` +
	`/BitsPerComponent 8 /Filter ${filter}${extra} >>`;

/**
 * A document with N text pages plus arbitrary named extra objects.
 *
 * Extras are named so callers can reference them symbolically instead of
 * counting objects by hand.
 */
function doc({ pages = 1, mediaBox = '[0 0 612 792]', pageExtra = '', stream = CONTENT, extraObjects = [], catalogExtra = '', streamDict = '<< >>', info = null } = {}) {
	const items = [
		{ name: 'catalog', dict: `<< /Type /Catalog /Pages ${'${pages}'} 0 R${catalogExtra} >>` },
		{ name: 'pages', dict: `<< /Type /Pages /Kids [${Array.from({ length: pages }, (_, p) => `\${p${p}} 0 R`).join(' ')}] /Count ${pages} >>` },
		{ name: 'font', dict: FONT }
	];

	// Page and content objects, interleaved after the reserved slots. Names are
	// assigned by position, so build the list first to know the numbering.
	for (let p = 0; p < pages; p++) items.push({ name: `p${p}`, placeholder: true });
	for (let p = 0; p < pages; p++) items.push({ name: `c${p}`, placeholder: true });
	items.push(...extraObjects);

	// Now fill in the placeholders with real dictionaries.
	let cursor = 3;
	for (let p = 0; p < pages; p++) {
		items[cursor] = {
			name: `p${p}`,
			dict:
				`<< /Type /Page /Parent ${'${pages}'} 0 R /MediaBox ${mediaBox} ` +
				`/Resources << /Font << /F1 ${'${font}'} 0 R >> >> /Contents ${`\${c${p}}`} 0 R${pageExtra} >>`
		};
		cursor++;
	}
	for (let p = 0; p < pages; p++) {
		items[cursor] = { name: `c${p}`, dict: streamDict, stream };
		cursor++;
	}

	return buildNamed(items, { catalogName: 'catalog', info });
}

/** One page per image, each with its own XObject. */
const imageDoc = ({ images, w, h, mediaBox = '[0 0 612 792]', content = null }) => {
	const items = [
		{ name: 'catalog', dict: `<< /Type /Catalog /Pages \${pages} 0 R >>` },
		{
			name: 'pages',
			dict: `<< /Type /Pages /Kids [${images.map((_, i) => `\${p${i}} 0 R`).join(' ')}] /Count ${images.length} >>`
		}
	];
	for (let i = 0; i < images.length; i++) items.push({ name: `p${i}`, placeholder: true });
	for (let i = 0; i < images.length; i++) items.push({ name: `c${i}`, placeholder: true });
	items.push(...images.map((img, i) => ({ name: `img${i}`, dict: img.dict, stream: img.stream })));

	items.forEach((it, i) => {
		if (!it.placeholder) return;
		const idx = it.name.slice(1);
		items[i] = it.name[0] === 'p'
			? {
					name: it.name,
					dict:
						`<< /Type /Page /Parent \${pages} 0 R /MediaBox ${mediaBox} ` +
						`/Resources << /XObject << /Im0 \${img${idx}} 0 R >> >> /Contents \${c${idx}} 0 R >>`
				}
			: {
					name: it.name,
					dict: '<< >>',
					stream: content ?? `q ${w} 0 0 ${h} 20 20 cm /Im0 Do Q\n`
				};
	});

	return buildNamed(items, { catalogName: 'catalog' });
};

/* ── generation ───────────────────────────────────────────────────────────── */

await mkdir(outDir, { recursive: true });
report('\nGenerating integrity fixtures into', outDir, '\n');

const save = async (name, bytes) => {
	await writeFile(path.join(outDir, name), bytes);
	report(`  ${name.padEnd(38)} ${String(bytes.length).padStart(7)} B`);
};

/* Basic documents --------------------------------------------------------- */
await save('text-1page.pdf', doc({}));
await save('text-3page.pdf', doc({ pages: 3 }));
await save(
	'vector-shapes.pdf',
	doc({
		stream:
			'1 0 0 RG 0 0 1 rg 2 w\n' +
			'50 50 m 550 50 l S\n50 100 m 550 100 l S\n' +
			'100 150 200 120 re f\n300 150 150 150 re S\n' +
			'60 400 m 160 500 260 300 360 500 l S\n'
	})
);
await save(
	'mixed-page-sizes.pdf',
	buildNamed([
		{ name: 'catalog', dict: '<< /Type /Catalog /Pages ${pages} 0 R >>' },
		{ name: 'pages', dict: '<< /Type /Pages /Kids [${p0} 0 R ${p1} 0 R ${p2} 0 R] /Count 3 >>' },
		{ name: 'font', dict: FONT },
		{ name: 'p0', dict: '<< /Type /Page /Parent ${pages} 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 ${font} 0 R >> >> /Contents ${c0} 0 R >>' },
		{ name: 'c0', dict: '<< >>', stream: CONTENT },
		{ name: 'p1', dict: '<< /Type /Page /Parent ${pages} 0 R /MediaBox [0 0 842 595] /Resources << /Font << /F1 ${font} 0 R >> >> /Contents ${c1} 0 R >>' },
		{ name: 'c1', dict: '<< >>', stream: CONTENT },
		{ name: 'p2', dict: '<< /Type /Page /Parent ${pages} 0 R /MediaBox [0 0 400 400] /Resources << /Font << /F1 ${font} 0 R >> >> /Contents ${c2} 0 R >>' },
		{ name: 'c2', dict: '<< >>', stream: CONTENT }
	], { catalogName: 'catalog' })
);
await save('rotated-pages.pdf', doc({ pages: 2, pageExtra: ' /Rotate 90' }));
await save('cropbox.pdf', doc({ pageExtra: ' /CropBox [10 20 500 700]' }));

/* Document features ------------------------------------------------------- */
await save(
	'annotations.pdf',
	doc({
		pageExtra: ' /Annots [${link} 0 R ${note} 0 R ${square} 0 R]',
		extraObjects: [
			{
				name: 'link',
				dict:
					'<< /Type /Annot /Subtype /Link /Rect [40 700 240 720] /Border [0 0 0] ' +
					'/A << /Type /Action /S /URI /URI (https://example.org/docs) >> >>'
			},
			{
				name: 'note',
				dict:
					'<< /Type /Annot /Subtype /Text /Rect [300 700 324 724] ' +
					'/Contents (A sticky note) /T (Author) /Name /Note >>'
			},
			{ name: 'square', dict: '<< /Type /Annot /Subtype /Square /Rect [80 300 300 500] /C [1 0 0] >>' }
		]
	})
);
await save(
	'links.pdf',
	doc({
		pageExtra: ' /Annots [${linkA} 0 R ${linkB} 0 R]',
		extraObjects: [
			{ name: 'linkA', dict: '<< /Type /Annot /Subtype /Link /Rect [10 700 100 720] /A << /S /URI /URI (https://a.example) >> >>' },
			{ name: 'linkB', dict: '<< /Type /Annot /Subtype /Link /Rect [10 650 100 670] /A << /S /URI /URI (https://b.example) >> >>' }
		]
	})
);
await save(
	'outlines.pdf',
	doc({
		pages: 2,
		catalogExtra: ' /Outlines ${outlineRoot} 0 R /PageMode /UseOutlines',
		extraObjects: [
			{ name: 'outlineRoot', dict: '<< /Type /Outlines /First ${o1} 0 R /Last ${o2} 0 R /Count 2 >>' },
			{ name: 'o1', dict: '<< /Title (Chapter One) /Parent ${outlineRoot} 0 R /Next ${o2} 0 R /First ${o3} 0 R /Last ${o3} 0 R /Count 1 /Dest [${p0} 0 R /Fit] >>' },
			{ name: 'o2', dict: '<< /Title (Chapter Two) /Parent ${outlineRoot} 0 R /Prev ${o1} 0 R /Dest [${p1} 0 R /Fit] >>' },
			{ name: 'o3', dict: '<< /Title (Section 1.1) /Parent ${o1} 0 R /Dest [${p0} 0 R /Fit] >>' }
		]
	})
);
await save('metadata.pdf', doc({
	info:
		'<< /Title (Quarterly Report) /Author (mrflamingchad67) /Subject (Integrity fixture) ' +
		'/Keywords (pdf, fixture, metadata) /Producer (QCompress test suite) /Creator (make-integrity-fixtures) >>'
}));
await save('xmp-metadata.pdf', doc({
	catalogExtra: ' /Metadata ${xmp} 0 R',
	extraObjects: [
		{
			name: 'xmp',
			dict: '<< /Type /Metadata /Subtype /XML >>',
			stream:
				'<?xpacket begin="" id="W5M0MpCehiHzreSzNTczkc9d"?>' +
				'<x:xmpmeta xmlns:x="adobe:ns:meta/"><rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#">' +
				'<rdf:Description dc:title="Fixture" xmlns:dc="http://purl.org/dc/elements/1.1/"/>' +
				'</rdf:RDF></x:xmpmeta><?xpacket end="w"?>'
		}
	]
}));
await save('acroform.pdf', doc({
	catalogExtra: ' /AcroForm << /Fields [${nameField} 0 R ${checkBox} 0 R] /DA (/Helv 0 Tf 0 g) >>',
	pageExtra: ' /Annots [${nameField} 0 R ${checkBox} 0 R]',
	extraObjects: [
		{
			name: 'nameField',
			dict:
				'<< /Type /Annot /Subtype /Widget /FT /Tx /T (fullName) /V (Ada Lovelace) ' +
				'/Rect [40 600 300 630] /DA (/Helv 12 Tf 0 g) /F 4 >>'
		},
		{
			name: 'checkBox',
			dict:
				'<< /Type /Annot /Subtype /Widget /FT /Btn /T (subscribe) /V /Off /AS /Off ' +
				'/Rect [40 550 70 580] /MK << /CA (4) >> /F 4 >>'
		}
	]
}));
await save(
	'transparency.pdf',
	doc({
		pageExtra: ' /Resources << /Font << /F1 ${font} 0 R >> /ExtGState << /GS1 ${gs} 0 R >> >>',
		stream: 'q /GS1 gs 1 0 0 rg 100 400 200 200 re f Q\n0.2 0.4 0.9 rg 200 350 200 200 re f\n',
		extraObjects: [{ name: 'gs', dict: '<< /Type /ExtGState /ca 0.35 /CA 0.35 >>' }]
	})
);

/* Image-focused ----------------------------------------------------------- */
const rgbSmall = await jpeg(pixels('gradient', 64, 48), 80);
const rgbDetail = await jpeg(pixels('detail', 64, 64), 80);
const rgbFlat = await jpeg(pixels('flat', 64, 64), 80);
const rgbNoise = await jpeg(pixels('random', 320, 240), 85);
const graySmall = await jpeg(grayPixels(64, 48), 80);
const tinyJpeg = await jpeg(pixels('flat', 12, 10), 80);

await save('jpeg-rgb.pdf', imageDoc({ images: [{ dict: imgDict(64, 48), stream: rgbSmall }], w: 200, h: 150 }));
await save('jpeg-gray.pdf', imageDoc({ images: [{ dict: imgDict(64, 48, '/DeviceGray'), stream: graySmall }], w: 200, h: 150 }));
await save('jpeg-flat.pdf', imageDoc({ images: [{ dict: imgDict(64, 64), stream: rgbFlat }], w: 200, h: 200 }));
await save('jpeg-thumbnail.pdf', imageDoc({ images: [{ dict: imgDict(12, 10), stream: tinyJpeg }], w: 12, h: 10 }));
await save('jpeg-large.pdf', imageDoc({ images: [{ dict: imgDict(320, 240), stream: rgbNoise }], w: 320, h: 240 }));

// Declared CMYK — see the file header for the colour-accuracy caveat.
await save('jpeg-cmyk-declared.pdf', imageDoc({ images: [{ dict: imgDict(64, 48, '/DeviceCMYK'), stream: rgbSmall }], w: 200, h: 150 }));

// BitsPerComponent 1: unsupported depth, must be skipped.
await save('jpeg-bpc1.pdf', imageDoc({
	images: [{ dict: imgDict(64, 48, '/DeviceGray').replace('/BitsPerComponent 8', '/BitsPerComponent 1'), stream: graySmall }],
	w: 200,
	h: 150
}));

// ICCBased with no /N at all: the component count cannot be determined, so the
// image cannot be shown to be RGB and MUST be skipped.
await save('jpeg-icc.pdf', buildNamed([
	{ name: 'catalog', dict: '<< /Type /Catalog /Pages ${pages} 0 R >>' },
	{ name: 'pages', dict: '<< /Type /Pages /Kids [${p0} 0 R] /Count 1 >>' },
	{ name: 'p0', dict: '<< /Type /Page /Parent ${pages} 0 R /MediaBox [0 0 612 792] /Resources << /XObject << /Im0 ${img} 0 R >> >> /Contents ${c0} 0 R >>' },
	{ name: 'c0', dict: '<< >>', stream: 'q 320 0 0 240 20 20 cm /Im0 Do Q\n' },
	{ name: 'img', dict: '<< /Type /XObject /Subtype /Image /Width 320 /Height 240 /ColorSpace [/ICCBased ${icc} 0 R] /BitsPerComponent 8 /Filter /DCTDecode >>', stream: rgbNoise },
	{ name: 'icc', dict: '<< /Alternate /DeviceRGB >>' }
], { catalogName: 'catalog' }));

// Corrupt DCTDecode payload: must be left alone, and must not crash anything.
const corrupt = new Uint8Array(rgbSmall);
for (let i = 40; i < Math.min(corrupt.length, 400); i++) corrupt[i] = (i * 37) & 0xff;
await save('jpeg-corrupt.pdf', imageDoc({ images: [{ dict: imgDict(64, 48), stream: corrupt }], w: 200, h: 150 }));

/* Wrapped and ICC-tagged encodings ----------------------------------------- */

/**
 * `/Filter [/FlateDecode /DCTDecode]`.
 *
 * Filters apply left to right when recovering samples, so what is stored is the
 * output of the *first* filter: a Flate-compressed JPEG, not a JPEG. Feeding
 * those bytes straight to a JPEG decoder fails on every image, which is how a
 * real 32-page document came to report "images unchanged" while 94% of its
 * bytes were images. Found by running the engine on a real file, not guessed.
 *
 * Uses a large, noisy source at high quality: a 64x48 thumbnail is already so
 * tightly compressed that re-encoding cannot beat it, and the fixture would
 * then pass for the wrong reason.
 */
await save(
	'jpeg-flate-wrapped.pdf',
	imageDoc({
		images: [
			{
				dict:
					'<< /Type /XObject /Subtype /Image /Width 320 /Height 240 /ColorSpace /DeviceRGB ' +
					'/BitsPerComponent 8 /DecodeParms [ null << /Quality 85 >> ] ' +
					'/Filter [ /FlateDecode /DCTDecode ] >>',
				stream: zlib.deflateSync(rgbNoise, { level: 6 })
			}
		],
		w: 320,
		h: 240
	})
);

/**
 * ICC-tagged RGB.
 *
 * `[/ICCBased n 0 R]` where the profile declares /N 3. The profile says how the
 * three components are *interpreted*, not what they are, so replacing the JPEG
 * leaves the profile exactly as valid as it was.
 */
const iccRgb = '<< /N 3 /Alternate /DeviceRGB /Range [0 1 0 1 0 1] >>';
await save('jpeg-icc-rgb.pdf', buildNamed([
	{ name: 'catalog', dict: '<< /Type /Catalog /Pages ${pages} 0 R >>' },
	{ name: 'pages', dict: '<< /Type /Pages /Kids [${p0} 0 R] /Count 1 >>' },
	{ name: 'p0', dict: '<< /Type /Page /Parent ${pages} 0 R /MediaBox [0 0 612 792] /Resources << /XObject << /Im0 ${img} 0 R >> >> /Contents ${c0} 0 R >>' },
	{ name: 'c0', dict: '<< >>', stream: 'q 320 0 0 240 20 20 cm /Im0 Do Q\n' },
	{ name: 'img', dict: '<< /Type /XObject /Subtype /Image /Width 320 /Height 240 /ColorSpace [/ICCBased ${icc} 0 R] /BitsPerComponent 8 /Filter /DCTDecode >>', stream: rgbNoise },
	{ name: 'icc', dict: iccRgb }
], { catalogName: 'catalog' }));

/**
 * ICC-tagged 4-component.
 *
 * The negative case for the rule above: /N 4 means the profile could describe
 * CMYK, where Adobe's APP14 inversion has to be reproduced exactly. Getting it
 * wrong silently swaps colours, so this must be skipped and left byte-identical.
 */
await save('jpeg-icc-cmyk.pdf', buildNamed([
	{ name: 'catalog', dict: '<< /Type /Catalog /Pages ${pages} 0 R >>' },
	{ name: 'pages', dict: '<< /Type /Pages /Kids [${p0} 0 R] /Count 1 >>' },
	{ name: 'p0', dict: '<< /Type /Page /Parent ${pages} 0 R /MediaBox [0 0 612 792] /Resources << /XObject << /Im0 ${img} 0 R >> >> /Contents ${c0} 0 R >>' },
	{ name: 'c0', dict: '<< >>', stream: 'q 320 0 0 240 20 20 cm /Im0 Do Q\n' },
	{ name: 'img', dict: '<< /Type /XObject /Subtype /Image /Width 320 /Height 240 /ColorSpace [/ICCBased ${icc} 0 R] /BitsPerComponent 8 /Filter /DCTDecode >>', stream: rgbNoise },
	{ name: 'icc', dict: '<< /N 4 >>' }
], { catalogName: 'catalog' }));

/* Deduplication cases ----------------------------------------------------- */
await save('shared-image.pdf', buildNamed([
	{ name: 'catalog', dict: '<< /Type /Catalog /Pages ${pages} 0 R >>' },
	{ name: 'pages', dict: '<< /Type /Pages /Kids [${p0} 0 R ${p1} 0 R] /Count 2 >>' },
	{ name: 'p0', dict: '<< /Type /Page /Parent ${pages} 0 R /MediaBox [0 0 612 792] /Resources << /XObject << /Im0 ${img} 0 R >> >> /Contents ${c0} 0 R >>' },
	{ name: 'p1', dict: '<< /Type /Page /Parent ${pages} 0 R /MediaBox [0 0 612 792] /Resources << /XObject << /Im0 ${img} 0 R >> >> /Contents ${c1} 0 R >>' },
	{ name: 'c0', dict: '<< >>', stream: 'q 200 0 0 150 20 20 cm /Im0 Do Q\n' },
	{ name: 'img', dict: imgDict(64, 48), stream: rgbSmall },
	{ name: 'c1', dict: '<< >>', stream: 'q 200 0 0 150 20 20 cm /Im0 Do Q\n' }
], { catalogName: 'catalog' }));

// Two images that are visually identical and *nearly* byte-identical: they
// differ only in a JPEG comment marker, which decoders ignore. They must NOT be
// deduplicated - the payload bytes differ, and the dedupe check is byte
// equality, not visual similarity.
//
// The difference is deliberately a valid comment segment rather than corrupted
// scan data. Damaging scan data instead would destroy a Huffman table, making
// the image undecodable, which would test the codec rather than the
// deduplication decision this fixture exists for.
let nearA = new Uint8Array(rgbSmall);
let nearB = new Uint8Array(rgbSmall);
{
	// Insert a JPEG COM segment carrying different text, immediately after the
	// 2-byte SOI marker. Comments are ignored by every decoder, so both images
	// render identically while their bytes genuinely differ.
	const ins = 2;
	const comA = Buffer.from([0xff, 0xfe, 0x00, 0x04, 0x41, 0x41, 0x41, 0x41]);
	const comB = Buffer.from([0xff, 0xfe, 0x00, 0x04, 0x42, 0x42, 0x42, 0x42]);
	const grow = (src, com) => {
		const out = new Uint8Array(src.length + com.length);
		out.set(src.subarray(0, ins), 0);
		out.set(com, ins);
		out.set(src.subarray(ins), ins + com.length);
		return out;
	};
	nearA = grow(nearA, comA);
	nearB = grow(nearB, comB);
	assert(nearA[0] === 0xff && nearA[1] === 0xd8, 'expected a JPEG SOI marker');
	assert(!nearA.every((v, i) => v === nearB[i]), 'the two images must actually differ');
}
await save('near-duplicate-images.pdf', buildNamed([
	{ name: 'catalog', dict: '<< /Type /Catalog /Pages ${pages} 0 R >>' },
	{ name: 'pages', dict: '<< /Type /Pages /Kids [${p0} 0 R ${p1} 0 R] /Count 2 >>' },
	{ name: 'p0', dict: '<< /Type /Page /Parent ${pages} 0 R /MediaBox [0 0 612 792] /Resources << /XObject << /Im0 ${imgA} 0 R >> >> /Contents ${c0} 0 R >>' },
	{ name: 'p1', dict: '<< /Type /Page /Parent ${pages} 0 R /MediaBox [0 0 612 792] /Resources << /XObject << /Im0 ${imgB} 0 R >> >> /Contents ${c1} 0 R >>' },
	{ name: 'c0', dict: '<< >>', stream: 'q 200 0 0 150 20 20 cm /Im0 Do Q\n' },
	{ name: 'imgA', dict: imgDict(64, 48), stream: nearA },
	{ name: 'imgB', dict: imgDict(64, 48), stream: nearB },
	{ name: 'c1', dict: '<< >>', stream: 'q 200 0 0 150 20 20 cm /Im0 Do Q\n' }
], { catalogName: 'catalog' }));

// THE HAZARD CASE: byte-identical content streams that draw DIFFERENT images,
// because each page's resource dictionary points at a different XObject.
// Deduplicating those content streams would silently corrupt page two.
await save('identical-content-diff-resources.pdf', buildNamed([
	{ name: 'catalog', dict: '<< /Type /Catalog /Pages ${pages} 0 R >>' },
	{ name: 'pages', dict: '<< /Type /Pages /Kids [${p0} 0 R ${p1} 0 R] /Count 2 >>' },
	{ name: 'p0', dict: '<< /Type /Page /Parent ${pages} 0 R /MediaBox [0 0 612 792] /Resources << /XObject << /Im0 ${imgA} 0 R >> >> /Contents ${c0} 0 R >>' },
	{ name: 'p1', dict: '<< /Type /Page /Parent ${pages} 0 R /MediaBox [0 0 612 792] /Resources << /XObject << /Im0 ${imgB} 0 R >> >> /Contents ${c1} 0 R >>' },
	{ name: 'c0', dict: '<< >>', stream: 'q 200 0 0 150 20 20 cm /Im0 Do Q\n' },
	{ name: 'imgA', dict: imgDict(64, 48), stream: rgbSmall },
	{ name: 'imgB', dict: imgDict(64, 64), stream: rgbDetail },
	// Byte-identical to ${c0}. Sharing it would be wrong.
	{ name: 'c1', dict: '<< >>', stream: 'q 200 0 0 150 20 20 cm /Im0 Do Q\n' }
], { catalogName: 'catalog' }));

await save('text-and-image.pdf', buildNamed([
	{ name: 'catalog', dict: '<< /Type /Catalog /Pages ${pages} 0 R >>' },
	{ name: 'pages', dict: '<< /Type /Pages /Kids [${p0} 0 R] /Count 1 >>' },
	{ name: 'p0', dict: '<< /Type /Page /Parent ${pages} 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 ${font} 0 R >> /XObject << /Im0 ${img} 0 R >> >> /Contents ${c0} 0 R >>' },
	{ name: 'c0', dict: '<< >>', stream: 'BT /F1 12 Tf 20 700 Td (Caption text) Tj ET\nq 200 0 0 150 20 300 cm /Im0 Do Q\n' },
	{ name: 'img', dict: imgDict(64, 48), stream: rgbSmall },
	{ name: 'font', dict: FONT }
], { catalogName: 'catalog' }));

await save('mixed-aspect-images.pdf', buildNamed([
	{ name: 'catalog', dict: '<< /Type /Catalog /Pages ${pages} 0 R >>' },
	{ name: 'pages', dict: '<< /Type /Pages /Kids [${p0} 0 R] /Count 1 >>' },
	{ name: 'p0', dict: '<< /Type /Page /Parent ${pages} 0 R /MediaBox [0 0 612 792] /Resources << /XObject << /Im0 ${imgA} 0 R /Im1 ${imgB} 0 R >> >> /Contents ${c0} 0 R >>' },
	{ name: 'c0', dict: '<< >>', stream: 'q 300 0 0 100 20 600 cm /Im0 Do Q\nq 100 0 0 300 20 200 cm /Im1 Do Q\n' },
	{ name: 'imgA', dict: imgDict(64, 48), stream: rgbSmall },
	{ name: 'imgB', dict: imgDict(64, 64), stream: rgbDetail }
], { catalogName: 'catalog' }));

/* Deliberately broken ----------------------------------------------------- */
await save('truncated.pdf', doc({ pages: 2 }).slice(0, Math.floor(doc({ pages: 2 }).length * 0.6)));
await save('not-a-pdf.pdf', Buffer.from('This is plainly not a PDF document.\n', 'latin1'));

report('\nIntegrity fixtures written.\n');
