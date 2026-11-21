const { app, BrowserWindow, ipcMain, dialog, safeStorage, shell } = require('electron');
const path = require('path'), fs = require('fs'), http = require('http'), crypto = require('crypto');
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
    backgroundColor: '#FAFAFA', icon: path.join(__dirname, 'build', 'icon.png'), title: 'White Glove', autoHideMenuBar: true,
    titleBarStyle: 'hidden',
    titleBarOverlay: { color: '#FAFAFA', symbolColor: '#3D3D3A', height: 40 },
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

/* ---- Google OAuth (loopback + PKCE) ---- */
const gFile = () => path.join(app.getPath('userData'), 'google.bin');
const gGet = () => { try { return JSON.parse(safeStorage.decryptString(fs.readFileSync(gFile()))); } catch { return {}; } };
const gPut = o => { if (!safeStorage.isEncryptionAvailable()) return false; fs.writeFileSync(gFile(), safeStorage.encryptString(JSON.stringify(o))); return true; };
let gTok = { t: '', exp: 0 };
const gForm = o => ({ method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams(o) });
async function gAccess() {
  if (gTok.t && Date.now() < gTok.exp - 60000) return gTok.t;
  const g = gGet(); if (!g.rt) throw new Error('Not signed in to Google.');
  const r = await fetch('https://oauth2.googleapis.com/token', gForm({ client_id: g.cid, client_secret: g.sec || '', refresh_token: g.rt, grant_type: 'refresh_token' }));
  const j = await r.json().catch(() => ({}));
  if (!r.ok) { if (j.error === 'invalid_grant') { delete g.rt; gPut(g); } throw new Error(j.error_description || j.error || 'Google sign-in failed'); }
  gTok = { t: j.access_token, exp: Date.now() + j.expires_in * 1000 }; return gTok.t;
}
ipcMain.handle('g:status', async () => { const g = gGet(); return { cfg: !!g.cid, signed: !!g.rt, email: g.email || '', cid: g.cid || '' }; });
ipcMain.handle('g:config', async (_e, cid, sec) => {
  const g = gGet(); cid = String(cid || '').trim(); sec = String(sec || '').trim();
  if (cid !== g.cid) { delete g.rt; delete g.email; gTok = { t: '', exp: 0 }; }
  g.cid = cid; if (sec) g.sec = sec; return gPut(g);
});
ipcMain.handle('g:signout', async () => { const g = gGet(); delete g.rt; delete g.email; gTok = { t: '', exp: 0 }; gPut(g); return true; });
ipcMain.handle('g:signin', async () => {
  const g = gGet(); if (!g.cid) return { ok: false, error: 'Save your Client ID first.' };
  try {
    const ver = crypto.randomBytes(32).toString('base64url'), ch = crypto.createHash('sha256').update(ver).digest('base64url'), state = crypto.randomBytes(8).toString('hex');
    let redir = '', to;
    const code = await new Promise((resolve, reject) => {
      const srv = http.createServer((q, s) => {
        const u = new URL(q.url, 'http://127.0.0.1');
        if (u.pathname !== '/') { s.writeHead(404); s.end(); return; }
        const c = u.searchParams.get('code'), er = u.searchParams.get('error');
        s.writeHead(200, { 'content-type': 'text/html' });
        s.end('<body style="font:16px sans-serif;text-align:center;margin-top:20vh">' + (c ? 'White Glove is connected. You can close this tab.' : 'Sign-in cancelled. You can close this tab.') + '</body>');
        clearTimeout(to); srv.close();
        if (u.searchParams.get('state') !== state) return reject(new Error('Sign-in was interrupted.'));
        c ? resolve(c) : reject(new Error(er || 'Sign-in cancelled.'));
      });
      srv.listen(0, '127.0.0.1', () => {
        redir = 'http://127.0.0.1:' + srv.address().port;
        const url = 'https://accounts.google.com/o/oauth2/v2/auth?' + new URLSearchParams({ client_id: g.cid, redirect_uri: redir, response_type: 'code', scope: 'https://www.googleapis.com/auth/spreadsheets https://www.googleapis.com/auth/drive.metadata.readonly', code_challenge: ch, code_challenge_method: 'S256', access_type: 'offline', prompt: 'consent', state });
        shell.openExternal(url);
      });
      to = setTimeout(() => { srv.close(); reject(new Error('Sign-in timed out.')); }, 180000);
    });
    const r = await fetch('https://oauth2.googleapis.com/token', gForm({ code, client_id: g.cid, client_secret: g.sec || '', code_verifier: ver, redirect_uri: redir, grant_type: 'authorization_code' }));
    const j = await r.json().catch(() => ({}));
    if (!r.ok || !j.refresh_token) return { ok: false, error: j.error_description || j.error || 'Google didn’t return a sign-in. Try again.' };
    g.rt = j.refresh_token; gTok = { t: j.access_token, exp: Date.now() + j.expires_in * 1000 };
    try { const a = await fetch('https://www.googleapis.com/drive/v3/about?fields=user(emailAddress)', { headers: { authorization: 'Bearer ' + j.access_token } }); g.email = ((await a.json()).user || {}).emailAddress || ''; } catch {}
    return gPut(g) ? { ok: true } : { ok: false, error: 'Couldn’t store the sign-in securely on this computer.' };
  } catch (e) { return { ok: false, error: String(e.message || e) }; }
});
ipcMain.handle('g:api', async (_e, m, u, b) => {
  try {
    if (!['GET', 'POST'].includes(m) || !/^https:\/\/(sheets\.googleapis\.com\/v4\/spreadsheets\/|www\.googleapis\.com\/drive\/v3\/(files|about))/.test(String(u))) return { ok: false, error: 'Blocked request.' };
    for (let a = 0; a < 2; a++) {
      const t = await gAccess();
      const r = await fetch(u, { method: m, headers: Object.assign({ authorization: 'Bearer ' + t }, b ? { 'content-type': 'application/json' } : {}), body: b ? JSON.stringify(b) : undefined });
      if (r.status === 401 && a === 0) { gTok = { t: '', exp: 0 }; continue; }
      const j = await r.json().catch(() => ({}));
      return r.ok ? { ok: true, data: j } : { ok: false, status: r.status, error: (j.error && j.error.message) || ('Google error ' + r.status) };
    }
  } catch (e) { return { ok: false, error: String(e.message || e) }; }
});

/* ---- live market prices (public data, no account) ---- */
ipcMain.handle('px:get', async (_e, list) => {
  const out = {}, syms = [...new Set((list || []).map(s => String(s).toUpperCase().replace(/[^A-Z0-9.\-^=]/g, '')).filter(Boolean))].slice(0, 60);
  await Promise.all(syms.map(async t => {
    try {
      const r = await fetch('https://query1.finance.yahoo.com/v8/finance/chart/' + encodeURIComponent(t) + '?range=1d&interval=1d', { headers: { 'user-agent': 'Mozilla/5.0' } });
      if (r.ok) { const j = await r.json(), m = j.chart && j.chart.result && j.chart.result[0] && j.chart.result[0].meta; if (m && m.regularMarketPrice > 0) { out[t] = { p: m.regularMarketPrice, prev: m.previousClose || m.chartPreviousClose || 0, at: (m.regularMarketTime || 0) * 1000 }; return; } }
    } catch {}
    try {
      const r = await fetch('https://stooq.com/q/l/?s=' + encodeURIComponent(t.toLowerCase()) + '.us&f=sd2t2ohlcv&h&e=csv');
      if (r.ok) { const row = ((await r.text()).trim().split(/\r?\n/)[1] || '').split(','), c = parseFloat(row[6]); if (c > 0) out[t] = { p: c, prev: 0, at: Date.now() }; }
    } catch {}
  }));
  return out;
});

/* ---- live charts (public data) ---- */
const UA = { 'user-agent': 'Mozilla/5.0' };
const RMAP = { '1d': ['1d', '5m'], '5d': ['5d', '30m'], '1mo': ['1mo', '1d'], '6mo': ['6mo', '1d'], '1y': ['1y', '1d'] };
const cleanSym = s => String(s || '').toUpperCase().replace(/[^A-Z0-9.\-^=]/g, '');
ipcMain.handle('px:chart', async (_e, sym, range) => {
  try {
    sym = cleanSym(sym); const [r, i] = RMAP[range] || RMAP['1d'];
    const res = await fetch('https://query1.finance.yahoo.com/v8/finance/chart/' + encodeURIComponent(sym) + '?range=' + r + '&interval=' + i + '&includePrePost=false', { headers: UA });
    if (!res.ok) return null;
    const j = await res.json(), R = j.chart && j.chart.result && j.chart.result[0]; if (!R) return null;
    const ts = R.timestamp || [], cl = ((R.indicators && R.indicators.quote && R.indicators.quote[0]) || {}).close || [], t = [], c = [];
    ts.forEach((x, k) => { if (cl[k] != null) { t.push(x * 1000); c.push(cl[k]); } });
    const m = R.meta || {};
    return { t, c, meta: { price: m.regularMarketPrice, prev: m.chartPreviousClose || m.previousClose || 0, type: m.instrumentType, name: m.longName || m.shortName || sym, sym } };
  } catch { return null; }
});
let yCrumb = null;
async function yAuth() {
  if (yCrumb && Date.now() < yCrumb.exp) return yCrumb;
  const r = await fetch('https://fc.yahoo.com', { headers: UA, redirect: 'manual' });
  const ck = (r.headers.getSetCookie ? r.headers.getSetCookie() : []).map(x => x.split(';')[0]).join('; ');
  const c = await fetch('https://query1.finance.yahoo.com/v1/test/getcrumb', { headers: Object.assign({ cookie: ck }, UA) });
  const crumb = await c.text(); if (!c.ok || !crumb || crumb.length > 40) throw new Error('crumb');
  yCrumb = { ck, crumb, exp: Date.now() + 3600e3 }; return yCrumb;
}
ipcMain.handle('px:fund', async (_e, sym) => {
  try {
    const a = await yAuth();
    const r = await fetch('https://query1.finance.yahoo.com/v10/finance/quoteSummary/' + encodeURIComponent(cleanSym(sym)) + '?modules=topHoldings&crumb=' + encodeURIComponent(a.crumb), { headers: Object.assign({ cookie: a.ck }, UA) });
    if (!r.ok) { yCrumb = null; return { holdings: [] }; }
    const j = await r.json(), th = (((j.quoteSummary || {}).result || [])[0] || {}).topHoldings || {};
    return { holdings: (th.holdings || []).filter(h => h.symbol).slice(0, 5).map(h => ({ sym: h.symbol, name: h.holdingName, pct: ((h.holdingPercent && h.holdingPercent.raw) || 0) * 100 })) };
  } catch { return { holdings: [] }; }
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
