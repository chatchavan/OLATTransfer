// Electron 44's package no longer downloads its binary on install; electron-vite then fails with
// "Electron uninstall". Download it (once) if node_modules/electron/path.txt is missing.
// If ELECTRON_OVERRIDE_DIST_PATH points at a shared copy (see ~/.electron), only write path.txt.
import { existsSync, writeFileSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'

const require = createRequire(import.meta.url)
let dir
try {
  dir = dirname(require.resolve('electron/package.json'))
} catch {
  process.exit(0) // electron not installed (e.g. production install)
}
const shared = process.env.ELECTRON_OVERRIDE_DIST_PATH
const bin = 'Electron.app/Contents/MacOS/Electron'
if (shared && existsSync(join(shared, bin))) {
  if (!existsSync(join(dir, 'path.txt'))) writeFileSync(join(dir, 'path.txt'), bin)
} else if (!existsSync(join(dir, 'path.txt')) || !existsSync(join(dir, 'dist'))) {
  console.log('Downloading the Electron binary…')
  execFileSync(process.execPath, [join(dir, 'install.js')], { stdio: 'inherit' })
}
