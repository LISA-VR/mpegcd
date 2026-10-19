// MD5 for the browser. WebCrypto does not ship MD5, so this is a small,
// self-contained, pure-JS implementation. Output is a 32-char lowercase hex
// string identical to `md5sum`. Verified in test/md5.test.mjs against known
// RFC 1321 / FIPS vectors.
//
// It is incremental (update/final) so we can hash a 2 GB file in chunks
// without holding the whole thing twice.

// ---- core (based on the standard public-domain MD5) --------------------
const F = (x, y, z) => (x & y) | (~x & z);
const G = (x, y, z) => (x & z) | (y & ~z);
const H = (x, y, z) => x ^ y ^ z;
const I = (x, y, z) => y ^ (x | ~z);

function rotl(n, b) { return (n << b) | (n >>> (32 - b)); }

// Pre-computed K table: K[i] = floor(abs(sin(i+1)) * 2^32)
const K = new Array(64);
for (let i = 0; i < 64; i++) K[i] = (Math.abs(Math.sin(i + 1)) * 4294967296) | 0;

// Per-round shift amounts
const S = new Int32Array([
  7,12,17,22, 7,12,17,22, 7,12,17,22, 7,12,17,22,
  5, 9,14,20, 5, 9,14,20, 5, 9,14,20, 5, 9,14,20,
  4,11,16,23, 4,11,16,23, 4,11,16,23, 4,11,16,23,
  6,10,15,21, 6,10,15,21, 6,10,15,21, 6,10,15,21,
]);

class MD5 {
  constructor() {
    this._a0 = 0x67452301; this._b0 = 0xefcdab89;
    this._c0 = 0x98badcfe; this._d0 = 0x10325476;
    this._buf = new Uint8Array(64);
    this._bufLen = 0;
    this._bytes = 0;   // total bytes fed
    this._final = false;
  }

  // feed a chunk of bytes (Uint8Array or ArrayBuffer)
  update(chunk) {
    if (this._final) throw new Error('update after final');
    const b = chunk instanceof Uint8Array ? chunk : new Uint8Array(chunk);
    this._bytes += b.length;
    let off = 0;
    // fill internal buffer
    if (this._bufLen > 0) {
      const need = 64 - this._bufLen;
      const take = Math.min(need, b.length);
      this._buf.set(b.subarray(0, take), this._bufLen);
      this._bufLen += take; off += take;
      if (this._bufLen === 64) { this._block(this._buf, 0); this._bufLen = 0; }
    }
    // process full 64-byte blocks directly from the chunk
    while (off + 64 <= b.length) { this._block(b, off); off += 64; }
    if (off < b.length) {
      this._buf.set(b.subarray(off), 0);
      this._bufLen = b.length - off;
    }
    return this;
  }

  _block(p, off) {
    let a = this._a0, b = this._b0, c = this._c0, d = this._d0;
    const M = new Int32Array(16);
    for (let i = 0; i < 16; i++) {
      M[i] = p[off + i * 4] | (p[off + i * 4 + 1] << 8) |
             (p[off + i * 4 + 2] << 16) | (p[off + i * 4 + 3] << 24);
    }
    for (let i = 0; i < 64; i++) {
      let f, g;
      if (i < 16)      { f = F(b, c, d); g = i; }
      else if (i < 32) { f = G(b, c, d); g = (5 * i + 1) % 16; }
      else if (i < 48) { f = H(b, c, d); g = (3 * i + 5) % 16; }
      else             { f = I(b, c, d); g = (7 * i) % 16; }
      f = (f + a + K[i] + M[g]) | 0;
      a = d; d = c; c = b;
      b = (b + rotl(f, S[i])) | 0;
    }
    this._a0 = (this._a0 + a) | 0;
    this._b0 = (this._b0 + b) | 0;
    this._c0 = (this._c0 + c) | 0;
    this._d0 = (this._d0 + d) | 0;
  }

  final() {
    if (this._final) return this._digest();
    this._final = true;

    // MD5 padding: 0x80, then zero bytes until length ≡ 56 (mod 64),
    // then the 64-bit little-endian bit length of the message.
    const totalBytes = this._bytes;
    const bitLenLo = (totalBytes << 3) >>> 0;
    const bitLenHi = Math.floor(totalBytes / 0x20000000);

    const cur = this._bufLen;
    const zeroPad = ((56 - ((cur + 1) % 64)) + 64) % 64; // zero bytes after the 0x80
    const tail = new Uint8Array(cur + 1 + zeroPad + 8);
    tail.set(this._buf.subarray(0, cur), 0);
    tail[cur] = 0x80;
    // zeroPad bytes stay 0
    const dv = new DataView(tail.buffer);
    dv.setUint32(tail.length - 8, bitLenLo, true);
    dv.setUint32(tail.length - 4, bitLenHi, true);

    for (let off = 0; off < tail.length; off += 64) this._block(tail, off);
    return this._digest();
  }

  _digest() {
    const words = [this._a0, this._b0, this._c0, this._d0];
    let hex = '';
    for (const w of words) {
      const u = w >>> 0;
      for (let s = 0; s < 4; s++) {
        hex += ((u >>> (s * 8)) & 0xff).toString(16).padStart(2, '0');
      }
    }
    return hex;
  }
}

// one-shot: md5 of a Uint8Array/ArrayBuffer/ArrayBufferView -> hex
export function md5hex(data) {
  const m = new MD5();
  m.update(data);
  return m.final();
}

export { MD5 };
