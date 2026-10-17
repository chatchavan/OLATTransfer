// Packaged app only: copies the OLATTransfer scripts bundled in the .app to a fixed folder
// outside it, so saved .command files and the idle-eject LaunchAgent keep working when the
// app is moved, replaced by a newer build, or run on a Mac without this repository.
const fs = require('fs')
const path = require('path')

const SCRIPTS = ['olatTransfer.sh', 'olat-common.sh', 'olat-idle-eject-check.sh']
const HELPER_SOURCE = 'olat-finder-helper.swift'
const HELPER_APP = 'OLATFinderHelper.app'
const HELPER_EXE = path.join(HELPER_APP, 'Contents', 'MacOS', 'OLATFinderHelper')

function same(a, b) {
  try { return fs.readFileSync(a).equals(fs.readFileSync(b)) } catch { return false }
}

// from: the bundled folder (Contents/Resources/olat). to: where the scripts are installed.
// stateDir: olat-common.sh's STATE_DIR, where ensure_finder_helper keeps OLATFinderHelper.app.
// Returns the list of what was changed (empty when everything was up to date).
function installScripts(from, to, stateDir) {
  const changed = []
  fs.mkdirSync(to, { recursive: true })
  for (const f of SCRIPTS) {
    const dst = path.join(to, f)
    if (same(path.join(from, f), dst)) continue
    fs.copyFileSync(path.join(from, f), dst)
    fs.chmodSync(dst, 0o755)
    changed.push(f)
  }
  // config.yml holds the user's settings: only the first install writes it.
  if (!fs.existsSync(path.join(to, 'config.yml'))) {
    fs.copyFileSync(path.join(from, 'config.yml'), path.join(to, 'config.yml'))
    changed.push('config.yml')
  }
  // ensure_finder_helper compiles the helper with swiftc when the binary is missing or older
  // than the source, and other Macs may have no swiftc. So install the prebuilt helper (built
  // from the bundled source) when the helper is missing or an earlier install's source changed,
  // then date the source before the binary so it is not rebuilt. A helper that olatTransfer.sh
  // built before the first install is kept: it may hold a locally signed Automation grant.
  const src = path.join(to, HELPER_SOURCE)
  const exe = path.join(stateDir, HELPER_EXE)
  const fresh = !same(path.join(from, HELPER_SOURCE), src)
  const replace = !fs.existsSync(exe) || (fresh && fs.existsSync(src))
  if (fs.existsSync(path.join(from, HELPER_APP)) && replace) {
    fs.rmSync(path.join(stateDir, HELPER_APP), { recursive: true, force: true })
    fs.mkdirSync(stateDir, { recursive: true })
    fs.cpSync(path.join(from, HELPER_APP), path.join(stateDir, HELPER_APP), { recursive: true, verbatimSymlinks: true })
    const now = new Date()
    fs.utimesSync(exe, now, now)
    changed.push(HELPER_APP)
  }
  if (fresh) {
    fs.copyFileSync(path.join(from, HELPER_SOURCE), src)
    changed.push(HELPER_SOURCE)
  }
  if (fs.existsSync(exe)) {
    const t = new Date(fs.statSync(exe).mtimeMs - 60000)
    if (fs.statSync(src).mtimeMs >= fs.statSync(exe).mtimeMs) fs.utimesSync(src, t, t)
  }
  return changed
}

module.exports = { installScripts, SCRIPTS, HELPER_SOURCE, HELPER_APP }
