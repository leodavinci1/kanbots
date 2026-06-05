#!/bin/bash
set -e
cd "$(dirname "$0")"

export PATH="$HOME/.nvm/versions/node/v20.19.0/bin:$HOME/.local/bin:/usr/local/bin:/usr/bin:/bin"

ELECTRON="node_modules/.pnpm/electron@33.4.11/node_modules/electron/dist/Electron.app/Contents/MacOS/Electron"

echo "[launch-dev] building api..."
pnpm --filter @kanbots/api build

echo "[launch-dev] building desktop main..."
cd packages/desktop
pnpm run build:main
pnpm run copy:web
cd ../..

echo "[launch-dev] killing old instance..."
pkill -f "kanbots-fork.*main.cjs" 2>/dev/null || true
sleep 1

echo "[launch-dev] launching..."
nohup "$ELECTRON" packages/desktop/dist/main.cjs > /tmp/kanbots-fork.log 2>&1 &
echo "[launch-dev] started PID $!"
