// Builds dist/Rsync pattern maker.app (arm64) plus a .zip of it for other Macs, from the shared
// Electron (~/.electron/<version>, see ~/.claude/CLAUDE.md) instead of @electron/packager:
// copies Electron.app, adds the app code, bundles the OLATTransfer scripts and a prebuilt
// OLATFinderHelper.app in Contents/Resources/olat, sets the name, and signs ad hoc.
// The app installs the scripts to ~/Library/Application Support/OLATTransfer/scripts on launch.
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, utimesSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { dirname, join, resolve } from 'node:path'
import { homedir, tmpdir } from 'node:os'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const gui = resolve(here, '..')
const repo = resolve(gui, '..')
const NAME = 'Rsync pattern maker'
const BUNDLE_ID = 'com.local.olattransfer.rsync-pattern-maker'
const pkg = JSON.parse(readFileSync(join(gui, 'package.json'), 'utf8'))
const dist = process.env.ELECTRON_OVERRIDE_DIST_PATH || join(homedir(), '.electron', '44.4.5')
const electronApp = join(dist, 'Electron.app')
if (!existsSync(electronApp)) throw new Error(`No shared Electron at ${electronApp}`)
const run = (cmd, args, opts) => execFileSync(cmd, args, Object.assign({ stdio: ['ignore', 'pipe', 'inherit'] }, opts)).toString()

// Assemble in a temp folder; replace dist/ only when everything worked.
const work = mkdtempSync(join(tmpdir(), 'rpm-build-'))
const out = join(work, `${NAME}.app`)
run('ditto', ['--arch', 'arm64', electronApp, out])
const res = join(out, 'Contents', 'Resources')
rmSync(join(res, 'default_app.asar'), { force: true })

// App code (no production dependencies: package.json has only electron as a dev dependency).
if (Object.keys(pkg.dependencies || {}).length) throw new Error('package.json has dependencies: copy them into the bundle')
const app = join(res, 'app')
for (const p of ['package.json', 'main.js', 'preload.js', 'lib', 'renderer']) {
  cpSync(join(gui, p), join(app, p), { recursive: true, filter: (s) => !s.endsWith('.DS_Store') })
}

// The OLATTransfer scripts.
const olat = join(res, 'olat')
mkdirSync(olat)
for (const f of ['olatTransfer.sh', 'olat-common.sh', 'olat-idle-eject-check.sh', 'olat-finder-helper.swift', 'config.yml']) cpSync(join(repo, f), join(olat, f))

// OLATFinderHelper.app, built by the real ensure_finder_helper into a scratch STATE_DIR, ad hoc
// (other Macs have no local signing identity; olat-common.sh re-signs it there with whatever
// is available).
const state = join(work, 'state')
run('/bin/bash', ['-c', `source "$1"
STATE_DIR="$2"; HELPER_APP="$STATE_DIR/OLATFinderHelper.app"; HELPER_APP_EXE="$HELPER_APP/Contents/MacOS/OLATFinderHelper"
CODESIGN_IDENTITY_CN="no identity at build time"
ensure_signing_identity() { :; }
log_line() { echo "$*" >&2; }
ensure_finder_helper
[[ -x "$HELPER_APP_EXE" ]]`, 'bash', join(olat, 'olat-common.sh'), state])
cpSync(join(state, 'OLATFinderHelper.app'), join(olat, 'OLATFinderHelper.app'), { recursive: true, verbatimSymlinks: true })

// Name, id, version, and the Automation prompt text: Run mounts the volume with osascript, which
// macOS attributes to this app; without NSAppleEventsUsageDescription it is denied with no prompt.
const plist = join(out, 'Contents', 'Info.plist')
for (const [k, v] of [
  ['CFBundleName', NAME], ['CFBundleDisplayName', NAME], ['CFBundleIdentifier', BUNDLE_ID],
  ['CFBundleShortVersionString', pkg.version], ['CFBundleVersion', pkg.version],
  ['NSAppleEventsUsageDescription', `${NAME} asks Finder to mount the OLAT WebDAV volume.`]
]) run('plutil', ['-replace', k, '-string', v, plist])
run('plutil', ['-replace', 'LSMinimumSystemVersion', '-string', '26.0', plist])

const now = new Date()
utimesSync(out, now, now)                          // ditto keeps Electron.app's old date
run('codesign', ['--force', '--deep', '--sign', '-', out])
run('codesign', ['--verify', '--deep', '--strict', out])

const outDir = join(gui, 'dist')
mkdirSync(outDir, { recursive: true })
const finalApp = join(outDir, `${NAME}.app`)
rmSync(finalApp, { recursive: true, force: true })
run('ditto', [out, finalApp])
const zip = join(outDir, `${NAME}-${pkg.version}-arm64.zip`)
rmSync(zip, { force: true })
run('ditto', ['-c', '-k', '--sequesterRsrc', '--keepParent', finalApp, zip])
rmSync(work, { recursive: true, force: true })
console.log(finalApp + '\n' + zip)
