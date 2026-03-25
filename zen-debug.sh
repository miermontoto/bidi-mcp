#!/bin/sh
# inyectar fix de dead keys en todos los perfiles antes de lanzar Zen
for d in "$HOME"/.zen/*/; do
  grep -q focusmanager "$d/user.js" 2>/dev/null || echo 'user_pref("focusmanager.testmode", false);' >> "$d/user.js"
done
exec /home/mier/apps/zen/zen --remote-debugging-port=9222
