import { md5hex } from '../src/core/md5.js';
import { strict as assert } from 'node:assert';

const cases = [
  ['', 'd41d8cd98f00b204e9800998ecf8427e'],
  ['a', '0cc175b9c0f1b6a831c399e269772661'],
  ['abc', '900150983cd24fb0d6963f7d28e17f72'],
  ['message digest', 'f96b697d7cb7938d525a2f31aaf161d0'],
  ['abcdefghijklmnopqrstuvwxyz', 'c3fcd3d76192e4007dfb496cca67e13b'],
  ['ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789',
   'd174ab98d277d9f5a5611c2c9f419d9f'],
  ['12345678901234567890123456789012345678901234567890123456789012345678901234567890',
   '57edf4a22be3c955ac49da2e2107b67a'],
];

for (const [s, want] of cases) {
  const got = md5hex(new TextEncoder().encode(s));
  assert.equal(got, want, `md5(${JSON.stringify(s)}) = ${got}, want ${want}`);
}

// chunked vs one-shot must match
const big = new Uint8Array(100000);
for (let i = 0; i < big.length; i++) big[i] = (i * 31) & 0xff;
const { MD5 } = await import('../src/core/md5.js');
const one = md5hex(big);
const m = new MD5();
m.update(big.subarray(0, 37000));
m.update(big.subarray(37000, 99999));
m.update(big.subarray(99999));
const chunked = m.final();
assert.equal(one, chunked, 'chunked md5 must equal one-shot');

console.log('md5: all vectors + chunked OK');
