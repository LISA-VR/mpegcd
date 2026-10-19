// @ts-check
import { defineConfig } from 'vite';

// Static site. The ffmpeg core (ffmpeg-core.wasm/.js) is copied verbatim into
// dist/ by Vite's asset handling because we reference it via new URL(...)
// inside the worker. We keep it in /public so it lands at the web root with a
// stable path the worker can fetch.
export default defineConfig({
  base: './',
  build: {
    outDir: 'dist',
    emptyOutDir: true,
    // The ffmpeg core wasm is ~32MB; keep chunk warnings quiet.
    chunkSizeWarningLimit: 40960,
    target: 'es2020',
  },
  // ffmpeg.wasm spawns its own worker via new URL(); Vite's dev pre-bundling
  // rewrites that URL and breaks it, so keep these out of the optimizer.
  optimizeDeps: { exclude: ['@ffmpeg/ffmpeg', '@ffmpeg/util'] },
  // Fixed port, reachable from other machines (see serve.sh).
  server: { host: '0.0.0.0', port: 5290, strictPort: true },
  preview: { host: '0.0.0.0', port: 5290, strictPort: true },
});
