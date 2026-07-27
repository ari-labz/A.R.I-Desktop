#!/usr/bin/env bash
set -e
export PATH="$HOME/.bun/bin:$PATH"

if ! command -v bun &>/dev/null; then
  echo "[ARI.Desktop] Bun not found — installing..."
  curl -fsSL https://bun.sh/install | bash
  export PATH="$HOME/.bun/bin:$PATH"
fi

echo "[ARI.Desktop] Installing dependencies..."
bun install

# Bun skips Electron's post-install binary download — run it explicitly if missing
if [ ! -f "node_modules/electron/dist/Electron.app/Contents/MacOS/Electron" ]; then
  echo "[ARI.Desktop] Downloading Electron binary..."
  bun node_modules/electron/install.js
fi

# Strip Gatekeeper quarantine then ad-hoc sign so macOS treats it as locally built
xattr -rd com.apple.quarantine node_modules/electron/dist/Electron.app 2>/dev/null || true
codesign --force --deep --sign - node_modules/electron/dist/Electron.app 2>/dev/null || true

echo "[ARI.Desktop] Launching Electron..."
exec bun run dev
