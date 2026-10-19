// LOSSLESSNESS GATE — dev/CI proof.
//
// @ffmpeg/ffmpeg (the browser package) is browser-only; its `node` export is
// an intentional stub. So this Node test drives the SAME encoder args through
// the system `ffmpeg` (same FFmpeg version family, same FFV1 codec) as a fast,
// always-available gate. The browser itself is verified separately with a real
// page load (test/README).
//
// It proves, for every supported pixel format:
//   1. compress with the production args,
//   2. decompress,
//   3. output bytes are byte-identical to input AND md5 matches.
//
// 10/12-bit samples are packed PROPERLY (little-endian, full-range high
// bytes) — that is what real YUV is. Naive [low,0] packing is not valid
// rawvideo and would (correctly) confuse ffmpeg's demuxer.

import { execFileSync, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { strict as assert } from 'node:assert';
import { mkdtempSync, writeFileSync, readFileSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { md5hex } from '../src/core/md5.js';
import { CODECS, pixFmt8, splitPlanes, mergePlanes } from '../src/core/strategy.js';

const pexec = promisify(execFile);
const dir = mkdtempSync(join(tmpdir(), 'mpegcd-rt-'));
const IN = join(dir, 'in.yuv');
const MKV = join(dir, 'out.mkv');
const OUT = join(dir, 'out.yuv');

function ffmpeg(args) {
  return pexec('ffmpeg', ['-hide_banner', '-loglevel', 'error', ...args]);
}

// planar frame byte count
function frameBytes(w, h, sub, bits) {
  const bps = bits <= 8 ? 1 : 2; const y = w * h;
  if (sub === '4:0:0') return y * bps;
  const cw = w >> 1, ch = (sub === '4:2:0') ? h >> 1 : h;
  return (y + 2 * cw * ch) * bps;
}

// synthesize raw YUV. For <=8-bit, one byte/sample. For >8-bit, proper
// little-endian 2-byte samples with FULL-RANGE high bytes.
function synth(w, h, frames, sub, bits) {
  const per = frameBytes(w, h, sub, bits);
  const total = per * frames;
  const buf = new Uint8Array(total);
  if (bits <= 8) {
    for (let i = 0; i < total; i++) buf[i] = (i * 131 + 7) & 0xff;
  } else {
    // 2 bytes per sample, LE, full range
    const n = total / 2;
    for (let i = 0; i < n; i++) {
      const v = ((i * 2654435761) >>> 0) % 1024; // full-range 10-bit-ish
      buf[2 * i] = v & 0xff;
      buf[2 * i + 1] = (v >> 8) & 0xff;
    }
  }
  return buf;
}

const cases = [
  { name: 'gray  4:0:0  8b',      pixFmt: 'gray',        sub: '4:0:0', bits: 8,  w: 128, h: 96,  fr: 30 },
  { name: 'yuv420p  8b',          pixFmt: 'yuv420p',     sub: '4:2:0', bits: 8,  w: 192, h: 128, fr: 30 },
  { name: 'yuv420p10le 10b',      pixFmt: 'yuv420p10le', sub: '4:2:0', bits: 10, w: 160, h: 120, fr: 30 },
  { name: 'yuv420p16le 16b',      pixFmt: 'yuv420p16le', sub: '4:2:0', bits: 16, w: 128, h: 96,  fr: 30 },
  { name: 'yuv422p   8b',         pixFmt: 'yuv422p',     sub: '4:2:2', bits: 8,  w: 160, h: 120, fr: 30 },
  { name: 'yuv422p10le 10b',      pixFmt: 'yuv422p10le', sub: '4:2:2', bits: 10, w: 160, h: 120, fr: 30 },
  { name: 'yuv422p16le 16b',      pixFmt: 'yuv422p16le', sub: '4:2:2', bits: 16, w: 128, h: 96,  fr: 30 },
  { name: 'yuv444p   8b',         pixFmt: 'yuv444p',     sub: '4:4:4', bits: 8,  w: 96,  h: 96,  fr: 30 },
  { name: 'yuv444p12le 12b',      pixFmt: 'yuv444p12le', sub: '4:4:4', bits: 12, w: 96,  h: 96,  fr: 30 },
  { name: 'yuv444p16le 16b',      pixFmt: 'yuv444p16le', sub: '4:4:4', bits: 16, w: 96,  h: 96,  fr: 30 },
];

let ok = 0;
for (const c of cases) {
  const yuv = synth(c.w, c.h, c.fr, c.sub, c.bits);
  const inMd5 = md5hex(yuv);
  writeFileSync(IN, yuv);
  if (existsSync(MKV)) rmSync(MKV);

  // production args
  await ffmpeg(['-y', '-f', 'rawvideo', '-pix_fmt', c.pixFmt, '-s', `${c.w}x${c.h}`,
    '-i', IN, '-an', ...CODECS.ffv1.args,
    '-metadata', `yuvview=${c.w};${c.h};YUV;test`, MKV]);

  await ffmpeg(['-y', '-i', MKV, '-f', 'rawvideo', '-pix_fmt', c.pixFmt,
    '-s', `${c.w}x${c.h}`, OUT]);

  const out = readFileSync(OUT);
  const sameBytes = yuv.length === out.length && yuv.every((v, i) => v === out[i]);
  const outMd5 = md5hex(out);
  assert.equal(sameBytes, true, `${c.name}: bytes differ (in ${yuv.length} out ${out.length})`);
  assert.equal(inMd5, outMd5, `${c.name}: md5 differs ${inMd5} != ${outMd5}`);
  const ratio = (yuv.length / out.length || yuv.length / readFileSync(MKV).length).toFixed(2);
  const mkvSize = readFileSync(MKV).length;
  console.log(`  OK  ${c.name.padEnd(20)}  ${yuv.length}B -> ${mkvSize}B mkv  (x${(yuv.length/mkvSize).toFixed(2)})  md5=${inMd5}`);
  ok++;

  // x264 lossless (8-bit only) and the hi/lo split, through the same checks
  const P8 = join(dir, 'p8.yuv'), M8 = join(dir, 'p8.mkv'), O8 = join(dir, 'p8.out');
  const roundtrip8 = async (raw, pf, codec) => {
    writeFileSync(P8, raw);
    await ffmpeg(['-y', '-f', 'rawvideo', '-pix_fmt', pf, '-s', `${c.w}x${c.h}`, '-i', P8, '-an', ...CODECS[codec].args, M8]);
    await ffmpeg(['-y', '-i', M8, '-f', 'rawvideo', '-pix_fmt', pf, '-s', `${c.w}x${c.h}`, O8]);
    return { out: readFileSync(O8), size: readFileSync(M8).length };
  };
  if (c.bits === 8) {
    const r = await roundtrip8(yuv, c.pixFmt, 'x264');
    assert.equal(md5hex(r.out), inMd5, `${c.name}: x264 not lossless`);
    console.log(`      x264 lossless  ok  ${r.size}B`);
  } else {
    const planes = splitPlanes(yuv, c.bits);
    assert.ok(planes, `${c.name}: split refused`);
    const pf8 = pixFmt8(c.pixFmt);
    for (const codec of ['ffv1', 'x264']) {
      const hi = await roundtrip8(planes.hi, pf8, codec);
      const lo = await roundtrip8(planes.lo, pf8, codec);
      assert.equal(md5hex(mergePlanes(hi.out, lo.out, c.bits)), inMd5, `${c.name}: split+${codec} not lossless`);
      console.log(`      split+${codec.padEnd(4)} ok  ${hi.size + lo.size}B`);
    }
  }
}

rmSync(dir, { recursive: true, force: true });
console.log(`\nroundtrip gate: ${ok}/${cases.length} lossless, md5-verified. PASS`);
