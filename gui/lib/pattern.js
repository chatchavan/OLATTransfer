// Pattern helpers (rsync wildcard patterns, see olat-common.sh build_pattern_filters).
// Matching itself is NEVER done here: the script/rsync is the only matcher.
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory()
  else root.CMPattern = factory()
})(typeof self !== 'undefined' ? self : this, function () {
  // Escape a folder/file name so it matches only itself.
  function escapeLiteral(name) {
    return String(name).replace(/[\\*?[\]]/g, '\\$&')
  }

  // Same rules as validate_pattern in olat-common.sh.
  function validatePattern(pattern) {
    if (!pattern) return { ok: false, reason: 'Pattern is empty' }
    if (pattern.includes('\n')) return { ok: false, reason: 'Pattern contains a newline' }
    if (pattern.startsWith('/')) return { ok: false, reason: "Pattern must be relative to the source folder (no leading '/')" }
    const p = pattern.endsWith('/') ? pattern.slice(0, -1) : pattern
    for (const seg of p.split('/')) {
      if (seg === '') return { ok: false, reason: "Pattern has an empty path level ('//')" }
      if (seg === '.' || seg === '..') return { ok: false, reason: "Pattern must not contain '.' or '..' levels" }
    }
    return { ok: true, pattern: p }
  }

  // A level of an example path: {name, mode: 'literal'|'any'|'custom', custom}
  function levelText(level) {
    if (level.mode === 'any') return '*'
    if (level.mode === 'custom') return level.custom
    return escapeLiteral(level.name)
  }

  function levelsToPattern(levels) {
    return levels.map(levelText).join('/')
  }

  // Default modes for an example path: the first level (the student level, many
  // siblings) is Any, the rest Literal. Previous levels with the same name keep
  // their mode when the user extends or changes the example.
  function levelsFromPath(names, previous, manyFirst) {
    if (manyFirst === undefined) manyFirst = names.length > 1
    return names.map((name, i) => {
      const old = previous && previous[i]
      if (old && old.name === name) return old
      return { name, mode: i === 0 && manyFirst ? 'any' : 'literal', custom: name }
    })
  }

  // Number of levels of a pattern, or null when it contains '**' (any depth).
  function patternLevels(pattern) {
    if (pattern.includes('**')) return null
    const p = pattern.endsWith('/') ? pattern.slice(0, -1) : pattern
    return p.split('/').length
  }

  // The pattern as seen from a sub-folder of the source root: when its first levels
  // are exactly that folder's path (the same name, or *), they are dropped. Returns
  // the new pattern, or null when it does not start with that path.
  function rebasePattern(pattern, rel) {
    const levels = pattern.split('/')
    if (levels.length <= rel.length) return null
    for (let i = 0; i < rel.length; i++) {
      if (levels[i] !== '*' && levels[i] !== escapeLiteral(rel[i])) return null
    }
    return levels.slice(rel.length).join('/')
  }

  function hasNonAscii(text) {
    return /[^\x00-\x7f]/.test(text)
  }

  return { escapeLiteral, validatePattern, levelText, levelsToPattern, levelsFromPath, patternLevels, rebasePattern, hasNonAscii }
})
