const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('fs')
const os = require('os')
const path = require('path')

const { installScripts } = require('../lib/install.js')

function bundle(root, swift = 'swift v1') {
  const from = path.join(root, 'olat')
  fs.mkdirSync(path.join(from, 'OLATFinderHelper.app', 'Contents', 'MacOS'), { recursive: true })
  for (const f of ['olatTransfer.sh', 'olat-common.sh', 'olat-idle-eject-check.sh']) fs.writeFileSync(path.join(from, f), f + ' v1')
  fs.writeFileSync(path.join(from, 'config.yml'), 'lookback_days: 7\n')
  fs.writeFileSync(path.join(from, 'olat-finder-helper.swift'), swift)
  fs.writeFileSync(path.join(from, 'OLATFinderHelper.app', 'Contents', 'MacOS', 'OLATFinderHelper'), 'bin ' + swift)
  return from
}

test('installScripts: first install, no-op rerun, update keeps config, helper never older than its source', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cm-install-'))
  const from = bundle(root)
  const to = path.join(root, 'state', 'scripts')
  const state = path.join(root, 'state')
  const exe = path.join(state, 'OLATFinderHelper.app', 'Contents', 'MacOS', 'OLATFinderHelper')
  const src = path.join(to, 'olat-finder-helper.swift')

  assert.deepEqual(installScripts(from, to, state).sort(), ['OLATFinderHelper.app', 'config.yml', 'olat-common.sh', 'olat-finder-helper.swift', 'olat-idle-eject-check.sh', 'olatTransfer.sh'])
  assert.equal(fs.statSync(path.join(to, 'olatTransfer.sh')).mode & 0o777, 0o755)
  assert.ok(fs.statSync(src).mtimeMs < fs.statSync(exe).mtimeMs)
  assert.deepEqual(installScripts(from, to, state), [])

  fs.writeFileSync(path.join(to, 'config.yml'), 'lookback_days: 3\n')   // the user's edit
  bundle(root, 'swift v2')
  fs.writeFileSync(path.join(from, 'olatTransfer.sh'), 'olatTransfer.sh v2')
  assert.deepEqual(installScripts(from, to, state).sort(), ['OLATFinderHelper.app', 'olat-finder-helper.swift', 'olatTransfer.sh'])
  assert.equal(fs.readFileSync(path.join(to, 'config.yml'), 'utf8'), 'lookback_days: 3\n')
  assert.equal(fs.readFileSync(exe, 'utf8'), 'bin swift v2')
  assert.ok(fs.statSync(src).mtimeMs < fs.statSync(exe).mtimeMs)

  fs.rmSync(path.join(state, 'OLATFinderHelper.app'), { recursive: true })   // helper deleted
  assert.deepEqual(installScripts(from, to, state), ['OLATFinderHelper.app'])
  fs.rmSync(root, { recursive: true, force: true })
})

test('installScripts: keeps a helper built by olatTransfer.sh before the first install', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cm-install-'))
  const from = bundle(root)
  const state = path.join(root, 'state')
  const to = path.join(state, 'scripts')
  const exe = path.join(state, 'OLATFinderHelper.app', 'Contents', 'MacOS', 'OLATFinderHelper')
  fs.mkdirSync(path.dirname(exe), { recursive: true })
  fs.writeFileSync(exe, 'locally built')
  assert.ok(!installScripts(from, to, state).includes('OLATFinderHelper.app'))
  assert.equal(fs.readFileSync(exe, 'utf8'), 'locally built')
  assert.ok(fs.statSync(path.join(to, 'olat-finder-helper.swift')).mtimeMs < fs.statSync(exe).mtimeMs)
  fs.rmSync(root, { recursive: true, force: true })
})
