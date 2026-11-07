#!/bin/sh
# Restart the local bili proxy so a freshly installed build is loaded.
set -u

PORT=${BILI_PORT:-18787}
PKG=${BILI_PKG:-"$HOME/.dsh/profiles/desktop/node_modules/billion-context"}
NODE=${NODE_BIN:-$(command -v node || true)}
HEALTH="http://127.0.0.1:$PORT/__bili/health"

alive() { curl -s -m 2 -o /dev/null "$HEALTH"; }

if [ -z "$NODE" ]; then
  echo "node not found; set NODE_BIN=/path/to/node" >&2
  exit 1
fi

OLD=$(lsof -nP -iTCP:"$PORT" -sTCP:LISTEN 2>/dev/null | awk 'NR==2{print $2}')
echo "old pid: ${OLD:-none}"

curl -s -m 3 -X POST "http://127.0.0.1:$PORT/__bili/shutdown" >/dev/null 2>&1
for _ in 1 2 3 4 5 6 7 8 9 10 11 12 13 14 15 16 17 18 19 20; do
  alive || break
  sleep 0.5
done
alive && echo "after shutdown: still up" || echo "after shutdown: down"

for _ in 1 2 3 4 5 6 7 8 9 10 11 12 13 14 15 16 17 18 19 20; do
  alive && break
  sleep 0.5
done

if ! alive; then
  echo "not supervised, starting by hand"
  nohup "$NODE" "$PKG/dist/index.js" start --host 127.0.0.1 --port "$PORT" \
    > /tmp/bili-restart.log 2>&1 &
  for _ in 1 2 3 4 5 6 7 8 9 10 11 12 13 14 15 16 17 18 19 20 21 22 23 24 25 26 27 28 29 30; do
    alive && break
    sleep 0.5
  done
fi

alive && echo "health: up" || echo "health: down"
NEW=$(lsof -nP -iTCP:"$PORT" -sTCP:LISTEN 2>/dev/null | awk 'NR==2{print $2}')
echo "new pid: ${NEW:-none}"
