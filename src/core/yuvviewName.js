// YUView naming convention (github.com/IENT/YUView).
//
// YUView identifies a raw YUV file by a *format string* of the form:
//
//     <width>;<height>;YUV;<pixelformat>
//
// where <pixelformat> is the exact string YUView's PixelFormatYUV::getName()
// emits. We reproduce that grammar here so the names we generate round-trip
// into YUView verbatim (it reads the string back with setFormatFromString,
// which splits on ';' and requires exactly 4 fields, field[2] === "YUV").
//
// PixelFormatYUV::getName() (videoHandlerYUV.cpp / PixelFormatYUV.cpp):
//   planar  -> "<PlaneOrder> [<IL>]<sub> <bits>-bit[ <BE|LE>]"
//              e.g. "YUV 4:2:0 8-bit", "YUV 4:2:0 10-bit LE", "YUV 4:2:0 16-bit LE"
//   packed  -> "<PackingOrder> <sub> <bits>-bit[ <BE|LE>] packed[-B]"
//              e.g. "YUYV 4:2:2 8-bit packed"
// The subsampling is always written with colons: 4:4:4, 4:2:2, 4:2:0, 4:0:0.
//
// We support the planar formats here (that is what depth/luma/chroma YUV in
// MPEG work is), plus packed YUYV/UYVY 4:2:2 for completeness.

const SUBSAMP = {
  '4:4:4': '4:4:4',
  '4:2:2': '4:2:2',
  '4:2:0': '4:2:0',
  '4:0:0': '4:0:0',
};

/**
 * Build the YUView pixel-format name for a detected YUV layout.
 *
 * @param {{planar:boolean, subsampling:'4:4:4'|'4:2:2'|'4:2:0'|'4:0:0',
 *         bitDepth:number, bigEndian:boolean,
 *         planeOrder?:'YUV'|'YVU', packingOrder?:'YUYV'|'UYVY'|'YVYU'|'UYVY'}} l
 */
export function yuvviewPixelFormatName(l) {
  const sub = SUBSAMP[l.subsampling];
  if (!sub) throw new Error('unknown subsampling ' + l.subsampling);
  const bits = `${l.bitDepth}-bit`;
  const endi = l.bitDepth > 8 ? (l.bigEndian ? ' BE' : ' LE') : '';
  if (l.planar) {
    const po = l.planeOrder ?? 'YUV';
    return `${po} ${sub} ${bits}${endi}`;
  }
  // packed
  const po = l.packingOrder ?? 'YUYV';
  const bytePacked = l.bytePacking ? ' packed-B' : ' packed';
  return `${po} ${sub} ${bits}${endi}${bytePacked}`;
}

/**
 * Full YUView format string: W;H;YUV;<pixelformat>.
 * This is the canonical, lossless description of a raw YUV stream.
 */
export function yuvviewFormatString({ width, height, pixelFormatName }) {
  return `${width};${height};YUV;${pixelFormatName}`;
}

// URL-encode a format string for use inside a filename (spaces, colons, ';').
export function encodeNameForFile(s) {
  return encodeURIComponent(s);
}

// Derive the output (compressed) filename for a YUV file.
//   DERS_z0300y0325x0404.yuv  ->  DERS_z0300y0325x0404__404_325__YUV_4_2_0_8-bit.mkv
// The double underscore separates basename / W / H / pixelformat-token so it
// is unambiguous and trivially reversible.
export function compressedFileName(baseName, { width, height, pixelFormatName }) {
  const token = pixelFormatName
    .replace(/ /g, '_')          // spaces -> _
    .replace(/:/g, '')           // drop colons (420 stays "420")
    .replace(/-/g, '_');         // 8-bit -> 8_bit
  return `${baseName}__${width}_${height}__${token}.mkv`;
}

// Reverse: parse the pixel-format token + W/H back out of a compressed name we
// generated. Returns null if the name is not one we produced.
export function parseCompressedName(fileName) {
  const m = fileName.replace(/\.mkv$/i, '').match(
    /^(.*)__(\d+)_(\d+)__(.+)$/
  );
  if (!m) return null;
  const [ , baseName, w, h, token ] = m;
  // Reconstruct the canonical YUView pixel-format name from the token.
  // subsampling is a 3-digit run after mangling (4:0:0->400, 4:2:0->420, 4:2:2->422, 4:4:4->444)
  const tm = token.match(/^([A-Z]{2,4})_(\d{3})_(\d+)_bit(?:_(BE|LE))?$/);
  if (!tm) return null;
  const planeOrder = tm[1];
  const s = tm[2];                 // "420"
  const sub = `${s[0]}:${s[1]}:${s[2]}`;   // "4:2:0"
  const bits = tm[3];
  const endi = tm[4] ? ' ' + tm[4] : '';
  const pixelFormatName = `${planeOrder} ${sub} ${bits}-bit${endi}`;
  return { baseName, width: +w, height: +h, pixelFormatName };
}

// ---------------------------------------------------------------------------
// Names YUView opens without touching its format menu.
//
// For a raw .yuv YUView ignores any metadata and reads the format from the
// FILE NAME (YUViewLib/src/filesource/FrameFormatGuess.cpp and
// video/yuv/PixelFormatYUVGuess.cpp), lower-cased:
//   size  : first match of  <w>x<h>_<fps>[hz]_<bits>b[._] | <w>x<h>_<fps>[hz][._] | <w>x<h>[._]
//           ("x" or "*"; must be followed by "_" or "."), leftmost match wins
//   format: the name contains  yuv<420|422|444|400>p[<bits><le|be>]   (ffmpeg's pix_fmt spelling)
// so   DERS_1920x1080_yuv420p16le.yuv   loads as 1920x1080, YUV 4:2:0 16-bit LE.
// The pitfall is the leftmost-wins size rule: a name like DERS_z0300y0325x0404
// holds "0325x0404", so the real size is put in front of it in that case.
// ---------------------------------------------------------------------------

const SIZE_RES = [
  /([0-9]+)(?:x|\*)([0-9]+)_([0-9]+)(?:hz)?_([0-9]+)b?[._]/,
  /([0-9]+)(?:x|\*)([0-9]+)_([0-9]+)(?:hz)?[._]/,
  /([0-9]+)(?:x|\*)([0-9]+)[._]/,
];
const FMT_RE = /yuv(400|420|422|444)p(?:(10|12|14|16)(le|be))?/;
const FMT_RE_G = /yuv(?:400|420|422|444)p(?:(?:10|12|14|16)(?:le|be))?/g;

/** What YUView would guess from a file name: {width,height,subsampling,bitDepth,bigEndian} (fields may be missing). */
export function guessFromName(name) {
  const n = name.toLowerCase();
  const out = {};
  for (const re of SIZE_RES) {
    const m = re.exec(n);
    if (m) { out.width = +m[1]; out.height = +m[2]; break; }
  }
  const f = FMT_RE.exec(n);
  if (f) {
    out.subsampling = `${f[1][0]}:${f[1][1]}:${f[1][2]}`;
    out.bitDepth = f[2] ? +f[2] : 8;
    out.bigEndian = f[3] === 'be';
  }
  return out;
}

/** ffmpeg pix_fmt -> the token YUView searches for (gray16le -> yuv400p16le). */
export function yuvToken(pixFmt) {
  const m = /^(?:gray|yuv(\d{3})p)(\d+(?:le|be))?$/.exec(pixFmt);
  if (!m) throw new Error('unsupported pix_fmt ' + pixFmt);
  return `yuv${m[1] || '400'}p${m[2] || ''}`;
}

/**
 * File stem (no extension) that YUView resolves to exactly width x height x pixFmt.
 * Keeps `base` as is when it already says so; otherwise appends _WxH_<token>,
 * and if the base would mislead YUView's size guess, puts them in front.
 */
export function yuvStem(base, { width, height, pixFmt }) {
  const token = yuvToken(pixFmt);
  const sub = `${token.slice(3, 4)}:${token.slice(4, 5)}:${token.slice(5, 6)}`;
  const m = /^yuv\d{3}p(\d+)?/.exec(token);
  const bits = m[1] ? +m[1] : 8;
  const be = /be$/.test(token);
  const right = n => {
    const g = guessFromName(n + '.yuv');
    if ((n.toLowerCase().match(FMT_RE_G) || []).length !== 1) return false;  // YUView tries several; keep it unambiguous
    return g.width === width && g.height === height && g.subsampling === sub && g.bitDepth === bits && !!g.bigEndian === be;
  };
  const clean = base.replace(FMT_RE_G, '').replace(/(\d)[x*](\d)/gi, '$1-$2');
  for (const s of [base, `${base}_${width}x${height}_${token}`, `${width}x${height}_${token}_${base}`,
                   `${clean}_${width}x${height}_${token}`, `${width}x${height}_${token}_${clean}`]) {
    if (right(s)) return s;
  }
  return `${width}x${height}_${token}_${clean}`;
}

/** pix_fmt for a guessFromName() result, or null when width/height/format are not all known. */
export function pixFmtFromGuess(g) {
  if (!g.width || !g.height || !g.subsampling) return null;
  const suf = g.bitDepth > 8 ? `${g.bitDepth}${g.bigEndian ? 'be' : 'le'}` : '';
  switch (g.subsampling) {
    case '4:0:0': return g.bitDepth > 8 ? `gray${suf}` : 'gray';
    case '4:2:0': return `yuv420p${suf}`;
    case '4:2:2': return `yuv422p${suf}`;
    case '4:4:4': return `yuv444p${suf}`;
    default: return null;
  }
}

/** Key to match an MD5 line to a file whatever its extension or its _WxH_<fmt> / __W_H__<fmt> decoration. */
export function nameKey(name) {
  return name.split('/').pop().toLowerCase()
    .replace(/\.(mkv|yuv|raw|y4m)$/, '')
    .replace(/__\d+_\d+__.+$/, '')
    .replace(/^\d+x\d+_yuv\d{3}p(?:\d+(?:le|be))?_/, '')
    .replace(/_\d+x\d+_yuv\d{3}p(?:\d+(?:le|be))?$/, '')
    .replace(/^_+|_+$/g, '');
}

/** "1920;1080;YUV;YUV 4:2:0 16-bit LE" (the mkv `yuvview` tag) -> {width,height,pixFmt}, or null. */
export function parseFormatString(str) {
  const f = String(str || '').split(';');
  if (f.length !== 4 || f[2] !== 'YUV') return null;
  const m = f[3].trim().match(/^(?:YUV|YVU)\s+(4:[4210]:[4210])\s+(\d+)-bit(?:\s+(BE|LE))?$/);
  if (!m) return null;
  const bitDepth = +m[2];
  const pixFmt = pixFmtFromGuess({ width: +f[0], height: +f[1], subsampling: m[1], bitDepth, bigEndian: m[3] === 'BE' });
  return pixFmt ? { width: +f[0], height: +f[1], pixFmt, formatString: str } : null;
}
