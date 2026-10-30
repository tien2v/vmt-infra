'use strict';
// Trang khach VMT (app.vominhthien.com, sau nay app.vmtglobal.com). Khong dung thu vien ngoai (Node 22).
// - Dang nhap khach (giai doan 1: tai khoan cap san; giai doan 2: tai khoan Gobiz)
// - Du lieu: snapshot Gobiz 30 ngay (n8n day vao trang admin), loc DUNG khach dang dang nhap ngay tren may chu.

const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const zlib = require('node:zlib');
const crypto = require('node:crypto');
const store = require('./lib/store');
const { buildIndex, brandOf, busiest } = require('./lib/map');

const PORT = Number(process.env.PORT || 3001);
const PUBLIC = path.join(__dirname, 'public');
const SESSION_HOURS = 24 * 7;
const COOKIE = 'vmt_k';
let VERSION = 'dev';
try { VERSION = fs.readFileSync(path.join(__dirname, 'VERSION'), 'utf8').trim().slice(0, 12); } catch {}

store.init();
const SECRET = store.sessionSecret();
let TEST = null;
try { TEST = JSON.parse(fs.readFileSync(path.join(__dirname, 'test-user.json'), 'utf8')); } catch {}

const b64u = (b) => Buffer.from(b).toString('base64url');
const sign = (s) => crypto.createHmac('sha256', SECRET).update(s).digest('base64url');
function makeSession(u) {
  const p = b64u(JSON.stringify({ u: u.username, v: u.pv, exp: Date.now() + SESSION_HOURS * 3600e3 }));
  return p + '.' + sign(p);
}
function readSession(req) {
  const raw = (req.headers.cookie || '').split(/;\s*/).find((c) => c.startsWith(COOKIE + '='));
  if (!raw) return null;
  const [p, mac] = raw.slice(COOKIE.length + 1).split('.');
  if (!p || !mac) return null;
  const good = sign(p);
  if (mac.length !== good.length || !crypto.timingSafeEqual(Buffer.from(mac), Buffer.from(good))) return null;
  let s; try { s = JSON.parse(Buffer.from(p, 'base64url').toString()); } catch { return null; }
  if (!s || s.exp < Date.now()) return null;
  const u = store.getUser(s.u);
  if (!u || !u.active || u.pv !== s.v) return null;
  return u;
}
function setCookie(res, v, maxAge) { res.setHeader('Set-Cookie', `${COOKIE}=${v}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=${maxAge}`); }
function send(res, code, body, headers = {}) { res.writeHead(code, Object.assign({ 'Cache-Control': 'no-store' }, headers)); res.end(body); }
function gz(req, res, code, buf, type) {
  if (buf.length > 1024 && /\bgzip\b/.test(req.headers['accept-encoding'] || '')) return send(res, code, zlib.gzipSync(buf), { 'Content-Type': type, 'Content-Encoding': 'gzip', Vary: 'Accept-Encoding' });
  send(res, code, buf, { 'Content-Type': type });
}
const json = (req, res, code, o) => gz(req, res, code, Buffer.from(JSON.stringify(o)), 'application/json; charset=utf-8');
function readBody(req, limit) {
  return new Promise((ok, no) => { const ch = []; let n = 0;
    req.on('data', (c) => { n += c.length; if (n > limit) { no(new Error('too_large')); req.destroy(); } else ch.push(c); });
    req.on('end', () => ok(Buffer.concat(ch))); req.on('error', no); });
}
const clientIp = (req) => String(req.headers['x-forwarded-for'] || req.socket.remoteAddress || '').split(',')[0].trim();
function sameOrigin(req) { const o = req.headers.origin; if (!o) return true; try { return new URL(o).host === req.headers.host; } catch { return false; } }
const fails = new Map();
function tooMany(k) { const now = Date.now(); const a = (fails.get(k) || []).filter((t) => now - t < 15 * 60e3); fails.set(k, a); return a.length >= 8; }
function addFail(k) { const a = fails.get(k) || []; a.push(Date.now()); fails.set(k, a); }
setInterval(() => { const now = Date.now(); for (const [k, a] of fails) if (!a.some((t) => now - t < 15 * 60e3)) fails.delete(k); }, 10 * 60e3).unref();

// ---------- du lieu: dung lai chi muc khi snapshot moi ----------
let idx = { id: null, index: null };
function index() {
  const id = store.latestSnapshotId();
  if (!id) return null;
  if (idx.id !== id) {
    const s = store.snapshot(id);
    if (!s) return idx.index;
    idx = { id, index: buildIndex(JSON.parse(s.data)) };
    resolveTest();
  }
  return idx.index;
}
function resolveTest() {
  if (!TEST || !TEST.username || !TEST.hash) return;
  const cur = store.getUser(TEST.username);
  let g = TEST.gobiz && TEST.gobiz !== 'auto' ? TEST.gobiz : (cur && cur.gobiz !== 'auto' ? cur.gobiz : null);
  if (!g && idx.index) g = busiest(idx.index, TEST.group || 'default');
  store.upsertTest(TEST.username, g || 'auto', TEST.hash, 'tai khoan test');
}
resolveTest();

const BRAND = {
  green: { name: 'Vominhthien', tag: 'Logistics', host: 'app.vominhthien.com' },
  yellow: { name: 'VMT Global', tag: 'Cùng nhau tiến bước', host: 'app.vmtglobal.com' },
};
const hostBrand = (req) => (/vmtglobal/i.test(req.headers.host || '') ? 'yellow' : 'green');

function payload(user) {
  const ix = index();
  const s = ix ? ix.byUser.get(String(user.gobiz).toLowerCase()) : null;
  const c = s && s.cust;
  const brand = c ? brandOf(c.grp) : 'green';
  const me = {
    username: user.username, gobiz: user.gobiz, test: user.note === 'tai khoan test',
    name: (c && c.fn) || user.gobiz, code: (c && c.code) || '', balance: c ? Number(c.bal) : null, brand,
  };
  const data = { orders: s ? s.orders : [], shipments: s ? s.shipments : [], peer: s ? s.peer : [], pulledAt: ix ? ix.gen : null, from: ix ? ix.from : null };
  return 'window.ME=' + JSON.stringify(me) + ';window.DATA=' + JSON.stringify(data) + ';';
}

const TYPES = { '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png', '.webp': 'image/webp', '.woff2': 'font/woff2', '.ico': 'image/x-icon', '.json': 'application/json' };
function serveFile(req, res, rel, cacheable) {
  const p = path.normalize(path.join(PUBLIC, rel));
  if (!p.startsWith(PUBLIC + path.sep)) return send(res, 404, 'Not found');
  fs.readFile(p, (err, buf) => {
    if (err) return send(res, 404, 'Not found');
    const type = TYPES[path.extname(p)] || 'application/octet-stream';
    const h = { 'Content-Type': type, 'Cache-Control': cacheable ? 'public, max-age=86400' : 'no-store' };
    if (/text|javascript|svg|json/.test(type) && buf.length > 1024 && /\bgzip\b/.test(req.headers['accept-encoding'] || '')) { h['Content-Encoding'] = 'gzip'; h.Vary = 'Accept-Encoding'; buf = zlib.gzipSync(buf); }
    res.writeHead(200, h); res.end(buf);
  });
}
function loginPage(req, res) {
  fs.readFile(path.join(__dirname, 'login.html'), 'utf8', (err, html) => {
    if (err) return send(res, 500, 'Server error');
    const b = hostBrand(req);
    send(res, 200, html.replaceAll('{{BRAND}}', b).replaceAll('{{NAME}}', BRAND[b].name).replaceAll('{{TAG}}', BRAND[b].tag), { 'Content-Type': 'text/html; charset=utf-8' });
  });
}

async function handle(req, res) {
  const url = new URL(req.url, 'http://x');
  const p = url.pathname;
  if (p === '/healthz') return json(req, res, 200, { ok: true, version: VERSION, snapshot: index() ? index().gen : null });

  if (p === '/api/login' && req.method === 'POST') {
    if (!sameOrigin(req)) return json(req, res, 403, { error: 'origin' });
    let b; try { b = JSON.parse((await readBody(req, 10000)).toString()); } catch { return json(req, res, 400, { error: 'Dữ liệu không hợp lệ' }); }
    const username = String(b.username || '').trim().toLowerCase();
    const ip = clientIp(req);
    if (tooMany('ip:' + ip) || tooMany('u:' + username)) return json(req, res, 429, { error: 'Sai quá nhiều lần, thử lại sau 15 phút' });
    index(); // dam bao tai khoan test da gan khach
    const u = store.checkPassword(username, String(b.password || ''));
    store.logLogin(username, ip, !!u);
    if (!u) { addFail('ip:' + ip); addFail('u:' + username); return json(req, res, 401, { error: 'Sai tên đăng nhập hoặc mật khẩu' }); }
    setCookie(res, makeSession(u), SESSION_HOURS * 3600);
    return json(req, res, 200, { ok: true });
  }
  if (p === '/api/logout') { setCookie(res, '', 0); res.writeHead(302, { Location: '/login' }); return res.end(); }
  if (p === '/login') return loginPage(req, res);
  if (p.startsWith('/assets/') || p === '/icons.js' || p === '/manifest.json') return serveFile(req, res, p.slice(1), true);

  const user = readSession(req);
  if (p === '/api/data.js') {
    if (!user) return send(res, 401, 'location.href="/login";', { 'Content-Type': 'text/javascript; charset=utf-8' });
    return gz(req, res, 200, Buffer.from(payload(user)), 'text/javascript; charset=utf-8');
  }
  if (p === '/' || p === '/index.html') {
    if (!user) { res.writeHead(302, { Location: '/login' }); return res.end(); }
    return serveFile(req, res, 'index.html', false);
  }
  return send(res, 404, 'Not found');
}

http.createServer((req, res) => {
  handle(req, res).catch((e) => { console.error(e); if (!res.headersSent) send(res, 500, 'Server error'); });
}).listen(PORT, () => console.log('Trang khach chay o cong ' + PORT));
