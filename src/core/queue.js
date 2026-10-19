// Queue orchestrator: a live FIFO of jobs. New jobs can be appended at any
// time (even mid-run) and are picked up when the worker is free. ffmpeg runs
// one job at a time on the shared core, so execution is serialized; the queue
// itself stays live.
//
// Job kinds:
//   compress   { file }              YUV in  -> .mkv out (+ md5, verified)
//   decompress { file, expectedMd5 } .mkv in -> YUV out  (+ md5, verified)
//
// Events (all pass the job object by reference; mutate & emit):
//   onJobStart(job), onJobProgress(job, frac, msg?), onJobDone(job),
//   onJobError(job, err), onQueueIdle()

import { compress, decompress } from './workerClient.js';
import { MD5, md5hex } from './md5.js';
import { probeYUV, parseFilenameGeometry, toPixFmt, toYuvviewLayout, bitDepthFromPixFmt } from './probe.js';
import { rankByFrame, coherence, thumbnail } from './frameCheck.js';
import { yuvviewPixelFormatName, yuvviewFormatString, parseCompressedName, guessFromName, pixFmtFromGuess, yuvStem, nameKey } from './yuvviewName.js';

let _uid = 1;

export function createQueue(opts = {}) {
  const jobs = [];
  let running = false;

  const emit = (name, ...args) => {
    if (typeof opts[name] === 'function') {
      try { opts[name](...args); } catch (e) { console.error('listener', name, e); }
    }
  };

  async function pump() {
    if (running) return;
    running = true;
    try {
      for (;;) {
        const job = jobs.find(j => j.status === 'queued');
        if (!job) break;
        job.status = 'running';
        job.progress = 0;
        job._onProgress = (j, frac, msg) => emit('onJobProgress', j, frac, msg);
        emit('onJobStart', job);
        try {
          if (job.kind === 'compress') await runCompress(job);
          else await runDecompress(job);
          job.status = 'done';
          emit('onJobDone', job);
        } catch (e) {
          job.status = 'error';
          job.error = (e && e.message) || String(e);
          emit('onJobError', job, e);
        }
      }
    } finally {
      running = false;
      emit('onQueueIdle');
    }
  }

  function baseJob(kind, file, extra = {}) {
    return {
      id: kind[0] + (_uid++),
      kind,
      file,
      name: file.name,
      status: 'queued',
      progress: 0,
      geo: null,
      md5: null,
      md5Out: null,
      outBlob: null,
      outName: null,
      formatString: null,
      verified: false,
      error: null,
      originalBytes: file.size,
      compressedBytes: null,
      elapsedMs: null,
      strategy: null,
      check: 'none',
      q: null,
      thumb: null,
      yuvName: null,
      expectedMd5: null,
      ...extra,
    };
  }

  return {
    get length() { return jobs.length; },
    get running() { return running; },
    all() { return jobs.slice(); },

    addCompress(file, override = null) {
      const job = baseJob('compress', file, { override });
      jobs.push(job);
      pump();
      return job;
    },

    addDecompress(file, expectedMd5 = null) {
      const job = baseJob('decompress', file, { expectedMd5 });
      jobs.push(job);
      pump();
      return job;
    },

    /** Bind (or replace) the expected MD5 of a decompress job at any stage and re-check it. */
    setExpectedMd5(job, md5) {
      job.expectedMd5 = md5;
      if (job.md5 && (job.status === 'done' || job.status === 'error')) {
        checkMd5(job);
        job.status = job.check === 'bad' ? 'error' : 'done';
        emit('onJobProgress', job, 1);
      }
    },

    /** Forget a job that is not running (finished, failed or still queued). */
    discard(job) {
      const i = jobs.indexOf(job);
      if (i >= 0 && job.status !== 'running') jobs.splice(i, 1);
    },

    remove(job) {
      const i = jobs.indexOf(job);
      if (i >= 0 && job.status === 'queued') jobs.splice(i, 1);
    },

    clearDone() {
      for (let i = jobs.length - 1; i >= 0; i--) {
        if (jobs[i].status === 'done' || jobs[i].status === 'error') jobs.splice(i, 1);
      }
    },
  };
}

/**
 * Run a long async phase (a single ffmpeg exec) while animating the progress
 * bar from `from` toward `to`. ffmpeg.wasm emits no frame-level progress, so
 * we can't report true completion; instead we advance the bar on a smooth
 * asymptotic ramp that always reflects "this phase is actively churning" and
 * never claims 100% until the phase truly resolves. The ramp eases in
 * (slow start, steady middle, final approach) so the bar visibly moves the
 * whole time without a misleading linear "we know the time" feel.
 * @returns {Promise<T>} the phase's return value
 */
async function phaseProgress(job, prog, from, to, label, run) {
  let stop = false;
  const t0 = performance.now();
  const tick = () => {
    if (stop) return;
    const dt = (performance.now() - t0) / 1000;
    // ease toward `to`: approach asymptotically; `speed` controls how fast it
    // nears the end. We cap at `to - epsilon` so we never show 100% early.
    const span = to - from;
    const frac = span * (1 - Math.exp(-dt / 2.2));
    prog(Math.min(from + frac, to - 0.001), label);
    requestAnimationFrame(tick);
  };
  requestAnimationFrame(tick);
  try {
    const v = await run();
    stop = true;
    prog(to, label);
    return v;
  } catch (e) {
    stop = true;
    throw e;
  }
}

// ---- compress -------------------------------------------------------------
async function runCompress(job) {
  const prog = (frac, msg) => { job.progress = frac; job.msg = msg || null; job._onProgress && job._onProgress(job, frac, msg); };

  prog(0.02, 'reading file…');
  const yuv = new Uint8Array(await job.file.arrayBuffer());

  // md5 of the original (chunked, with real per-chunk progress)
  prog(0.04, 'hashing original…');
  const m = new MD5();
  const CHUNK = 16 * 1024 * 1024;
  const nChunks = Math.max(1, Math.ceil(yuv.length / CHUNK));
  for (let c = 0, off = 0; off < yuv.length; off += CHUNK, c++) {
    m.update(yuv.subarray(off, Math.min(off + CHUNK, yuv.length)));
    prog(0.04 + (0.04 * (c + 1)) / nChunks, 'hashing original…');
  }
  const originalMd5 = m.final();
  job.md5 = originalMd5;
  prog(0.08, 'probing geometry…');

  // a YUView-style name (<w>x<h>_yuv420p16le) says it all; else DERS/Kinect zNNNyNNNxNNN
  const named = guessFromName(job.name);
  const hint = named.width ? named : parseFilenameGeometry(job.name);
  if (hint) hint.name = job.name;
  const cands = probeYUV(job.file.size, hint ? hint : { name: job.name });
  // A name that spells size and format is trusted. Otherwise frame 0 decides
  // between the candidates: the one that looks like a picture wins.
  if (!(named.width && named.subsampling) && !job.override) rankByFrame(cands, yuv);
  let geo;
  if (job.override) {
    // the user fixed the geometry: trust it if the file is a whole number of frames
    const o = job.override;
    const planes = { '4:0:0': 1, '4:2:0': 1.5, '4:2:2': 2, '4:4:4': 3 }[o.subsampling];
    const perFrame = o.width * o.height * planes * (o.bitDepth > 8 ? 2 : 1);
    if (!(perFrame > 0) || job.file.size % perFrame !== 0) {
      throw new Error(`${job.file.size} bytes is not a whole number of ${o.width}x${o.height} ${o.subsampling} ${o.bitDepth}-bit frames`);
    }
    geo = { ...o, frames: job.file.size / perFrame, perFrameBytes: perFrame };
  } else {
    if (cands.length === 0) throw new Error('could not determine a valid YUV geometry for ' + job.name);
    geo = cands[0];
  }
  job.alternatives = cands.slice(0, 6).map(c => ({ width: c.width, height: c.height, subsampling: c.subsampling, bitDepth: c.bitDepth, frames: c.frames, q: c.q ?? null }));
  job.q = coherence(yuv, geo.width, geo.height, geo.bitDepth);
  job.thumb = thumbnail(yuv, geo.width, geo.height, geo.bitDepth, geo.subsampling);

  const pixFmt = toPixFmt(geo);
  const layout = toYuvviewLayout(pixFmt);
  const bits = bitDepthFromPixFmt(pixFmt);
  const pixelFormatName = yuvviewPixelFormatName({
    planar: true, subsampling: geo.subsampling, bitDepth: bits,
    bigEndian: false, planeOrder: layout.planeOrder,
  });
  const formatString = yuvviewFormatString({ width: geo.width, height: geo.height, pixelFormatName });

  job.geo = { width: geo.width, height: geo.height, pixFmt, frames: geo.frames, subsampling: geo.subsampling, bitDepth: bits };
  job.formatString = formatString;
  prog(0.1, `compressing ${geo.width}x${geo.height} ${pixFmt} (${geo.frames} frames)…`);

  // the name YUView needs to open the restored .yuv with no manual format entry
  const baseName = job.name.replace(/\.(yuv|raw|nca)$/i, '');
  const stem = yuvStem(baseName, { width: geo.width, height: geo.height, pixFmt });
  const outName = stem + '.mkv';
  job.yuvName = stem + '.yuv';

  const t0 = Date.now();
  let source = yuv;
  let mkvBytes, md5Out;
  // First try the strategy search (see strategy.js); if the self-check ever
  // disagrees, redo it with plain FFV1 rather than failing the job.
  for (const strategy of ['auto', 'ffv1']) {
    // compress: 0.12 -> 0.70 (the long encode). ffmpeg takes ownership of the
    // buffer it is given, so a retry re-reads the file.
    if (!source) source = new Uint8Array(await job.file.arrayBuffer());
    const cRes = await phaseProgress(job, prog, 0.12, 0.70, 'compressing…', () => compress({
      yuv: source, width: geo.width, height: geo.height, pixFmt, formatString, outName, strategy,
    }));
    source = null;
    job.strategy = cRes.strategy;
    // Eager, independent copy for the output blob. Keep mkvBytes pristine: the
    // verify step passes a throwaway copy to ffmpeg, whose writeFile transfers
    // (detaches) the ArrayBuffer it is handed.
    mkvBytes = new Uint8Array(cRes.mkv.byteLength);
    mkvBytes.set(cRes.mkv);
    const mkvForVerify = mkvBytes.slice();

    // verify: 0.70 -> 0.98 (decode back + re-hash)
    prog(0.72, 'verifying losslessness…');
    const dRes = await phaseProgress(job, prog, 0.72, 0.98, 'verifying losslessness…', () => decompress({
      mkv: mkvForVerify, width: geo.width, height: geo.height, pixFmt,
    }));
    prog(0.99, 're-hashing…');
    md5Out = md5hex(dRes.yuv);
    if (md5Out === originalMd5) break;
    console.warn(`[mpegcd] ${job.strategy} not lossless for ${job.name}; retrying with FFV1`);
  }
  job.verified = md5Out === originalMd5;
  job.md5Out = md5Out;
  job.elapsedMs = Date.now() - t0;

  if (!job.verified) {
    job.error = `NOT LOSSLESS — decompressed md5 ${md5Out} != original ${originalMd5}`;
    throw new Error(job.error);
  }

  job.outBlob = new Blob([mkvBytes], { type: 'video/x-matroska' });
  job.outName = outName;
  job.compressedBytes = mkvBytes.length;
}

// ---- decompress -----------------------------------------------------------
// MD5 check of a finished decompress against job.expectedMd5. The expected hash
// can arrive at any time (before, during or after the run), so this is called
// from every one of those places. job.check: 'none' | 'ok' | 'bad'.
export function checkMd5(job) {
  if (!job.md5 || !job.expectedMd5) { job.check = 'none'; job.verified = false; return; }
  job.verified = job.md5.toLowerCase() === job.expectedMd5.toLowerCase();
  job.check = job.verified ? 'ok' : 'bad';
  job.error = job.verified ? null : `MD5 MISMATCH — expected ${job.expectedMd5}, got ${job.md5}`;
}

async function runDecompress(job) {
  const prog = (frac, msg) => { job.progress = frac; job.msg = msg || null; job._onProgress && job._onProgress(job, frac, msg); };

  prog(0.03, 'reading file…');
  const mkvBytes = new Uint8Array(await job.file.arrayBuffer());

  // geometry: the file's own tag wins; its name (<w>x<h>_<pix_fmt> or the old
  // __W_H__ form) is the fallback for files without one
  const geo = _geoFromCompressed(job.name) || {};
  prog(0.15, 'decompressing…');
  // writeFile transfers (detaches) the buffer it is given, so capture the size
  // first and hand ffmpeg a throwaway copy.
  const compressedSize = mkvBytes.length;
  const mkvForDecompress = mkvBytes.slice();
  const result = await phaseProgress(job, prog, 0.15, 0.80, 'decompressing…', () => decompress({
    mkv: mkvForDecompress, width: geo.width, height: geo.height, pixFmt: geo.pixFmt, probe: true,
  }));
  job.geo = { width: result.width, height: result.height, pixFmt: result.pixFmt };
  prog(0.82, 'hashing YUV…');
  job.md5 = await phaseProgress(job, prog, 0.82, 0.98, 'hashing YUV…', () => md5hex(result.yuv));
  job.thumb = thumbnail(result.yuv, result.width, result.height, bitDepthFromPixFmt(result.pixFmt), toYuvviewLayout(result.pixFmt).subsampling);
  job.outName = _yuvNameForCompressed(job.name, job.geo);
  job.outBlob = new Blob([result.yuv], { type: 'application/octet-stream' });
  job.compressedBytes = compressedSize;
  job.originalBytes = result.yuv.length;

  checkMd5(job);
  if (job.check === 'bad') throw new Error(job.error);
}

// Geometry from a compressed filename: <stem>_<w>x<h>_<pix_fmt>.mkv, or the
// older <stem>__<w>_<h>__YUV_420_8_bit.mkv.
function _geoFromCompressed(name) {
  const old = parseCompressedName(name);
  if (old) {
    const pixFmt = _pixFmtFromYuvviewToken(old.pixelFormatName);
    if (pixFmt) return { width: old.width, height: old.height, pixFmt };
  }
  const g = guessFromName(name);
  const pixFmt = pixFmtFromGuess(g);
  return pixFmt ? { width: g.width, height: g.height, pixFmt } : null;
}

// Inverse of the old filename token: "YUV 4:2:0 10-bit LE" -> yuv420p10le.
function _pixFmtFromYuvviewToken(s) {
  const t = String(s).replace(/\s+/g, ' ').trim();
  const m = t.match(/^(YUV|YVU|YUVA)\s+([4210]):([4210]):([4210])\s+(\d+)-bit(?:\s+(BE|LE))?$/);
  if (!m) return null;
  return pixFmtFromGuess({ width: 1, height: 1, subsampling: `${m[2]}:${m[3]}:${m[4]}`, bitDepth: +m[5], bigEndian: m[6] === 'BE' });
}

// The restored .yuv takes the compressed file's stem, which already carries
// <w>x<h>_<pix_fmt> (what YUView reads); older names get it added.
function _yuvNameForCompressed(name, geo) {
  const stem = name.replace(/\.mkv$/i, '');
  const old = /^(.*)__\d+_\d+__.+$/.exec(stem);
  if (!old && pixFmtFromGuess(guessFromName(stem + '.yuv'))) return stem + '.yuv';
  return yuvStem(old ? old[1] : stem, geo) + '.yuv';
}
