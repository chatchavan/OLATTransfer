// Browser-only fallback: lets the renderer run in a plain browser (no Electron) with
// fictional data, so the layout can be checked and screenshotted. Not used in the app:
// the preload defines window.api first, then this file does nothing.
;(() => {
  if (window.api) return
  const OLAT = '/Volumes/lms.uzh.ch'
  const ROOT = OLAT + '/webdav/coursefolders/26HS 22MI0003 Fundamentals of Human-Centered Computing/_courseelementdata/Hand in'
  const names = ['Example Student A', 'Sample Student B', 'Test Student C', 'Demo Student D', 'Placeholder Student E', 'Fictional Student F', 'Mock Student G', 'Specimen Student H']
  const f = (name, size) => ({ name, dir: false, size })
  const d = (name, children) => ({ name, dir: true, size: 0, children })
  const student = (i) => d(names[i], [
    d('Participant Drop Box', [d('a1.1', [f('report.pdf', 120000), f('notes.txt', 500 + i), d('figures', [f('fig1.png', 4000)]), d('drafts', [d('v1', [f('draft.docx', 9000), d('reviewed', null)])])]), d('a1.2', [f('solution.pdf', 700)])]),
    d('Return Box', [])
  ])
  const FAKE = { [ROOT]: names.map((_, i) => student(i)) }
  const LOCAL = '/Users/chat/Desktop/a1.1'
  const params = new URLSearchParams(location.search)
  const mounted = params.get('unmounted') !== '1'

  function find(path) {
    if (path === ROOT) return FAKE[ROOT]
    if (!path.startsWith(ROOT + '/')) return null
    let nodes = FAKE[ROOT]
    for (const name of path.slice(ROOT.length + 1).split('/')) {
      const n = (nodes || []).find((x) => x.name === name)
      if (!n) return null
      nodes = n.children
    }
    return nodes
  }

  function cut(nodes, depth, level) {
    return (nodes || []).map((n) => n.dir ? { name: n.name, dir: true, size: 0, children: n.children && level < depth ? cut(n.children, depth, level + 1) : null } : n)
  }

  function toRegex(pattern) {
    const levels = pattern.split('/')
    return levels.map((lv) => new RegExp('^' + lv.replace(/\\(.)|[.+^${}()|[\]]|(\*)|(\?)/g, (m, esc, star, q) => esc ? esc.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') : star ? '[^/]*' : q ? '[^/]' : '\\' + m) + '$'))
  }

  function walk(nodes, prefix, out) {
    for (const n of nodes || []) {
      const p = prefix ? prefix + '/' + n.name : n.name
      out.push({ path: p, dir: n.dir, size: n.size || 0 })
      if (n.dir && n.children) walk(n.children, p, out)
    }
    return out
  }

  function preview(p) {
    const entries = p.srcEntries || []
    const all = walk(entries, '', [])
    const matched = {}
    const per = []
    let minLevels = null
    p.patterns.forEach((pat) => {
      const rx = toRegex(pat)
      const tops = new Set()
      const lv = pat.includes('**') ? null : rx.length
      if (lv !== null) minLevels = minLevels === null ? lv : Math.min(minLevels, lv)
      for (const a of all) {
        const parts = a.path.split('/')
        const hit = parts.length >= rx.length && rx.every((r, i) => r.test(parts[i]))
        const onWay = a.dir && parts.length < rx.length && parts.every((s, i) => rx[i].test(s))
        if (hit || onWay) {
          if (hit || onWay) matched[a.path] = a.dir
          if (hit) tops.add(parts[0])
        }
      }
      per.push({ top: tops.size, files: 0 })
    })
    const rows = []
    const keys = Object.keys(matched).sort()
    keys.forEach((k) => {
      const parts = k.split('/')
      const dir = matched[k]
      const file = all.find((a) => a.path === k)
      const status = dir ? (parts.length === 1 && parts[0].startsWith('Example') ? 'same' : 'new') : (k.endsWith('notes.txt') && parts[0].startsWith('Example') ? 'diff' : parts[0].startsWith('Example') && k.endsWith('report.pdf') ? 'same' : 'new')
      rows.push({ path: k, name: parts[parts.length - 1], depth: parts.length - 1, dir, status, size: file ? file.size : 0 })
    })
    rows.push({ path: 'readme.txt', name: 'readme.txt', depth: 0, dir: false, status: 'existing', size: 10 })
    rows.sort((a, b) => (a.path < b.path ? -1 : 1))
    return { ok: true, rows, matched, minLevels, perPattern: per, sampleCount: entries.filter((e) => e.dir).length, topTotal: entries.filter((e) => e.dir).length }
  }

  const OUT = ['>f+++++++++ Example Student A/Participant Drop Box/a1.1/figures/fig1.png', '>f.s....... Example Student A/Participant Drop Box/a1.1/notes.txt', '>f+++++++++ Sample Student B/Participant Drop Box/a1.1/report.pdf', '>f+++++++++ Test Student C/Participant Drop Box/a1.1/report.pdf', '', 'Would download 4 file(s):', '  …', '✅  Transfer finished.'].join('\n') + '\n'
  let runCb = null, dryCb = null

  window.api = {
    info: async () => ({ ok: true, value: { scriptPath: '/Users/chat/local_git/OLATTransfer/olatTransfer.sh', olatPrefix: OLAT, home: '/Users/chat' } }),
    loadSettings: async () => ({ ok: true, value: { src: ROOT, dst: LOCAL, patterns: [], eject: true, sidecar: false } }),
    saveSettings: async () => ({ ok: true }),
    pathInfo: async (p) => ({ ok: true, value: { olat: p.startsWith(OLAT), kind: p.startsWith(OLAT) ? (find(p) ? 'dir' : 'none') : 'dir', mounted } }),
    pathForFile: () => '',
    chooseDir: async () => ({ ok: true, value: { path: null } }),
    openCommand: async () => ({ ok: true, value: { path: null } }),
    tree: async (root, o) => {
      if (!mounted && root.startsWith(OLAT)) return { ok: false, code: 'NOT_MOUNTED', message: '' }
      await new Promise((r) => setTimeout(r, 150))
      const nodes = root.startsWith(OLAT) ? find(root) : [d('Example Student A', null), f('loose.txt', 3)]
      if (!nodes) return { ok: false, code: 'NOT_FOUND', message: '' }
      let top = cut(nodes, (o && o.depth) || 1, 1)
      const total = top.filter((n) => n.dir).length
      if (o && o.firstN) { let s = 0; top = top.filter((n) => !n.dir || ++s <= o.firstN) }
      return { ok: true, entries: top, total }
    },
    preview: async (p) => preview(p),
    saveCommand: async () => ({ ok: true, value: { path: '/Users/chat/Documents/OLAT commands/a1.1-download.command' } }),
    copy: async () => ({ ok: true }),
    run: {
      start: async (p) => { setTimeout(() => { runCb && runCb({ type: 'start', cmd: 'bash olatTransfer.sh …' }); runCb && runCb({ type: 'out', text: OUT }); runCb && runCb({ type: 'exit', code: 0 }) }, 200); return { ok: true, value: {} } },
      abort: async () => ({ ok: true }),
      onEvent: (cb) => { runCb = cb }
    },
    dryrun: {
      open: async () => { window.open('dryrun.html', '_blank'); return { ok: true, value: {} } },
      get: async () => ({ ok: true, value: { title: 'Dry-run · 14:32:05 · Hand in → a1.1', params: { direction: 'download', patterns: ['*/Participant Drop Box/a1.1'] }, output: OUT, state: 'done', exitCode: 0, startedAt: Date.now() - 4200, finishedAt: Date.now(), topFolders: names, cmdDry: 'bash "/Users/chat/local_git/OLATTransfer/olatTransfer.sh" -n -m "*/Participant Drop Box/a1.1" "' + ROOT + '" "' + LOCAL + '"', cmdReal: 'bash olatTransfer.sh …' } }),
      runReal: async () => ({ ok: true }),
      abort: async () => ({ ok: true }),
      close: async () => { window.close(); return { ok: true } },
      onEvent: (cb) => { dryCb = cb }
    }
  }
})()
