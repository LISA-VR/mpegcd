// Auto-detect a raw YUV stream's geometry by *sweeping* the file.
//
// A raw YUV file is just W*H*(plane factor)*bytesPerSample-per-frame of raw
// pixels, with no header. Given the total byte count, the valid geometries are
// the (W, H, subsampling, bitDepth) tuples whose per-frame byte count divides
// the total. We enumerate candidates, score them, and let the user override.
//
// The strongest real-world prior (and the user's own example): MPEG depth /
// luma / chroma clips. The filenames in this project's data already encode the
// geometry (DERS_z0300y0325x0404.yuv == 300 frames, 325 rows, 404 cols), so we
// also parse that convention as a first guess.

const SUBSAMP_PLANES = {
  // planes-per-pixel factor for planar layouts (Y + chroma)
  '4:4:4': 3,
  '4:2:2': 2.5,
  '4:2:0': 1.5,
  '4:0:0': 1,
};

// bit depths YUView / ffmpeg support for planar YUV
const BIT_DEPTHS = [8, 10, 12, 14, 16];

// Parse the DERS/Kinect-style zNNNNyNNNNxNNNN geometry out of a filename.
// Returns {frames,width,height} or null.
export function parseFilenameGeometry(fileName) {
  // match z0300y0325x0404 (zero-padded or plain), in any order
  const z = /z(\d{2,5})/i.exec(fileName);
  const y = /y(\d{2,5})/i.exec(fileName);
  const x = /x(\d{2,5})/i.exec(fileName);
  if (z && y && x) {
    return { frames: +z[1], height: +y[1], width: +x[1] };
  }
  return null;
}

// Sizes seen in MPEG / JVET / video test material.
const STD_SIZES = [
  [1920, 1080], [3840, 2160], [1280, 720], [2560, 1440], [4096, 2160], [2048, 1080], [3712, 2064],
  [640, 360], [1024, 768], [832, 480], [640, 480], [416, 240], [352, 288], [176, 144], [1080, 1920], [960, 540],
  [1600, 900], [1920, 1088], [7680, 4320], [512, 512], [1024, 1024], [2048, 2048], [720, 576], [720, 480],
];

// Push every (subsampling, bit depth) that makes `size` a whole number of w x h frames.
function addSizeCands(cands, size, w, h, source, hint) {
  const depthy = hint && hint.name && /depth|ders|disp|z[-_]?map/i.test(hint.name);
  for (const sub of Object.keys(SUBSAMP_PLANES)) {
    for (const bits of BIT_DEPTHS) {
      const perFrame = w * h * SUBSAMP_PLANES[sub] * (bits > 8 ? 2 : 1);
      if (perFrame <= 0 || size % perFrame !== 0) continue;
      const frames = size / perFrame;
      if (frames < 1 || frames > 1000000) continue;
      const score =
        (source === 'standard' ? 1000 : 0) +
        (bits === 8 ? 30 : 0) +
        (bits === 12 || bits === 14 ? -15 : 0) +    // rare in practice
        (depthy && bits === 16 ? 45 : 0) +          // depth maps are 16-bit in MPEG material
        (sub === '4:2:0' ? 12 : sub === '4:0:0' ? 8 : 0) +
        (w >= h ? 0.5 : 0) +
        (source === 'sweep' ? Math.min(frames, 1000) * 0.01 + ((w % 16 === 0 && h % 16 === 0) ? 5 : 0) : -Math.log2(frames) * 0.5);
      cands.push({ width: w, height: h, subsampling: sub, bitDepth: bits, frames, planar: true, perFrameBytes: perFrame, score, source });
    }
  }
}

/**
 * Enumerate candidate YUV geometries for a file of `size` bytes.
 *
 * @param {number} size total file bytes
 * @param {{frames?:number, width?:number, height?:number}} [hint]
 *   optional geometry from the filename (strong prior).
 * @returns {Array<{
 *   width:number, height:number, subsampling:string, bitDepth:number,
 *   frames:number, planar:boolean, perFrameBytes:number,
 *   score:number, source:'filename'|'sweep'
 * }>
 */
export function probeYUV(size, hint) {
  const cands = [];

  // 1) Filename hint first — if it is internally consistent, it wins.
  if (hint && hint.width && hint.height) {
    for (const sub of Object.keys(SUBSAMP_PLANES)) {
      for (const bits of BIT_DEPTHS) {
        const bytesPerSample = bits > 8 ? 2 : 1;   // 9..16-bit samples are stored in 16 bits
        const perFrame = Math.round(hint.width * hint.height * SUBSAMP_PLANES[sub] * bytesPerSample);
        if (perFrame > 0 && size % perFrame === 0) {
          const frames = size / perFrame;
          // Prefer the candidate whose frame count matches the filename's z.
          const score =
            (hint.frames && frames === hint.frames ? 10000 : 0) +
            (hint.subsampling === sub ? 5000 : 0) +   // format spelled in a YUView-style name
            (hint.bitDepth === bits ? 5000 : 0) +
            (bits === 8 ? 30 : 0) +            // 8-bit is most common
            (sub === '4:0:0' ? 20 : 0) +       // depth maps are often 4:0:0
            (sub === '4:2:0' ? 10 : 0) +
            -Math.abs(frames - (hint.frames || 0)) * 0.001;
          cands.push({
            width: hint.width, height: hint.height, subsampling: sub,
            bitDepth: bits, frames, planar: true, perFrameBytes: perFrame,
            score, source: 'filename',
          });
        }
      }
    }
  }

  // 2) Standard video / MPEG test-sequence sizes first: a file that fits one of
  //    them (any format) is almost certainly that, and the generic sweep below
  //    does not even reach sizes like 1920x1080.
  if (cands.length === 0) {
    for (const [w, h] of STD_SIZES) addSizeCands(cands, size, w, h, 'standard', hint);
  }

  // 3) General sweep over a bounded width/height space (for anything else).
  if (cands.length === 0) {
    const W = 3840, H = 2160;
    for (let w = 64; w <= W; w += (w >= 512 ? 16 : 4)) {
      if (w % 2 !== 0) continue;
      for (let h = 64; h <= H; h += (h >= 512 ? 16 : 4)) {
        if (h % 2 !== 0) continue;
        addSizeCands(cands, size, w, h, 'sweep', hint);
      }
    }
  }

  cands.sort((a, b) => b.score - a.score);
  return cands;
}

/**
 * Map a detected geometry to an ffmpeg rawvideo pixel format.
 * planar 4:0:0 -> gray8/10/12/14/16le
 * planar 4:2:0 -> yuv420p[<bits>le]
 * planar 4:2:2 -> yuv422p[<bits>le]
 * planar 4:4:4 -> yuv444p[<bits>le]
 */
export function toPixFmt(geo) {
  const bits = geo.bitDepth;
  const suf = bits === 8 ? '' : `${bits}le`;
  switch (geo.subsampling) {
    case '4:0:0': return `gray${suf || '8le'}`.replace('gray8le', 'gray8');
    case '4:2:0': return `yuv420p${suf}`;
    case '4:2:2': return `yuv422p${suf}`;
    case '4:4:4': return `yuv444p${suf}`;
    default: throw new Error('unsupported subsampling ' + geo.subsampling);
  }
}

// ffmpeg pix_fmt -> YUView pixel-format layout (for the name).
export function toYuvviewLayout(pixFmt) {
  if (pixFmt.startsWith('gray')) return { planar: true, subsampling: '4:0:0', planeOrder: 'YUV' };
  if (pixFmt.startsWith('yuv420p')) return { planar: true, subsampling: '4:2:0', planeOrder: 'YUV' };
  if (pixFmt.startsWith('yuv422p')) return { planar: true, subsampling: '4:2:2', planeOrder: 'YUV' };
  if (pixFmt.startsWith('yuv444p')) return { planar: true, subsampling: '4:4:4', planeOrder: 'YUV' };
  throw new Error('unsupported pix_fmt ' + pixFmt);
}

export function bitDepthFromPixFmt(pixFmt) {
  const m = /(\d+)le$/.exec(pixFmt);
  if (m) return +m[1];
  if (pixFmt.startsWith('gray8') || pixFmt === 'gray') return 8;
  return 8;
}
