const { app, BrowserWindow, ipcMain, dialog, safeStorage, shell, screen, session } = require('electron');
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

const stateFile = () => path.join(app.getPath('userData'), 'window.json');
function loadState() {
  try {
    const s = JSON.parse(fs.readFileSync(stateFile(), 'utf8')), b = s.bounds;
    if (!b || !(b.width > 0) || !(b.height > 0)) return null;
    // Only restore if the saved spot is still on a connected display (e.g. monitor 2 unplugged -> fall back to default).
    const ok = screen.getAllDisplays().some(d => { const a = d.workArea, x = Math.max(a.x, b.x), y = Math.max(a.y, b.y), w = Math.min(a.x + a.width, b.x + b.width) - x, h = Math.min(a.y + a.height, b.y + b.height) - y; return w >= 200 && h >= 120; });
    return ok ? s : null;
  } catch { return null; }
}
function saveState() {
  try {
    if (!win || win.isDestroyed() || win.isMinimized() || win.isFullScreen()) return;
    fs.writeFileSync(stateFile(), JSON.stringify({ bounds: win.getNormalBounds(), max: win.isMaximized() }));
  } catch {}
}
function create() {
  const st = process.env.WG_SHOT ? null : loadState();
  win = new BrowserWindow({
    width: 1240, height: 820, minWidth: 900, minHeight: 600, ...(st ? st.bounds : {}),
    backgroundColor: '#FAFAFA', icon: path.join(__dirname, 'build', 'icon.png'), title: 'White Glove', autoHideMenuBar: true,
    titleBarStyle: 'hidden',
    titleBarOverlay: { color: '#FAFAFA', symbolColor: '#3D3D3A', height: 40 },
    webPreferences: { preload: path.join(__dirname, 'preload.js'), contextIsolation: true, nodeIntegration: false, sandbox: false }
  });
  win.setMenuBarVisibility(false);
  if (st && st.max) win.maximize();
  if (!process.env.WG_SHOT) { let t = null; const sv = () => { clearTimeout(t); t = setTimeout(saveState, 400); }; ['move', 'resize', 'maximize', 'unmaximize'].forEach(ev => win.on(ev, sv)); win.on('close', saveState); }
  win.loadFile(path.join(__dirname, 'app', 'index.html'), process.env.WG_SHOT ? { query: { nosplash: '1' } } : undefined);
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

/* ---- Google Sheet summary: read a published CSV (no account, no key) ---- */
ipcMain.handle('sum:fetch', async (_e, u) => {
  try {
    if (typeof u !== 'string' || !/^https:\/\/docs\.google\.com\/spreadsheets\//.test(u)) return { ok: false, error: 'That isn\u2019t a Google Sheets link.' };
    const r = await fetch(u, { redirect: 'follow', headers: { 'cache-control': 'no-cache' } });
    if (!/^https:\/\/(docs\.google\.com|[a-z0-9-]+\.googleusercontent\.com)\//.test(r.url)) return { ok: false, error: 'Unexpected redirect.' };
    if (!r.ok) return { ok: false, error: r.status === 404 ? 'Link not found. Is the tab still published?' : 'Google returned ' + r.status + '.' };
    const t = await r.text();
    return { ok: true, text: t.slice(0, 2000000) };
  } catch (e) { return { ok: false, error: 'Couldn\u2019t reach Google. Check your connection.' }; }
});
// one-time cleanup of the old Google sign-in (key, secret and token) and its browser session
function wipeGoogle() {
  try { fs.rmSync(path.join(app.getPath('userData'), 'google.bin'), { force: true }); } catch {}
  try { session.fromPartition('persist:gsheets').clearStorageData(); } catch {}
}

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
    const res = await fetch('https://query1.finance.yahoo.com/v8/finance/chart/' + encodeURIComponent(sym) + '?range=' + r + '&interval=' + i + '&includePrePost=' + (range === '1d' || range === '5d' ? 'true' : 'false'), { headers: UA });
    if (!res.ok) return null;
    const j = await res.json(), R = j.chart && j.chart.result && j.chart.result[0]; if (!R) return null;
    const ts = R.timestamp || [], Q = (R.indicators && R.indicators.quote && R.indicators.quote[0]) || {}, cl = Q.close || [], t = [], c = [], o = [], h = [], l = [], v = [];
    ts.forEach((x, k) => { if (cl[k] != null) { t.push(x * 1000); c.push(cl[k]); o.push(Q.open && Q.open[k] != null ? Q.open[k] : cl[k]); h.push(Q.high && Q.high[k] != null ? Q.high[k] : cl[k]); l.push(Q.low && Q.low[k] != null ? Q.low[k] : cl[k]); v.push((Q.volume && Q.volume[k]) || 0); } });
    const m = R.meta || {};
    return { t, c, o, h, l, v, meta: { exch: m.fullExchangeName || m.exchangeName, cur: m.currency, dh: m.regularMarketDayHigh, dl: m.regularMarketDayLow, vol: m.regularMarketVolume, price: m.regularMarketPrice, prev: m.chartPreviousClose || m.previousClose || 0, type: m.instrumentType, name: m.longName || m.shortName || sym, sym, reg: (m.currentTradingPeriod && m.currentTradingPeriod.regular) ? [m.currentTradingPeriod.regular.start * 1000, m.currentTradingPeriod.regular.end * 1000] : null } };
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
ipcMain.handle('px:info', async (_e, sym) => {
  try {
    sym = cleanSym(sym); const a = await yAuth();
    const res = await fetch('https://query1.finance.yahoo.com/v7/finance/quote?symbols=' + encodeURIComponent(sym) + '&crumb=' + encodeURIComponent(a.crumb), { headers: Object.assign({ cookie: a.ck }, UA) });
    if (!res.ok) return null;
    const j = await res.json(), q = j.quoteResponse && j.quoteResponse.result && j.quoteResponse.result[0]; if (!q) return null;
    return { cap: q.marketCap, open: q.regularMarketOpen, dh: q.regularMarketDayHigh, dl: q.regularMarketDayLow, vol: q.regularMarketVolume, exch: q.fullExchangeName, cur: q.currency, name: q.longName || q.shortName, hi52: q.fiftyTwoWeekHigh, lo52: q.fiftyTwoWeekLow, prev: q.regularMarketPreviousClose };
  } catch { return null; }
});
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

app.setAppUserModelId('com.whiteglove.app');
app.whenReady().then(() => {
  wipeGoogle();
  create();
  upd = createUpdater({ getUrl: feedUrl, version: app.getVersion(), emit: sendUpd });
  if (app.isPackaged) { setTimeout(() => upd.check(), 8000); setInterval(() => upd.check(), 6 * 3600 * 1000); }
});
app.on('will-quit', () => { if (!installing && upd && upd.isReady()) { installing = true; upd.install(false); } });
app.on('second-instance', () => { if (win) { if (win.isMinimized()) win.restore(); win.focus(); } });
app.on('window-all-closed', () => app.quit());
