'use strict';
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('callwin', {
  onCall: (fn) => ipcRenderer.on('call', (_e, c) => fn(c)),
  act: (action) => ipcRenderer.send('callwin', action),
});
