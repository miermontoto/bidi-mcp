#!/bin/sh
# resuelve node >= 22 via fnm y lanza el servidor en modo HTTP
FNM_DIR="$HOME/.local/share/fnm"
NODE_DIR=$(find "$FNM_DIR/node-versions" -maxdepth 1 -name 'v22*' -type d | sort -V | tail -1)
exec "$NODE_DIR/installation/bin/node" "$(dirname "$0")/server.mjs" --http 3100
