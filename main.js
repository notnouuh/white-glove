const { app, BrowserWindow, ipcMain, dialog, safeStorage, shell } = require('electron');
const path = require('path'), fs = require('fs');
const { create: createUpdater } = require('./updater');
const DEFAULT_FEED = 'https://github.com/notnouuh/white-glove/releases/latest/download';
const updFile = () => path.join(app.getPath('userData'), 'update.json');
const feedUrl = () => { try { return JSON.parse(fs.readFileSync(updFile(), 'utf8')).url || DEFAULT_FEED; } catch { return DEFAULT_FEED; } };
const sendUpd = o => win && !win.isDestroyed() && win.webContents.send('upd', o);
let upd = null, installing = false;

if (!app.requestSingleInstanceLock()) app.quit();
let win, watched = null, timer = null;
const keyFile = () => path.join(app.getPath('userData'), 'anthropic.key');

function create() {
  win = new BrowserWindow({
    width: 1240, height: 820, minWidth: 900, minHeight: 600,
    backgroundColor: '#F7F6F3', icon: path.join(__dirname, 'build', 'icon.png'), title: 'White Glove', autoHideMenuBar: true,
    titleBarStyle: 'hidden',
    titleBarOverlay: { color: '#F7F6F3', symbolColor: '#3D3D3A', height: 40 },
    webPreferences: { preload: path.join(__dirname, 'preload.js'), contextIsolation: true, nodeIntegration: false, sandbox: false }
  });
  win.setMenuBarVisibility(false);
  win.loadFile(path.join(__dirname, 'app', 'index.html'));
  win.webContents.setWindowOpenHandler(({ url }) => { if (/^https:/.test(url)) shell.openExternal(url); return { action: 'deny' }; });
  win.webContents.on('will-navigate', e => e.preventDefault());
  if (process.env.WG_SHOT) {
    win.webContents.on('did-finish-load', async () => {
      await new Promise(r => setTimeout(r, 800));
      if (process.env.WG_JS) await win.webContents.executeJavaScript(process.env.WG_JS);
      await new Promise(r => setTimeout(r, 600));
      const img = await win.webContents.capturePage();
      fs.writeFileSync(process.env.WG_SHOT, img.toPNG());
      app.quit();
    });
  }
}

ipcMain.handle('upd:get', async () => ({ version: app.getVersion(), url: feedUrl(), ready: !!(upd && upd.isReady()) }));
ipcMain.handle('upd:set', async (_e, url) => { fs.writeFileSync(updFile(), JSON.stringify({ url: (url || '').trim() })); return true; });
ipcMain.handle('upd:check', async () => { if (!app.isPackaged && !process.env.WG_UPD_TEST) sendUpd({ state: 'dev' }); else upd.check(); return true; });
ipcMain.handle('upd:install', async () => { if (upd && upd.install(true)) { installing = true; app.quit(); } });

ipcMain.handle('file:pick', async () => {
  const r = await dialog.showOpenDialog(win, { title: 'Choose your Excel file', properties: ['openFile'], filters: [{ name: 'Spreadsheets', extensions: ['xlsx', 'xlsm', 'xls', 'csv'] }] });
  if (r.canceled || !r.filePaths[0]) return null;
  return { path: r.filePaths[0], name: path.basename(r.filePaths[0]) };
});
ipcMain.handle('file:read', async (_e, p) => { try { return { b64: fs.readFileSync(p).toString('base64'), mtime: fs.statSync(p).mtimeMs }; } catch { return null; } });
let quietUntil = 0;
ipcMain.handle('file:write', async (_e, p, b64, expected, force) => {
  try {
    const cur = fs.existsSync(p) ? fs.statSync(p).mtimeMs : 0;
    if (!force && expected && cur && Math.abs(cur - expected) > 1) return { conflict: true };
    if (cur) {
      const dir = path.join(app.getPath('userData'), 'backups'); fs.mkdirSync(dir, { recursive: true });
      const bk = path.join(dir, path.basename(p) + '.bak'); fs.copyFileSync(p, bk);
    }
    fs.writeFileSync(p, Buffer.from(b64, 'base64'));
    quietUntil = Date.now() + 8000;
    return { ok: true, mtime: fs.statSync(p).mtimeMs };
  } catch (e) { return { ok: false, error: e.code === 'EBUSY' || e.code === 'EPERM' ? 'The file is open in another program (like Excel). Close it and try again.' : String(e.message || e) }; }
});
ipcMain.handle('file:newFile', async (_e, name, b64) => {
  const r = await dialog.showSaveDialog(win, { title: 'Create workbook', defaultPath: path.join(app.getPath('documents'), name), filters: [{ name: 'Excel', extensions: ['xlsx'] }] });
  if (r.canceled || !r.filePath) return null;
  fs.writeFileSync(r.filePath, Buffer.from(b64, 'base64'));
  return { path: r.filePath, name: path.basename(r.filePath) };
});
ipcMain.handle('file:save', async (_e, name, data) => {
  const r = await dialog.showSaveDialog(win, { defaultPath: name });
  if (r.canceled || !r.filePath) return false;
  fs.writeFileSync(r.filePath, data); return true;
});
ipcMain.handle('file:watch', async (_e, p) => {
  if (watched) { fs.unwatchFile(watched); watched = null; }
  if (!p) return;
  watched = p;
  fs.watchFile(p, { interval: 3000 }, (cur, prev) => {
    if (cur.mtimeMs === prev.mtimeMs) return;
    if (Date.now() < quietUntil) return;
    clearTimeout(timer);
    timer = setTimeout(() => win && win.webContents.send('file:changed'), 1500);
  });
});
ipcMain.handle('key:has', async () => fs.existsSync(keyFile()));
ipcMain.handle('key:set', async (_e, k) => {
  if (!safeStorage.isEncryptionAvailable()) return false;
  fs.writeFileSync(keyFile(), safeStorage.encryptString(k)); return true;
});
ipcMain.handle('ai:send', async (_e, body) => {
  try {
    if (!fs.existsSync(keyFile())) return { ok: false, error: 'No API key saved.' };
    const key = safeStorage.decryptString(fs.readFileSync(keyFile()));
    const res = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-api-key': key, 'anthropic-version': '2023-06-01' },
      body: JSON.stringify({ max_tokens: 1500, ...body })
    });
    const j = await res.json();
    if (!res.ok) return { ok: false, error: (j.error && j.error.message) || ('HTTP ' + res.status) };
    return { ok: true, data: j };
  } catch (e) { return { ok: false, error: e.message }; }
});

app.whenReady().then(() => {
  create();
  upd = createUpdater({ getUrl: feedUrl, version: app.getVersion(), emit: sendUpd });
  if (app.isPackaged) { setTimeout(() => upd.check(), 8000); setInterval(() => upd.check(), 6 * 3600 * 1000); }
});
app.on('will-quit', () => { if (!installing && upd && upd.isReady()) { installing = true; upd.install(false); } });
app.on('second-instance', () => { if (win) { if (win.isMinimized()) win.restore(); win.focus(); } });
app.on('window-all-closed', () => app.quit());
