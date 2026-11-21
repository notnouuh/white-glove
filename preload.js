const { contextBridge, ipcRenderer } = require('electron');
let cb = null, ucb = null;
ipcRenderer.on('upd', (_e, o) => ucb && ucb(o));
ipcRenderer.on('file:changed', () => cb && cb());
contextBridge.exposeInMainWorld('wg', {
  pickFile: () => ipcRenderer.invoke('file:pick'),
  readFile: p => ipcRenderer.invoke('file:read', p),
  writeFile: (p, b, m, f) => ipcRenderer.invoke('file:write', p, b, m, f),
  newFile: (n, b) => ipcRenderer.invoke('file:newFile', n, b),
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
  gStatus: () => ipcRenderer.invoke('g:status'),
  gConfig: (c, s) => ipcRenderer.invoke('g:config', c, s),
  gSignin: () => ipcRenderer.invoke('g:signin'),
  gSignout: () => ipcRenderer.invoke('g:signout'),
  gApi: (m, u, b) => ipcRenderer.invoke('g:api', m, u, b),
  pxGet: l => ipcRenderer.invoke('px:get', l),
  ai: b => ipcRenderer.invoke('ai:send', b)
});
