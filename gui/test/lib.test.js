const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('fs')
const os = require('os')
const path = require('path')
const { execFileSync, spawnSync } = require('child_process')

const Shell = require('../lib/shell.js')
const Pattern = require('../lib/pattern.js')
const Command = require('../lib/command.js')
const Summary = require('../lib/summary.js')
const Listing = require('../lib/listing.js')
const Preview = require('../lib/preview.js')

const REPO = path.resolve(__dirname, '..', '..')
const COMMON = path.join(REPO, 'olat-common.sh')
const SCRIPT = path.join(REPO, 'olatTransfer.sh')

const NASTY = ['plain', 'with space', 'Geyer, Marlena', 'q"uote', "it's", 'dollar$HOME', 'back`tick`', 'back\\slash', 'x*y?z[1]', 'Müller', 'a1.?', '$(touch /tmp/should-not-exist)', '${HOME}']

test('dq: bash gives the value back unchanged', () => {
  for (const v of NASTY) {
    const out = execFileSync('/bin/bash', ['-c', 'printf %s ' + Shell.dq(v)]).toString()
    assert.equal(out, v)
  }
})

test('splitWords reverses dq', () => {
  const words = Shell.splitWords(NASTY.map(Shell.dq).join(' \\\n\t'))
  assert.deepEqual(words, NASTY)
})

test('escapeLiteral escapes only the four special characters', () => {
  assert.equal(Pattern.escapeLiteral('a1.1'), 'a1.1')
  assert.equal(Pattern.escapeLiteral('x*y?z[1]\\'), 'x\\*y\\?z\\[1\\]\\\\')
  assert.equal(Pattern.escapeLiteral('Geyer, Marlena'), 'Geyer, Marlena')
})

test('validatePattern agrees with validate_pattern in olat-common.sh', () => {
  const cases = ['', '/abs', 'a//b', 'a/./b', 'a/../b', 'a/b/', '*/Participant Drop Box/a1.1', '**/x', 'a\nb', '.', 'a b/c']
  for (const c of cases) {
    const bash = spawnSync('/bin/bash', ['-c', 'source "$1"; validate_pattern "$2"', 'bash', COMMON, c])
    assert.equal(Pattern.validatePattern(c).ok, bash.status === 0, JSON.stringify(c))
  }
})

test('levels: defaults, modes, extension keeps modes', () => {
  const a = Pattern.levelsFromPath(['Example Student A', 'Participant Drop Box', 'a1.1'])
  assert.deepEqual(a.map((l) => l.mode), ['any', 'literal', 'literal'])
  assert.equal(Pattern.levelsToPattern(a), '*/Participant Drop Box/a1.1')
  a[2].mode = 'custom'; a[2].custom = 'a1.?'
  const b = Pattern.levelsFromPath(['Example Student A', 'Participant Drop Box', 'a1.1', 'x[1].txt'], a)
  assert.equal(b[2].mode, 'custom')
  assert.equal(Pattern.levelsToPattern(b), '*/Participant Drop Box/a1.?/x\\[1\\].txt')
  assert.equal(Pattern.levelsFromPath(['only'])[0].mode, 'literal')
})

test('patternLevels', () => {
  assert.equal(Pattern.patternLevels('*/a/b'), 3)
  assert.equal(Pattern.patternLevels('a/b/'), 2)
  assert.equal(Pattern.patternLevels('**/x'), null)
})

const OPTS = { direction: 'download', src: '/Volumes/lms.uzh.ch/webdav/x y/Hand in', dest: '/Users/chat/Desktop/a "1.1"', patterns: ['*/Participant Drop Box/a1.1', '*/Participant Drop Box/a1.?'], eject: true, sidecar: false }

test('buildCommand / parseCommand round trip', () => {
  for (const o of [OPTS, Object.assign({}, OPTS, { eject: false }), Object.assign({}, OPTS, { direction: 'upload', sidecar: true, src: '/Users/chat/$x', dest: '/Volumes/lms.uzh.ch/a`b' })]) {
    const text = Command.buildCommand('/repo dir/olatTransfer.sh', o)
    const r = Command.parseCommand(text)
    assert.equal(r.ok, true, r.error)
    assert.equal(r.scriptPath, '/repo dir/olatTransfer.sh')
    assert.equal(r.src, o.src); assert.equal(r.dest, o.dest)
    assert.deepEqual(r.patterns, o.patterns)
    assert.equal(r.eject, o.eject); assert.equal(r.sidecar, o.sidecar)
    assert.equal(r.direction, o.direction)
  }
})

test('buildCommand layout, flags order, and -s only for uploads', () => {
  const t = Command.buildCommand('/r/olatTransfer.sh', OPTS)
  assert.match(t, /^#!\/bin\/bash\n# olat-command-maker: v1\n# direction=download\n# root=/)
  assert.match(t, /\n# pattern=\*\/Participant Drop Box\/a1\.1\n# pattern=\*\/Participant Drop Box\/a1\.\?\n# disconnect=yes\nbash "\/r\/olatTransfer.sh" \\\n\t-d \\\n\t-m "/)
  assert.ok(!/-s \\/.test(Command.buildCommand('/r/o.sh', Object.assign({}, OPTS, { sidecar: true }))))
  const up = Command.buildCommand('/r/o.sh', Object.assign({}, OPTS, { direction: 'upload', sidecar: true }))
  assert.match(up, /\t-d \\\n\t-s \\\n\t-m /)
  assert.ok(t.endsWith('"\n') && !t.includes('\\\n\n'))
})

test('buildCommand output is valid bash that passes the right arguments', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cm-test-'))
  try {
    const fake = path.join(dir, 'fake script.sh')
    fs.writeFileSync(fake, '#!/bin/bash\nfor a in "$@"; do printf "[%s]\\n" "$a"; done\n')
    const cmd = path.join(dir, 'x.command')
    fs.writeFileSync(cmd, Command.buildCommand(fake, OPTS))
    const out = execFileSync('/bin/bash', [cmd]).toString().trim().split('\n')
    assert.deepEqual(out, ['[-d]', '[-m]', '[' + OPTS.patterns[0] + ']', '[-m]', '[' + OPTS.patterns[1] + ']', '[' + OPTS.src + ']', '[' + OPTS.dest + ']'])
  } finally { fs.rmSync(dir, { recursive: true, force: true }) }
})

test('parseCommand refuses foreign files', () => {
  assert.equal(Command.parseCommand('#!/bin/bash\nbash "/x/olatTransfer.sh" -m "a" "b" "c"\n').ok, false)
  assert.equal(Command.parseCommand('#!/bin/bash\n# olat-command-maker: v1\necho hi\n').ok, false)
})

test('buildArgs: dry run never disconnects, -s only for upload', () => {
  assert.deepEqual(Command.buildArgs(Object.assign({}, OPTS, { dry: true })).slice(0, 1), ['-n'])
  assert.ok(!Command.buildArgs(Object.assign({}, OPTS, { dry: true })).includes('-d'))
  assert.ok(!Command.buildArgs(Object.assign({}, OPTS, { sidecar: true })).includes('-s'))
  assert.ok(Command.buildArgs(Object.assign({}, OPTS, { sidecar: true, direction: 'upload' })).includes('-s'))
})

test('parseItemize / summarize', () => {
  const out = [
    'Starting rsync------------------',
    'cd+++++++++ A/', 'cd+++++++++ A/Box/', 'cd+++++++++ A/Box/a1.1/',
    '>f+++++++++ A/Box/a1.1/x.pdf', '>f.s....... A/Box/a1.1/y.txt',
    '>f+++++++++ B/Box/a1.1/z.pdf',
    '', 'Would download 3 file(s):', '  >f+++++++++ A/Box/a1.1/x.pdf'
  ].join('\n')
  const s = Summary.summarize(out, ['*/Box/a1.1'], ['A', 'B', 'C', 'D'])
  assert.equal(s.files, 3)
  assert.deepEqual(s.groups.map((g) => [g.name, g.files, g.created, g.sizeDiff]), [['A/Box/a1.1', 2, 1, 1], ['B/Box/a1.1', 1, 1, 0]])
  assert.deepEqual(s.absent, ['C', 'D'])
  assert.deepEqual(s.createdTop, ['A'])
})

// ---------------------------------------------------------------- listing and preview on real folders
function makeTree(root, spec) {
  for (const [name, val] of Object.entries(spec)) {
    const p = path.join(root, name)
    if (val === null || typeof val === 'number') {
      fs.writeFileSync(p, 'x'.repeat(val || 1))
    } else {
      fs.mkdirSync(p, { recursive: true })
      makeTree(p, val)
    }
  }
}

function sampleSource() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cm-src-'))
  makeTree(root, {
    'Example Student A': { 'Participant Drop Box': { 'a1.1': { 'report.pdf': 10, 'notes.txt': 5, drafts: { 'v1.docx': 7 } }, 'a1.2': { 'big.bin': 50 } }, 'Return Box': { 'x.txt': 3 }, '.hidden': { 'h.txt': 1 } },
    'Sample Student B': { 'Participant Drop Box': { 'a1.1': { 'solution.pdf': 12 } } },
    'Test Student C': { 'Return Box': { 'y.txt': 2 } },
    'Demo Student D': { 'Participant Drop Box': { 'a1.1': { 'a.txt': 1 } } },
    'Mock Student E': { 'Participant Drop Box': { 'a1.1': { 'b.txt': 1 } } },
    'Fictional Student F': { 'Participant Drop Box': { 'a1.1': { 'c.txt': 1 } } },
    'loose.txt': 4
  })
  return root
}

test('listTree: depth, hidden entries, firstN sampling, sizes', async () => {
  const root = sampleSource()
  try {
    const r = await Listing.listTree(root, { depth: 3, firstN: 5 })
    assert.equal(r.ok, true)
    assert.equal(r.total, 6)
    const dirs = r.entries.filter((e) => e.dir)
    assert.equal(dirs.length, 5)
    assert.ok(r.entries.some((e) => e.name === 'loose.txt' && e.size === 4))
    const a = r.entries.find((e) => e.name === 'Example Student A')
    assert.deepEqual(a.children.map((c) => c.name), ['Participant Drop Box', 'Return Box'])
    const pdb = a.children[0]
    assert.deepEqual(pdb.children.map((c) => c.name), ['a1.1', 'a1.2'])
    assert.equal(pdb.children[0].children, null)   // cut-off: level 3 folders are not listed
    assert.equal((await Listing.listTree(root, { depth: 1 })).entries.find((e) => e.name === 'Example Student A').children, null)
    const missing = await Listing.listTree(path.join(root, 'nope'))
    assert.deepEqual([missing.ok, missing.code], [false, 'NOT_FOUND'])
  } finally { fs.rmSync(root, { recursive: true, force: true }) }
})

async function preview(root, dst, patterns, extra) {
  const sample = await Listing.listTree(root, { depth: 50, firstN: 5 })
  const names = sample.entries.filter((e) => e.dir).map((e) => e.name)
  return Preview.computePreview(Object.assign({
    commonSh: COMMON, patterns, srcEntries: sample.entries, srcRealPath: null, dstPath: dst,
    existingEntries: dst ? (await Listing.listTree(dst, { depth: 50 })).entries : [], sampleNames: names, topTotal: names.length
  }, extra))
}

test('preview: new / same / diff / existing, from the real rsync filters', async () => {
  const root = sampleSource()
  const dst = fs.mkdtempSync(path.join(os.tmpdir(), 'cm-dst-'))
  try {
    makeTree(dst, { 'Example Student A': { 'Participant Drop Box': { 'a1.1': { 'report.pdf': 10, 'notes.txt': 99, 'old.txt': 1 } } }, 'unrelated.txt': 1 })
    const r = await preview(root, dst, ['*/Participant Drop Box/a1.1'])
    assert.equal(r.ok, true)
    const by = Object.fromEntries(r.rows.map((x) => [x.path, x.status]))
    const base = 'Example Student A/Participant Drop Box/a1.1/'
    assert.equal(by[base + 'report.pdf'], 'same')
    assert.equal(by[base + 'notes.txt'], 'diff')
    assert.equal(by[base + 'drafts/v1.docx'], 'new')
    assert.equal(by[base + 'old.txt'], 'existing')
    assert.equal(by['unrelated.txt'], 'existing')
    assert.equal(by['Sample Student B/Participant Drop Box/a1.1'], 'new')
    assert.equal(by['Sample Student B/Participant Drop Box/a1.1/solution.pdf'], 'new')
    // not selected: other branches of the source never show up
    assert.ok(!(base.replace('a1.1', 'a1.2') + 'big.bin' in by))
    assert.ok(!('Example Student A/Return Box' in by))
    assert.ok(!('Test Student C' in by))
    assert.equal(r.perPattern[0].top, 5)           // the first 5 folders by name (Demo, Example, Fictional, Mock, Sample) all match
    assert.equal(r.minLevels, 3)
    assert.equal(r.matched['Example Student A/Participant Drop Box/a1.1'], true)
    assert.equal(r.matched['Example Student A/Participant Drop Box'], true)   // on the way
  } finally { fs.rmSync(root, { recursive: true, force: true }); fs.rmSync(dst, { recursive: true, force: true }) }
})

test('preview: second pattern adds a1.2; `?` and `**` patterns', async () => {
  const root = sampleSource()
  const dst = fs.mkdtempSync(path.join(os.tmpdir(), 'cm-dst-'))
  try {
    let r = await preview(root, dst, ['*/Participant Drop Box/a1.?'])
    let paths = r.rows.map((x) => x.path)
    assert.ok(paths.includes('Example Student A/Participant Drop Box/a1.2/big.bin'))
    r = await preview(root, dst, ['**/solution.pdf'])
    assert.equal(r.minLevels, null)
    assert.ok(r.rows.some((x) => x.path === 'Sample Student B/Participant Drop Box/a1.1/solution.pdf' && x.status === 'new'))
    r = await preview(root, dst, ['*/Nothing/here'])
    assert.equal(r.rows.length, 0)
    assert.equal(r.perPattern[0].top, 0)
  } finally { fs.rmSync(root, { recursive: true, force: true }); fs.rmSync(dst, { recursive: true, force: true }) }
})

test('preview: upload against a mock destination built from an OLAT-like listing; names with special characters', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cm-up-'))
  try {
    makeTree(root, { 'Geyer, Marlena': { 'Return Box': { 'a1.1': { 'f[1].txt': 4, 'g.txt': 4 } } }, 'Zed, New': { 'Return Box': { 'a1.1': { 'f.txt': 1 } } } })
    const dstEntries = [{ name: 'Geyer, Marlena', dir: true, children: [{ name: 'Return Box', dir: true, children: [{ name: 'a1.1', dir: true, children: [{ name: 'g.txt', dir: false, size: 9 }] }] }] }]
    const names = ['Geyer, Marlena', 'Zed, New']
    const sample = await Listing.listTree(root, { depth: 50, firstN: 5 })
    const r = await Preview.computePreview({ commonSh: COMMON, patterns: ['*/Return Box/a1.1'], srcEntries: sample.entries, srcRealPath: root, dstPath: null, dstEntries, existingEntries: dstEntries, sampleNames: names, topTotal: 2 })
    const by = Object.fromEntries(r.rows.map((x) => [x.path, x.status]))
    assert.equal(by['Geyer, Marlena/Return Box/a1.1/f[1].txt'], 'new')
    assert.equal(by['Geyer, Marlena/Return Box/a1.1/g.txt'], 'diff')
    assert.equal(by['Zed, New'], 'new')
    assert.equal(by['Zed, New/Return Box/a1.1/f.txt'], 'new')
    // literal with escaped brackets selects exactly that file
    const lit = await Preview.computePreview({ commonSh: COMMON, patterns: ['Geyer, Marlena/Return Box/a1.1/f\\[1\\].txt'], srcEntries: sample.entries, srcRealPath: root, dstPath: null, dstEntries: [], existingEntries: [], sampleNames: names, topTotal: 2 })
    assert.deepEqual(lit.rows.filter((x) => !x.dir).map((x) => x.name), ['f[1].txt'])
  } finally { fs.rmSync(root, { recursive: true, force: true }) }
})

test('preview: a target folder whose content is not listed yet still matches (placeholder row)', async () => {
  const srcEntries = [{ name: 'S1', dir: true, children: [{ name: 'Box', dir: true, children: [{ name: 'a1.1', dir: true, children: null }] }] }]
  const dst = fs.mkdtempSync(path.join(os.tmpdir(), 'cm-dst-'))
  try {
    const r = await Preview.computePreview({ commonSh: COMMON, patterns: ['*/Box/a1.1'], srcEntries, srcRealPath: null, dstPath: dst, dstEntries: [], existingEntries: [], sampleNames: ['S1'], topTotal: 1 })
    assert.equal(r.perPattern[0].top, 1)
    const by = Object.fromEntries(r.rows.map((x) => [x.path, x.status]))
    assert.equal(by['S1/Box/a1.1'], 'new')
    assert.equal(by['S1/Box/a1.1/' + Preview.PLACEHOLDER], 'unloaded')
    assert.equal(r.rows.find((x) => x.status === 'unloaded').name, 'not loaded yet')
  } finally { fs.rmSync(dst, { recursive: true, force: true }) }
})

test('preview: existing items under an unlisted target are "pending", not "not touched"', async () => {
  const srcEntries = [{ name: 'S1', dir: true, children: [{ name: 'Box', dir: true, children: [{ name: 'a1.1', dir: true, children: null }] }] }]
  const dst = fs.mkdtempSync(path.join(os.tmpdir(), 'cm-dst-'))
  try {
    makeTree(dst, { S1: { Box: { 'a1.1': { 'old.txt': 1 }, other: { 'x.txt': 1 } } } })
    const existingEntries = (await Listing.listTree(dst, { depth: 50 })).entries
    const r = await Preview.computePreview({ commonSh: COMMON, patterns: ['*/Box/a1.1'], srcEntries, srcRealPath: null, dstPath: dst, dstEntries: [], existingEntries, sampleNames: ['S1'], topTotal: 1 })
    const by = Object.fromEntries(r.rows.map((x) => [x.path, x.status]))
    assert.equal(by['S1/Box/a1.1/old.txt'], 'pending')
    assert.equal(by['S1/Box/other/x.txt'], 'existing')
  } finally { fs.rmSync(dst, { recursive: true, force: true }) }
})
