const { app, BrowserWindow, ipcMain, dialog, clipboard, screen, Menu } = require('electron')
const { spawn, execFile } = require('child_process')
const fs = require('fs')
const os = require('os')
const path = require('path')

const Command = require('./lib/command.js')
const Listing = require('./lib/listing.js')
const Preview = require('./lib/preview.js')
const Settings = require('./lib/settings.js')

// Test hooks (self-check runs only): CM_USER_DATA, CM_OLAT_PREFIX, CM_TEST_DIALOG,
// CM_SCREENSHOT, CM_SCRIPT, CM_WAIT, CM_SCRIPT_PATH (stand-in for olatTransfer.sh), CM_SHOT_TARGET=dryrun, CM_TEST_MENU (id chosen in context menus).
if (process.env.CM_USER_DATA) app.setPath('userData', process.env.CM_USER_DATA)

// From the repo (npm start) the scripts are the repo's own. The packaged .app carries copies
// in Contents/Resources/olat and installs them to a fixed folder (lib/install.js).
// app.isPackaged is false there (the executable is still called Electron), so test the layout.
// os.homedir() follows $HOME, like olat-common.sh, so a test run can redirect it.
const PACKAGED = __dirname === path.join(process.resourcesPath, 'app')
const STATE_DIR = path.join(os.homedir(), 'Library', 'Application Support', 'OLATTransfer')
const SCRIPTS_DIR = PACKAGED ? path.join(STATE_DIR, 'scripts') : path.resolve(__dirname, '..')
if (PACKAGED) {
  try { require('./lib/install.js').installScripts(path.join(process.resourcesPath, 'olat'), SCRIPTS_DIR, STATE_DIR) }
  catch (err) { dialog.showErrorBox('Cannot install the OLATTransfer scripts', String((err && err.message) || err)) }
}
const SCRIPT = process.env.CM_SCRIPT_PATH || path.join(SCRIPTS_DIR, 'olatTransfer.sh')
const COMMON = path.join(SCRIPTS_DIR, 'olat-common.sh')
const OLAT_PREFIX = process.env.CM_OLAT_PREFIX || '/Volumes/lms.uzh.ch'

const isOlat = (p) => typeof p === 'string' && (p === OLAT_PREFIX || p.startsWith(OLAT_PREFIX + '/'))
const volumeMounted = () => fs.existsSync(OLAT_PREFIX)

// ---------------------------------------------------------------- IPC plumbing
function handle(channel, fn) {
  ipcMain.handle(channel, async (event, ...args) => {
    try {
      const value = await fn(event, ...args)
      if (value && typeof value === 'object' && !Array.isArray(value) && 'ok' in value) return value
      return { ok: true, value }
    } catch (err) {
      return { ok: false, error: String((err && err.message) || err) }
    }
  })
}

// Keeps the idle-eject agent from ejecting while we browse the volume.
let lastTouch = 0
function touchLastUsed() {
  const now = Date.now()
  if (now - lastTouch < 30000) return
  lastTouch = now
  execFile('/bin/bash', ['-c', 'source "$1"; touch_last_used', 'bash', COMMON], () => {})
}

// ---------------------------------------------------------------- windows
const mainWindows = new Set()

function windowOptions(extra) {
  return Object.assign({
    titleBarStyle: 'hiddenInset',
    trafficLightPosition: { x: 16, y: 18 },
    backgroundColor: undefined,
    webPreferences: { preload: path.join(__dirname, 'preload.js'), contextIsolation: true, sandbox: true }
  }, extra)
}

function boundsOnScreen(b) {
  if (!b) return null
  return screen.getAllDisplays().some((d) => {
    const a = d.workArea
    return b.x >= a.x - 50 && b.y >= a.y - 50 && b.x < a.x + a.width - 100 && b.y < a.y + a.height - 100
  }) ? b : null
}

function createMainWindow() {
  const settings = Settings.load(app.getPath('userData'))
  const b = boundsOnScreen(settings.bounds)
  const win = new BrowserWindow(windowOptions(Object.assign({ width: 1120, height: 820, minWidth: 900, minHeight: 620, title: 'Rsync pattern maker' }, b || {})))
  win.loadFile(path.join(__dirname, 'renderer', 'index.html'))
  mainWindows.add(win)
  win.on('close', () => {
    try {
      const s = Settings.load(app.getPath('userData'))
      s.bounds = win.getBounds()
      Settings.save(app.getPath('userData'), s)
    } catch { /* ignore */ }
    stopRun(win.webContents.id)
  })
  win.on('closed', () => mainWindows.delete(win))
  return win
}

// ---------------------------------------------------------------- running the script
function spawnScript(params, dry, onOut, onExit) {
  const args = [SCRIPT].concat(Command.buildArgs(Object.assign({}, params, { dry })))
  const child = spawn('/bin/bash', args, { cwd: REPO, env: process.env, detached: true })
  child.stdout.on('data', (d) => onOut(d.toString('utf8')))
  child.stderr.on('data', (d) => onOut(d.toString('utf8')))
  child.on('error', (e) => { onOut('\n' + e.message + '\n'); onExit(null) })
  child.on('close', (code) => onExit(code))
  return child
}

function killTree(child) {
  if (!child || child.exitCode !== null) return
  try { process.kill(-child.pid, 'SIGTERM') } catch { try { child.kill('SIGTERM') } catch { /* gone */ } }
}

const runs = new Map()   // webContents id -> {child}
function stopRun(id) {
  const r = runs.get(id)
  if (r) { killTree(r.child); runs.delete(id) }
}

handle('run:start', (event, params) => {
  const wc = event.sender
  if (runs.has(wc.id)) throw new Error('A run is already in progress')
  const cmd = Command.buildOneLine(SCRIPT, params)
  const send = (p) => { if (!wc.isDestroyed()) wc.send('run:event', p) }
  send({ type: 'start', cmd })
  const child = spawnScript(params, false, (text) => send({ type: 'out', text }), (code) => { runs.delete(wc.id); send({ type: 'exit', code }) })
  runs.set(wc.id, { child })
  return { cmd }
})
handle('run:abort', (event) => { stopRun(event.sender.id) })

// ---------------------------------------------------------------- dry-run windows
const jobs = new Map()   // webContents id -> job

function topFolders(src) {
  try {
    return fs.readdirSync(src, { withFileTypes: true }).filter((d) => d.isDirectory() && !d.name.startsWith('.')).map((d) => d.name)
  } catch { return [] }
}

function jobSend(job, payload) {
  if (!job.win.isDestroyed()) job.win.webContents.send('dryrun:event', payload)
}

function jobAppend(job, text) {
  jobSend(job, { type: 'out', text, offset: job.output.length })
  job.output += text
}

function startJobProcess(job, dry) {
  job.state = dry ? 'running' : 'running-real'
  job.child = spawnScript(job.params, dry, (t) => jobAppend(job, t), (code) => {
    job.child = null
    job.state = 'done'
    job.exitCode = code
    job.finishedAt = Date.now()
    jobSend(job, { type: 'exit', code, finishedAt: job.finishedAt, real: !dry })
  })
}

handle('dryrun:open', (event, params) => {
  touchLastUsed()
  const now = new Date()
  const hhmmss = now.toTimeString().slice(0, 8)
  const title = `Dry-run · ${hhmmss} · ${path.basename(params.src)} → ${path.basename(params.dest)}`
  const win = new BrowserWindow(windowOptions({ width: 920, height: 780, minWidth: 640, minHeight: 480, title }))
  const job = { win, params, title, startedAt: Date.now(), output: '', state: 'running', exitCode: null, finishedAt: null, child: null, topFolders: topFolders(params.src), cmdDry: Command.buildOneLine(SCRIPT, Object.assign({}, params, { dry: true })), cmdReal: Command.buildOneLine(SCRIPT, Object.assign({}, params, { dry: false })) }
  const id = win.webContents.id
  jobs.set(id, job)
  win.on('closed', () => { killTree(job.child); jobs.delete(id) })
  win.loadFile(path.join(__dirname, 'renderer', 'dryrun.html'))
  win.webContents.once('did-finish-load', () => { if (!job.child && job.state === 'running') startJobProcess(job, true) })
  return { title }
})

const jobOf = (event) => {
  const job = jobs.get(event.sender.id)
  if (!job) throw new Error('No dry-run job for this window')
  return job
}
handle('dryrun:get', (event) => {
  const j = jobOf(event)
  return { title: j.title, params: j.params, output: j.output, state: j.state, exitCode: j.exitCode, startedAt: j.startedAt, finishedAt: j.finishedAt, topFolders: j.topFolders, cmdDry: j.cmdDry, cmdReal: j.cmdReal }
})
handle('dryrun:run-real', (event) => {
  const j = jobOf(event)
  if (j.child) throw new Error('Already running')
  jobAppend(j, '\n▶ ' + j.cmdReal + '\n\n')
  startJobProcess(j, false)
})
handle('dryrun:abort', (event) => { const j = jobOf(event); killTree(j.child) })
handle('dryrun:close', (event) => { const j = jobOf(event); j.win.close() })

// ---------------------------------------------------------------- everything else
handle('app:info', () => ({ scriptPath: SCRIPT, olatPrefix: OLAT_PREFIX, home: app.getPath('home') }))
handle('settings:load', () => Settings.load(app.getPath('userData')))
handle('settings:save', (_e, s) => { Settings.save(app.getPath('userData'), s) })
// Native context menu. items: [{id, label, enabled?}] -> {id} of the chosen item or {id: null}.
handle('menu:context', (event, items) => new Promise((resolve) => {
  if (process.env.CM_TEST_MENU) return resolve({ id: process.env.CM_TEST_MENU })
  let chosen = null
  const menu = Menu.buildFromTemplate(items.map((i) => ({ label: i.label, enabled: i.enabled !== false, click: () => { chosen = i.id } })))
  menu.popup({ window: BrowserWindow.fromWebContents(event.sender), callback: () => setTimeout(() => resolve({ id: chosen }), 20) })
}))
handle('clipboard:write', (_e, text) => { clipboard.writeText(String(text)) })

handle('path:info', (_e, p) => {
  const olat = isOlat(p)
  let kind = 'none'
  try { kind = fs.statSync(p).isDirectory() ? 'dir' : 'file' } catch { /* missing */ }
  return { olat, kind, mounted: !olat || volumeMounted() }
})

handle('fs:tree', async (_e, root, opts) => {
  const olat = isOlat(root)
  if (olat && !volumeMounted()) return { ok: false, code: 'NOT_MOUNTED', message: 'WebDAV is not mounted' }
  if (olat) touchLastUsed()
  const r = await Listing.listTree(root, opts || {})
  if (!r.ok && olat && r.code === 'NOT_FOUND' && !volumeMounted()) return { ok: false, code: 'NOT_MOUNTED', message: 'WebDAV is not mounted' }
  return r
})

function testAnswer() { return process.env.CM_TEST_DIALOG || null }

handle('dialog:dir', async (event, opts) => {
  if (testAnswer()) return { path: testAnswer() }
  const win = BrowserWindow.fromWebContents(event.sender)
  const r = await dialog.showOpenDialog(win, { title: (opts && opts.title) || 'Choose a folder', defaultPath: opts && opts.defaultPath, properties: ['openDirectory', 'createDirectory'] })
  return { path: r.canceled ? null : r.filePaths[0] }
})

handle('dialog:open-command', async (event) => {
  let file = testAnswer()
  if (!file) {
    const win = BrowserWindow.fromWebContents(event.sender)
    const r = await dialog.showOpenDialog(win, { title: 'Open a .command made by Rsync pattern maker', properties: ['openFile'], filters: [{ name: 'Command files', extensions: ['command'] }] })
    file = r.canceled ? null : r.filePaths[0]
  }
  if (!file) return { path: null }
  return { path: file, text: fs.readFileSync(file, 'utf8') }
})

handle('preview:run', async (_e, p) => {
  const olatSrc = isOlat(p.src)
  const olatDst = isOlat(p.dest)
  if (olatSrc || olatDst) touchLastUsed()
  let srcEntries, topTotal, sampleNames
  if (olatSrc) {
    srcEntries = p.srcEntries || []
    sampleNames = srcEntries.filter((e) => e.dir).map((e) => e.name)
    topTotal = sampleNames.length
  } else {
    const all = await Listing.listTree(p.src, { depth: 1 })
    if (!all.ok) return all
    const names = all.entries.filter((e) => e.dir).map((e) => e.name)
    topTotal = names.length
    sampleNames = names.slice(0, 5)
    const sample = await Listing.listTree(p.src, { depth: 60, onlyNames: sampleNames, maxEntries: 20000 })
    if (!sample.ok) return sample
    srcEntries = sample.entries
  }
  let existing = []
  if (!olatDst) {
    const ex = await Listing.listTree(p.dest, { depth: 8, maxEntries: 3000 })
    if (ex.ok) existing = ex.entries
  } else {
    existing = p.dstEntries || []
  }
  return Preview.computePreview({
    commonSh: COMMON,
    patterns: p.patterns,
    srcEntries,
    srcRealPath: olatSrc ? null : p.src,
    dstPath: olatDst ? null : p.dest,
    dstEntries: p.dstEntries || [],
    existingEntries: existing,
    sampleNames,
    topTotal
  })
})

function writeCommand(file, text) {
  fs.writeFileSync(file, text, { mode: 0o755 })
  fs.chmodSync(file, 0o755)
}

handle('command:save', async (event, p) => {
  let file = testAnswer()
  if (!file) {
    const win = BrowserWindow.fromWebContents(event.sender)
    const r = await dialog.showSaveDialog(win, { title: 'Save command', defaultPath: path.join(p.defaultDir || app.getPath('documents'), p.name || 'OLAT transfer.command'), filters: [{ name: 'Command files', extensions: ['command'] }] })
    if (r.canceled || !r.filePath) return { path: null }
    file = r.filePath
  }
  if (!file.endsWith('.command')) file += '.command'
  writeCommand(file, p.text)
  if (p.runInTerminal) execFile('/usr/bin/open', ['-a', 'Terminal', file], () => {})
  return { path: file }
})

// ---------------------------------------------------------------- start-up
app.whenReady().then(() => {
  const win = createMainWindow()
  const shot = process.env.CM_SCREENSHOT
  if (shot || process.env.CM_SCRIPT) {
    win.webContents.once('did-finish-load', async () => {
      try {
        if (process.env.CM_SCRIPT) {
          const code = fs.readFileSync(process.env.CM_SCRIPT, 'utf8')
          const result = await win.webContents.executeJavaScript(`(async () => { ${code}\n})()`)
          if (result !== undefined) console.log('CM_SCRIPT result:', JSON.stringify(result))
        }
        await new Promise((r) => setTimeout(r, Number(process.env.CM_WAIT || 800)))
        if (shot) {
          let target = win
          if (process.env.CM_SHOT_TARGET === 'dryrun') target = BrowserWindow.getAllWindows().find((w) => w.webContents.getURL().includes('dryrun.html')) || win
          fs.writeFileSync(shot, (await target.webContents.capturePage()).toPNG())
        }
      } catch (e) {
        console.log('CM self-check error:', e && e.stack || e)
      }
      app.exit(0)
    })
  }
})

app.on('window-all-closed', () => app.quit())
app.on('activate', () => { if (!BrowserWindow.getAllWindows().length) createMainWindow() })
