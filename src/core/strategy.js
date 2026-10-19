// Lossless compression strategies: pure logic, no ffmpeg here (unit-testable).
//
// FFV1 is a good all-round lossless codec, but it is not the smallest for
// every kind of YUV. Measured on real MPEG data (dRVS ChocoFountain):
//
//   16-bit depth map : FFV1 x24.8  ->  hi/lo byte split + x264 lossless x58.9
//   10-bit texture   : FFV1 x6.3   ->  hi byte FFV1 + lo bits x264      x6.8
//
// (x265 lossless would win on some 8-bit depth maps, but the single-thread
// ffmpeg.wasm build deadlocks creating its thread pool, so it is not used.)
//
// So the compressor *tries* a few strategies on a sample of the frames and
// keeps the smallest. A strategy is either
//   direct : one stream, the file's own pix_fmt, one codec
//   split  : two 8-bit streams (high bits / low bits of every sample), each
//            with its own codec; they are muxed into one .mkv
// Decoding recombines the two streams exactly; the site then verifies the MD5.

// ffmpeg encoder argument sets. All are bit-exact lossless.
export const CODECS = {
  ffv1: {
    label: 'FFV1',
    // coder 2 + large context + long GOP: contexts keep learning across frames
    args: ['-c:v', 'ffv1', '-level', '3', '-coder', '2', '-context', '1', '-g', '1000'],
    maxBits: 16,
  },
  x264: {
    label: 'x264',
    args: ['-c:v', 'libx264', '-preset', 'slower', '-qp', '0'],
    maxBits: 8,
  },
};

/** Codecs able to carry `bits`-bit samples directly. */
export function codecsFor(bits) {
  return Object.keys(CODECS).filter(k => CODECS[k].maxBits >= bits);
}

/** The 8-bit twin of a pix_fmt: yuv420p10le -> yuv420p, gray16le -> gray. */
export function pixFmt8(pixFmt) {
  if (pixFmt.startsWith('gray')) return 'gray';
  const m = /^(yuv\d{3}p)/.exec(pixFmt);
  if (!m) throw new Error('unsupported pix_fmt ' + pixFmt);
  return m[1];
}

/** Bytes of one frame of the given planar layout. */
export function frameBytes(width, height, subsampling, bits) {
  const f = { '4:4:4': 3, '4:2:2': 2, '4:2:0': 1.5, '4:0:0': 1 }[subsampling];
  if (!f) throw new Error('unsupported subsampling ' + subsampling);
  return width * height * f * (bits > 8 ? 2 : 1);
}

/**
 * Split little-endian >8-bit samples into a high plane (v >> (bits-8)) and a
 * low plane (v & mask), both one byte per sample.
 * Returns null if a sample does not fit in `bits` bits (then the split would
 * not be reversible; callers fall back to a direct strategy).
 */
export function splitPlanes(yuv, bits) {
  const n = yuv.length >> 1;
  if (yuv.length & 1) return null;
  const sh = bits - 8;
  const mask = (1 << sh) - 1;
  const hi = new Uint8Array(n);
  const lo = new Uint8Array(n);
  let over = 0;
  for (let i = 0, j = 0; i < n; i++, j += 2) {
    const v = yuv[j] | (yuv[j + 1] << 8);
    over |= v >> bits;
    hi[i] = v >> sh;
    lo[i] = v & mask;
  }
  return over ? null : { hi, lo };
}

/** Inverse of splitPlanes. */
export function mergePlanes(hi, lo, bits) {
  const n = hi.length;
  const sh = bits - 8;
  const out = new Uint8Array(n * 2);
  for (let i = 0, j = 0; i < n; i++, j += 2) {
    const v = (hi[i] << sh) | lo[i];
    out[j] = v & 255;
    out[j + 1] = v >> 8;
  }
  return out;
}
