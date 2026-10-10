// Quoting for the generated .command files. One function, tested against bash.
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory()
  else root.CMShell = factory()
})(typeof self !== 'undefined' ? self : this, function () {
  // Double-quote a value for bash: inside "..." only \ " $ ` are special.
  function dq(value) {
    return '"' + String(value).replace(/[\\"$`]/g, '\\$&') + '"'
  }

  // Split a bash-ish command line into words. Understands bare words and
  // double-quoted strings (with \\ \" \$ \` escapes) and backslash-newline
  // continuations: exactly what buildCommand() produces, nothing more.
  function splitWords(text) {
    const words = []
    let i = 0
    const n = text.length
    while (i < n) {
      const c = text[i]
      if (c === ' ' || c === '\t' || c === '\n') { i++; continue }
      if (c === '\\' && text[i + 1] === '\n') { i += 2; continue }
      let word = ''
      while (i < n && !/[ \t\n]/.test(text[i])) {
        if (text[i] === '"') {
          i++
          while (i < n && text[i] !== '"') {
            if (text[i] === '\\' && /[\\"$`]/.test(text[i + 1] || '')) { word += text[i + 1]; i += 2 }
            else { word += text[i]; i++ }
          }
          if (i >= n) throw new Error('unterminated quote')
          i++
        } else if (text[i] === '\\' && text[i + 1] === '\n') {
          break
        } else {
          word += text[i]; i++
        }
      }
      words.push(word)
    }
    return words
  }

  return { dq, splitWords }
})
