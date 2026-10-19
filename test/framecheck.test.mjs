import { strict as assert } from 'node:assert';
import { coherence, rankByFrame, thumbnail } from '../src/core/frameCheck.js';
import { probeYUV } from '../src/core/probe.js';

// a smooth synthetic picture (gradient + a bright box), 8 and 16 bit, 640x360 4:2:0
const W = 640, H = 360;
function picture(bits) {
  const bps = bits > 8 ? 2 : 1, max = (1 << bits) - 1;
  const buf = new Uint8Array(W * H * 1.5 * bps * 2);              // two frames
  for (let f = 0; f < 2; f++) for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
    let v = (x / W * 0.5 + y / H * 0.4) * max;
    if (x > 200 && x < 400 && y > 100 && y < 250) v = 0.9 * max;
    v = Math.round(v);
    const i = f * W * H * 1.5 + y * W + x;
    if (bps === 2) { buf[2 * i] = v & 255; buf[2 * i + 1] = v >> 8; } else buf[i] = v;
  }
  return buf;
}
const noise = new Uint8Array(W * H * 3); let seed = 1;
for (let i = 0; i < noise.length; i++) { seed = (seed * 1664525 + 1013904223) >>> 0; noise[i] = seed >>> 24; }

for (const bits of [8, 16]) {
  const b = picture(bits);
  const right = coherence(b, W, H, bits), badW = coherence(b, W + 6, H, bits);
  assert.ok(right < 0.1, `picture at its own geometry is coherent (${bits}b q=${right})`);
  assert.ok(badW > right * 3, `wrong width is worse (${badW} vs ${right})`);
}
assert.ok(coherence(picture(16), W, H, 8) > 0.5, '16-bit data read as 8-bit interleaves bytes');
assert.ok(coherence(noise, W, H, 8) > 0.9, 'noise is q~1');
assert.equal(coherence(new Uint8Array(10), W, H, 8), null, 'short buffer');

// ranking: the same bytes are 1 frame of 16-bit or 2 of 8-bit; the picture decides
const b16 = picture(16).subarray(0, W * H * 3);                   // exactly one 16-bit frame
const c = rankByFrame(probeYUV(b16.length, { name: 'x.yuv' }).filter(x => x.width === W && x.height === H), b16);
assert.equal(c[0].bitDepth, 16, 'ranked 16-bit first');

const t = thumbnail(picture(8), W, H, 8);
assert.equal(t.width, 160); assert.equal(t.height, 90);
assert.equal(t.pixels.length, 160 * 90 * 3);
assert.equal(t.colour, false, 'flat chroma (the synthetic picture has none) is grey');
// a colour frame: left half red-ish chroma (Cr high), right half blue-ish (Cb high)
const cw = 64, ch = 48, col = new Uint8Array(cw * ch * 1.5).fill(128);
col.fill(120, 0, cw * ch);
for (let y = 0; y < ch / 2; y++) for (let x = 0; x < cw / 2; x++) {
  col[cw * ch + y * (cw / 2) + x] = x < cw / 4 ? 100 : 200;                // Cb
  col[cw * ch + (cw / 2) * (ch / 2) + y * (cw / 2) + x] = x < cw / 4 ? 220 : 90;   // Cr
}
const tc = thumbnail(col, cw, ch, 8, '4:2:0');
assert.equal(tc.colour, true);
const px = (x) => [0, 1, 2].map(k => tc.pixels[3 * (10 * tc.width + x) + k]);
assert.ok(px(5)[0] > px(5)[2], 'left side is reddish');
assert.ok(px(cw - 5)[2] > px(cw - 5)[0], 'right side is bluish');
console.log('framecheck: PASS');
