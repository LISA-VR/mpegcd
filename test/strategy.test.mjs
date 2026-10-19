// Plane split/merge must be an exact bijection, and refuse out-of-range samples.
import { strict as assert } from 'node:assert';
import { splitPlanes, mergePlanes, pixFmt8, frameBytes, codecsFor } from '../src/core/strategy.js';

for (const bits of [10, 12, 14, 16]) {
  const n = 5000, max = 1 << bits;
  const yuv = new Uint8Array(n * 2);
  for (let i = 0; i < n; i++) {
    const v = i < 4 ? [0, 1, max - 1, max >> 1][i] : (i * 2654435761 >>> 0) % max;
    yuv[2 * i] = v & 255; yuv[2 * i + 1] = v >> 8;
  }
  const p = splitPlanes(yuv, bits);
  assert.ok(p, `${bits}-bit split`);
  assert.deepEqual(mergePlanes(p.hi, p.lo, bits), yuv, `${bits}-bit round-trip`);
}
// a 16-bit value in a "10-bit" file cannot be split reversibly
assert.equal(splitPlanes(new Uint8Array([0xff, 0xff]), 10), null);

assert.equal(pixFmt8('yuv420p10le'), 'yuv420p');
assert.equal(pixFmt8('yuv444p16le'), 'yuv444p');
assert.equal(pixFmt8('gray16le'), 'gray');
assert.equal(pixFmt8('gray'), 'gray');
assert.equal(frameBytes(3712, 2064, '4:2:0', 16), 22984704);
assert.deepEqual(codecsFor(8), ['ffv1', 'x264']);
assert.deepEqual(codecsFor(10), ['ffv1']);
assert.deepEqual(codecsFor(16), ['ffv1']);
console.log('strategy.test: ok');
