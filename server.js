const http = require('http'), fs = require('fs'), path = require('path');
const { WebSocketServer } = require('ws');
const PORT = process.env.PORT || 3000;
const GA = (process.env.GA_ID || '').trim(); // e.g. G-ABC123XYZ
const gaTag = /^G-[A-Z0-9]+$/i.test(GA)
  ? `<script async src="https://www.googletagmanager.com/gtag/js?id=${GA}"></script><script>window.dataLayer=window.dataLayer||[];function gtag(){dataLayer.push(arguments)}gtag('js',new Date());gtag('config','${GA}');</script>`
  : '';
const page = Buffer.from(fs.readFileSync([path.join(__dirname, 'index.html'), path.join(__dirname, 'public', 'index.html')].find((p) => fs.existsSync(p)), 'utf8').replace('<!--GA-->', gaTag).replace(/__SITE__/g, (process.env.SITE_URL || '').replace(/\/$/, '')));

const visitors = new Map(); // id -> last ping time
const counts = () => {
  const now = Date.now();
  for (const [k, t] of visitors) if (now - t > 35000) visitors.delete(k);
  return { visitors: visitors.size, chatting: [...wss.clients].filter((c) => c.readyState === 1).length };
};
const srv = http.createServer((req, res) => {
  const u = new URL(req.url, 'http://x');
  if (u.pathname === '/ping') {
    const id = (u.searchParams.get('id') || '').slice(0, 40);
    if (id) visitors.set(id, Date.now());
    res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
    return res.end(JSON.stringify(counts()));
  }
  const base = (process.env.SITE_URL || ('https://' + req.headers.host)).replace(/\/$/, '');
  if (u.pathname === '/robots.txt') {
    res.writeHead(200, { 'Content-Type': 'text/plain' });
    return res.end('User-agent: *\nAllow: /\nSitemap: ' + base + '/sitemap.xml\n');
  }
  if (u.pathname === '/sitemap.xml') {
    res.writeHead(200, { 'Content-Type': 'application/xml' });
    return res.end('<?xml version="1.0" encoding="UTF-8"?><urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9"><url><loc>' + base + '/</loc><changefreq>weekly</changefreq><priority>1.0</priority></url></urlset>');
  }
  res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
  res.end(page);
});
const wss = new WebSocketServer({ server: srv, maxPayload: 16384 });

let waiting = null;
const reports = new Map(), banned = new Set();
const send = (ws, o) => ws.readyState === 1 && ws.send(JSON.stringify(o));

function leave(ws) {
  if (waiting === ws) waiting = null;
  const p = ws.peer;
  ws.peer = null;
  if (p) { p.peer = null; send(p, { t: 'left' }); }
}

wss.on('connection', (ws, req) => {
  ws.ip = (req.headers['x-forwarded-for'] || req.socket.remoteAddress || '').split(',')[0].trim();
  if (banned.has(ws.ip)) return ws.close();

  ws.on('message', (d) => {
    let m; try { m = JSON.parse(d); } catch { return; }
    if (m.t === 'find') {
      leave(ws);
      if (waiting && waiting !== ws && waiting.readyState === 1) {
        const w = waiting; waiting = null;
        w.peer = ws; ws.peer = w;
        send(w, { t: 'match', initiator: true });
        send(ws, { t: 'match', initiator: false });
      } else waiting = ws;
    } else if (m.t === 'stop') leave(ws);
    else if (['offer', 'answer', 'ice', 'chat'].includes(m.t) && ws.peer) send(ws.peer, m);
    else if (m.t === 'report' && ws.peer) {
      const bad = ws.peer, n = (reports.get(bad.ip) || 0) + 1;
      reports.set(bad.ip, n);
      console.log('REPORT', bad.ip, 'count', n);
      if (n >= 3) { banned.add(bad.ip); bad.close(); } // 3 reports = ban (resets on restart)
      leave(ws);
    }
  });
  ws.on('close', () => leave(ws));
});

srv.listen(PORT, () => console.log('Running on http://localhost:' + PORT));
