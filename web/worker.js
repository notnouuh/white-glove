// Optional price proxy for Cloudflare Workers (free). Deploy, then set window.WG_PROXY in config.js to its URL.
const UA = { 'user-agent': 'Mozilla/5.0' };
const CORS = { 'access-control-allow-origin': '*', 'access-control-allow-headers': '*' };
const J = (o, s = 200) => new Response(JSON.stringify(o), { status: s, headers: { ...CORS, 'content-type': 'application/json' } });
const clean = s => String(s || '').toUpperCase().replace(/[^A-Z0-9.\-^=]/g, '');
let crumb = null;
async function auth() {
  if (crumb && Date.now() < crumb.exp) return crumb;
  const r = await fetch('https://fc.yahoo.com', { headers: UA, redirect: 'manual' });
  const ck = (r.headers.getSetCookie ? r.headers.getSetCookie() : []).map(x => x.split(';')[0]).join('; ');
  const c = await fetch('https://query1.finance.yahoo.com/v1/test/getcrumb', { headers: { ...UA, cookie: ck } });
  const t = await c.text(); if (!c.ok || !t || t.length > 40) throw new Error('crumb');
  crumb = { ck, t, exp: Date.now() + 3600e3 }; return crumb;
}
export default {
  async fetch(req) {
    if (req.method === 'OPTIONS') return new Response(null, { headers: CORS });
    const u = new URL(req.url);
    try {
      if (u.pathname.startsWith('/yf/v8/finance/chart/')) {
        const r = await fetch('https://query1.finance.yahoo.com' + u.pathname.slice(3) + u.search, { headers: UA });
        return new Response(await r.text(), { status: r.status, headers: { ...CORS, 'content-type': 'application/json' } });
      }
      if (u.pathname === '/info') {
        const a = await auth(), r = await fetch('https://query1.finance.yahoo.com/v7/finance/quote?symbols=' + encodeURIComponent(clean(u.searchParams.get('s'))) + '&crumb=' + encodeURIComponent(a.t), { headers: { ...UA, cookie: a.ck } });
        const q = (((await r.json()).quoteResponse || {}).result || [])[0]; if (!q) return J(null, 404);
        return J({ cap: q.marketCap, open: q.regularMarketOpen, dh: q.regularMarketDayHigh, dl: q.regularMarketDayLow, vol: q.regularMarketVolume, exch: q.fullExchangeName, cur: q.currency, name: q.longName || q.shortName, hi52: q.fiftyTwoWeekHigh, lo52: q.fiftyTwoWeekLow, prev: q.regularMarketPreviousClose });
      }
      if (u.pathname === '/fund') {
        const a = await auth(), r = await fetch('https://query1.finance.yahoo.com/v10/finance/quoteSummary/' + encodeURIComponent(clean(u.searchParams.get('s'))) + '?modules=topHoldings&crumb=' + encodeURIComponent(a.t), { headers: { ...UA, cookie: a.ck } });
        const th = ((((await r.json()).quoteSummary || {}).result || [])[0] || {}).topHoldings || {};
        return J({ holdings: (th.holdings || []).filter(h => h.symbol).slice(0, 5).map(h => ({ sym: h.symbol, name: h.holdingName, pct: ((h.holdingPercent && h.holdingPercent.raw) || 0) * 100 })) });
      }
    } catch (e) { return J({ error: String(e) }, 502); }
    return J({ ok: true });
  }
};
