#!/usr/bin/env bash
# Serve the site on a fixed port, bound to all interfaces (0.0.0.0).
#   ./serve.sh          production build (builds first if dist/ is stale or missing)
#   ./serve.sh dev      Vite dev server with hot reload
# Override the port with PORT=8080 ./serve.sh. Fails instead of picking another
# port if it is taken, so the URL you share never changes.
set -euo pipefail
cd "$(dirname "$0")"
PORT="${PORT:-5290}"
mode="${1:-prod}"

[ -d node_modules ] || npm install

host="$(hostname -f 2>/dev/null || hostname)"
echo "mpegcd: http://${host}:${PORT}/  (listening on 0.0.0.0:${PORT})"

case "$mode" in
  dev)  exec npx vite --host 0.0.0.0 --port "$PORT" --strictPort ;;
  prod|preview)
    if [ ! -d dist ] || [ -n "$(find src main.js index.html style.css vite.config.js -newer dist -print -quit)" ]; then
      npm run build
    fi
    exec npx vite preview --host 0.0.0.0 --port "$PORT" --strictPort ;;
  *) echo "usage: $0 [prod|dev]" >&2; exit 2 ;;
esac
