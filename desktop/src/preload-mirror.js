'use strict';
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('mirror', {
  onVideo: (fn) => ipcRenderer.on('mirror.video', (_e, p) => fn(p)),
  onAudio: (fn) => ipcRenderer.on('mirror.audio', (_e, p) => fn(p)),
  input: (ev) => ipcRenderer.send('mirror.input', ev),
  screenshot: (dataUrl) => ipcRenderer.invoke('mirror.screenshot', dataUrl),
  stop: () => ipcRenderer.invoke('mirror.stop'),
});
