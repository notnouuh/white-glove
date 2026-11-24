/* Browser/iPhone stand-in for the desktop app's native bridge (window.wg). */
(function () {
  if (window.wg) return;
  document.documentElement.classList.add('web');
  const P = (window.WG_PROXY || '').replace(/\/$/, '');
  const YF = 'https://query1.finance.yahoo.com';
  const clean = s => String(s || '').toUpperCase().replace(/[^A-Z0-9.\-^=]/g, '');
  const yfetch = async (path) => {
    const u = P ? P + '/yf' + path : 'https://corsproxy.io/?url=' + encodeURIComponent(YF + path);
    const r = await fetch(u); if (!r.ok) throw new Error('px ' + r.status); return r.json();
  };
  const RMAP = { '1d': ['1d', '5m'], '5d': ['5d', '30m'], '1mo': ['1mo', '1d'], '6mo': ['6mo', '1d'], '1y': ['1y', '1d'], '5dd': ['5d', '1d'] };
  const noop = () => {};
  window.wg = {
    isWeb: true,
    pickFile: async () => null, readFile: async () => null, writeFile: async () => ({ ok: false }), newFile: async () => null, watch: async () => {}, onFileChanged: noop,
    saveFile: async (name, data) => {
      const b = new Blob([data], { type: 'application/json' }), a = document.createElement('a');
      a.href = URL.createObjectURL(b); a.download = name; document.body.appendChild(a); a.click(); setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 1500); return true;
    },
    hasKey: async () => false, setKey: async () => false,
    ai: async () => ({ ok: false, error: 'Claude chat lives in the desktop app for now.' }),
    updGet: async () => ({ version: '', url: '', ready: false }), updSet: async () => {}, updCheck: async () => {}, updInstall: async () => {}, onUpdate: noop,
    gStatus: async () => ({ cfg: false, signed: false, web: true }), gConfig: async () => false, gSignin: async () => ({ ok: false, error: 'Desktop only.' }), gSignout: async () => true, sumFetch: async () => ({ ok: false, error: 'The Google summary is available in the desktop app.' }),
    pxGet: async list => {
      const out = {}, syms = [...new Set((list || []).map(clean).filter(Boolean))].slice(0, 60);
      await Promise.all(syms.map(async t => {
        try {
          const j = await yfetch('/v8/finance/chart/' + encodeURIComponent(t) + '?range=1d&interval=1d'), m = j.chart && j.chart.result && j.chart.result[0] && j.chart.result[0].meta;
          if (m && m.regularMarketPrice > 0) out[t] = { p: m.regularMarketPrice, prev: m.previousClose || m.chartPreviousClose || 0, at: (m.regularMarketTime || 0) * 1000 };
        } catch (e) {}
      }));
      return out;
    },
    pxChart: async (sym, range) => {
      try {
        sym = clean(sym); const [r, i] = RMAP[range] || RMAP['1d'];
        const j = await yfetch('/v8/finance/chart/' + encodeURIComponent(sym) + '?range=' + r + '&interval=' + i + '&includePrePost=' + (range === '1d' || range === '5d' ? 'true' : 'false'));
        const R = j.chart && j.chart.result && j.chart.result[0]; if (!R) return null;
        const ts = R.timestamp || [], Q = (R.indicators && R.indicators.quote && R.indicators.quote[0]) || {}, cl = Q.close || [], t = [], c = [], o = [], h = [], l = [], v = [];
        ts.forEach((x, k) => { if (cl[k] != null) { t.push(x * 1000); c.push(cl[k]); o.push(Q.open && Q.open[k] != null ? Q.open[k] : cl[k]); h.push(Q.high && Q.high[k] != null ? Q.high[k] : cl[k]); l.push(Q.low && Q.low[k] != null ? Q.low[k] : cl[k]); v.push((Q.volume && Q.volume[k]) || 0); } });
        const m = R.meta || {};
        return { t, c, o, h, l, v, meta: { exch: m.fullExchangeName || m.exchangeName, cur: m.currency, dh: m.regularMarketDayHigh, dl: m.regularMarketDayLow, vol: m.regularMarketVolume, price: m.regularMarketPrice, prev: m.chartPreviousClose || m.previousClose || 0, type: m.instrumentType, name: m.longName || m.shortName || sym, sym, reg: (m.currentTradingPeriod && m.currentTradingPeriod.regular) ? [m.currentTradingPeriod.regular.start * 1000, m.currentTradingPeriod.regular.end * 1000] : null } };
      } catch (e) { return null; }
    },
    pxInfo: async sym => { if (!P) return null; try { const r = await fetch(P + '/info?s=' + encodeURIComponent(clean(sym))); return r.ok ? r.json() : null; } catch (e) { return null; } },
    pxFund: async sym => { if (!P) return { holdings: [] }; try { const r = await fetch(P + '/fund?s=' + encodeURIComponent(clean(sym))); return r.ok ? r.json() : { holdings: [] }; } catch (e) { return { holdings: [] }; } }
  };
  if ('serviceWorker' in navigator && location.protocol.startsWith('http')) navigator.serviceWorker.register('sw.js').catch(noop);
})();
