#!/bin/bash
# Rebuilds gui/dist/Rsync pattern maker.app (and its .zip) from the current source,
# then shows it in Finder. Double-click, or run in a Terminal.
cd "$(dirname "$0")/gui" || exit 1
export PATH="/opt/homebrew/bin:/usr/local/bin:$PATH"
export ELECTRON_OVERRIDE_DIST_PATH="$HOME/.electron/44.4.5"
export ELECTRON_EXEC_PATH="$ELECTRON_OVERRIDE_DIST_PATH/Electron.app/Contents/MacOS/Electron"
if [[ ! -d node_modules ]]; then
    npm install --ignore-scripts && node scripts/ensure-electron.mjs || exit 1
fi
npm run package --silent || exit 1
open -R "dist/Rsync pattern maker.app"
