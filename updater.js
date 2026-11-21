const fs = require('fs'), path = require('path'), os = require('os'), crypto = require('crypto'), { spawn } = require('child_process');

const cmp = (a, b) => {
  const A = String(a).split('.').map(Number), B = String(b).split('.').map(Number);
  for (let i = 0; i < 3; i++) { const x = A[i] || 0, y = B[i] || 0; if (x !== y) return x > y ? 1 : -1; }
  return 0;
};
const safeUrl = u => /^https:\/\//i.test(u) || /^http:\/\/(localhost|127\.0\.0\.1)(:|\/|$)/i.test(u);

function create({ getUrl, version, emit, tmpDir = os.tmpdir(), spawnFn = spawn }) {
  let ready = null, busy = false;
  async function check() {
    if (busy) return; busy = true;
    try {
      const base = (getUrl() || '').trim();
      if (!base) return emit({ state: 'nofeed' });
      if (!safeUrl(base)) throw new Error('The update source must be an https:// address.');
      emit({ state: 'checking' });
      const root = base.replace(/\/+$/, '');
      const r = await fetch(root + '/latest.json', { cache: 'no-store' });
      if (!r.ok) throw new Error('Update source answered ' + r.status);
      const j = await r.json();
      if (!j.version || !j.file) throw new Error('Update source is missing version info.');
      if (cmp(j.version, version) <= 0) return emit({ state: 'current' });
      if (ready && ready.version === j.version) return emit({ state: 'ready', version: j.version });
      emit({ state: 'downloading', version: j.version, pct: 0 });
      const fr = await fetch(new URL(j.file, root + '/').toString());
      if (!fr.ok) throw new Error('Download failed (' + fr.status + ').');
      const total = +fr.headers.get('content-length') || 0;
      const dest = path.join(tmpDir, 'White-Glove-Setup-' + j.version + '.exe');
      const ws = fs.createWriteStream(dest), h = crypto.createHash('sha256');
      let got = 0, lastPct = -1;
      for await (const chunk of fr.body) {
        if (!ws.write(chunk)) await new Promise(res => ws.once('drain', res));
        h.update(chunk); got += chunk.length;
        const pct = total ? Math.floor(got / total * 100) : 0;
        if (pct !== lastPct) { lastPct = pct; emit({ state: 'downloading', version: j.version, pct }); }
      }
      await new Promise(res => ws.end(res));
      if (j.sha256 && h.digest('hex') !== String(j.sha256).toLowerCase()) {
        try { fs.unlinkSync(dest); } catch {}
        throw new Error('The downloaded update failed its integrity check.');
      }
      ready = { version: j.version, file: dest };
      emit({ state: 'ready', version: j.version });
    } catch (e) {
      emit({ state: 'error', message: String(e && e.message || e).slice(0, 160) });
    } finally { busy = false; }
  }
  function install(relaunch) {
    if (!ready) return false;
    spawnFn(ready.file, relaunch ? ['/S', '/R=1'] : ['/S'], { detached: true, stdio: 'ignore' }).unref();
    return true;
  }
  return { check, install, isReady: () => !!ready, cmp };
}
module.exports = { create, cmp };
