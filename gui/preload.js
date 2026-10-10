const { contextBridge, ipcRenderer, webUtils } = require('electron')

const call = (channel, ...args) => ipcRenderer.invoke(channel, ...args)

function subscribe(channel, cb) {
  const handler = (_e, payload) => cb(payload)
  ipcRenderer.on(channel, handler)
  return () => ipcRenderer.removeListener(channel, handler)
}

contextBridge.exposeInMainWorld('api', {
  info: () => call('app:info'),
  loadSettings: () => call('settings:load'),
  saveSettings: (s) => call('settings:save', s),
  pathInfo: (p) => call('path:info', p),
  pathForFile: (file) => webUtils.getPathForFile(file),
  chooseDir: (opts) => call('dialog:dir', opts),
  openCommand: () => call('dialog:open-command'),
  tree: (root, opts) => call('fs:tree', root, opts),
  preview: (params) => call('preview:run', params),
  saveCommand: (params) => call('command:save', params),
  copy: (text) => call('clipboard:write', text),
  contextMenu: (items) => call('menu:context', items),
  run: {
    start: (params) => call('run:start', params),
    abort: () => call('run:abort'),
    onEvent: (cb) => subscribe('run:event', cb)
  },
  dryrun: {
    open: (params) => call('dryrun:open', params),
    get: () => call('dryrun:get'),
    runReal: () => call('dryrun:run-real'),
    abort: () => call('dryrun:abort'),
    close: () => call('dryrun:close'),
    onEvent: (cb) => subscribe('dryrun:event', cb)
  }
})
