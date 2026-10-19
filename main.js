// mpegcd — main thread. One drop zone, one live queue.
//
//   *.yuv / *.raw          -> compress   (lossless .mkv, self-verified)
//   *.mkv                  -> decompress (YUV back, named so YUView opens it as is)
//   *.zip                  -> opened; its .mkv / .yuv / md5 files are routed the same way
//   *.md5 / MD5SUMS.txt    -> hashes; every restored YUV is checked against them,
//                             whether the file arrives before, during or after it
//
// The queue is LIVE: adding files while it runs just appends to the FIFO.

import { createQueue } from './src/core/queue.js';
import { nameKey } from './src/core/yuvviewName.js';
import { toYuvviewLayout, bitDepthFromPixFmt, toPixFmt } from './src/core/probe.js';
import JSZip from 'jszip';

const $ = (sel) => document.querySelector(sel);

// ---- helpers --------------------------------------------------------------
function fmtBytes(n) {
  if (n == null) return '—';
  if (n < 1024) return n + ' B';
  if (n < 1024 * 1024) return (n / 1024).toFixed(1) + ' KB';
  if (n < 1024 * 1024 * 1024) return (n / 1024 / 1024).toFixed(2) + ' MB';
  return (n / 1024 / 1024 / 1024).toFixed(2) + ' GB';
}
function download(blob, name) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url; a.download = name;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 5000);
}
function el(tag, cls, text) {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text != null) e.textContent = text;
  return e;
}
const esc = (s) => String(s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

const statusEl = $('#ffmpeg-status');
statusEl.textContent = 'ffmpeg.wasm loads on first use (≈32 MB, cached)';

// ---- one job card ---------------------------------------------------------
function makeJobRow(job) {
  const root = el('article', 'job');
  const head = el('div', 'job-head');
  const kind = el('span', 'kind', job.kind === 'compress' ? 'YUV → MKV' : 'MKV → YUV');
  const name = el('span', 'job-name', job.name);
  name.title = job.name;
  const state = el('span', 'job-state');
  head.append(kind, name, state);
  const track = el('div', 'track');
  const fill = el('div', 'fill');
  track.append(fill);
  const meta = el('div', 'meta');
  const err = el('div', 'err');
  const dl = el('div', 'dl');
  const edit = el('div', 'geo');
  edit.hidden = true;
  // first-frame thumbnail beside the facts, so a wrong geometry is visible at a glance
  const thumb = el('canvas', 'thumb');
  thumb.hidden = true;
  const main = el('div', 'job-main');
  main.append(meta, edit, err, dl);
  const body = el('div', 'job-body');
  body.append(thumb, main);
  root.append(head, track, body);
  job._row = { root, fill, state, meta, edit, err, dl, thumb, href: null };
  job._updateRow = () => render(job);
  render(job);
  return root;
}

function render(job) {
  const r = job._row;
  r.root.className = 'job ' + job.status;
  const p = job.status === 'done' ? 1 : (job.progress || 0);
  const pct = Math.min(100, Math.round(p * 100));
  r.fill.style.width = pct + '%';
  r.state.textContent =
    job.status === 'done' ? 'done'
    : job.status === 'error' ? 'failed'
    : job.status === 'queued' ? 'queued'
    : `${pct}%${job.msg ? ' · ' + job.msg : ''}`;

  const facts = [];
  const add = (html, cls) => facts.push(`<span${cls ? ` class="${cls}"` : ''}>${html}</span>`);
  if (job.kind === 'compress') {
    if (job.geo) add(`${job.geo.width}×${job.geo.height} ${job.geo.pixFmt} · ${job.geo.frames}f`);
    if (job.compressedBytes != null) {
      const ratio = job.compressedBytes ? (job.originalBytes / job.compressedBytes).toFixed(1) : '∞';
      add(`${fmtBytes(job.originalBytes)} → <b>${fmtBytes(job.compressedBytes)}</b> <em>×${ratio}</em>`);
    }
    if (job.strategy) add(esc(job.strategy));
    if (job.status === 'done' && job.verified) add('bit-exact (MD5 round trip)', 'ok');
  } else {
    if (job.geo) add(`${job.geo.width}×${job.geo.height} ${job.geo.pixFmt}`);
    if (job.md5) add(`${fmtBytes(job.compressedBytes)} → <b>${fmtBytes(job.originalBytes)}</b>`);
    if (job.md5) {
      if (job.check === 'ok') add('MD5 match', 'ok');
      else if (job.check === 'bad') add('MD5 mismatch', 'bad');
      else add('no reference MD5 (add .md5 / MD5SUMS to verify)', 'dim');
    }
  }
  if (job.kind === 'compress' && job.q != null && job.q > 0.75) {
    add(`frame 0 is noise-like (q=${job.q.toFixed(2)}): check the geometry`, 'warn');
  }
  r.meta.innerHTML = facts.join('');
  if (job.thumb && !r.thumbDrawn) {
    const t = job.thumb, c = r.thumb;
    c.width = t.width; c.height = t.height;
    const img = new ImageData(t.width, t.height);
    for (let i = 0; i < t.width * t.height; i++) img.data.set([t.pixels[3 * i], t.pixels[3 * i + 1], t.pixels[3 * i + 2], 255], i * 4);
    c.getContext('2d').putImageData(img, 0, 0);
    c.hidden = false; r.thumbDrawn = true;
    c.title = 'frame 0' + (job.q != null ? `, coherence q=${job.q.toFixed(3)}` : '');
  }
  if (job.kind === 'compress' && (job.status === 'done' || job.status === 'error')) {
    const b = el('button', 'link', 'set geometry');
    b.type = 'button';
    b.addEventListener('click', () => openGeometryEditor(job));
    r.meta.appendChild(b);
  }
  r.meta.title = job.md5 ? 'md5 ' + job.md5 : '';
  r.err.textContent = job.error || '';

  const hasDl = job.status === 'done' && job.outBlob;
  if (hasDl && !r.href) {
    r.href = URL.createObjectURL(job.outBlob);
    const a = document.createElement('a');
    a.href = r.href;
    a.download = job.outName;
    a.textContent = job.outName;
    r.dl.replaceChildren(a);
  } else if (!hasDl && r.href) {
    URL.revokeObjectURL(r.href);
    r.href = null;
    r.dl.replaceChildren();
  }
  refreshActions();
}

// ---- fixing a wrong geometry guess -------------------------------------------
// A raw YUV has no header, so size and pix_fmt are inferred from the file size
// (a <w>x<h>_<pix_fmt> name settles it). When the inference is wrong, the card
// offers the candidates and manual entry, and re-encodes with the choice.
const PIX_FMTS = ['yuv420p', 'yuv420p10le', 'yuv420p12le', 'yuv420p16le', 'yuv422p', 'yuv422p10le', 'yuv422p16le',
  'yuv444p', 'yuv444p10le', 'yuv444p12le', 'yuv444p16le', 'gray', 'gray10le', 'gray16le'];

function openGeometryEditor(job) {
  const box = job._row.edit;
  if (!box.hidden) { box.hidden = true; return; }
  const g = job.geo || {};
  const num = (v) => { const i = el('input'); i.type = 'number'; i.min = 2; i.step = 2; i.value = v || ''; return i; };
  const w = num(g.width), h = num(g.height);
  const fmt = el('select');
  for (const f of PIX_FMTS) { const o = el('option', null, f); fmt.appendChild(o); }
  fmt.value = g.pixFmt || 'yuv420p';
  const alt = el('select');
  alt.appendChild(el('option', null, 'candidate geometries…'));
  for (const c of job.alternatives || []) {
    const pf = toPixFmt(c);
    const o = el('option', null, `${c.width}×${c.height} ${pf} · ${c.frames} fr` + (c.q != null ? ` · q=${c.q.toFixed(2)}` : ''));
    o.value = JSON.stringify([c.width, c.height, pf]);
    alt.appendChild(o);
  }
  alt.addEventListener('change', () => {
    if (!alt.value.startsWith('[')) return;
    const [cw, ch, pf] = JSON.parse(alt.value);
    w.value = cw; h.value = ch; fmt.value = pf;
  });
  const go = el('button', 'primary', 'Re-encode');
  go.type = 'button';
  go.addEventListener('click', () => {
    const width = +w.value, height = +h.value, pf = fmt.value;
    if (!(width > 0 && height > 0)) return;
    queue.discard(job);
    if (job._row.href) URL.revokeObjectURL(job._row.href);
    job._row.root.remove();
    track(queue.addCompress(job.file, { width, height, subsampling: toYuvviewLayout(pf).subsampling, bitDepth: bitDepthFromPixFmt(pf) }));
  });
  const lab = (t, c) => { const l = el('label', null, t); l.appendChild(c); return l; };
  box.replaceChildren(...(job.alternatives && job.alternatives.length ? [alt] : []), lab('width', w), lab('height', h), lab('pix_fmt', fmt), go);
  box.hidden = false;
}

// ---- the queue ------------------------------------------------------------
const listEl = $('#queue');
const actionsEl = $('#actions');
const zipBtn = $('#btn-zip');

const queue = createQueue({
  onJobStart: (job) => render(job),
  onJobProgress: (job) => render(job),
  onJobDone: (job) => render(job),
  onJobError: (job) => render(job),
});

// MD5SUMS.txt for everything compressed so far, in md5sum format and named after
// the .yuv each .mkv restores to (so `md5sum -c` works on the decoded files).
// Rebuilt whenever the set of finished compress jobs changes.
const md5Btn = $('#btn-md5');
let md5Text = null;
function refreshMd5File(jobs) {
  const lines = jobs.filter(j => j.kind === 'compress' && j.status === 'done' && j.md5).map(j => `${j.md5}  ${j.yuvName}`);
  const text = lines.length ? lines.join('\n') + '\n' : null;
  if (text === md5Text) return;
  md5Text = text;
  if (md5Btn.href && md5Btn.href.startsWith('blob:')) URL.revokeObjectURL(md5Btn.href);
  md5Btn.hidden = !text;
  if (text) md5Btn.href = URL.createObjectURL(new Blob([text], { type: 'text/plain' }));
  md5Btn.querySelector('.n').textContent = lines.length > 1 ? ` (${lines.length})` : '';
}

function refreshActions() {
  const jobs = queue.all();
  refreshMd5File(jobs);
  const done = jobs.filter(j => j.status === 'done' && j.outBlob).length;
  actionsEl.hidden = jobs.length === 0;
  zipBtn.disabled = done === 0;
  zipBtn.querySelector('.n').textContent = done > 1 ? ` (${done})` : '';
}

function track(job) {
  // show the card right away (queued), not only when its turn comes
  listEl.appendChild(makeJobRow(job));
  refreshActions();
  return job;
}

// ---- md5 sidecars: any order, any time -------------------------------------
const hashes = new Map();       // nameKey -> md5
let strays = [];                // bare hashes with no name

function ingestMd5Text(text) {
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    let m = line.match(/^([0-9a-fA-F]{32})\s+\*?\s*(.+)$/);             // md5sum:  <hash>  <name>
    if (m) { hashes.set(nameKey(m[2].trim()), m[1].toLowerCase()); continue; }
    m = line.match(/^MD5\s*\((.+)\)\s*=\s*([0-9a-fA-F]{32})$/i);        // BSD:     MD5 (<name>) = <hash>
    if (m) { hashes.set(nameKey(m[1].trim()), m[2].toLowerCase()); continue; }
    m = line.match(/^([0-9a-fA-F]{32})$/);                              // bare hash
    if (m) strays.push(m[1].toLowerCase());
  }
  bindHashes();
}

const expectedFor = (job) => hashes.get(nameKey(job.name)) || null;

function bindHashes() {
  const decs = queue.all().filter(j => j.kind === 'decompress');
  for (const j of decs) {
    const h = expectedFor(j);
    if (h && h !== j.expectedMd5) queue.setExpectedMd5(j, h);
  }
  // a lone hash with no name belongs to the lone file still waiting for one
  const open = decs.filter(j => !j.expectedMd5);
  if (strays.length === 1 && open.length === 1) {
    queue.setExpectedMd5(open[0], strays[0]);
    strays = [];
  }
  decs.forEach(j => j._updateRow && j._updateRow());
}

// ---- routing: look at what each file is ------------------------------------
const isMd5File = (n) => /\.(md5|md5sum|sum)$/i.test(n) || /(^|\/)md5sums?(\.txt)?$/i.test(n) || /\.md5\.txt$/i.test(n);
const md5First = (a, b) => (isMd5File(b.name) ? 1 : 0) - (isMd5File(a.name) ? 1 : 0);

function memFile(name, bytes) {
  return { name, size: bytes.length, arrayBuffer: async () => bytes.buffer };
}

function route(file) {
  if (/\.mkv$/i.test(file.name)) {
    const job = queue.addDecompress(file, expectedFor({ name: file.name }));
    track(job);
  } else if (isMd5File(file.name) || /\.txt$/i.test(file.name)) {
    return file.text().then(ingestMd5Text);
  } else {
    track(queue.addCompress(file));
  }
}

async function addFiles(fileList) {
  const files = Array.from(fileList).sort(md5First);   // a file dropped with its MD5 is checked as soon as it is done
  for (const f of files) {
    if (!/\.zip$/i.test(f.name)) { await route(f); continue; }
    const zip = await JSZip.loadAsync(f);
    const entries = Object.values(zip.files)
      .filter(e => !e.dir && !/(^|\/)(__MACOSX\/|\._)/.test(e.name))
      .map(e => ({ e, name: e.name.split('/').pop() }))
      .sort(md5First);
    for (const { e, name } of entries) {
      if (isMd5File(name) || /\.txt$/i.test(name)) {
        if (isMd5File(name) || /^md5/i.test(name)) ingestMd5Text(await e.async('string'));
        continue;                                       // README.txt and the like
      }
      await route(memFile(name, await e.async('uint8array')));
    }
  }
  refreshActions();
}

// ---- drop zone -------------------------------------------------------------
const drop = $('#drop');
const input = $('#file');
drop.addEventListener('keydown', (e) => {
  if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); input.click(); }
});
input.addEventListener('change', () => {
  if (input.files && input.files.length) addFiles(input.files);
  input.value = '';
});
// the whole window is a drop target; the zone just lights up
let depth = 0;
const hasFiles = (e) => e.dataTransfer && Array.from(e.dataTransfer.types || []).includes('Files');
window.addEventListener('dragenter', (e) => { if (hasFiles(e)) { depth++; drop.classList.add('drag'); } });
window.addEventListener('dragleave', () => { depth = Math.max(0, depth - 1); if (!depth) drop.classList.remove('drag'); });
window.addEventListener('dragover', (e) => { if (hasFiles(e)) e.preventDefault(); });
window.addEventListener('drop', (e) => {
  if (!hasFiles(e)) return;
  e.preventDefault();
  depth = 0; drop.classList.remove('drag');
  if (e.dataTransfer.files.length) addFiles(e.dataTransfer.files);
});

// ---- actions ---------------------------------------------------------------
$('#btn-clear').addEventListener('click', () => {
  for (const j of queue.all()) {
    if ((j.status === 'done' || j.status === 'error') && j._row) {
      if (j._row.href) URL.revokeObjectURL(j._row.href);
      j._row.root.remove();
    }
  }
  queue.clearDone();
  refreshActions();
});

zipBtn.addEventListener('click', async () => {
  const done = queue.all().filter(j => j.status === 'done' && j.outBlob);
  if (!done.length) return;
  zipBtn.disabled = true;
  try {
    const zip = new JSZip();
    const lines = [];
    for (const j of done) {
      zip.file(j.outName, await j.outBlob.arrayBuffer());
      // md5sum format, named after the .yuv the .mkv restores to, so
      // `md5sum -c MD5SUMS.txt` works on the decompressed files as they are
      lines.push(`${j.md5}  ${j.kind === 'compress' ? j.yuvName : j.outName}`);
    }
    zip.file('MD5SUMS.txt', lines.join('\n') + '\n');
    if (done.some(j => j.kind === 'compress')) zip.file('README.txt', zipReadme(done));
    download(await zip.generateAsync({ type: 'blob', compression: 'STORE' }), 'mpegcd.zip');
  } catch (e) {
    alert('zip failed: ' + e.message);
  } finally {
    refreshActions();
  }
});

// ---- README.txt for zips that leave the site -------------------------------
// Whoever receives such a zip may never have seen the site, so it says where to
// go, what is inside and how to decode (with and without the site).
const SITE_URL = 'https://lisa-vr.github.io/mpegcd/';

function zipReadme(done) {
  const comp = done.filter(j => j.kind === 'compress');
  const rows = comp.map(j => {
    const g = j.geo;
    return `  ${j.outName}\n      ${g.width}x${g.height} ${g.pixFmt}, ${g.frames} frame${g.frames > 1 ? 's' : ''}, ${j.strategy}`;
  });
  const plain = comp.filter(j => !/^split/i.test(j.strategy || ''));
  const cmds = plain.map(j => `    ffmpeg -i ${j.outName} -f rawvideo -pix_fmt ${j.geo.pixFmt} ${j.yuvName}`);
  return [
    'mpegcd: lossless YUV archive',
    '============================',
    '',
    'These files were compressed losslessly (bit-exact) with mpegcd:',
    '',
    '    ' + SITE_URL,
    '',
    'To get the YUV files back, open that page and drop this .zip on it. Everything',
    'runs in your browser; nothing is uploaded. Each restored file is checked against',
    'MD5SUMS.txt automatically.',
    '',
    'Contents',
    ...rows,
    '  MD5SUMS.txt',
    '      md5 of each original YUV, in md5sum format, named after the restored file:',
    '      `md5sum -c MD5SUMS.txt` works on the decoded files.',
    '',
    'Without the website',
    ...(cmds.length ? ['  Files coded as plain FFV1 or x264 are ordinary Matroska:', ...cmds] : []),
    ...(plain.length < comp.length ? ['  Files marked "split" keep the high and low bytes of each sample as two video', '  streams and need the website to be merged back.'] : []),
    '',
    'The restored .yuv files are named <name>_<w>x<h>_<pix_fmt>.yuv, which YUView',
    'opens directly without changing the format settings.',
    '',
  ].join('\n');
}

// ---- sample ----------------------------------------------------------------
(function wireDemo() {
  const btn = $('#btn-demo');
  const lbl = btn.querySelector('.lbl');
  const orig = lbl.textContent;
  btn.addEventListener('click', async () => {
    btn.disabled = true;
    lbl.textContent = 'Fetching…';
    try {
      const res = await fetch(new URL('demo/demo_pair.zip', document.baseURI), { cache: 'no-store' });
      if (!res.ok) throw new Error('HTTP ' + res.status);
      download(await res.blob(), 'demo_pair.zip');
      lbl.textContent = 'Saved; drop the .zip here to decode';
    } catch {
      lbl.textContent = 'Sample unavailable';
    }
    setTimeout(() => { btn.disabled = false; lbl.textContent = orig; }, 4000);
  });
})();

// ffmpeg status: ok after the first success
setInterval(() => {
  if (queue.all().some(j => j.status === 'done') && statusEl.className !== 'status ok') {
    statusEl.textContent = 'ffmpeg.wasm ready · local processing';
    statusEl.className = 'status ok';
  }
}, 500);

refreshActions();
