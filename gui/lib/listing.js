// Directory listing for the tree views (main process). Used for local folders
// and for the Finder-mounted WebDAV volume alike; both are plain directories.
const fs = require('fs')
const path = require('path')

const collator = new Intl.Collator('en', { numeric: true, sensitivity: 'base' })
function compareNames(a, b) {
  return collator.compare(a, b) || (a < b ? -1 : a > b ? 1 : 0)
}

async function pool(items, limit, fn) {
  const results = new Array(items.length)
  let next = 0
  async function worker() {
    while (next < items.length) {
      const i = next++
      results[i] = await fn(items[i], i)
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker))
  return results
}

function classifyError(e) {
  if (e && (e.code === 'ENOENT' || e.code === 'ENOTDIR')) return { code: 'NOT_FOUND', message: e.message }
  if (e && (e.code === 'EACCES' || e.code === 'EPERM')) return { code: 'DENIED', message: e.message }
  return { code: 'ERROR', message: String((e && e.message) || e) }
}

// One level: [{name, dir, size}] without hidden entries (the script excludes them).
async function listDir(dir) {
  const dirents = await fs.promises.readdir(dir, { withFileTypes: true })
  const visible = dirents.filter((d) => !d.name.startsWith('.'))
  const entries = await pool(visible, 8, async (d) => {
    let isDir = d.isDirectory()
    let size = 0
    if (!isDir) {
      try {
        const st = await fs.promises.stat(path.join(dir, d.name))
        isDir = st.isDirectory()
        size = isDir ? 0 : st.size
      } catch { /* broken link: show as empty file */ }
    }
    return { name: d.name, dir: isDir, size }
  })
  entries.sort((a, b) => compareNames(a.name, b.name))
  return entries
}

// Nested listing. depth = levels to list below `root` (1 = just its children);
// folders at the cut-off get children: null (= "not listed yet").
// firstN: keep only the first N sub-folders of the root (sampling), the total
// is reported. onlyNames: keep only these top-level folders.
// maxEntries: stop descending once this many entries were collected.
async function listTree(root, opts = {}) {
  const depth = opts.depth || 1
  const maxEntries = opts.maxEntries || Infinity
  let count = 0
  let truncated = false

  async function walk(dir, level) {
    let entries = await listDir(dir)
    count += entries.length
    const out = []
    for (const e of entries) {
      const node = { name: e.name, dir: e.dir, size: e.size }
      if (e.dir) node.children = null
      out.push(node)
    }
    return out
  }

  async function descend(dir, nodes, level, parallel) {
    const dirs = nodes.filter((n) => n.dir)
    if (level >= depth) return
    await pool(dirs, parallel, async (n) => {
      if (count >= maxEntries) { truncated = true; return }
      try {
        n.children = await walk(path.join(dir, n.name), level + 1)
      } catch (e) {
        n.children = null
        n.error = classifyError(e).code
        return
      }
      await descend(path.join(dir, n.name), n.children, level + 1, 1)
    })
  }

  try {
    let top = await walk(root, 1)
    let total = top.filter((n) => n.dir).length
    if (opts.onlyNames) {
      const keep = new Set(opts.onlyNames)
      top = top.filter((n) => !n.dir || keep.has(n.name))
    }
    if (opts.firstN) {
      let seen = 0
      top = top.filter((n) => !n.dir || ++seen <= opts.firstN)
    }
    await descend(root, top, 1, 3)
    return { ok: true, entries: top, total, truncated }
  } catch (e) {
    return Object.assign({ ok: false }, classifyError(e))
  }
}

module.exports = { listDir, listTree, compareNames, classifyError }
