// Verify the bulk-zip assembly: given a set of done compress jobs, the zip must
// contain every .mkv (byte-identical to the job's outBlob) plus an MD5SUMS.txt
// mapping each original yuv name -> its md5. We replicate main.js's zip code
// path with JSZip directly.
import JSZip from 'jszip';
import { strict as assert } from 'node:assert';
import { readFileSync, writeFileSync } from 'node:fs';

// Two synthetic "done jobs" (we use the real test YUVs' known md5s + fake mkv
// payloads that we also place in the zip, to confirm round-trip integrity).
const jobA = {
  name: 'TEST_z0010y0096x0144.yuv',
  md5: '8d17d2a58d974d873b04e3eaa077a172',
  outName: 'TEST_z0010y0096x0144__144_96__YUV_420_8_bit.mkv',
  mkv: new Uint8Array([1, 2, 3, 4, 5, 26, 69, 0xde, 0xa3]), // stand-in mkv bytes
};
const jobB = {
  name: 'TEXT_z0008y0072x0096.yuv',
  md5: 'fb8a077e3d8f866c5d6aee1dd21b2400',
  outName: 'TEXT_z0008y0072x0096__96_72__YUV_420_8_bit.mkv',
  mkv: new Uint8Array([9, 8, 7, 26, 69, 0xde, 0xa3]),
};
const done = [jobA, jobB];

// --- replicate main.js zip assembly ---
const zip = new JSZip();
let md5Lines = [];
for (const j of done) {
  zip.file(j.outName, j.mkv);
  md5Lines.push(`${j.md5}  ${j.name}`);
}
zip.file('MD5SUMS.txt', md5Lines.join('\n') + '\n');
const zipBuf = await zip.generateAsync({ type: 'uint8array', compression: 'STORE' });
// --- end replication ---

// Now read it back and verify contents
const back = await JSZip.loadAsync(zipBuf);
const names = Object.keys(back.files).filter(n => !back.files[n].dir).sort();
assert.deepEqual(names, ['MD5SUMS.txt', jobA.outName, jobB.outName].sort(), 'zip file set');

// mkv bytes round-trip
const a = new Uint8Array(await back.file(jobA.outName).async('uint8array'));
assert.deepEqual(Array.from(a), Array.from(jobA.mkv), 'mkv A bytes');
const b = new Uint8Array(await back.file(jobB.outName).async('uint8array'));
assert.deepEqual(Array.from(b), Array.from(jobB.mkv), 'mkv B bytes');

// MD5SUMS parses via the same regex main.js uses
const txt = await back.file('MD5SUMS.txt').async('string');
const map = {};
for (const line of txt.split('\n')) {
  const m = line.trim().match(/^([0-9a-fA-F]{32})\s+\*?\s*(.+)$/);
  if (m) map[m[2].trim()] = m[1].toLowerCase();
}
assert.equal(map[jobA.name], jobA.md5, 'md5 A');
assert.equal(map[jobB.name], jobB.md5, 'md5 B');

writeFileSync('/tmp/mpegcd-test.zip', Buffer.from(zipBuf));
console.log('zip OK:', names.join(', '), '-> /tmp/mpegcd-test.zip', zipBuf.length, 'bytes');
console.log('MD5SUMS parses to', JSON.stringify(map));
