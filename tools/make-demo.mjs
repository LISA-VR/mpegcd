// Regenerates public/demo/demo_pair.zip — the sample the site offers via the
// "Download sample pair" button.
//
// The sample is REAL dataset data, byte-for-byte, nothing resized or cropped:
// ULB ToysTable (Bonatto, Fachada, Lafruit; CC BY-NC-SA, doi 10.5281/zenodo.5055542),
// plane B, three neighbouring cameras of one row (x = 370, 404, 438 mm), used as
// the three frames of each stream:
//   texture : Kinect_z0300y0325x{0370,0404,0438}.yuv   1920x1080 yuv420p     8-bit
//   depth   : DERS_z0300y0325x{0370,0404,0438}.yuv     1920x1080 yuv420p16le 16-bit (DERS estimate)
// Each stream is compressed with the same strategy search as the site (FFV1,
// x264 -qp 0, or a hi/lo 8-bit split, whichever is smallest) and tagged with
// the YUView format string. The zip also holds MD5SUMS.txt (md5 of the raw YUV
// each .mkv must restore), so dropping it into Decompress verifies the round trip.
//
// Run:  TOYSTABLE=/path/to/toystable node tools/make-demo.mjs   (needs ffmpeg with libx264 on PATH)
// Build tool only; the committed public/demo/demo_pair.zip is the artifact.

import { readFileSync, writeFileSync, mkdirSync, mkdtempSync, statSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { yuvStem } from '../src/core/yuvviewName.js';
import { CODECS, codecsFor, pixFmt8, splitPlanes, mergePlanes } from '../src/core/strategy.js';

const DATASET = process.env.TOYSTABLE;   // directory of the ULB ToysTable dataset (zenodo 5055542)
if (!DATASET) throw new Error('set TOYSTABLE to the ToysTable dataset directory');
const XS = ['0370', '0404', '0438'];
const W = 1920, H = 1080;
const STREAMS = [
  { name: 'ToysTable_B_DERS_depth', pixFmt: 'yuv420p16le', bits: 16, fmt: 'YUV 4:2:0 16-bit LE',
    files: XS.map(x => join(DATASET, `depths_DERS/depths/B/B/DERS_z0300y0325x${x}.yuv`)) },
  { name: 'ToysTable_B_Kinect_texture', pixFmt: 'yuv420p', bits: 8, fmt: 'YUV 4:2:0 8-bit',
    files: XS.map(x => join(DATASET, `textures/textures/B/B/Kinect_z0300y0325x${x}.yuv`)) },
];

const tmp = mkdtempSync(join(tmpdir(), 'mpegcd-demo-'));
const md5 = b => createHash('md5').update(b).digest('hex');
function ff(args) {
  const r = spawnSync('ffmpeg', ['-y', '-loglevel', 'error', '-threads', '1', ...args], { stdio: 'inherit' });
  if (r.status !== 0) throw new Error('ffmpeg failed: ' + args.join(' '));
}
const raw = (file, pf) => ['-f', 'rawvideo', '-pix_fmt', pf, '-s', `${W}x${H}`, '-i', file];

function encode(file, pf, codec, out, extra = []) {
  ff([...raw(file, pf), '-an', ...CODECS[codec].args, ...extra, out]);
  return statSync(out).size;
}
function best(file, pf, bits, tag) {
  let pick = null;
  for (const c of codecsFor(bits)) {
    const out = join(tmp, `${tag}_${c}.mkv`);
    const size = encode(file, pf, c, out);
    console.log(`  ${tag} ${c}: ${size}`);
    if (!pick || size < pick.size) pick = { codec: c, size, out };
  }
  return pick;
}

const files = [];
const sums = [];
for (const s of STREAMS) {
  const yuv = Buffer.concat(s.files.map(f => readFileSync(f)));
  const frame = W * H * 1.5 * (s.bits > 8 ? 2 : 1);
  if (yuv.length !== frame * XS.length) throw new Error(`${s.name}: ${yuv.length} bytes is not ${XS.length} frames of ${W}x${H} ${s.pixFmt}`);
  const yuvPath = join(tmp, s.name + '.yuv');
  writeFileSync(yuvPath, yuv);
  const meta = ['-metadata', `yuvview=${W};${H};YUV;${s.fmt}`];
  console.log(s.name, md5(yuv), yuv.length, 'bytes');

  const direct = best(yuvPath, s.pixFmt, s.bits, s.name);
  let mkv = direct.out, label = CODECS[direct.codec].label, size = direct.size;
  let split = null;
  if (s.bits > 8) {
    const sp = splitPlanes(yuv, s.bits);
    const hiP = join(tmp, s.name + '.hi'), loP = join(tmp, s.name + '.lo');
    writeFileSync(hiP, sp.hi); writeFileSync(loP, sp.lo);
    const p8 = pixFmt8(s.pixFmt);
    const hi = best(hiP, p8, 8, s.name + '_hi'), lo = best(loP, p8, 8, s.name + '_lo');
    if (hi.size + lo.size < size) {
      const out = join(tmp, s.name + '_split.mkv');
      ff(['-i', hi.out, '-i', lo.out, '-map', '0:v:0', '-map', '1:v:0', '-c', 'copy', ...meta, out]);
      mkv = out; size = statSync(out).size; label = `split ${CODECS[hi.codec].label} + ${CODECS[lo.codec].label}`;
      split = { hiP, loP, p8 };
    }
  }
  if (!split) { const out = join(tmp, s.name + '_final.mkv'); ff(['-i', mkv, '-map', '0:v:0', '-c', 'copy', ...meta, out]); mkv = out; }

  // verify: decode back and compare md5 with the original bytes
  let back;
  if (split) {
    const h = join(tmp, 'rt_hi'), l = join(tmp, 'rt_lo');
    ff(['-i', mkv, '-map', '0:v:0', '-f', 'rawvideo', '-pix_fmt', split.p8, h]);
    ff(['-i', mkv, '-map', '0:v:1', '-f', 'rawvideo', '-pix_fmt', split.p8, l]);
    back = Buffer.from(mergePlanes(readFileSync(h), readFileSync(l), s.bits));
  } else {
    const o = join(tmp, 'rt.yuv');
    ff(['-i', mkv, '-f', 'rawvideo', '-pix_fmt', s.pixFmt, o]);
    back = readFileSync(o);
  }
  if (md5(back) !== md5(yuv)) throw new Error(s.name + ' round trip is NOT lossless');
  console.log(`  -> ${label}: ${size} bytes (x${(yuv.length / size).toFixed(1)}), round trip verified`);

  // <name>_<w>x<h>_<pix_fmt>: the .yuv restored from it opens in YUView with no format settings
  const stem = yuvStem(s.name, { width: W, height: H, pixFmt: s.pixFmt });
  files.push([`${stem}.mkv`, readFileSync(mkv)]);
  sums.push(`${md5(yuv)}  ${stem}.yuv`);
}

const { default: JSZip } = await import('jszip');
const zip = new JSZip();
for (const [n, b] of files) zip.file(n, b);
zip.file('MD5SUMS.txt', sums.join('\n') + '\n');
zip.file('README.txt',
  'Real data from ULB ToysTable (Bonatto, Fachada, Lafruit), CC BY-NC-SA,\n' +
  'doi 10.5281/zenodo.5055542. Three neighbouring cameras (plane B, y=325, x=370/404/438)\n' +
  'are the 3 frames of each stream: 1920x1080 texture (8-bit) and DERS depth (16-bit).\n' +
  'Nothing is resized or cropped. Drop this zip on the page to restore the YUVs\n' +
  'and verify their MD5.\n');
const out = await zip.generateAsync({ type: 'nodebuffer', compression: 'STORE' });
mkdirSync('public/demo', { recursive: true });
writeFileSync('public/demo/demo_pair.zip', out);
console.log('wrote public/demo/demo_pair.zip', out.length, 'bytes');
