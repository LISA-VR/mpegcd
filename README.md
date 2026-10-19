# mpegcd — YUV ⇄ lossless-compressed video, in your browser

**Live site: https://lisa-vr.github.io/mpegcd/**

`mpegcd` is a **static website** that turns raw YUV files into the smallest
possible **truly lossless** compressed video, and back again — **entirely on
your own machine**. Nothing is uploaded. Your YUV data never leaves your
computer; the site only ships the code and the compressed-WASM ffmpeg that
does the work.

It exists because in MPEG standardisation we share a lot of YUV — depth maps
(`DERS_z0300y0325x0404.yuv`), chroma/luma, 8/10/16-bit — and a 300-frame clip
is ~2 GB raw. Sharing the raw file is heavy and slow. ffmpeg can compress this
kind of video almost perfectly losslessly, but **finding the parameters that
are *actually* lossless is easy to get wrong** (several "lossless" modes
silently drop chroma or bit-depth — see [Why this is hard](#why-this-is-hard)).
`mpegcd` picks the right ones for you and **proves** it was lossless.

## What it does

One drop zone, one live queue. The file type decides the operation:

| Dropped | Result |
|---|---|
| `.yuv` / `.raw` | compressed to lossless `.mkv`, decoded again and MD5-compared with the source before it is offered |
| `.mkv` | restored to `.yuv`, named so that YUView opens it unaided (see [Naming](#naming-convention-yuview-compatible)) |
| `.zip` | opened; its `.mkv`, `.yuv` and MD5 files are routed as above |
| `.md5`, `MD5SUMS(.txt)` | reference hashes (md5sum or BSD format, or a bare hash) |

**Verification is late-bound.** A restored YUV is compared with the reference
MD5 whenever one is available: before, during or after the decode. Without one
the file is still downloadable, marked *no reference MD5*; adding an MD5 file
later verifies it in place, and a mismatch withdraws the download. Hashes are
matched to files by stem, ignoring the extension and the `_<w>x<h>_<pix_fmt>`
decoration, so `MD5SUMS.txt` written for the originals works on the `.mkv`s.

**Geometry.** A raw YUV carries no header. Frame size and `pix_fmt` are taken
from a YUView-style name (`<w>x<h>` and `yuv420p16le` in the name), else
inferred from the file size against a list of standard sizes, else a bounded
sweep. Without a name, the candidates are ranked on the data itself
(`src/core/frameCheck.js`): a no-reference coherence statistic of the first
luma plane, q = mean neighbour difference / that of white noise (about 1 for
noise, much lower for a picture), the frame 0 / frame 1 agreement to tell
640x360 from 640x480, and the largest sample value to tell 10-bit from 16-bit
data stored in 16 bits. (VMAF and LPIPS are full-reference metrics, so they
do not apply to a lone frame.) Each card shows the luma of frame 0 and warns
when q > 0.75. A wrong inference can be corrected with *set geometry*
(candidates with their q, or manual entry), which re-encodes. On decode the `yuvview` tag stored in the
`.mkv` takes precedence over the file name.

**MD5SUMS.txt** is offered as a download as soon as a file has been compressed
and is rebuilt as more files are dropped (md5sum format, one line per `.yuv`).

**Bulk.** *Download all* produces one `.zip` of the finished files plus an
`MD5SUMS.txt` named after the `.yuv` each `.mkv` restores to, so
`md5sum -c MD5SUMS.txt` works on the decoded files as they are.

**Sample.** The page offers real dataset frames, unmodified (nothing resized or
cropped): three adjacent cameras of the *ULB ToysTable* dataset (Bonatto,
Fachada, Lafruit; CC BY-NC-SA) as the 3 frames of a 1920×1080 8-bit Kinect
texture and of its 16-bit DERS depth, already compressed (3.4 MB) with an
`MD5SUMS.txt`. Drop the zip back on the page to decode and verify it. It is
rebuilt from the dataset by `tools/make-demo.mjs`.

## Why this is hard (and why the parameters matter)

This is the core of the tool, so it's worth stating plainly. "Lossless" in
ffmpeg has traps:

| Encoder | Container | What it actually does | Lossless? |
|---|---|---|---|
| `png` | `.mp4` | Internally converts to **rgb24** — a YUV→RGB→YUV round-trip. **Drops chroma sub-sampling.** | ❌ No, for YUV420/422/444 |
| `qtrle` | `.mov` | Supports only `rgb24/gray` — **drops chroma.** | ❌ No, for YUV |
| `ffv1` | `.mp4` | MP4 **has no FFV1 tag** — the muxer refuses. | ❌ Can't even mux |
| **`ffv1`** | **`.mkv`** | Stores the **original pix_fmt** (`yuv420p`, `yuv420p10le`, …). No colour-space conversion. | ✅ **Yes** |

So the only combination that is *both* MP4-adjacent-friendly *and* genuinely
lossless for YUV (including 10/16-bit) is **FFV1 level 3, coder 1, in
Matroska**. We verified this on real data: a `yuv420p` file and a
`yuv420p10le` file both round-trip **byte-for-byte** through
`ffv1 -level 3 -coder 1 → .mkv → rawvideo`. `png`/`qtrle` in `.mp4` failed the
same test (chroma lost). That's the parameter choice `mpegcd` makes for you.

> **Note on the container.** You may have asked for MP4. MP4 simply cannot
> carry FFV1, and every MP4-capable "lossless" codec (png, qtrle, prores) is
> not actually lossless for YUV. Matroska (`.mkv`) is the lossless container;
> `mpegcd` uses it. If you specifically need the *bytes* to be in an MP4
> shell for some pipeline, say so and we'll add a raw-in-MP4 fallback with a
> loud warning that it's only for the gray/8-bit-Y-plane cases.

## Picking the smallest lossless encoding

FFV1 is a fine default, but on real MPEG data it is far from the smallest
option for 16-bit content. So for each file `mpegcd` **tries a few strategies
on a sample of the frames** (up to 8 frames / 24 MB; a small file is encoded in
full and the winner reused) and keeps the smallest. All are bit-exact lossless
and are still self-verified by decoding and re-hashing:

| Strategy | When it is tried | What it is |
|---|---|---|
| `FFV1` | always | level 3, range coder with large contexts (`-coder 2 -context 1`), long GOP so contexts keep learning across frames |
| `x264` lossless (`-qp 0`) | 8-bit streams | inter-frame prediction; wins on static / slowly-changing content |
| **split** high/low | >8-bit samples | each sample is cut into a *high* plane (top 8 bits) and a *low* plane (the rest); each is an ordinary 8-bit video stream, coded by whichever of FFV1 / x264 is smaller, and both are muxed in the same `.mkv` |

The split is what makes 16-bit depth maps so much smaller: FFV1's 16-bit
modelling is weak, while x264 lossless on the two 8-bit planes exploits both
spatial and temporal redundancy. Decoding detects the two-stream layout by
itself, so older single-stream `.mkv` files keep working.

Not used: **x265** lossless (it would beat the others on some 8-bit depth
maps) — the single-thread ffmpeg.wasm build deadlocks when x265 creates its
thread pool. **HEVC/H.264 directly on 10-bit+** is not available (8-bit x264
only) and x265 is much worse than FFV1 on noisy texture anyway.

## Measured (real data, in the browser)

Real MPEG data (dRVS *ChocoFountain*, 3712×2064), cropped to 640×360 × 40
frames, compressed and decompressed **inside headless Chromium with the actual
ffmpeg.wasm**, MD5-verified after the round trip:

| Source | Raw | FFV1 `-coder 1` (before) | Now | Strategy chosen |
|---|---:|---:|---:|---|
| 16-bit depth, 4:2:0 | 27.6 MB | 1.12 MB (×24.8) | **0.47 MB (×58.5)** | split: x264 + x264 |
| 10-bit texture, 4:2:0 | 27.6 MB | 4.36 MB (×6.3) | **4.05 MB (×6.8)** | split: FFV1 (top 8 bits) + x264 (low 2 bits) |
| 16-bit DERS depth (ToysTable sample), 1920×1080 × 3 | 18.7 MB | 0.288 MB (×64.9) | **0.201 MB (×93)** | split: x264 + x264 |
| 8-bit Kinect texture (ToysTable sample), 1920×1080 × 3 | 9.3 MB | 3.24 MB (×2.9) | 3.20 MB (×2.9) | FFV1 |

Natural (noisy) texture is close to its lossless limit with these codecs;
depth maps are where the structure is, and where the gain is.

## Naming convention (YUView-compatible)

For a raw `.yuv`, [YUView](https://github.com/IENT/YUView) ignores metadata
and reads the format from the **file name** (`FrameFormatGuess.cpp`,
`PixelFormatYUVGuess.cpp`, lower-cased):

- **size** — the leftmost `<w>x<h>` (or `<w>*<h>`) followed by `_` or `.`;
- **format** — an ffmpeg-style token `yuv<400|420|422|444>p[<bits><le|be>]`.

`mpegcd` therefore names both the `.mkv` and the `.yuv` it restores
`<name>_<w>x<h>_<pix_fmt>`, e.g.
`ToysTable_B_DERS_depth_1920x1080_yuv420p16le.yuv`, and YUView opens it with no
change to the format settings. A name that already says the right thing is kept
as is. Because the *leftmost* match wins, a base name such as
`DERS_z0300y0325x0404` (which contains `0325x0404`) gets the size placed in
front: `1920x1080_yuv420p16le_DERS_z0300y0325x0404`. Stray format tokens in the
base name are removed so the result is unambiguous. `test/naming.test.mjs`
checks 126 name/format/size combinations against these rules.

The same format is also stored in the Matroska `yuvview` tag as YUView's own
format string, `<w>;<h>;YUV;<pixelformat>`. Older `<name>__<w>_<h>__YUV_420_8_bit.mkv`
files still decode.

## Privacy / architecture

- **100% client-side.** Static site (no backend, no API). The only "server" is
  a static file host (GitHub Pages works).
- **ffmpeg runs as WebAssembly** (`@ffmpeg/ffmpeg` + `@ffmpeg/core`). The
  `FFmpeg` instance drives ffmpeg.wasm's *own* internal worker, so the heavy
  decode/encode never blocks the UI thread. (We deliberately do **not** wrap it
  in a second worker — that double-nesting breaks the internal worker's URL
  resolution under a bundler.)
- **MD5** is computed in the browser (WebCrypto doesn't ship MD5, so we bundle
  a small WASM/JS MD5 — same hash `md5sum` produces, verified).
- **ZIP** in/out uses JSZip in the browser.

## Non-goals (for now)

- No inter-user sharing/registry. If User A compresses a clip, User B gets it
  by normal file transfer; the site does not host anyone's data.
- No audio, no subtitles — YUV video only.
- No frame re-ordering, no trimming, no re-encoding between pix_fmts.
  In-pix_fmt → compressed → out-same-pix_fmt, byte-identical.

## Development

```
npm install          # also copies the ffmpeg.wasm core into public/ffmpeg/
npm run dev          # dev server, bound to 0.0.0.0 (reachable on the LAN)
npm run build        # static site -> dist/
npm run preview      # serve dist/, bound to 0.0.0.0
./serve.sh           # build if stale + serve dist/ on fixed port 5290, 0.0.0.0
./serve.sh dev       # same, with the Vite dev server (hot reload)
npm test             # full test suite
```

`dev`, `preview` and `serve.sh` bind to **`0.0.0.0`** on the fixed port **5290**
(`PORT=8080 ./serve.sh` to change it; it fails rather than hopping to another
port, so the URL never moves). The site is therefore reachable from other machines on your network (not just `localhost`). Pass
`--host 127.0.0.1` if you want it loopback-only.

### Module layout

```
src/
  core/
    ffmpeg.js        # FFmpeg (ffmpeg.wasm) singleton: load once, reuse
    workerClient.js  # compress()/decompress() — strategy trials + the ffmpeg CLI calls
    strategy.js      # codec arg sets, hi/lo plane split & merge (pure, unit-tested)
    probe.js         # geometry/pix_fmt probing + filename parsing
    yuvviewName.js   # YUView format string + filename round-trip
    md5.js           # MD5 (same hash as md5sum)
    queue.js         # the live processing queue + in-browser self-verify
  main.js            # UI wiring (in the page; ffmpeg's own worker does the work)
public/
  ffmpeg/            # ffmpeg.wasm core (copied here by postinstall)
  demo/demo_pair.zip # the real ToysTable depth+color sample (.mkv x2 + MD5SUMS.txt)
test/
  md5.test.mjs       # MD5 vectors + chunked hashing
  naming.test.mjs    # YUView name <-> format-string round-trip
  strategy.test.mjs  # hi/lo plane split/merge is an exact bijection
  probe.test.mjs     # geometry inference (standard sizes, YUView-style names)
  zip.test.mjs       # bulk-zip assembly (videos + MD5SUMS.txt)
  roundtrip.mjs      # 10 pix_fmts through the exact prod args, byte-identical
```

### Verification gate

`npm test` runs the losslessness gate: **10 pixel formats** (gray / 4:2:0 /
4:2:2 / 4:4:4 across 8/10/12/16-bit) must round-trip through the *exact*
encoder settings used in production and match byte-for-byte, MD5-verified. If
any reference fails, the build is red. Every file the site compresses is
additionally self-verified in the browser (decoded back and re-hashed) before
it can be downloaded.
