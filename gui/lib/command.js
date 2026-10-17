// Builds and parses the .command files and the script arguments.
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory(require('./shell.js'))
  else root.CMCommand = factory(root.CMShell)
})(typeof self !== 'undefined' ? self : this, function (Shell) {
  const MARKER = '# olat-command-maker: v1'   // keeps the app's old name so existing .command files still open

  // Arguments for olatTransfer.sh (after the script path).
  // opts: {direction, src, dest, patterns, eject, sidecar, dry}
  function buildArgs(o) {
    const args = []
    if (o.dry) args.push('-n')
    else {
      if (o.eject) args.push('-d')
      if (o.sidecar && o.direction === 'upload') args.push('-s')
    }
    for (const p of o.patterns) args.push('-m', p)
    args.push(o.src, o.dest)
    return args
  }

  // One-line shell command, for display in the Run window.
  function buildOneLine(scriptPath, o) {
    const args = buildArgs(o)
    const parts = ['bash', Shell.dq(scriptPath)]
    for (let i = 0; i < args.length; i++) {
      const a = args[i]
      if (a === '-m') { parts.push('-m', Shell.dq(args[++i])) }
      else if (/^-[dsn]$/.test(a)) parts.push(a)
      else parts.push(Shell.dq(a))
    }
    return parts.join(' ')
  }

  // The .command file text. opts as above (dry is ignored: files are for real runs).
  function buildCommand(scriptPath, o) {
    const lines = [
      '#!/bin/bash',
      MARKER,
      '# direction=' + o.direction,
      '# root=' + o.src
    ]
    for (const p of o.patterns) lines.push('# pattern=' + p)
    lines.push('# disconnect=' + (o.eject ? 'yes' : 'no'))
    lines.push('bash ' + Shell.dq(scriptPath) + ' \\')
    const args = buildArgs(Object.assign({}, o, { dry: false }))
    for (let i = 0; i < args.length; i++) {
      const a = args[i]
      let text
      if (a === '-m') { text = '-m ' + Shell.dq(args[++i]) }
      else if (/^-[ds]$/.test(a)) text = a
      else text = Shell.dq(a)
      const last = i === args.length - 1
      lines.push('\t' + text + (last ? '' : ' \\'))
    }
    return lines.join('\n') + '\n'
  }

  // Reads a file written by buildCommand. Refuses files without the marker.
  function parseCommand(text) {
    const lines = String(text).split('\n')
    if (!lines.some((l) => l.trim() === MARKER)) {
      return { ok: false, error: 'This file was not made by Rsync pattern maker (no "' + MARKER + '" line).' }
    }
    const at = lines.findIndex((l) => /^bash\s+"/.test(l))
    if (at < 0) return { ok: false, error: 'No olatTransfer.sh call found in the file.' }
    let words
    try { words = Shell.splitWords(lines.slice(at).join('\n')) } catch (e) { return { ok: false, error: 'Cannot read the command: ' + e.message } }
    // words[0] = bash, words[1] = script path
    const rest = words.slice(2)
    const patterns = []
    let eject = false, sidecar = false
    const positional = []
    for (let i = 0; i < rest.length; i++) {
      const w = rest[i]
      if (w === '-m') patterns.push(rest[++i])
      else if (w === '-d') eject = true
      else if (w === '-s') sidecar = true
      else positional.push(w)
    }
    if (positional.length !== 2 || patterns.some((p) => p === undefined)) {
      return { ok: false, error: 'Expected exactly a source and a destination folder in the command.' }
    }
    const meta = {}
    for (const l of lines.slice(0, at)) {
      const m = /^#\s*direction=(.*)$/.exec(l)
      if (m) meta.direction = m[1].trim()
    }
    return { ok: true, scriptPath: words[1], direction: meta.direction || null, src: positional[0], dest: positional[1], patterns, eject, sidecar }
  }

  return { MARKER, buildArgs, buildOneLine, buildCommand, parseCommand }
})
