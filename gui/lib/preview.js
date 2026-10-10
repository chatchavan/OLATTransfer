// Live preview (main process). Builds throwaway sparse trees from listings and
// runs the real `rsync -n -i` with the filter arguments produced by
// build_pattern_filters in olat-common.sh. No matching logic lives here.
const fs = require('fs')
const os = require('os')
const path = require('path')
const { execFile } = require('child_process')
const Pattern = require('./pattern.js')
const Summary = require('./summary.js')
const { compareNames } = require('./listing.js')

const RSYNC = '/usr/bin/rsync'
// Folders whose content has not been listed yet (OLAT sampling) get one placeholder file, so a
// pattern that targets them still matches (-m would prune an empty folder).
const PLACEHOLDER = '~not-loaded~'

function run(file, args, opts) {
  return new Promise((resolve, reject) => {
    execFile(file, args, Object.assign({ maxBuffer: 256 * 1024 * 1024, encoding: 'buffer' }, opts), (err, stdout, stderr) => {
      if (err && !(err.code === 23)) {
        err.stderr = stderr && stderr.toString()
        return reject(err)
      }
      resolve(stdout.toString('utf8'))
    })
  })
}

// Filter arguments from the real implementation in olat-common.sh.
async function getFilterArgs(commonSh, patterns) {
  const script = 'source "$1"; shift; build_pattern_filters "$@"; printf "%s\\0" "${PATTERN_FILTER_ARGS[@]}"'
  const out = await run('/bin/bash', ['-c', script, 'bash', commonSh].concat(patterns))
  const parts = out.split('\0')
  parts.pop()
  return parts
}

// Create the nested listing as empty (sparse) files and folders under dir.
function buildMock(dir, entries, markUnloaded) {
  for (const e of entries || []) {
    const p = path.join(dir, e.name)
    try {
      if (e.dir) {
        fs.mkdirSync(p, { recursive: true })
        if (e.children) buildMock(p, e.children, markUnloaded)
        else if (markUnloaded && !e.error) fs.closeSync(fs.openSync(path.join(p, PLACEHOLDER), 'w'))
      } else {
        const fd = fs.openSync(p, 'w')
        if (e.size) fs.ftruncateSync(fd, e.size)
        fs.closeSync(fd)
      }
    } catch { /* two names that differ only in Unicode form collide on APFS: skip */ }
  }
}

function flatten(entries, prefix, out) {
  for (const e of entries || []) {
    const p = prefix ? prefix + '/' + e.name : e.name
    out.push({ path: p, dir: e.dir, size: e.size || 0 })
    if (e.dir && e.children) flatten(e.children, p, out)
  }
  return out
}

function rsyncArgs(filterArgs, src, dst) {
  return ['-r', '-l', '-n', '-i', '--size-only', '--exclude=.*'].concat(filterArgs, [src.replace(/\/?$/, '/'), dst.replace(/\/?$/, '/')])
}

// opts: {commonSh, patterns, srcEntries, srcRealPath|null, dstPath|null, dstEntries,
//        existingEntries, sampleNames, topTotal}
async function computePreview(opts) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'olat-cm-'))
  try {
    const mockSrc = path.join(tmp, 'src')
    const empty = path.join(tmp, 'empty')
    fs.mkdirSync(mockSrc); fs.mkdirSync(empty)
    buildMock(mockSrc, opts.srcEntries, true)

    const sample = new Set(opts.sampleNames)
    const patternSrc = opts.srcRealPath || mockSrc

    // 1. each pattern alone, against an empty destination: what it matches
    const matched = new Map()
    const perPattern = []
    for (const p of opts.patterns) {
      const filter = await getFilterArgs(opts.commonSh, [p])
      const out = await run(RSYNC, rsyncArgs(filter, patternSrc, empty))
      const items = Summary.parseItemize(out)
      const tops = new Set()
      let files = 0
      for (const it of items) {
        matched.set(it.path, { dir: it.dir })
        tops.add(it.path.split('/')[0])
        if (!it.dir) files++
      }
      perPattern.push({ top: tops.size, files })
    }

    // 2. all patterns against the destination: what would be transferred
    const filterAll = await getFilterArgs(opts.commonSh, opts.patterns)
    let dst = opts.dstPath
    if (!dst) {
      dst = path.join(tmp, 'dst')
      fs.mkdirSync(dst)
      buildMock(dst, opts.dstEntries)
    } else if (!fs.existsSync(dst)) {
      dst = empty
    }
    const out2 = await run(RSYNC, rsyncArgs(filterAll, mockSrc, dst))
    const changed = new Map()
    for (const it of Summary.parseItemize(out2)) {
      if (it.dir) changed.set(it.path, it.created ? 'new' : 'same')
      else changed.set(it.path, it.created ? 'new' : it.sizeDiff ? 'diff' : 'same')
    }

    const matchedObj = {}
    for (const [k, v] of matched) matchedObj[k] = v.dir
    const levels = opts.patterns.map(Pattern.patternLevels)
    const minLevels = levels.some((l) => l === null) ? null : Math.min.apply(null, levels)

    const sampleMatched = new Map()
    for (const [k, v] of matched) if (sample.has(k.split('/')[0])) sampleMatched.set(k, v)
    const rows = mergeRows(sampleMatched, changed, opts.existingEntries)
    return { ok: true, rows, matched: matchedObj, minLevels, perPattern, sampleCount: opts.sampleNames.length, topTotal: opts.topTotal }
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true })
  }
}

// Merge what the patterns select with what already exists at the destination.
// Status: new | same | diff (selected) and existing (not touched).
function mergeRows(matched, changed, existingEntries) {
  const nodes = new Map()
  function ensure(p, dir) {
    let n = nodes.get(p)
    if (n) return n
    const i = p.lastIndexOf('/')
    if (i >= 0) ensure(p.slice(0, i), true)
    n = { path: p, name: p.slice(i + 1), dir, status: 'existing', size: 0 }
    if (n.name === PLACEHOLDER) { n.status = 'unloaded'; n.name = 'not loaded yet' }
    nodes.set(p, n)
    return n
  }
  for (const [p, v] of matched) {
    const n = ensure(p, v.dir)
    n.dir = v.dir
    if (n.status === 'unloaded') continue
    n.status = v.dir ? (changed.get(p) === 'new' ? 'new' : 'same') : (changed.get(p) || 'same')
  }
  for (const e of flatten(existingEntries, '', [])) {
    if (!nodes.has(e.path)) { const n = ensure(e.path, e.dir); n.size = e.size }
    else nodes.get(e.path).size = e.size
  }
  // Existing items inside a folder whose source content is not listed yet cannot be compared.
  const pendingDirs = []
  for (const n of nodes.values()) if (n.status === 'unloaded') pendingDirs.push(n.path.slice(0, n.path.lastIndexOf('/')))
  for (const n of nodes.values()) {
    if (n.status === 'existing' && pendingDirs.some((d) => n.path.startsWith(d + '/'))) n.status = 'pending'
  }
  const children = new Map()
  for (const n of nodes.values()) {
    const parent = n.path.includes('/') ? n.path.slice(0, n.path.lastIndexOf('/')) : ''
    if (!children.has(parent)) children.set(parent, [])
    children.get(parent).push(n)
  }
  const rows = []
  function dfs(parent, depth) {
    const list = (children.get(parent) || []).sort((a, b) => compareNames(a.name, b.name))
    for (const n of list) {
      rows.push({ path: n.path, name: n.name, depth, dir: n.dir, status: n.status, size: n.size })
      if (n.dir) dfs(n.path, depth + 1)
    }
  }
  dfs('', 0)
  return rows
}

module.exports = { PLACEHOLDER, getFilterArgs, buildMock, computePreview, mergeRows, flatten, RSYNC }
