// Turns the output of `olatTransfer.sh -n …` (rsync -i lines) into the numbers
// and groups shown in the dry-run window.
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory(require('./pattern.js'))
  else root.CMSummary = factory(root.CMPattern)
})(typeof self !== 'undefined' ? self : this, function (Pattern) {
  // rsync itemize line: 11 flag characters, a space, the path. Only lines that
  // start at column 0 count (the script's own summary lines are indented).
  const ITEM = /^([<>ch.*][fdLDS])([.+?a-zA-Z]{5,9}) (.+)$/

  function parseItemize(output) {
    const items = []
    for (const line of String(output).split('\n')) {
      const m = ITEM.exec(line.replace(/\r$/, ''))
      if (!m) continue
      const path = m[3]
      if (path === './') continue
      const isDir = m[1][1] === 'd'
      items.push({
        path: path.replace(/\/$/, ''),
        dir: isDir,
        created: m[2].includes('+'),
        sizeDiff: !m[2].includes('+') && m[2][1] === 's'
      })
    }
    return items
  }

  // topFolders: names of the folders at the source root (for "without this path").
  function summarize(output, patterns, topFolders) {
    const items = parseItemize(output)
    const files = items.filter((i) => !i.dir)
    const levelList = patterns.map(Pattern.patternLevels)
    const k = levelList.some((l) => l === null) ? null : Math.min.apply(null, levelList.length ? levelList : [1])
    const groups = new Map()
    for (const f of files) {
      const parts = f.path.split('/')
      const key = k === null || parts.length <= k ? parts.slice(0, -1).join('/') || parts[0] : parts.slice(0, k).join('/')
      let g = groups.get(key)
      if (!g) { g = { name: key, files: 0, created: 0, sizeDiff: 0 }; groups.set(key, g) }
      g.files++
      if (f.created) g.created++
      else if (f.sizeDiff) g.sizeDiff++
    }
    const groupList = Array.from(groups.values()).sort((a, b) => (a.name < b.name ? -1 : 1))
    const withMatch = new Set(groupList.map((g) => g.name.split('/')[0]))
    const absent = (topFolders || []).filter((n) => !withMatch.has(n))
    const createdTop = items.filter((i) => i.dir && i.created && !i.path.includes('/')).map((i) => i.path)
    return { files: files.length, groups: groupList, absent, createdTop, items }
  }

  return { parseItemize, summarize }
})
