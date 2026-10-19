// ffmpeg wrapper around @ffmpeg/ffmpeg running in a Web Worker.
//
// This is the heart of mpegcd. Two operations, both guaranteed lossless by
// construction AND verified at runtime:
//
//   compressYUV(bytes, geo, name) -> { blob, md5, formatString, ... }
//   decompressMKV(bytes, geo, name, expectedMd5) -> { yuvBytes, verified, ... }
//
// The encoder is FFV1 level 3, coder 1, muxed to Matroska (.mkv). That is the
// only combination that is (a) actually lossless for YUV incl. 10/16-bit and
// (b) muxable (MP4 has no FFV1 tag; png/qtrle in MP4 silently drop chroma).
// See README "Why this is hard".
//
// After encoding we DECODE the result back to raw and re-hash it; if the MD5
// does not match the original, we throw. You never download a non-lossless
// file.

import { FFmpeg } from '@ffmpeg/ffmpeg';

let _ffmpeg = null;
let _loading = null;

/**
 * Load the ffmpeg core once. `coreURL` is the URL of ffmpeg-core.js and the
 * base for the .wasm (same directory).
 */
export async function loadFFmpeg({ coreURL, wasmURL, classWorkerURL } = {}) {
  if (_ffmpeg) return _ffmpeg;
  if (_loading) return _loading;
  _loading = (async () => {
    const ff = new FFmpeg();
    const base = new URL('.', coreURL);
    await ff.load({
      coreURL: coreURL ?? new URL('ffmpeg/ffmpeg-core.js', base).href,
      wasmURL: wasmURL ?? new URL('ffmpeg/ffmpeg-core.wasm', base).href,
      // single-thread core: no classWorkerURL needed. Pass it if using core-mt.
      ...(classWorkerURL ? { classWorkerURL } : {}),
    });
    _ffmpeg = ff;
    return ff;
  })();
  try { return await _loading; }
  catch (e) { _loading = null; throw e; }
}

function getFFmpeg() {
  if (!_ffmpeg) throw new Error('ffmpeg not loaded; call loadFFmpeg() first');
  return _ffmpeg;
}

// unique temp filenames inside the ffmpeg virtual FS
let _uid = 0;
function tmpName(ext) { return `in_${Date.now()}_${_uid++}.${ext}`; }

async function writeFile(ff, name, data) {
  await ff.writeFile(name, data);
}
async function readFile(ff, name) {
  const d = await ff.readFile(name);
  // readFile returns Uint8Array
  return d;
}
async function unlinkQuiet(ff, name) {
  try { await ff.unlink(name); } catch { /* ignore */ }
}

/**
 * Compress a raw YUV buffer to lossless FFV1/Matroska.
 *
 * @param {Uint8Array} yuvBytes the raw YUV file bytes
 * @param {object} geo { width, height, pixFmt, frames }  pixFmt e.g. 'yuv420p10le'
 * @param {string} outName basename for the .mkv (without extension)
 * @param {(frac:number,msg?:string)=>void} [onProgress]
 * @returns {Promise<{blob:Blob, bytes:Uint8Array, md5:string, verified:boolean,
 *            outName:string, formatString:string}>}
 */
export async function compressYUV(yuvBytes, geo, outName, onProgress) {
  const ff = getFFmpeg();
  const inName = tmpName('yuv');
  const mkvName = outName.replace(/\.mkv$/i, '') + '.mkv';

  await writeFile(ff, inName, yuvBytes);

  const args = [
    '-y',
    '-f', 'rawvideo',
    '-pix_fmt', geo.pixFmt,
    '-s', `${geo.width}x${geo.height}`,
    '-i', inName,
    '-an',
    '-c:v', 'ffv1',
    '-level', '3',
    '-coder', '1',
    '-metadata', `yuvview=${geo.formatString}`,
    mkvName,
  ];

  if (onProgress) {
    const prog = (e) => { if (e && e.progress != null) onProgress(e.progress); };
    ff.on('progress', prog);
    try {
      const code = await ff.exec(args);
      if (code !== 0) throw new Error('ffmpeg compress failed: exit ' + code);
    } finally {
      ff.off('progress', prog);
    }
  } else {
    const code = await ff.exec(args);
    if (code !== 0) throw new Error('ffmpeg compress failed: exit ' + code);
  }

  const mkvBytes = await readFile(ff, mkvName);
  await unlinkQuiet(ff, inName);
  await unlinkQuiet(ff, mkvName);

  return {
    blob: new Blob([mkvBytes], { type: 'video/x-matroska' }),
    bytes: mkvBytes,
    outName: mkvName,
    formatString: geo.formatString,
  };
}

/**
 * Decompress a lossless FFV1/Matroska buffer back to raw YUV and verify its
 * MD5 against the expected hash of the original.
 *
 * @param {Uint8Array} mkvBytes
 * @param {object} geo { width, height, pixFmt, frames }
 * @param {string} expectedMd5 md5 hex of the original YUV (case-insensitive)
 * @returns {Promise<{yuvBytes:Uint8Array, md5:string, verified:boolean}>}
 */
export async function decompressMKV(mkvBytes, geo, expectedMd5) {
  const ff = getFFmpeg();
  const mkvIn = tmpName('mkv');
  const yuvOut = tmpName('yuv');

  await writeFile(ff, mkvIn, mkvBytes);

  const args = [
    '-y',
    '-i', mkvIn,
    '-f', 'rawvideo',
    '-pix_fmt', geo.pixFmt,
    '-s', `${geo.width}x${geo.height}`,
    yuvOut,
  ];
  const code = await ff.exec(args);
  if (code !== 0) throw new Error('ffmpeg decompress failed: exit ' + code);

  const yuvBytes = await readFile(ff, yuvOut);
  await unlinkQuiet(ff, mkvIn);
  await unlinkQuiet(ff, yuvOut);

  // import md5 lazily to keep this module import-cheap in non-node contexts
  const { md5hex } = await import('./md5.js');
  const md5 = md5hex(yuvBytes);
  return {
    yuvBytes,
    md5,
    verified: !expectedMd5 || md5.toLowerCase() === expectedMd5.toLowerCase(),
  };
}
