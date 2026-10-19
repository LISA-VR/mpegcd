// Main-thread ffmpeg client.
//
// @ffmpeg/ffmpeg's FFmpeg class ALREADY spawns and drives its own internal
// worker (new Worker("./worker.js")) where the wasm core runs. So we do NOT
// wrap it in another worker — that double-nesting breaks the internal worker's
// URL resolution (Vite inlines our module worker as a data: URL, so the inner
// `new URL("./worker.js", import.meta.url)` can't resolve).
//
// We instantiate FFmpeg on the main thread; the heavy lifting (decode/encode)
// still happens off the main thread inside ffmpeg.wasm's own worker, so the UI
// stays responsive. The single-thread core is fine here.

import { FFmpeg } from '@ffmpeg/ffmpeg';
import { bitDepthFromPixFmt, toYuvviewLayout } from './probe.js';
import { parseFormatString } from './yuvviewName.js';
import { CODECS, codecsFor, pixFmt8, frameBytes, splitPlanes, mergePlanes } from './strategy.js';

let _ff = null;
let _loading = null;

// Absolute core URLs, resolved against the page origin.
function coreUrls() {
  const base = new URL('.', location.href);
  return {
    coreURL: new URL('ffmpeg/ffmpeg-core.js', base).href,
    wasmURL: new URL('ffmpeg/ffmpeg-core.wasm', base).href,
  };
}

export async function loadFFmpeg() {
  if (_ff) return _ff;
  if (_loading) return _loading;
  _loading = (async () => {
    const ff = new FFmpeg();
    ff.on('log', ({ type, message }) => {
      if (type === 'error') console.error('[ffmpeg]', message);
    });
    const { coreURL, wasmURL } = coreUrls();
    await ff.load({ coreURL, wasmURL });
    _ff = ff;
    return ff;
  })();
  try { return await _loading; }
  catch (e) { _loading = null; throw e; }
}

let _uid = 1;
const tmp = (ext) => `m_${_uid++}.${ext}`;

// Trials run on the leading frames: up to MAX_SAMPLE_FRAMES while they fit in
// SAMPLE_BYTES, but never fewer than MIN_SAMPLE_FRAMES (a single frame cannot
// show the temporal gain of x264). A file that small is encoded in full by
// every candidate and the winner reused.
const SAMPLE_BYTES = 64 * 1024 * 1024;
const MIN_SAMPLE_FRAMES = 4;
const MAX_SAMPLE_FRAMES = 12;

async function run(ff, args, what) {
  const code = await ff.exec(args);
  if (code !== 0) throw new Error(`ffmpeg ${what} exit ${code}`);
}

// Encode one raw stream with one codec into a standalone .mkv. Returns the
// bytes, or null when this codec cannot take that pix_fmt/geometry (trial).
async function encodeStream(ff, rawN, pf, w, h, codec, extra = []) {
  const outN = tmp('mkv');
  try {
    await run(ff, [
      '-y', '-f', 'rawvideo', '-pix_fmt', pf, '-s', `${w}x${h}`, '-i', rawN,
      '-an', ...CODECS[codec].args, ...extra, outN,
    ], 'encode ' + codec);
    return (await ff.readFile(outN)).slice();
  } catch {
    return null;
  } finally {
    try { await ff.deleteFile(outN); } catch { /* ignore */ }
  }
}

// Smallest codec for one raw stream. `raw` is copied, never consumed.
async function bestCodec(ff, raw, pf, w, h, bits) {
  const rawN = tmp('raw');
  await ff.writeFile(rawN, raw.slice());
  let best = null;
  try {
    for (const codec of codecsFor(bits)) {
      const bytes = await encodeStream(ff, rawN, pf, w, h, codec);
      if (bytes && (!best || bytes.length < best.size)) best = { codec, size: bytes.length, bytes };
    }
  } finally {
    try { await ff.deleteFile(rawN); } catch { /* ignore */ }
  }
  if (!best) throw new Error('no codec could encode ' + pf);
  return best;
}

// Stream-copy one or two encoded .mkv streams into one file, tagged for YUView.
async function mux(ff, parts, formatString) {
  const ins = [];
  for (const bytes of parts) {
    const n = tmp('mkv');
    await ff.writeFile(n, bytes.slice());
    ins.push(n);
  }
  const outN = tmp('mkv');
  await run(ff, [
    '-y', ...ins.flatMap(n => ['-i', n]),
    ...ins.flatMap((_, k) => ['-map', `${k}:v:0`]),
    '-c', 'copy', '-metadata', `yuvview=${formatString}`, outN,
  ], 'mux');
  const out = (await ff.readFile(outN)).slice();
  for (const n of [...ins, outN]) { try { await ff.deleteFile(n); } catch { /* ignore */ } }
  return out;
}

/**
 * Compress a raw YUV buffer to the smallest lossless Matroska we can find.
 * Tries (on a sample of frames) FFV1 / x264 / x265 directly and, for >8-bit
 * samples, a high-byte/low-byte split into two 8-bit streams; the caller
 * verifies the result by decoding it. See strategy.js.
 * `strategy: 'ffv1'` skips the search (safe fallback).
 * NOTE: `yuv` may be detached (handed to ffmpeg's worker) after this call.
 * @returns {Promise<{mkv:Uint8Array, strategy:string}>}
 */
export async function compress({ yuv, width, height, pixFmt, formatString, outName, strategy = 'auto' }) {
  const ff = await loadFFmpeg();
  const bits = bitDepthFromPixFmt(pixFmt);
  const { subsampling } = toYuvviewLayout(pixFmt);
  const perFrame = frameBytes(width, height, subsampling, bits);
  const frames = Math.floor(yuv.length / perFrame);
  const meta = ['-metadata', `yuvview=${formatString}`];

  const encodeDirect = async (codec) => {
    const rawN = tmp('yuv');
    await ff.writeFile(rawN, yuv);
    const bytes = await encodeStream(ff, rawN, pixFmt, width, height, codec, meta);
    try { await ff.deleteFile(rawN); } catch { /* ignore */ }
    if (!bytes) throw new Error('ffmpeg compress failed (' + codec + ')');
    return bytes;
  };

  if (strategy === 'ffv1' || frames < 1) {
    return { mkv: await encodeDirect('ffv1'), strategy: 'FFV1' };
  }

  const fit = Math.max(MIN_SAMPLE_FRAMES, Math.min(MAX_SAMPLE_FRAMES, Math.floor(SAMPLE_BYTES / perFrame)));
  const nSample = Math.min(frames, fit);
  const whole = nSample === frames;
  const sample = yuv.subarray(0, nSample * perFrame);

  // --- trials ---
  const direct = await bestCodec(ff, sample, pixFmt, width, height, bits);
  let split = null;
  if (bits > 8) {
    const planes = splitPlanes(sample, bits);
    if (planes) {
      const pf8 = pixFmt8(pixFmt);
      const hi = await bestCodec(ff, planes.hi, pf8, width, height, 8);
      const lo = await bestCodec(ff, planes.lo, pf8, width, height, 8);
      if (hi.size + lo.size < direct.size) split = { hi, lo };
    }
  }

  // --- final encode with the winner ---
  if (split) {
    const label = `split high 8 / low ${bits - 8} bits: ${CODECS[split.hi.codec].label} + ${CODECS[split.lo.codec].label}`;
    // The sample was the whole file: the trial outputs already are the result.
    if (whole) return { mkv: await mux(ff, [split.hi.bytes, split.lo.bytes], formatString), strategy: label };
    const planes = splitPlanes(yuv, bits);   // null: a later frame exceeds `bits` -> go direct
    if (planes) {
      const pf8 = pixFmt8(pixFmt);
      const parts = [];
      for (const [plane, codec] of [[planes.hi, split.hi.codec], [planes.lo, split.lo.codec]]) {
        const rawN = tmp('raw');
        await ff.writeFile(rawN, plane);
        const bytes = await encodeStream(ff, rawN, pf8, width, height, codec);
        try { await ff.deleteFile(rawN); } catch { /* ignore */ }
        if (!bytes) throw new Error('ffmpeg compress failed (' + codec + ')');
        parts.push(bytes);
      }
      return { mkv: await mux(ff, parts, formatString), strategy: label };
    }
  }
  if (whole) return { mkv: await mux(ff, [direct.bytes], formatString), strategy: CODECS[direct.codec].label };
  return { mkv: await encodeDirect(direct.codec), strategy: CODECS[direct.codec].label };
}

// Number of video streams in a Matroska buffer already in ffmpeg's FS.
async function videoStreamCount(ff, inN) {
  const outN = tmp('txt');
  try {
    await ff.ffprobe(['-v', 'error', '-select_streams', 'v', '-show_entries', 'stream=index',
      '-of', 'csv=p=0', inN, '-o', outN]);
    const txt = new TextDecoder().decode(await ff.readFile(outN));
    return txt.split('\n').filter(l => l.trim() !== '').length;
  } catch {
    return 1;
  } finally {
    try { await ff.deleteFile(outN); } catch { /* ignore */ }
  }
}

// The `yuvview` format string we embed when compressing, read back from a
// Matroska already in ffmpeg's FS (null when absent, e.g. a foreign file).
async function readFormatTag(ff, inN) {
  const outN = tmp('json');
  try {
    await ff.ffprobe(['-v', 'error', '-show_entries', 'format_tags=yuvview:stream_tags=yuvview',
      '-of', 'json', inN, '-o', outN]);
    const j = JSON.parse(new TextDecoder().decode(await ff.readFile(outN)));
    const tag = (j.format && j.format.tags && j.format.tags.yuvview)
      || ((j.streams || []).map(x => x.tags && x.tags.yuvview).find(Boolean));
    return tag || null;
  } catch {
    return null;
  } finally {
    try { await ff.deleteFile(outN); } catch { /* ignore */ }
  }
}

/**
 * Decompress a lossless Matroska (single stream, or hi/lo split pair) back to
 * raw YUV. With `probe`, the geometry embedded in the file wins over the
 * width/height/pixFmt given (taken from its name), so a renamed file still
 * restores correctly.
 * @returns {Promise<{yuv:Uint8Array, width:number, height:number, pixFmt:string}>}
 */
export async function decompress({ mkv, width, height, pixFmt, probe = false }) {
  const ff = await loadFFmpeg();
  const inN = tmp('mkv');
  await ff.writeFile(inN, mkv);
  if (probe) {
    const g = parseFormatString(await readFormatTag(ff, inN));
    if (g) ({ width, height, pixFmt } = g);
  }
  if (!pixFmt || !width || !height) {
    try { await ff.deleteFile(inN); } catch { /* ignore */ }
    throw new Error('no geometry: the file has no format tag and its name has no <w>x<h>_<pix_fmt>');
  }
  const bits = bitDepthFromPixFmt(pixFmt);
  const nStreams = bits > 8 ? await videoStreamCount(ff, inN) : 1;

  if (nStreams >= 2) {
    const pf8 = pixFmt8(pixFmt);
    const hiN = tmp('raw'), loN = tmp('raw');
    await run(ff, [
      '-y', '-i', inN,
      '-map', '0:v:0', '-f', 'rawvideo', '-pix_fmt', pf8, hiN,
      '-map', '0:v:1', '-f', 'rawvideo', '-pix_fmt', pf8, loN,
    ], 'decompress');
    const hi = (await ff.readFile(hiN)).slice();
    const lo = (await ff.readFile(loN)).slice();
    for (const n of [inN, hiN, loN]) { try { await ff.deleteFile(n); } catch { /* ignore */ } }
    if (hi.length !== lo.length) throw new Error('split streams differ in length');
    return { yuv: mergePlanes(hi, lo, bits), width, height, pixFmt };
  }

  const outN = tmp('yuv');
  await run(ff, [
    '-y', '-i', inN, '-f', 'rawvideo', '-pix_fmt', pixFmt,
    '-s', `${width}x${height}`, outN,
  ], 'decompress');
  const yuvRaw = await ff.readFile(outN);
  const yuv = yuvRaw.slice(); // independent copy before the buffer is detached
  await ff.deleteFile(inN);
  await ff.deleteFile(outN);
  return { yuv, width, height, pixFmt };
}
