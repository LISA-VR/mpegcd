// First-frame plausibility: does a candidate geometry produce a picture?
//
// A raw YUV has no header, so width / bit depth are inferred. VMAF and friends
// need a reference image, which a lone frame does not have; instead we use a
// no-reference spatial-coherence statistic on the luma plane of frame 0.
//
//   q = ( mean|Y[r][c] - Y[r+1][c]|  +  mean|Y[r][c] - Y[r][c+1]| ) / 2  /  (1.128 * sd(Y))
//
// 1.128*sd is the expected neighbour difference of uncorrelated (white) samples,
// so q ~ 1 for noise and q << 1 for an image. A wrong width makes the vertical
// neighbour a different image row (q rises); reading 16-bit data as 8-bit (or
// the reverse) interleaves high and low bytes (q rises). Pure functions.

const MAX_ROWS = 192;                 // rows sampled; keeps this O(1 MB) whatever the size
const THUMB_W = 160;

function reader(buf, bits) {
  return bits > 8 ? (i => buf[2 * i] | (buf[2 * i + 1] << 8)) : (i => buf[i]);
}

/** Coherence q of the luma plane of the first frame, or null if the buffer is too short / degenerate. */
export function coherence(buf, w, h, bits) {
  if (w < 2 || h < 2 || buf.length < w * h * (bits > 8 ? 2 : 1)) return null;
  const get = reader(buf, bits);
  const rows = Math.min(h - 1, MAX_ROWS);
  let n = 0, s = 0, ss = 0, sv = 0, sh = 0;
  for (let k = 0; k < rows; k++) {
    const r = Math.floor((k * (h - 1)) / rows);
    const a0 = r * w, b0 = (r + 1) * w;
    for (let c = 0; c < w - 1; c++) {
      const a = get(a0 + c);
      s += a; ss += a * a; n++;
      sh += Math.abs(a - get(a0 + c + 1));
      sv += Math.abs(a - get(b0 + c));
    }
  }
  const mean = s / n;
  const sd = Math.sqrt(Math.max(0, ss / n - mean * mean));
  if (sd < 0.5) return 0;               // flat frame: nothing to judge, do not penalise
  return (sv / n + sh / n) / 2 / (1.128 * sd);
}

/** Largest luma sample over the sampled rows of frame 0 (to bound the bit depth). */
export function maxSample(buf, w, h, bits) {
  const bps = bits > 8 ? 2 : 1;
  if (w < 1 || h < 1 || buf.length < w * h * bps) return null;
  const get = reader(buf, bits);
  const rows = Math.min(h, MAX_ROWS);
  let m = 0;
  for (let k = 0; k < rows; k++) {
    const r = Math.floor((k * h) / rows);
    for (let c = 0; c < w; c++) { const v = get(r * w + c); if (v > m) m = v; }
  }
  return m;
}

/**
 * Temporal counterpart: mean |Y0 - Y1| between frame 0 and frame 1, normalised
 * like coherence(). With the right frame height frame 1 starts where it should
 * and the two frames agree; with a wrong height it starts mid-picture (q ~ 1).
 * This is what tells 640x360 from 640x480, which have the same row stride.
 */
export function temporal(buf, w, h, bits, off) {
  const bps = bits > 8 ? 2 : 1;
  if (w < 2 || h < 2 || buf.length < off + w * h * bps) return null;
  const get = reader(buf, bits);
  const base = off / bps;
  const rows = Math.min(h, MAX_ROWS);
  let n = 0, s = 0, ss = 0, sd01 = 0;
  for (let k = 0; k < rows; k++) {
    const r = Math.floor((k * h) / rows);
    for (let c = 0; c < w; c++) {
      const a = get(r * w + c);
      s += a; ss += a * a; n++;
      sd01 += Math.abs(a - get(base + r * w + c));
    }
  }
  const mean = s / n;
  const sd = Math.sqrt(Math.max(0, ss / n - mean * mean));
  if (sd < 0.5) return 0;
  return sd01 / n / (1.128 * sd);
}

/**
 * Re-rank candidate geometries by how picture-like the first frame(s) are under
 * each: q = coherence of frame 0, and for multi-frame candidates the worse of
 * that and the frame-0/frame-1 agreement. Only candidates clearly worse than the
 * best one are demoted (0.15 of slack), so the prior (standard size, 8-bit,
 * 4:2:0 ...) still decides between equally good ones; e.g. an 8-bit frame
 * and the same bytes read as gray12 look alike, and the prior prefers the former.
 */
export function rankByFrame(cands, buf, top = 400) {
  const cache = new Map();
  let best = Infinity;
  for (const c of cands.slice(0, top)) {
    const key = `${c.width}x${c.height}x${c.bitDepth}x${c.frames > 1 ? c.perFrameBytes : 0}`;
    if (!cache.has(key)) {
      const q = coherence(buf, c.width, c.height, c.bitDepth);
      const t = q != null && c.frames > 1 ? temporal(buf, c.width, c.height, c.bitDepth, c.perFrameBytes) : null;
      cache.set(key, q == null ? null : Math.max(q, t ?? 0));
    }
    // a >8-bit candidate is impossible if its samples do not fit, and 10-bit
    // data stored in 16 bits is told from true 16-bit by the largest value seen
    if (c.bitDepth > 8 && c.q !== null) {
      const mk = `m${c.width}x${c.height}`;
      if (!cache.has(mk)) cache.set(mk, maxSample(buf, c.width, c.height, 16));
    }
    c.q = cache.get(key);
    if (c.q != null) best = Math.min(best, c.q);
  }
  for (const c of cands.slice(0, top)) {
    if (c.q == null) continue;
    c.score -= 2000 * Math.max(0, c.q - best - 0.15) + 400 * (c.q - best);   // clear losers out, near-ties by coherence
    const mx = c.bitDepth > 8 ? cache.get(`m${c.width}x${c.height}`) : null;
    if (mx != null) {
      const need = mx > 0 ? Math.floor(Math.log2(mx)) + 1 : 1;
      if (need > c.bitDepth) c.score -= 5000;                              // samples do not fit
      else if (c.bitDepth === [10, 12, 14, 16].find(b => b >= Math.max(need, 9))) c.score += 25;   // tightest standard depth
    }
  }
  return cands.sort((x, y) => y.score - x.score);
}

/**
 * Thumbnail of frame 0: {width, height, pixels} with 3 bytes (R,G,B) per pixel, or null.
 * Content with colour (a texture) is converted from YCbCr (BT.709 for HD and
 * above, BT.601 below; limited range) at its natural levels. Content whose
 * chroma is flat (a depth map, 4:0:0) is shown as grey with the luma
 * contrast-stretched, since its useful range is rarely the full one.
 */
export function thumbnail(buf, w, h, bits, sub = '4:2:0') {
  const bps = bits > 8 ? 2 : 1;
  const chromaW = sub === '4:4:4' ? w : sub === '4:0:0' ? 0 : w >> 1;
  const chromaH = sub === '4:2:0' ? h >> 1 : sub === '4:0:0' ? 0 : h;
  const need = (w * h + 2 * chromaW * chromaH) * bps;
  const hasChroma = chromaW > 0 && buf.length >= need;
  if (w < 2 || h < 2 || buf.length < w * h * bps) return null;
  const get = reader(buf, bits);
  const tw = Math.min(THUMB_W, w), th = Math.max(1, Math.round((h * tw) / w));
  const sh = bits - 8;
  const Y = new Float32Array(tw * th), U = new Float32Array(tw * th), V = new Float32Array(tw * th);
  for (let y = 0; y < th; y++) {
    const sy = Math.min(h - 1, Math.floor(((y + 0.5) * h) / th));
    for (let x = 0; x < tw; x++) {
      const sx = Math.min(w - 1, Math.floor(((x + 0.5) * w) / tw));
      const i = y * tw + x;
      Y[i] = get(sy * w + sx);
      if (hasChroma) {
        const ci = (sy * chromaH / h | 0) * chromaW + (sx * chromaW / w | 0);
        U[i] = get(w * h + ci) / (1 << sh);
        V[i] = get(w * h + chromaW * chromaH + ci) / (1 << sh);
      }
    }
  }
  // does the chroma carry anything? (spread around its own mean, in 8-bit levels)
  let colour = false;
  if (hasChroma) {
    for (const P of [U, V]) {
      let m = 0, q = 0;
      for (let i = 0; i < P.length; i++) m += P[i];
      m /= P.length;
      for (let i = 0; i < P.length; i++) q += (P[i] - m) * (P[i] - m);
      if (Math.sqrt(q / P.length) > 3) colour = true;
    }
  }
  const pixels = new Uint8Array(tw * th * 3);
  const clamp = (v) => (v < 0 ? 0 : v > 255 ? 255 : v);
  if (colour) {
    const [kr, kb] = w >= 1280 || h >= 720 ? [0.2126, 0.0722] : [0.299, 0.114];   // BT.709 / BT.601
    const kg = 1 - kr - kb;
    for (let i = 0; i < Y.length; i++) {
      const y = (Y[i] / (1 << sh) - 16) * (255 / 219);
      const cb = (U[i] - 128) * (255 / 224), cr = (V[i] - 128) * (255 / 224);
      const r = y + 2 * (1 - kr) * cr, b = y + 2 * (1 - kb) * cb;
      const g = (y - kr * r - kb * b) / kg;
      pixels[3 * i] = clamp(r); pixels[3 * i + 1] = clamp(g); pixels[3 * i + 2] = clamp(b);
    }
  } else {
    const sorted = Float32Array.from(Y).sort();
    const lo = sorted[Math.floor(sorted.length * 0.01)], hi = sorted[Math.floor(sorted.length * 0.99)];
    const span = Math.max(1, hi - lo);
    for (let i = 0; i < Y.length; i++) {
      const g = clamp(((Y[i] - lo) * 255) / span);
      pixels[3 * i] = pixels[3 * i + 1] = pixels[3 * i + 2] = g;
    }
  }
  return { width: tw, height: th, pixels, colour };
}
