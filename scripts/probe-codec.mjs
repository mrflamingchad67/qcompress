/** Verify the jSquash JPEG codec and resizer work, and that re-encoding shrinks. */
import { decode, encode } from '@jsquash/jpeg';
import resize from '@jsquash/resize';
import { chromium } from 'playwright';
import { fileURLToPath, pathToFileURL } from 'node:url';
import path from 'node:path';

const here = path.dirname(fileURLToPath(import.meta.url));

// Make a real JPEG with Chromium.
const browser = await chromium.launch({ channel: 'chromium' });
const page = await browser.newPage();
await page.goto('about:blank');
const b64 = await page.evaluate(async () => {
	const c = document.createElement('canvas');
	c.width = 1240; c.height = 1754;
	const ctx = c.getContext('2d');
	const g = ctx.createLinearGradient(0, 0, 0, 1754);
	g.addColorStop(0, '#4a7fb5'); g.addColorStop(0.55, '#9fc4e0');
	g.addColorStop(0.56, '#3f6b3a'); g.addColorStop(1, '#1d3320');
	ctx.fillStyle = g; ctx.fillRect(0, 0, 1240, 1754);
	let seed = 0x2545f491;
	const rnd = () => { seed ^= seed << 13; seed >>>= 0; seed ^= seed >> 17; seed ^= seed << 5; seed >>>= 0; return seed / 4294967296; };
	for (let i = 0; i < 900; i++) {
		ctx.fillStyle = `rgba(255,255,255,${rnd() * 0.08})`;
		ctx.fillRect(rnd() * 1240, rnd() * 1754, 2 + rnd() * 5, 2 + rnd() * 5);
	}
	const blob = await new Promise((r) => c.toBlob(r, 'image/jpeg', 0.9));
	const buf = new Uint8Array(await blob.arrayBuffer());
	let s = '';
	for (let i = 0; i < buf.length; i++) s += String.fromCharCode(buf[i]);
	return btoa(s);
});
await browser.close();

const jpeg = new Uint8Array(Buffer.from(b64, 'base64'));
const out = (...a) => process.stdout.write(a.join(' ') + '\n');

out(`\nOriginal JPEG           : ${jpeg.length} B  (1240x1754 q0.9)`);

const img = await decode(jpeg.buffer);
out(`Decoded                 : ${img.width}x${img.height} ${img.data.length} B RGBA`);

// encode() takes an options OBJECT and returns an ArrayBuffer.
const enc = async (image, quality) => {
	const buf = await encode(image, { quality });
	return new Uint8Array(buf);
};

// Re-encode at several qualities
for (const q of [90, 75, 50, 35]) {
	const e = await enc(img, q);
	out(`  re-encode q=${String(q).padEnd(4)}      : ${String(e.length).padStart(7)} B  (${(((jpeg.length - e.length) / jpeg.length) * 100).toFixed(1)}% vs original)`);
}

// Downscale then encode
for (const [w, dpi] of [[930, 150], [620, 100]]) {
	const r = await resize(img, { width: w, height: Math.round((img.height * w) / img.width) });
	const e = await enc(r, 75);
	out(`  ${String(dpi).padStart(3)}dpi + q75      : ${String(e.length).padStart(7)} B  (${(((jpeg.length - e.length) / jpeg.length) * 100).toFixed(1)}% vs original, ${r.width}x${r.height})`);
}

// Round-trip sanity: is the re-encode actually a decodable JPEG?
const check = await enc(img, 75);
out(`\n  re-encoded starts SOI : ${check[0] === 0xff && check[1] === 0xd8}`);
out(`  re-encoded ends EOI   : ${check[check.length - 2] === 0xff && check[check.length - 1] === 0xd9}`);
const round = await decode(check.buffer);
out(`  re-decodes to         : ${round.width}x${round.height}`);
out('\nCodec verified: decode -> resize -> encode all work in-process.\n');