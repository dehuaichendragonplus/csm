#!/bin/bash
set -e
script_dir=$(cd "$(dirname "$0")" && pwd)
cd "$script_dir"
if [ ! -d node_modules ]; then
  echo "[sync-manager] installing dependencies (first run)…"
  npm install
fi
exec node server.js "$@"
