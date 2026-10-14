/**
 * Generate realistic PDF fixtures containing genuine encoded images.
 *
 * The engine's behaviour depends entirely on how images are stored, so the
 * fixtures must use real encodings - not synthetic noise. Real JPEG and PNG
 * bytes are produced in Chromium (canvas encoders) and then embedded into
 * hand-built PDFs:
 *
 *   - DCTDecode  = the raw JPEG file, verbatim (what every scanner/phone makes)
 *   - FlateDecode+SMask = lossless RGB plus a separate alpha channel
 *
 * Everything is deterministic: the same seed always draws the same picture.
 *
 * Run: bun scripts/generate/make-fixtures.mjs
 */
import { chromium } from 'playwright';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import zlib from 'node:zlib';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const outDir = path.join(here, '..', 'fixtures');

/* ── PDF assembly ──────────────────────────────────────────────────────── */

function buildPdf(objects, header = '%PDF-1.5') {
	const chunks = [];
	let pos = 0;
	const offsets = [];
	const enc = (s) => Buffer.from(s, 'latin1');

	const push = (buf) => {
		const b = Buffer.isBuffer(buf) ? buf : enc(buf);
		chunks.push(b);
		pos += b.length;
	};

	push(header + '\n%\xE2\xE3\xCF\xD3\n');

	objects.forEach((o, i) => {
		offsets.push(pos);
		if (o.stream === undefined) {
			push(`${i + 1} 0 obj\n${o.dict}\nendobj\n`);
		} else {
			const body = Buffer.isBuffer(o.stream) ? o.stream : enc(o.stream);
			let dict = o.dict;
			dict = /\/Length\s+\d+/.test(dict)
				? dict.replace(/\/Length\s+\d+/, `/Length ${body.length}`)
				: dict.replace(/\s*>>\s*$/, ` /Length ${body.length} >>`);
			push(`${i + 1} 0 obj\n${dict}\nstream\n`);
			push(body);
			push('\nendstream\nendobj\n');
		}
	});

	const xrefPos = pos;
	const n = objects.length + 1;
	let xref = `xref\n0 ${n}\n0000000000 65535 f \n`;
	for (const o of offsets) xref += `${String(o).padStart(10, '0')} 00000 n \n`;
	push(xref);
	push(`trailer\n<< /Size ${n} /Root 1 0 R >>\nstartxref\n${xrefPos}\n%%EOF\n`);

	return Buffer.concat(chunks);
}

/** PDF whose pages each contain one DISTINCT image XObject. */
function imagePdf({ images, colorspace, bpc, smask, w, h, filter = '/DCTDecode' }) {
	const pages = images.length;
	const objs = [
		{ dict: '<< /Type /Catalog /Pages 2 0 R >>' },
		{
			dict:
				`<< /Type /Pages /Kids [${Array.from({ length: pages }, (_, p) => `${3 + p * 2} 0 R`).join(' ')}] /Count ${pages} >>`
		}
	];
	for (let p = 0; p < pages; p++) {
		const contentObj = 4 + p * 2;
		const imgObj = 3 + pages * 2 + p;
		objs.push({
			dict:
				`<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] ` +
				`/Resources << /XObject << /Im0 ${imgObj} 0 R >> >> /Contents ${contentObj} 0 R >>`
		});
		objs.push({ dict: '<< >>', stream: `q ${w} 0 0 ${h} 0 0 cm /Im0 Do Q\n` });
	}
	// One image object per page - real documents do not share one stream.
	images.forEach((img, p) => {
		objs.push({
			dict:
				`<< /Type /XObject /Subtype /Image /Width ${w} /Height ${h} ` +
				`/ColorSpace ${colorspace} /BitsPerComponent ${bpc} /Filter ${filter}` +
				`${smask ? ` /SMask ${3 + pages * 2 + pages + p} 0 R` : ''} >>`,
			stream: img
		});
	});
	if (smask) images.forEach((_, p) => objs.push({ dict: '<< >>', stream: smask[p] }));
	return buildPdf(objs);
}

/* ── image generation in Chromium ──────────────────────────────────────── */

const browser = await chromium.launch({ channel: 'chromium' });
const page = await browser.newPage();
await page.goto('about:blank');

/**
 * Draw a deterministic picture and return the encoded bytes.
 * kind: 'photo' (smooth + gradients), 'scan' (grainy, high freq), 'graphic'
 */
async function makeImage({ kind, w, h, format, quality, alpha = false }) {
	const b64 = await page.evaluate(
		async ({ kind, w, h, format, quality, alpha }) => {
			const c = document.createElement('canvas');
			c.width = w;
			c.height = h;
			const ctx = c.getContext('2d');

			let seed = 0x2545f491;
			const rnd = () => {
				seed ^= seed << 13; seed >>>= 0;
				seed ^= seed >> 17;
				seed ^= seed << 5; seed >>>= 0;
				return seed / 4294967296;
			};

			if (kind === 'scan') {
				// Off-white paper, dark text-like blocks, sensor grain.
				ctx.fillStyle = '#f4f2ec';
				ctx.fillRect(0, 0, w, h);
				ctx.fillStyle = '#15120d';
				const rows = Math.floor(h / 26);
				for (let r = 0; r < rows; r++) {
					const y = 14 + r * 26;
					let x = 60;
					while (x < w - 60) {
						const wordW = 40 + rnd() * 150;
						if (rnd() > 0.25) ctx.fillRect(x, y, wordW, 12);
						x += wordW + 14 + rnd() * 20;
					}
				}
			} else if (kind === 'graphic') {
				ctx.fillStyle = '#ffffff';
				ctx.fillRect(0, 0, w, h);
				for (let i = 0; i < 40; i++) {
					ctx.fillStyle = `hsl(${(i * 9) % 360} 70% 50% / ${0.15 + rnd() * 0.5})`;
					ctx.fillRect(rnd() * w, rnd() * h, 40 + rnd() * 260, 40 + rnd() * 260);
				}
			} else {
				// Photograph-ish: sky gradient, terrain, fine texture.
				const g = ctx.createLinearGradient(0, 0, 0, h);
				g.addColorStop(0, '#4a7fb5');
				g.addColorStop(0.55, '#9fc4e0');
				g.addColorStop(0.56, '#3f6b3a');
				g.addColorStop(1, '#1d3320');
				ctx.fillStyle = g;
				ctx.fillRect(0, 0, w, h);
				for (let i = 0; i < 900; i++) {
					ctx.fillStyle = `rgba(255,255,255,${rnd() * 0.08})`;
					ctx.fillRect(rnd() * w, rnd() * h, 2 + rnd() * 5, 2 + rnd() * 5);
				}
			}

			if (alpha) {
				// Punch a soft alpha hole so the SMask is genuinely needed.
				const m = ctx.createRadialGradient(w / 2, h / 2, 10, w / 2, h / 2, Math.min(w, h) / 2);
				m.addColorStop(0, 'rgba(0,0,0,1)');
				m.addColorStop(0.75, 'rgba(0,0,0,0.35)');
				m.addColorStop(1, 'rgba(0,0,0,0)');
				ctx.globalCompositeOperation = 'destination-out';
				ctx.fillStyle = m;
				ctx.fillRect(0, 0, w, h);
				ctx.globalCompositeOperation = 'source-over';
			}

			const blob = await new Promise((r) => c.toBlob(r, format, quality));
			const buf = new Uint8Array(await blob.arrayBuffer());
			let s = '';
			for (let i = 0; i < buf.length; i++) s += String.fromCharCode(buf[i]);
			return btoa(s);
		},
		{ kind, w, h, format, quality, alpha }
	);
	return Buffer.from(b64, 'base64');
}

/** Raw RGBA pixels, for building FlateDecode + SMask images. */
async function rawRGBA({ kind, w, h, alpha }) {
	const b64 = await page.evaluate(
		({ kind, w, h, alpha }) => {
			const c = document.createElement('canvas');
			c.width = w; c.height = h;
			const ctx = c.getContext('2d');
			let seed = 0x2545f491;
			const rnd = () => {
				seed ^= seed << 13; seed >>>= 0;
				seed ^= seed >> 17;
				seed ^= seed << 5; seed >>>= 0;
				return seed / 4294967296;
			};
			const g = ctx.createLinearGradient(0, 0, 0, h);
			g.addColorStop(0, '#4a7fb5'); g.addColorStop(0.55, '#9fc4e0');
			g.addColorStop(0.56, '#3f6b3a'); g.addColorStop(1, '#1d3320');
			ctx.fillStyle = g; ctx.fillRect(0, 0, w, h);
			for (let i = 0; i < 900; i++) {
				ctx.fillStyle = `rgba(255,255,255,${rnd() * 0.08})`;
				ctx.fillRect(rnd() * w, rnd() * h, 2 + rnd() * 5, 2 + rnd() * 5);
			}
			if (alpha) {
				const m = ctx.createRadialGradient(w / 2, h / 2, 10, w / 2, h / 2, Math.min(w, h) / 2);
				m.addColorStop(0, 'rgba(0,0,0,1)');
				m.addColorStop(0.75, 'rgba(0,0,0,0.35)');
				m.addColorStop(1, 'rgba(0,0,0,0)');
				ctx.globalCompositeOperation = 'destination-out';
				ctx.fillStyle = m; ctx.fillRect(0, 0, w, h);
				ctx.globalCompositeOperation = 'source-over';
			}
			const d = ctx.getImageData(0, 0, w, h).data;
			let s = '';
			const CH = 8192;
			for (let i = 0; i < d.length; i += CH) {
				s += String.fromCharCode.apply(null, Array.from(d.subarray(i, i + CH)));
			}
			return btoa(s);
		},
		{ kind, w, h, alpha }
	);
	return Buffer.from(b64, 'base64');
}

const save = async (name, buf) => {
	await writeFile(path.join(outDir, name), buf);
	console.log(
		`  ${name.padEnd(34)} ${String(buf.length).padStart(9)} B`
	);
};

await mkdir(outDir, { recursive: true });
console.log('\nGenerating fixtures into', outDir, '\n');

/* JPEG / DCTDecode ------------------------------------------------------- */
// Each page gets its own distinct image, as in a real document.
const jpegs = async (kind, w, h, q, n) =>
	Promise.all(
		Array.from({ length: n }, () => makeImage({ kind, w, h, format: 'image/jpeg', quality: q }))
	);

await save(
	'photo-q90.pdf',
	imagePdf({ images: await jpegs('photo', 1240, 1754, 0.9, 1), colorspace: '/DeviceRGB', bpc: 8, w: 1240, h: 1754 })
);
await save(
	'photo-q35.pdf',
	imagePdf({ images: await jpegs('photo', 1240, 1754, 0.35, 1), colorspace: '/DeviceRGB', bpc: 8, w: 1240, h: 1754 })
);
await save(
	'scan-300dpi-q80.pdf',
	imagePdf({ images: await jpegs('scan', 2480, 3508, 0.8, 3), colorspace: '/DeviceRGB', bpc: 8, w: 1240, h: 1754 })
);
await save(
	'graphic-q75.pdf',
	imagePdf({ images: await jpegs('graphic', 900, 700, 0.75, 2), colorspace: '/DeviceRGB', bpc: 8, w: 700, h: 540 })
);

/* FlateDecode (lossless) ------------------------------------------------- */
{
	const { w, h } = { w: 900, h: 700 };
	for (let p = 0; p < 2; p++) {
		const rgba = await rawRGBA({ kind: 'photo', w, h, alpha: false });
		const dst = Buffer.alloc(w * h * 3);
		for (let i = 0, j = 0; i < rgba.length; i += 4, j += 3) {
			dst[j] = rgba[i]; dst[j + 1] = rgba[i + 1]; dst[j + 2] = rgba[i + 2];
		}
		await save(
			`photo-flate-p${p}.pdf`,
			imagePdf({
				images: [zlib.deflateSync(dst, { level: 9 })],
				filter: '/FlateDecode',
				colorspace: '/DeviceRGB',
				bpc: 8,
				w,
				h
			})
		);
	}
}

/* FlateDecode + SMask (alpha / transparency) ------------------------------ */
{
	const { w, h } = { w: 700, h: 700 };
	const rgbas = [];
	const alphas = [];
	for (let p = 0; p < 2; p++) {
		const rgba = await rawRGBA({ kind: 'graphic', w, h, alpha: true });
		const rgb = Buffer.alloc(w * h * 3);
		const alpha = Buffer.alloc(w * h);
		for (let i = 0, j = 0, k = 0; i < rgba.length; i += 4, j += 3, k += 1) {
			rgb[j] = rgba[i]; rgb[j + 1] = rgba[i + 1]; rgb[j + 2] = rgba[i + 2];
			alpha[k] = rgba[i + 3];
		}
		rgbas.push(zlib.deflateSync(rgb, { level: 9 }));
		alphas.push(zlib.deflateSync(alpha, { level: 9 }));
	}
	await save(
		'alpha-smask.pdf',
		imagePdf({
			images: rgbas,
			smask: alphas,
			filter: '/FlateDecode',
			colorspace: '/DeviceRGB',
			bpc: 8,
			w,
			h
		})
	);
}

/* Oversized image: 600 DPI raster for a small logical area ---------------- */
await save(
	'oversized-600dpi.pdf',
	imagePdf({
		images: await jpegs('scan', 2480, 3508, 0.95, 1),
		colorspace: '/DeviceRGB',
		bpc: 8,
		w: 2480,
		h: 3508
	})
);

await browser.close();
console.log('\nDone.\n');