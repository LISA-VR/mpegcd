import { strict as assert } from 'node:assert';
import { probeYUV } from '../src/core/probe.js';

const top = (size, hint) => probeYUV(size, hint)[0];
const eq = (c, w, h, sub, bits, frames) =>
  assert.deepEqual([c.width, c.height, c.subsampling, c.bitDepth, c.frames], [w, h, sub, bits, frames]);

// real ToysTable frames: 1920x1080, one frame; depth is 16-bit, texture 8-bit
eq(top(6220800, { name: 'DERS_z0300y0325x0404.yuv' }), 1920, 1080, '4:2:0', 16, 1);
eq(top(3110400, { name: 'Kinect_z0300y0325x0404.yuv' }), 1920, 1080, '4:2:0', 8, 1);
// a YUView-style name settles size and format
eq(top(3712 * 2064 * 3, { width: 3712, height: 2064, subsampling: '4:2:0', bitDepth: 16 }), 3712, 2064, '4:2:0', 16, 1);
// landscape beats portrait for the same pixel count
eq(top(1920 * 1080 * 1.5 * 10, {}), 1920, 1080, '4:2:0', 8, 10);
console.log('probe: PASS');

// 9..16-bit samples are stored in 2 bytes: 640x360 4:2:0 10-bit is 691200 B/frame, not 1.25 B/sample
const c10 = probeYUV(691200 * 40, { name: 'x.yuv' }).find(c => c.width === 640 && c.height === 360 && c.subsampling === '4:2:0' && c.bitDepth === 10);
assert.equal(c10.frames, 40);
console.log('probe (storage bytes): PASS');
