'use strict';
const { contextBridge, ipcRenderer, webUtils } = require('electron');

const call = (ch) => (...a) => ipcRenderer.invoke(ch, ...a);

contextBridge.exposeInMainWorld('wasl', {
  state: call('state'),
  onState: (fn) => ipcRenderer.on('state', (_e, s) => fn(s)),
  pairStart: call('pair.start'),
  pairCancel: call('pair.cancel'),
  unpair: call('unpair'),
  pickFiles: call('files.pick'),
  sendFiles: call('files.send'),
  cancelTransfer: call('files.cancel'),
  openFile: call('files.open'),
  clearTransfers: call('files.clear'),
  sendClipboard: call('clip.send'),
  copy: call('clip.copy'),
  ring: call('ring'),
  dismiss: call('notif.dismiss'),
  clearNotifications: call('notif.clear'),
  action: call('notif.action'),
  setSettings: call('settings.set'),
  pickDir: call('settings.pickDir'),
  openUrl: call('open.url'),
  pathOf: (file) => webUtils.getPathForFile(file),
});
