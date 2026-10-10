'use strict'
;(() => {
  const { h, ic, mount } = window.UI
  const Summary = window.CMSummary
  const api = window.api
  const $ = (id) => document.getElementById(id)

  let job = null          // snapshot from main
  let tab = 'matches'
  let pendingEvents = []
  let outputEl = null

  function split() {
    const at = job.output.indexOf('\n▶ ')
    return { dry: at < 0 ? job.output : job.output.slice(0, at), real: at < 0 ? '' : job.output.slice(at + 1) }
  }

  const realStarted = () => job.output.includes('\n▶ ')
  const finished = () => job.state === 'done'

  function outputText() {
    return '▶ ' + job.cmdDry + '\n\n' + job.output
  }

  function matchesView(sum, up) {
    const kids = []
    if (up && sum.createdTop.length) {
      kids.push(h('div', { class: 'note-warn', role: 'note' }, ic('warn'),
        'Creates ' + sum.createdTop.length + (sum.createdTop.length === 1 ? ' folder' : ' folders') + ' on OLAT: ' + sum.createdTop.join(', ') + '. Nothing on OLAT is deleted.'))
    }
    if (!sum.groups.length) kids.push(h('div', { class: 'mr dim' }, 'No matching folders.'))
    for (const g of sum.groups) {
      const parts = [g.files + (g.files === 1 ? ' file' : ' files')]
      if (g.created && g.created !== g.files) parts.push(g.created + ' new')
      if (g.sizeDiff) parts.push(g.sizeDiff + ' differ')
      kids.push(h('div', { class: 'mr' }, ic('folder'), h('span', { class: 'mn', title: g.name }, g.name), h('span', { class: 'cnt' }, parts.join(' · '))))
    }
    if (sum.absent.length) {
      kids.push(h('details', {}, h('summary', {}, 'Show the ' + sum.absent.length + ' ' + (sum.absent.length === 1 ? 'folder' : 'folders') + ' without this path'),
        sum.absent.map((n) => h('div', { class: 'mr dim' }, ic('folder'), h('span', { class: 'mn' }, n)))))
    }
    return h('div', {}, kids)
  }

  function render() {
    if (!job) return
    document.title = job.title
    $('title').textContent = job.title
    const up = job.params.direction === 'upload'
    const parts = split()
    const sum = Summary.summarize(parts.dry, job.params.patterns, job.topFolders)
    const failed = finished() && !realStarted() && job.exitCode !== 0
    const running = job.state !== 'done'
    const dryDone = !running || realStarted()

    let summaryText
    if (!dryDone) summaryText = 'Running…'
    else if (failed) summaryText = 'The dry run failed (exit ' + job.exitCode + '). See the Output tab.'
    else summaryText = sum.groups.length + ' matching folders · ' + sum.files.toLocaleString() + (up ? ' files to upload' : ' files') +
      (sum.absent.length ? ' · ' + sum.absent.length + ' ' + (up ? 'local folders' : 'students') + ' without this path' : '') +
      (up && sum.createdTop.length ? ' · ' + sum.createdTop.length + ' folder(s) would be created on OLAT' : '')

    const outPre = h('pre', { class: 'run-output', tabindex: '0', 'aria-label': 'Dry-run output', id: 'out' }, outputText())
    outputEl = outPre
    const panel = h('div', { class: 'panel' }, tab === 'matches' ? matchesView(sum, up) : outPre)

    mount($('body'),
      h('div', {}, h('span', { class: 'fl', id: 'cmdl' }, 'Command'), h('pre', { class: 'code', 'aria-labelledby': 'cmdl' }, job.cmdDry)),
      h('div', { class: 'sumrow' }, h('span', { class: 'badge-pill' + (failed ? ' bad' : '') }, failed ? 'Dry run failed' : 'Dry run: nothing was copied'), h('span', { class: 'sum' }, summaryText)),
      h('div', { class: 'seg', role: 'group', 'aria-label': 'View' },
        h('button', { type: 'button', 'aria-pressed': String(tab === 'matches'), onclick: () => { tab = 'matches'; render() } }, 'Matches'),
        h('button', { type: 'button', 'aria-pressed': String(tab === 'output'), onclick: () => { tab = 'output'; render() } }, 'Output')),
      panel)
    if (tab === 'output') outPre.scrollTop = outPre.scrollHeight

    let status
    if (job.state === 'running') status = 'Running the dry run…'
    else if (job.state === 'running-real') status = 'Running for real…'
    else if (realStarted()) status = 'Run finished · exit ' + (job.exitCode === null ? 'error' : job.exitCode)
    else status = 'Finished in ' + (((job.finishedAt || Date.now()) - job.startedAt) / 1000).toFixed(1) + ' s · exit ' + (job.exitCode === null ? 'error' : job.exitCode)
    mount($('bar'),
      h('div', { class: 'status', role: 'status' }, status),
      running ? h('button', { class: 'btn ghost', type: 'button', onclick: () => api.dryrun.abort() }, 'Abort') : null,
      h('button', { class: 'btn', type: 'button', onclick: () => api.copy ? api.copy(outputText()) : null }, ic('copy'), 'Copy output'),
      h('button', { class: 'btn danger', type: 'button', disabled: running || realStarted() || failed, title: 'Run the same command for real (without -n)', onclick: () => { tab = 'output'; api.dryrun.runReal() } }, ic('play'), 'Run'),
      h('button', { class: 'btn', type: 'button', onclick: () => api.dryrun.close() }, 'Close'))
  }

  function apply(ev) {
    if (ev.type === 'out') {
      const have = job.output.length
      if (ev.offset >= have) job.output += ev.text
      else if (ev.offset + ev.text.length > have) job.output += ev.text.slice(have - ev.offset)
      if (tab === 'output' && outputEl) { outputEl.textContent = outputText(); outputEl.scrollTop = outputEl.scrollHeight }
      else if (tab === 'matches') render()
    } else if (ev.type === 'exit') {
      job.state = 'done'; job.exitCode = ev.code; job.finishedAt = ev.finishedAt
      if (!ev.real && ev.code !== 0) tab = 'output'
      render()
    }
  }

  async function init() {
    document.addEventListener('dragover', (e) => e.preventDefault())
    document.addEventListener('drop', (e) => e.preventDefault())
    api.dryrun.onEvent((ev) => { if (job) apply(ev); else pendingEvents.push(ev) })
    const res = await api.dryrun.get()
    if (!res.ok) { $('body').textContent = res.error; return }
    job = res.value
    for (const ev of pendingEvents) apply(ev)
    pendingEvents = []
    render()
  }
  init()
})()
