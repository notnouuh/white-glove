const { contextBridge, ipcRenderer } = require('electron');
let cb = null, ucb = null;
ipcRenderer.on('upd', (_e, o) => ucb && ucb(o));
ipcRenderer.on('file:changed', () => cb && cb());
contextBridge.exposeInMainWorld('wg', {
  pickFile: () => ipcRenderer.invoke('file:pick'),
  readFile: p => ipcRenderer.invoke('file:read', p),
  saveFile: (n, d) => ipcRenderer.invoke('file:save', n, d),
  watch: p => ipcRenderer.invoke('file:watch', p),
  onFileChanged: f => { cb = f; },
  hasKey: () => ipcRenderer.invoke('key:has'),
  setKey: k => ipcRenderer.invoke('key:set', k),
  updGet: () => ipcRenderer.invoke('upd:get'),
  updSet: u => ipcRenderer.invoke('upd:set', u),
  updCheck: () => ipcRenderer.invoke('upd:check'),
  updInstall: () => ipcRenderer.invoke('upd:install'),
  onUpdate: f => { ucb = f; },
  ai: b => ipcRenderer.invoke('ai:send', b)
});
