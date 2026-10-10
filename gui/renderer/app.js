'use strict'
;(() => {
  const { h, ic, mount, keepFocus } = window.UI
  const Pattern = window.CMPattern
  const Command = window.CMCommand
  const api = window.api

  const SAMPLE = 5          // folders sampled at the OLAT source root
  const STEP = 3            // levels per listing step on OLAT
  const $ = (id) => document.getElementById(id)

  // ------------------------------------------------------------------ state
  const S = {
    info: { scriptPath: '', olatPrefix: '/Volumes/lms.uzh.ch' },
    src: '', dst: '',
    srcInfo: null, dstInfo: null,
    eject: true, sidecar: false, saveDir: '',
    tree: { state: 'idle', code: null, message: '', root: null, total: 0 },
    patterns: [],            // {id, text, levels|null}
    focus: 0,
    selected: null,          // rel path (array of names) of the clicked tree row
    preview: { state: 'idle', data: null, message: '', code: null },
    openRows: new Set(), closedRows: new Set(),
    menu: null, modal: null,
    saveMsg: '', saveErr: '',
    run: { output: '', running: false, exit: null, cmd: '' },
    dstCache: {},            // upload: OLAT destination listings per top-level folder
    dropping: null
  }
  let nextId = 1
  const newPattern = (text, levels) => ({ id: nextId++, text: text || '', levels: levels || null })

  // ------------------------------------------------------------------ helpers
  const olatLike = (p) => !!p && (p === S.info.olatPrefix || p.startsWith(S.info.olatPrefix + '/'))
  const baseName = (p) => p.replace(/\/+$/, '').split('/').pop()
  const joinPath = (root, rel) => rel.length ? root.replace(/\/+$/, '') + '/' + rel.join('/') : root

  function direction() {
    const s = olatLike(S.src), d = olatLike(S.dst)
    if (!S.src || !S.dst) return { ok: false, reason: 'Choose a source and a destination folder.' }
    if (s && !d) return { ok: true, value: 'download' }
    if (!s && d) return { ok: true, value: 'upload' }
    if (s && d) return { ok: false, reason: 'Source and destination are both on OLAT. One side must be a local folder.' }
    return { ok: false, reason: 'Neither side is on OLAT. One side must be under ' + S.info.olatPrefix + '.' }
  }

  // Patterns that will be used: non-empty rows. Returns {list:[{row, pattern}], error}
  function preparedPatterns() {
    const list = []
    let error = null
    S.patterns.forEach((row, i) => {
      if (!row.text) return
      const v = Pattern.validatePattern(row.text)
      if (!v.ok) { error = error || ('Pattern ' + (i + 1) + ': ' + v.reason); return }
      if (list.some((x) => x.pattern === v.pattern)) return      // the same pattern twice counts once
      list.push({ row: i, pattern: v.pattern })
    })
    return { list, error }
  }

  function readiness() {
    const d = direction()
    if (!d.ok) return { ok: false, reason: d.reason }
    if (S.srcInfo && S.srcInfo.kind !== 'dir') return { ok: false, reason: 'The source folder does not exist.' }
    const p = preparedPatterns()
    if (p.error) return { ok: false, reason: p.error }
    if (!p.list.length) return { ok: false, reason: 'Add at least one pattern.' }
    return { ok: true, direction: d.value, patterns: p.list.map((x) => x.pattern) }
  }

  function cmdParams(dry) {
    const r = readiness()
    return { direction: r.direction, src: S.src, dest: S.dst, patterns: r.patterns, eject: S.eject, sidecar: S.sidecar && r.direction === 'upload', dry: !!dry }
  }

  // ------------------------------------------------------------------ persistence
  let saveTimer = null
  function persist() {
    clearTimeout(saveTimer)
    saveTimer = setTimeout(async () => {
      const cur = await api.loadSettings()
      const base = cur.ok ? cur.value : {}
      api.saveSettings(Object.assign({}, base, { src: S.src, dst: S.dst, patterns: S.patterns.map((p) => p.text), eject: S.eject, sidecar: S.sidecar, saveDir: S.saveDir }))
    }, 400)
  }

  // ------------------------------------------------------------------ source tree
  function mkNodes(entries, parentRel) {
    return (entries || []).map((e) => {
      const rel = parentRel.concat(e.name)
      return {
        name: e.name, rel, dir: e.dir, size: e.size || 0,
        children: e.dir && e.children ? mkNodes(e.children, rel) : null,
        open: false, loading: false, error: null
      }
    })
  }

  function toEntries(nodes) {
    return nodes.map((n) => {
      const e = { name: n.name, dir: n.dir, size: n.size }
      if (n.dir) e.children = n.children ? toEntries(n.children) : null
      return e
    })
  }

  async function loadSource() {
    S.selected = null
    S.dstCache = {}
    if (!S.src) { S.tree = { state: 'idle', root: null, total: 0 }; renderAll(); return }
    S.tree = { state: 'loading', root: null, total: 0 }
    renderSrcTree()
    const info = await api.pathInfo(S.src)
    S.srcInfo = info.ok ? info.value : null
    if (S.srcInfo && S.srcInfo.olat && !S.srcInfo.mounted) { S.tree = { state: 'error', code: 'NOT_MOUNTED', message: '' }; renderAll(); return }
    if (S.srcInfo && S.srcInfo.kind !== 'dir') { S.tree = { state: 'error', code: 'NOT_FOUND', message: '' }; renderAll(); return }
    const olat = olatLike(S.src)
    const mine = S.src
    const r = await api.tree(S.src, olat ? { depth: STEP, firstN: SAMPLE } : { depth: 1 })
    if (mine !== S.src) return
    const res = r.ok ? r.value || r : null
    if (!r.ok || (r.value && r.value.ok === false)) {
      const e = r.value && r.value.ok === false ? r.value : r
      S.tree = { state: 'error', code: e.code || 'ERROR', message: e.message || e.error || '' }
    } else {
      const root = { name: baseName(S.src), rel: [], dir: true, children: mkNodes(res.entries, []), open: true, loading: false }
      S.tree = { state: 'ok', root, total: res.total || 0 }
    }
    renderAll()
    schedulePreview()
  }

  function nodeAt(rel) {
    let nodes = S.tree.root && S.tree.root.children
    let node = S.tree.root
    for (const name of rel) {
      node = (nodes || []).find((n) => n.name === name)
      if (!node) return null
      nodes = node.children
    }
    return node
  }

  async function loadChildren(node, depth) {
    node.loading = true
    renderSrcTree()
    const r = await api.tree(joinPath(S.src, node.rel), { depth })
    node.loading = false
    const v = r.ok ? (r.value && r.value.ok !== undefined ? r.value : r) : r
    if (v.ok === false || !r.ok) {
      node.error = v.code || 'ERROR'
      if (v.code === 'NOT_MOUNTED') { S.tree = { state: 'error', code: 'NOT_MOUNTED', message: '' }; renderAll(); return }
    } else {
      node.error = null
      node.children = mkNodes(v.entries, node.rel)
    }
    renderSrcTree()
    schedulePreview()
  }

  function toggleNode(node) {
    node.open = !node.open
    if (node.open && node.dir && node.children === null && !olatLike(S.src)) loadChildren(node, 1)
    else renderSrcTree()
  }

  // ------------------------------------------------------------------ patterns
  function focusedRow() {
    if (!S.patterns.length) S.patterns.push(newPattern())
    if (S.focus >= S.patterns.length) S.focus = S.patterns.length - 1
    return S.patterns[S.focus]
  }

  function setExample(rel) {
    if (!rel.length) { S.selected = null; renderSrcTree(); return }
    let row = focusedRow()
    if (!row.levels && row.text) {          // a hand-typed pattern: do not overwrite it
      row = newPattern()
      S.patterns.push(row)
      S.focus = S.patterns.length - 1
    }
    const kids = (S.tree.root && S.tree.root.children) || []
    const manyFirst = Math.max(S.tree.total || 0, kids.filter((n) => n.dir).length) > 1
    row.levels = Pattern.levelsFromPath(rel, row.levels, manyFirst)
    row.text = Pattern.levelsToPattern(row.levels)
    S.selected = rel
    renderPatterns()
    renderSrcTree()
    persist()
    schedulePreview()
  }

  function setLevelMode(row, idx, mode) {
    row.levels[idx].mode = mode
    row.text = Pattern.levelsToPattern(row.levels)
    renderPatterns()
    renderSrcTree()
    persist()
    schedulePreview()
  }

  function setLevelCustom(row, idx, text) {
    row.levels[idx].custom = text
    row.text = Pattern.levelsToPattern(row.levels)
    const input = document.querySelector('[data-pid="' + row.id + '"]')
    if (input) input.value = row.text
    updatePatternMessages()
    persist()
    schedulePreview()
  }

  function addPattern() {
    S.patterns.push(newPattern())
    S.focus = S.patterns.length - 1
    renderPatterns()
    const inputs = document.querySelectorAll('#patterns input')
    if (inputs.length) inputs[inputs.length - 1].focus()
    persist()
  }

  function removePattern(i) {
    S.patterns.splice(i, 1)
    if (S.focus >= S.patterns.length) S.focus = Math.max(0, S.patterns.length - 1)
    S.selected = null
    renderPatterns(); renderSrcTree(); renderBar(); persist(); schedulePreview()
  }

  // ------------------------------------------------------------------ preview
  let previewTimer = null
  let previewSeq = 0

  function schedulePreview() {
    clearTimeout(previewTimer)
    previewTimer = setTimeout(runPreview, 200)
    updateHitsAndBar()
  }

  async function fetchDstSample(names) {
    // Upload: list the matching top-level folders on the OLAT destination (bounded).
    const key = S.dst
    S.dstCache[key] = S.dstCache[key] || {}
    const cache = S.dstCache[key]
    const out = []
    for (const name of names) {
      if (!(name in cache)) {
        const r = await api.tree(joinPath(S.dst, [name]), { depth: 6, maxEntries: 4000 })
        const v = r.ok ? (r.value && r.value.ok !== undefined ? r.value : r) : r
        if (v.ok === false) {
          if (v.code === 'NOT_MOUNTED') throw Object.assign(new Error('not mounted'), { code: 'NOT_MOUNTED' })
          cache[name] = null                 // folder does not exist on OLAT yet
        } else {
          cache[name] = { name, dir: true, children: v.entries }
        }
      }
      if (cache[name]) out.push(cache[name])
    }
    return out
  }

  function sampleNames() {
    const root = S.tree.root
    if (!root || !root.children) return []
    return root.children.filter((n) => n.dir).slice(0, SAMPLE).map((n) => n.name)
  }

  async function runPreview() {
    const seq = ++previewSeq
    const d = direction()
    const p = preparedPatterns()
    if (!d.ok || S.tree.state !== 'ok' || !p.list.length || p.error) {
      S.preview = { state: 'idle', data: null }
      renderDstTree(); renderSrcTree(); updateHitsAndBar()
      return
    }
    if (olatLike(S.dst)) {
      const info = await api.pathInfo(S.dst)
      S.dstInfo = info.ok ? info.value : null
      if (S.dstInfo && !S.dstInfo.mounted) { S.preview = { state: 'error', code: 'NOT_MOUNTED' }; renderDstTree(); return }
    }
    S.preview = Object.assign({}, S.preview, { state: 'loading' })
    renderDstTree()
    try {
      const params = { src: S.src, dest: S.dst, patterns: p.list.map((x) => x.pattern) }
      if (d.value === 'download') params.srcEntries = toEntries(S.tree.root.children)
      else params.dstEntries = await fetchDstSample(sampleNames())
      const r = await api.preview(params)
      if (seq !== previewSeq) return
      const v = r.ok ? (r.value && r.value.ok !== undefined ? r.value : r) : r
      if (v.ok === false || !r.ok) {
        S.preview = { state: 'error', code: v.code || 'ERROR', message: v.message || v.error || r.error || '' }
      } else {
        S.preview = { state: 'ok', data: v, direction: d.value, map: p.list.map((x) => x.row) }
        S.openRows = new Set(); S.closedRows = new Set()
      }
    } catch (e) {
      if (seq !== previewSeq) return
      S.preview = { state: 'error', code: e.code || 'ERROR', message: e.message }
    }
    renderDstTree(); renderSrcTree(); updateHitsAndBar()
  }

  // ------------------------------------------------------------------ rendering: panes
  function pathField(id, value, err) {
    const el = $(id)
    if (document.activeElement !== el) el.value = value
    el.classList.toggle('err', !!err)
  }

  function rowMatchClass(node) {
    const pv = S.preview
    if (pv.state !== 'ok' || !pv.data || !node.rel.length) return ''
    const key = node.rel.join('/')
    const matched = pv.data.matched
    if (!(key in matched)) return 'dim'
    if (node.dir) {
      const min = pv.data.minLevels
      if (min === null || node.rel.length >= min) return 'hit'
      return ''
    }
    return 'hit'
  }

  function modeTag(node) {
    const row = S.patterns[S.focus]
    if (!row || !row.levels || !S.selected) return null
    const i = node.rel.length - 1
    if (i < 0 || i >= S.selected.length) return null
    if (S.selected.slice(0, i + 1).join('\u0000') !== node.rel.join('\u0000')) return null
    const lv = row.levels[i]
    return lv ? (lv.mode === 'any' ? 'Any (*)' : lv.mode === 'custom' ? 'Custom' : 'Literal') : null
  }

  function chooserFor(node) {
    const row = S.patterns[S.focus]
    const idx = node.rel.length - 1
    if (!row || !row.levels || !row.levels[idx]) return null
    const lv = row.levels[idx]
    const btn = (mode, label) => h('button', { type: 'button', 'aria-pressed': String(lv.mode === mode), onclick: (e) => { e.stopPropagation(); setLevelMode(row, idx, mode) } }, label)
    const text = Pattern.levelText(lv)
    return h('div', { class: 'chooser', style: { marginLeft: (6 + 18 * (node.rel.length + 1)) + 'px' } },
      h('span', { class: 'lbl' }, 'Level ' + (idx + 1) + ' of the pattern: match ', h('b', {}, node.name), ' as'),
      h('div', { class: 'tri', role: 'group', 'aria-label': 'How to match this name' }, btn('literal', 'Literal'), btn('any', 'Any (*)'), btn('custom', 'Custom')),
      h('input', {
        class: 'in sm', type: 'text', value: text, spellcheck: 'false', 'aria-label': 'Wildcard for this level', 'data-fid': 'custom-' + row.id + '-' + idx,
        readonly: lv.mode !== 'custom' ? '' : null,
        oninput: (e) => setLevelCustom(row, idx, e.target.value)
      })
    )
  }

  function treeRow(node, depth) {
    const pad = 6 + 18 * depth
    const cls = ['tr']
    const sel = S.selected && S.selected.join('\u0000') === node.rel.join('\u0000')
    if (sel) cls.push('sel')
    else { const m = rowMatchClass(node); if (m) cls.push(m) }
    const tag = modeTag(node)
    const chev = h('button', {
      class: 'chev' + (node.dir ? '' : ' none'), type: 'button', tabindex: '-1', 'aria-label': node.open ? 'Collapse' : 'Expand',
      onclick: (e) => { e.stopPropagation(); toggleNode(node) }
    }, node.dir ? ic(node.open ? 'chevD' : 'chevR') : null)
    return h('div', {
      class: cls.join(' '), role: 'treeitem', style: { paddingLeft: pad + 'px' }, 'aria-expanded': node.dir ? String(node.open) : null,
      onclick: () => { if (node.dir && !node.open) { node.open = true; if (node.children === null && !olatLike(S.src)) loadChildren(node, 1) } setExample(node.rel) },
      ondblclick: () => { if (node.dir) toggleNode(node) }
    },
      chev, ic(node.dir ? 'folder' : 'file'), h('span', { class: 'nm' }, node.name),
      node.loading ? h('span', { class: 'cnt' }, ic('spinner', 'spin'), ' listing…') : (tag ? h('span', { class: 'tag' }, tag) : null))
  }

  function srcRows(nodes, depth, out) {
    for (const n of nodes) {
      out.push(treeRow(n, depth))
      const sel = S.selected && S.selected.join('\u0000') === n.rel.join('\u0000')
      if (sel) { const c = chooserFor(n); if (c) out.push(c) }
      if (n.dir && n.open) {
        if (n.children) srcRows(n.children, depth + 1, out)
        else if (olatLike(S.src) && !n.loading) {
          out.push(h('button', { class: 'more load', type: 'button', style: { marginLeft: (6 + 18 * (depth + 1)) + 'px', width: 'auto' }, onclick: () => loadChildren(n, STEP) },
            ic('chevD'), 'Not listed yet. Click to load ' + STEP + ' levels of ' + n.name + '.'))
        }
        if (n.error) out.push(h('div', { class: 'more', style: { marginLeft: (6 + 18 * (depth + 1)) + 'px' } }, ic('alert'), 'Cannot list this folder (' + n.error + ').'))
      }
    }
    return out
  }

  function failPanel(code, retry) {
    const msg = {
      NOT_MOUNTED: ['WebDAV is not mounted', 'The folder ' + S.info.olatPrefix + ' is not available, so this path cannot be listed. Mount OLAT in Finder (any OLAT Transfer script also mounts it), then retry.'],
      NOT_FOUND: ['Folder not found', 'This path does not exist.'],
      DENIED: ['Access denied', 'macOS did not allow this app to read the folder. Check System Settings → Privacy & Security (Files and Folders / Network Volumes).']
    }[code] || ['Cannot list this folder', 'Something went wrong while reading it.']
    return h('div', { class: 'fail', role: 'alert' },
      h('span', { class: 'badge' }, ic('alert', 'big')), h('h3', {}, msg[0]), h('p', {}, msg[1]),
      retry ? h('button', { class: 'btn primary', type: 'button', onclick: retry }, ic('retry'), 'Retry') : null)
  }

  function renderSrcTree() {
    keepFocus(() => {
      const box = $('tree-src')
      const t = S.tree
      const legend = h('span', { class: 'legend' },
        h('span', { class: 'lg' }, h('span', { class: 'sw sw-hit' }), 'matched'), h('span', { class: 'lg' }, h('span', { class: 'sw sw-dim' }), 'not matched'))
      const title = olatLike(S.src) ? 'Source sample' : 'Source folder'
      const head = h('div', { class: 'tree-h' }, h('span', { class: 'live' }, t.state === 'loading' ? h('span', { class: 'dot busy' }) : null, h('b', {}, title)), legend)
      let body
      if (t.state === 'idle') body = h('div', { class: 'empty' }, 'Choose or drop a source folder.')
      else if (t.state === 'loading') body = h('div', { class: 'empty' }, ic('spinner', 'spin'), '  listing…')
      else if (t.state === 'error') body = failPanel(t.code, () => loadSource())
      else {
        const rows = [treeRow(t.root, 0)]
        srcRows(t.root.children || [], 1, rows)
        if (olatLike(S.src) && t.total > SAMPLE) {
          rows.push(h('div', { class: 'more' }, ic('info'), 'Only the first ' + SAMPLE + ' of ' + t.total + ' folders are listed, to design the pattern. The pattern applies to all ' + t.total + '.'))
        }
        body = h('div', { class: 'tree-b' }, rows)
      }
      mount(box, t.state === 'error' ? null : head, body, dropOverlay('src'))
    })
  }

  function dropOverlay(side) {
    return S.dropping === side ? h('div', { class: 'drop-overlay' }, 'Drop folder to use as ' + (side === 'src' ? 'source' : 'destination')) : null
  }

  function isOpenRow(row) { return row.status === 'existing' ? S.openRows.has(row.path) : !S.closedRows.has(row.path) }

  function dstRow(row) {
    const cls = ['tr']
    if (row.status === 'new') cls.push('new')
    else if (row.status === 'diff') cls.push('diff')
    else if (row.status === 'existing' || row.status === 'unloaded') cls.push('dim')
    const title = { new: 'new', same: 'already there', diff: 'differs in size', existing: 'not touched', pending: 'not compared yet: the source content is not listed', unloaded: 'contents not listed yet: open this folder on the left and load deeper' }[row.status]
    const open = row.dir && isOpenRow(row)
    const chev = h('button', {
      class: 'chev' + (row.dir ? '' : ' none'), type: 'button', tabindex: '-1',
      onclick: (e) => {
        e.stopPropagation()
        if (row.status === 'existing') { S.openRows.has(row.path) ? S.openRows.delete(row.path) : S.openRows.add(row.path) }
        else { S.closedRows.has(row.path) ? S.closedRows.delete(row.path) : S.closedRows.add(row.path) }
        renderDstTree()
      }
    }, row.dir ? ic(open ? 'chevD' : 'chevR') : null)
    return h('div', { class: cls.join(' '), role: 'treeitem', title, style: { paddingLeft: (6 + 18 * row.depth) + 'px' } },
      chev, ic(row.status === 'unloaded' ? 'info' : row.dir ? 'folder' : 'file'), h('span', { class: 'nm' }, row.name), row.status === 'existing' && !row.dir ? h('span', { class: 'cnt' }, 'not touched') : null)
  }

  function renderDstTree() {
    const box = $('tree-dst')
    const pv = S.preview
    const d = direction()
    const legend = h('span', { class: 'legend' },
      h('span', { class: 'lg' }, h('span', { class: 'sw sw-new' }), 'new'),
      h('span', { class: 'lg' }, h('span', { class: 'sw sw-same' }), 'already there'),
      h('span', { class: 'lg' }, h('span', { class: 'sw sw-diff' }), 'differs in size'))
    const head = h('div', { class: 'tree-h' }, h('span', { class: 'live' }, h('span', { class: pv.state === 'loading' ? 'dot busy' : 'dot' }), h('b', {}, 'Preview after transfer')), legend)
    let body
    if (pv.state === 'error' && pv.code === 'NOT_MOUNTED') {
      mount(box, failPanel('NOT_MOUNTED', () => { runPreview() }), dropOverlay('dst')); return
    }
    if (!d.ok) body = h('div', { class: 'empty' }, d.reason)
    else if (S.tree.state === 'error') body = h('div', { class: 'empty' }, 'Nothing to preview until the source folder can be listed.')
    else if (S.tree.state !== 'ok') body = h('div', { class: 'empty' }, 'Nothing to preview until the source folder can be listed.')
    else if (pv.state === 'idle') body = h('div', { class: 'empty' }, 'Add a pattern to see what it selects. Click a folder on the left to start.')
    else if (pv.state === 'loading' && !pv.data) body = h('div', { class: 'empty' }, ic('spinner', 'spin'), '  comparing…')
    else if (pv.state === 'error') body = h('div', { class: 'empty' }, 'Preview failed: ' + (pv.message || pv.code))
    else {
      const data = pv.data
      const rows = []
      const created = data.rows.filter((r) => r.dir && r.status === 'new' && !r.path.includes('/')).map((r) => r.name)
      if (pv.direction === 'upload' && created.length) {
        rows.push(h('div', { class: 'note-warn', role: 'note' }, ic('warn'),
          'Uploading creates ' + created.length + (created.length === 1 ? ' folder' : ' folders') + ' on OLAT: ' + created.join(', ') + '. Nothing on OLAT is deleted when patterns are used.'))
      } else if (pv.direction === 'upload') {
        rows.push(h('div', { class: 'note-warn', role: 'note' }, ic('info'), 'Nothing on OLAT is deleted when patterns are used.'))
      }
      if (!data.rows.length) rows.push(h('div', { class: 'more' }, ic('info'), 'No pattern matches anything in the listed folders.'))
      const hidden = []
      for (const r of data.rows) {
        let skip = false
        for (const hp of hidden) if (r.path.startsWith(hp + '/')) { skip = true; break }
        if (skip) continue
        rows.push(dstRow(r))
        if (r.dir && !isOpenRow(r)) hidden.push(r.path)
      }
      const total = data.topTotal
      const olatSrc = pv.direction === 'download'
      rows.push(h('div', { class: 'more' }, ic('info'), olatSrc
        ? 'Based on the ' + data.sampleCount + ' listed folders' + (S.tree.total > data.sampleCount ? ' of ' + S.tree.total : '') + '. Markers cover only what is fetched from OLAT.'
        : 'Compared with OLAT for the first ' + Math.min(SAMPLE, total) + ' of ' + total + ' local folders' + (total > SAMPLE ? '. The others are not shown.' : '.')))
      rows.push(h('button', { class: 'more load', type: 'button', onclick: () => startDry() }, ic('check'), 'Run full dry run on OLAT (opens a new window)'))
      body = h('div', { class: 'tree-b' }, rows)
    }
    mount(box, head, body, dropOverlay('dst'))
  }

  function renderPaneFields() {
    pathField('in-src', S.src, S.tree.state === 'error')
    pathField('in-dst', S.dst, false)
  }

  // ------------------------------------------------------------------ rendering: patterns
  function patternMessages(row) {
    if (!row.text) return null
    const v = Pattern.validatePattern(row.text)
    if (!v.ok) return { cls: 'pmsg', text: v.reason }
    if (Pattern.hasNonAscii(row.text)) return { cls: 'pmsg warn', text: 'Contains non-ASCII letters. Accented names exist in two Unicode forms, so a typed literal may miss some. Use * for those letters (? counts bytes, not letters).' }
    return null
  }

  function hitsText(i) {
    const pv = S.preview
    if (pv.state !== 'ok' || !pv.data) return null
    const k = pv.map.indexOf(i)
    if (k < 0) return null
    const pp = pv.data.perPattern[k]
    const total = pv.direction === 'download' ? pv.data.sampleCount : pv.data.topTotal
    return { text: pp.top ? 'matches ' + pp.top + ' of ' + total + (pv.direction === 'download' ? ' listed' : ' local') : 'matches nothing', none: !pp.top }
  }

  function updatePatternMessages() {
    S.patterns.forEach((row) => {
      const slot = document.querySelector('[data-msg="' + row.id + '"]')
      if (!slot) return
      const m = patternMessages(row)
      slot.className = m ? m.cls : 'hidden'
      slot.textContent = m ? m.text : ''
    })
  }

  function updateHitsAndBar() {
    S.patterns.forEach((row, i) => {
      const slot = document.querySelector('[data-hits="' + row.id + '"]')
      if (!slot) return
      const t = hitsText(i)
      slot.textContent = t ? t.text : ''
      slot.className = 'hits' + (t && t.none ? ' none' : '')
    })
    renderBar()
  }

  function renderPatterns() {
    keepFocus(() => {
      if (!S.patterns.length) S.patterns.push(newPattern())
      const kids = []
      S.patterns.forEach((row, i) => {
        kids.push(h('div', { class: 'prow' + (i === S.focus ? ' focus' : ''), onfocusin: () => { if (S.focus !== i) { S.focus = i; document.querySelectorAll('.prow').forEach((r, k) => r.classList.toggle('focus', k === i)) } } },
          h('span', { class: 'n', 'aria-hidden': 'true' }, String(i + 1)),
          h('input', {
            class: 'in', type: 'text', spellcheck: 'false', value: row.text, 'aria-label': 'Pattern ' + (i + 1), 'data-pid': row.id, 'data-fid': 'pat-' + row.id,
            placeholder: '*/Participant Drop Box/a1.1',
            oninput: (e) => { row.text = e.target.value; row.levels = null; S.selected = null; updatePatternMessages(); persist(); schedulePreview(); renderSrcTree() }
          }),
          h('span', { class: 'hits', 'data-hits': row.id }),
          h('button', { class: 'btn sm icon', type: 'button', 'aria-label': 'Remove pattern ' + (i + 1), title: 'Remove pattern', onclick: () => removePattern(i) }, ic('close'))))
        const m = patternMessages(row)
        kids.push(h('div', { 'data-msg': row.id, class: m ? m.cls : 'hidden' }, m ? m.text : ''))
      })
      mount($('patterns'), kids)
      updateHitsAndBar()
    })
  }

  // ------------------------------------------------------------------ rendering: bar, menus, modals
  function renderBar() {
    const r = readiness()
    $('btn-play').disabled = !r.ok
    $('btn-save').disabled = !r.ok
    $('btn-play').title = r.ok ? 'Run' : r.reason
    $('btn-save').title = r.ok ? 'Save .command' : r.reason
    $('status').textContent = ''
  }

  function menuItem(icon, label, onclick) {
    return h('button', { class: 'mi', type: 'button', role: 'menuitem', onclick }, ic(icon), label)
  }

  function renderMenus() {
    const d = direction()
    const up = d.ok && d.value === 'upload'
    const open = S.menu !== null
    mount($('menu-layer'), open ? h('button', { class: 'dismiss', type: 'button', 'aria-label': 'Close menu', onclick: () => { S.menu = null; renderMenus() } }) : null)
    $('btn-gear').setAttribute('aria-expanded', String(S.menu === 'gear'))
    $('btn-play').setAttribute('aria-expanded', String(S.menu === 'play'))
    mount($('pop-gear'), S.menu === 'gear' ? h('div', { class: 'pop', role: 'menu', 'aria-label': 'Settings' },
      h('label', { class: 'mi' }, h('input', { type: 'checkbox', checked: S.eject, onchange: (e) => { S.eject = e.target.checked; persist(); renderBar() } }), 'Disconnect WebDAV when done'),
      h('label', { class: 'mi' + (up ? '' : ' off') }, h('input', { type: 'checkbox', checked: S.sidecar && up, disabled: !up, onchange: (e) => { S.sidecar = e.target.checked; persist() } }),
        h('span', {}, 'Remove macOS ._ files after upload', h('span', { class: 'mi-hint' }, up ? 'Use it if ._ files show up on OLAT after an upload' : 'Only for uploads to OLAT')))
    ) : null)
    mount($('pop-play'), S.menu === 'play' ? h('div', { class: 'pop', role: 'menu', 'aria-label': 'Run' },
      menuItem('play', 'Dry-run (opens a new window)', () => { S.menu = null; renderMenus(); startDry() }),
      menuItem('play', 'Run', () => { S.menu = null; renderMenus(); openRun() })
    ) : null)
  }

  function modalShell(title, id, ...body) {
    return h('div', { class: 'scrim' },
      h('button', { class: 'scrim-close', type: 'button', 'aria-label': 'Close dialog', onclick: closeModal }),
      h('div', { class: 'dialog' + (id === 'rt' ? ' wide' : ''), role: 'dialog', 'aria-labelledby': id },
        h('div', { class: 'dh' }, h('h3', { id }, title), h('button', { class: 'btn icon', type: 'button', 'aria-label': 'Close', onclick: closeModal }, ic('close'))), body))
  }

  function closeModal() { S.modal = null; renderModal() }

  function commandText() {
    const r = readiness()
    if (!r.ok) return ''
    return Command.buildCommand(S.info.scriptPath, cmdParams(false))
  }

  function renderModal() {
    const layer = $('modal-layer')
    if (S.modal === 'save') {
      const text = commandText()
      mount(layer, modalShell('Save command', 'sv',
        h('div', {}, h('span', { class: 'fl', id: 'gen' }, 'Generated .command'), h('pre', { class: 'code', 'aria-labelledby': 'gen' }, text)),
        h('div', { class: 'actions' },
          h('button', { class: 'btn primary', type: 'button', onclick: () => saveCommand(false) }, ic('save'), 'Save .command…'),
          h('button', { class: 'btn', type: 'button', onclick: () => saveCommand(true) }, ic('terminal'), 'Save & run in Terminal'),
          h('button', { class: 'btn ghost', type: 'button', onclick: async () => { await api.copy(text); S.saveMsg = 'Copied.'; S.saveErr = ''; renderModal() } }, ic('copy'), 'Copy command')),
        S.saveMsg ? h('div', { class: 'saved' }, S.saveMsg) : null,
        S.saveErr ? h('div', { class: 'errtxt' }, S.saveErr) : null))
    } else if (S.modal === 'run') {
      const r = S.run
      const pre = h('pre', { class: 'run-output', tabindex: '0', 'aria-label': 'Command output', id: 'run-pre' }, r.output)
      mount(layer, modalShell('Run', 'rt',
        h('div', { class: 'run-actions' },
          h('button', { class: 'btn danger', type: 'button', disabled: r.running, onclick: () => openRun(true) }, ic('play'), 'Run again'),
          h('button', { class: 'btn ghost', type: 'button', disabled: !r.running, onclick: () => api.run.abort() }, 'Abort'),
          h('button', { class: 'btn', type: 'button', onclick: () => api.copy($('run-pre') ? $('run-pre').textContent : '') }, ic('copy'), 'Copy output')),
        h('div', { class: 'run-summary', id: 'run-summary' }, runSummary()), pre))
      pre.scrollTop = pre.scrollHeight
    } else if (S.modal && S.modal.notice) {
      mount(layer, modalShell(S.modal.notice.title, 'nt', h('div', {}, S.modal.notice.text),
        h('div', { class: 'actions' }, h('button', { class: 'btn primary', type: 'button', onclick: closeModal }, 'OK'))))
    } else mount(layer)
  }

  function runSummary() {
    const r = S.run
    if (r.running) return 'Running…'
    if (r.exit === null) return ''
    return r.exit === 0 ? '✓ exit 0 · 1 succeeded · 0 failed' : '✗ exit ' + r.exit + ' · 0 succeeded · 1 failed'
  }

  // ------------------------------------------------------------------ actions
  async function saveCommand(runInTerminal) {
    S.saveMsg = ''; S.saveErr = ''
    const r = readiness()
    const name = (baseName(S.dst) || 'transfer').replace(/[^\w .-]/g, '') + (r.direction === 'upload' ? '-upload' : '-download') + '.command'
    const res = await api.saveCommand({ text: commandText(), name, defaultDir: S.saveDir || undefined, runInTerminal })
    if (!res.ok) S.saveErr = res.error
    else if (res.value.path) {
      S.saveMsg = 'Saved ' + res.value.path + (runInTerminal ? ' and started it in Terminal.' : '.')
      S.saveDir = res.value.path.replace(/\/[^/]*$/, '')
      persist()
    }
    renderModal()
  }

  async function openRun(again) {
    if (!again) S.run = { output: '', running: false, exit: null, cmd: '' }
    else S.run = { output: '', running: false, exit: null, cmd: '' }
    S.modal = 'run'
    renderModal()
    const res = await api.run.start(cmdParams(false))
    if (!res.ok) { S.run.output = res.error + '\n'; renderModal(); return }
    S.run.running = true
    renderModal()
  }

  function startDry() {
    const r = readiness()
    if (!r.ok) return
    api.dryrun.open(cmdParams(true)).then((res) => { if (!res.ok) { S.modal = { notice: { title: 'Cannot start the dry run', text: res.error } }; renderModal() } })
  }

  async function openExisting() {
    const res = await api.openCommand()
    if (!res.ok || !res.value.path) { if (!res.ok) S.modal = { notice: { title: 'Cannot open the file', text: res.error } }; renderModal(); return }
    const parsed = Command.parseCommand(res.value.text)
    if (!parsed.ok) { S.modal = { notice: { title: 'Not a Command Maker file', text: parsed.error } }; renderModal(); return }
    S.src = parsed.src; S.dst = parsed.dest
    S.eject = parsed.eject; S.sidecar = parsed.sidecar
    S.patterns = parsed.patterns.map((p) => newPattern(p))
    S.focus = 0; S.selected = null
    await refreshInfos()
    persist()
    renderAll()
    loadSource()
  }

  async function refreshInfos() {
    const a = S.src ? await api.pathInfo(S.src) : null
    const b = S.dst ? await api.pathInfo(S.dst) : null
    S.srcInfo = a && a.ok ? a.value : null
    S.dstInfo = b && b.ok ? b.value : null
  }

  async function setPath(side, value) {
    value = value.trim()
    if (value.length > 1) value = value.replace(/\/+$/, '')      // no trailing slash
    if (side === 'src' && value === S.src) return
    if (side === 'dst' && value === S.dst) return
    if (side === 'src') S.src = value; else S.dst = value
    persist()
    await refreshInfos()
    if (side === 'src') loadSource()
    else { renderAll(); schedulePreview() }
  }

  async function chooseDir(side) {
    const cur = side === 'src' ? S.src : S.dst
    const res = await api.chooseDir({ title: side === 'src' ? 'Choose the source folder' : 'Choose the destination folder', defaultPath: cur || undefined })
    if (res.ok && res.value.path) { await setPath(side, res.value.path) }
  }

  // ------------------------------------------------------------------ wiring
  function renderAll() {
    renderPaneFields()
    renderSrcTree()
    renderDstTree()
    renderPatterns()
    renderMenus()
    renderModal()
    renderBar()
  }

  function wirePane(side) {
    const pane = $('pane-' + side)
    const input = $('in-' + side)
    input.addEventListener('change', () => setPath(side, input.value))
    input.addEventListener('keydown', (e) => { if (e.key === 'Enter') setPath(side, input.value) })
    pane.addEventListener('dragover', (e) => { e.preventDefault(); if (S.dropping !== side) { S.dropping = side; side === 'src' ? renderSrcTree() : renderDstTree() } })
    pane.addEventListener('dragleave', (e) => { if (!pane.contains(e.relatedTarget)) { S.dropping = null; side === 'src' ? renderSrcTree() : renderDstTree() } })
    pane.addEventListener('drop', async (e) => {
      e.preventDefault()
      S.dropping = null
      const file = e.dataTransfer && e.dataTransfer.files && e.dataTransfer.files[0]
      const p = file ? api.pathForFile(file) : ''
      side === 'src' ? renderSrcTree() : renderDstTree()
      if (!p) return
      const info = await api.pathInfo(p)
      if (info.ok && info.value.kind === 'dir') setPath(side, p)
      else { S.modal = { notice: { title: 'Not a folder', text: 'Drop a folder, not a file.' } }; renderModal() }
    })
  }

  async function init() {
    document.addEventListener('dragover', (e) => e.preventDefault())
    document.addEventListener('drop', (e) => e.preventDefault())
    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') { if (S.modal) closeModal(); else if (S.menu) { S.menu = null; renderMenus() } }
    })
    mount($('browse-src'), ic('folder')); mount($('browse-dst'), ic('folder'))
    mount($('arrow'), ic('arrow', 'big'))
    mount($('add-pattern'), ic('plus'), 'Add pattern')
    mount($('open-cmd'), ic('folderOpen')); mount($('btn-gear'), ic('gear')); mount($('btn-play'), ic('play')); mount($('btn-save'), ic('save'))
    $('browse-src').addEventListener('click', () => chooseDir('src'))
    $('browse-dst').addEventListener('click', () => chooseDir('dst'))
    $('add-pattern').addEventListener('click', addPattern)
    $('open-cmd').addEventListener('click', openExisting)
    $('btn-gear').addEventListener('click', () => { S.menu = S.menu === 'gear' ? null : 'gear'; renderMenus() })
    $('btn-play').addEventListener('click', () => { S.menu = S.menu === 'play' ? null : 'play'; renderMenus() })
    $('btn-save').addEventListener('click', () => { S.saveMsg = ''; S.saveErr = ''; S.modal = 'save'; renderModal() })
    wirePane('src'); wirePane('dst')

    api.run.onEvent((ev) => {
      const r = S.run
      if (ev.type === 'start') r.output = '▶ ' + ev.cmd + '\n\n'
      else if (ev.type === 'out') r.output += ev.text
      else if (ev.type === 'exit') { r.running = false; r.exit = ev.code; r.output += '\n' + (ev.code === 0 ? '✓' : '✗') + ' exit ' + (ev.code === null ? 'error' : ev.code) + '\n' }
      if (S.modal === 'run') {
        const pre = $('run-pre')
        if (ev.type === 'exit') renderModal()
        else if (pre) { pre.textContent = r.output; pre.scrollTop = pre.scrollHeight }
      }
    })

    const [info, settings] = await Promise.all([api.info(), api.loadSettings()])
    if (info.ok) S.info = info.value
    const s = settings.ok ? settings.value : {}
    S.src = s.src || ''; S.dst = s.dst || ''
    S.eject = s.eject !== false; S.sidecar = !!s.sidecar; S.saveDir = s.saveDir || ''
    S.patterns = (s.patterns || []).map((t) => newPattern(t))
    await refreshInfos()
    renderAll()
    if (S.src) loadSource()
  }

  window.__cm = { S, setPath, runPreview, addPattern, setExample, nodeAt, loadSource, loadChildren, toggleNode, renderAll }   // self-check hook
  init()
})()
