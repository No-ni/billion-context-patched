#!/bin/sh
# Install this build over an existing billion-context installation.
set -eu

HERE=$(cd "$(dirname "$0")" && pwd)
TARGET=${1:-"$HOME/.dsh/profiles/desktop/node_modules/billion-context"}

if [ ! -f "$TARGET/package.json" ] || [ ! -d "$TARGET/dist" ]; then
  echo "no billion-context installation at $TARGET" >&2
  exit 1
fi

STAMP=$(date +%Y%m%d-%H%M%S)
cp "$TARGET/dist/index.js" "$TARGET/dist/index.js.bak-$STAMP"
cp "$HERE/../dist/index.js" "$TARGET/dist/index.js"
chmod +x "$TARGET/dist/index.js"

echo "installed into $TARGET"
echo "backup: dist/index.js.bak-$STAMP"
echo "restart to activate: $HERE/restart-bili.sh"
