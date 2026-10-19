import { strict as assert } from 'node:assert';
import {
  yuvviewPixelFormatName, yuvviewFormatString,
  compressedFileName, parseCompressedName,
  guessFromName, yuvStem, yuvToken, pixFmtFromGuess, parseFormatString, nameKey,
} from '../src/core/yuvviewName.js';

// Round-trip: for each (subsampling, bits, endianness), the name we generate
// must parse back to the exact same pixel-format name.
const cases = [
  // [subsampling, bits, bigEndian, planeOrder]
  ['4:0:0', 8,  false, 'YUV'],
  ['4:2:0', 8,  false, 'YUV'],
  ['4:2:0', 10, false, 'YUV'],
  ['4:2:0', 12, false, 'YUV'],
  ['4:2:0', 16, false, 'YUV'],
  ['4:2:0', 16, true,  'YUV'],
  ['4:2:2', 8,  false, 'YUV'],
  ['4:2:2', 10, false, 'YUV'],
  ['4:4:4', 8,  false, 'YUV'],
  ['4:4:4', 12, false, 'YUV'],
  ['4:4:4', 16, false, 'YUV'],
];

for (const [sub, bits, be, po] of cases) {
  const pfName = yuvviewPixelFormatName({ planar: true, subsampling: sub, bitDepth: bits, bigEndian: be, planeOrder: po });
  const w = 384, h = 216;
  const fname = compressedFileName('DERS_z0300y0325x0404', { width: w, height: h, pixelFormatName: pfName });
  // fname ends in .mkv; parseCompressedName strips it
  const parsed = parseCompressedName(fname);
  assert.ok(parsed, `parse failed for ${fname}`);
  assert.equal(parsed.baseName, 'DERS_z0300y0325x0404', `baseName for ${fname}`);
  assert.equal(parsed.width, w);
  assert.equal(parsed.height, h);
  assert.equal(parsed.pixelFormatName, pfName, `round-trip token for ${pfName}: got ${parsed.pixelFormatName} from ${fname}`);
  console.log(`  OK  ${pfName.padEnd(24)} -> ${fname} -> ${parsed.pixelFormatName}`);
}

// Full format string
const fs = yuvviewFormatString({ width: 404, height: 325, pixelFormatName: 'YUV 4:2:0 8-bit' });
assert.equal(fs, '404;325;YUV;YUV 4:2:0 8-bit');
console.log(`  OK  format string: ${fs}`);

// ---- names YUView opens without format settings -------------------------------
// YUView (FrameFormatGuess.cpp / PixelFormatYUVGuess.cpp) takes the size from the
// first <w>x<h> followed by _ or ., and the format from a yuv<sub>p<bits><le|be> token.
const pix = ['yuv420p', 'yuv420p10le', 'yuv420p16le', 'yuv422p', 'yuv444p12le', 'gray', 'gray16le'];
const bases = ['clip', 'DERS_z0300y0325x0404', 'v00_depth_3712x2064_yuv420p16le', 'a_1x2_b', 'run_yuv420p10le', 'Kinect_z0300y0325x0404_x1920'];
for (const pixFmt of pix) for (const base of bases) for (const [w, h] of [[1920, 1080], [64, 48], [3712, 2064]]) {
  const stem = yuvStem(base, { width: w, height: h, pixFmt });
  const g = guessFromName(stem + '.yuv');
  assert.equal(g.width, w, `width of ${stem}`);
  assert.equal(g.height, h, `height of ${stem}`);
  assert.equal(pixFmtFromGuess(g), pixFmt.startsWith('gray') ? pixFmt : pixFmt, `format of ${stem}`);
  assert.equal(g.bitDepth, /(\d+)le$/.test(pixFmt) ? +/(\d+)le$/.exec(pixFmt)[1] : 8, `bits of ${stem}`);
  assert.equal((stem.match(/yuv\d{3}p/g) || []).length, 1, `exactly one format token in ${stem}`);
}
assert.equal(yuvStem('v00_depth_3712x2064_yuv420p16le', { width: 3712, height: 2064, pixFmt: 'yuv420p16le' }), 'v00_depth_3712x2064_yuv420p16le', 'a right name is kept');
assert.equal(yuvStem('DERS_z0300y0325x0404', { width: 1920, height: 1080, pixFmt: 'yuv420p16le' }), '1920x1080_yuv420p16le_DERS_z0300y0325x0404', 'a misleading 0325x0404 pushes the size in front');
assert.equal(yuvToken('gray16le'), 'yuv400p16le');
assert.deepEqual(parseFormatString('1920;1080;YUV;YUV 4:2:0 16-bit LE'), { width: 1920, height: 1080, pixFmt: 'yuv420p16le', formatString: '1920;1080;YUV;YUV 4:2:0 16-bit LE' });
assert.equal(parseFormatString('nonsense'), null);
// md5 lines match a file whatever extension or decoration it has
for (const n of ['a.yuv', 'a.mkv', 'a__64_48__YUV_420_8_bit.mkv', 'a_64x48_yuv420p.yuv', '64x48_yuv420p_a.mkv', 'dir/a_64x48_yuv420p.mkv'])
  assert.equal(nameKey(n), 'a', n);
console.log('  OK  YUView-resolvable names (' + pix.length * bases.length * 3 + ' combinations)');

console.log('\nyuvview naming round-trip: PASS');
