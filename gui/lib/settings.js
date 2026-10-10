// Small JSON settings file in the app's data folder (not in the repo).
const fs = require('fs')
const path = require('path')

const DEFAULTS = { src: '', dst: '', patterns: [], eject: true, sidecar: false, saveDir: '', bounds: null }

function load(dir) {
  try {
    const raw = JSON.parse(fs.readFileSync(path.join(dir, 'settings.json'), 'utf8'))
    return Object.assign({}, DEFAULTS, raw)
  } catch {
    return Object.assign({}, DEFAULTS)
  }
}

function save(dir, settings) {
  fs.mkdirSync(dir, { recursive: true })
  const file = path.join(dir, 'settings.json')
  const tmp = file + '.tmp'
  fs.writeFileSync(tmp, JSON.stringify(Object.assign({}, DEFAULTS, settings), null, 2))
  fs.renameSync(tmp, file)
}

module.exports = { DEFAULTS, load, save }
