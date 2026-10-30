'use strict';
// VMT Console - may chu admin (khong dung thu vien ngoai: chi Node 22 co san)
// - Dang nhap + phan quyen theo ban (admin, sale, order, kho, tc)
// - Nhan du lieu Gobiz do n8n day sang (/api/ingest, co chu ky RSA)
// - Tra du lieu da loc theo vai tro (/api/data): kho khong nhan duoc so tien

const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const zlib = require('node:zlib');
const crypto = require('node:crypto');
const { prepare, forRole } = require('./lib/data');
const store = require('./lib/store');
const cn = require('./lib/cn');

const PORT = Number(process.env.PORT || 3000);
const PUBLIC = path.join(__dirname, 'public');
const PUBKEY = fs.readFileSync(process.env.INGEST_PUBKEY_FILE || path.join(__dirname, 'ingest_pub.pem'));
const SESSION_HOURS = 12;
const COOKIE = 'vmt_s';
let VERSION = 'dev';
try { VERSION = fs.readFileSync(path.join(__dirname, 'VERSION'), 'utf8').trim().slice(0, 12); } catch {}

store.init();
const SECRET = store.sessionSecret();
store.ensureAdmin();
let UIINS = null; try { UIINS = JSON.parse(fs.readFileSync(path.join(__dirname, 'ui-inspect.json'), 'utf8')); } catch {}
store.syncUiInspect(UIINS);

// ---------- tien ich ----------
const b64u = (b) => Buffer.from(b).toString('base64url');
const sign = (s) => crypto.createHmac('sha256', SECRET).update(s).digest('base64url');

function makeSession(user) {
  const payload = b64u(JSON.stringify({ u: user.username, r: user.role, v: user.pv, exp: Date.now() + SESSION_HOURS * 3600e3 }));
  return payload + '.' + sign(payload);
}
function readSession(req) {
  const raw = (req.headers.cookie || '').split(/;\s*/).find((c) => c.startsWith(COOKIE + '='));
  if (!raw) return null;
  const [payload, mac] = raw.slice(COOKIE.length + 1).split('.');
  if (!payload || !mac) return null;
  const good = sign(payload);
  if (mac.length !== good.length || !crypto.timingSafeEqual(Buffer.from(mac), Buffer.from(good))) return null;
  let s;
  try { s = JSON.parse(Buffer.from(payload, 'base64url').toString()); } catch { return null; }
  if (!s || s.exp < Date.now()) return null;
  const u = store.getUser(s.u);
  if (!u || !u.active || u.pv !== s.v) return null; // doi mat khau / khoa tai khoan -> phien cu het hieu luc
  return u;
}
function isHttps(req) { return req.headers['x-forwarded-proto'] === 'https' || process.env.COOKIE_SECURE === '1'; }
function setCookie(req, res, value, maxAgeSec) {
  res.setHeader('Set-Cookie', `${COOKIE}=${value}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAgeSec}${isHttps(req) ? '; Secure' : ''}`);
}
function send(res, code, body, headers = {}) {
  res.writeHead(code, Object.assign({ 'Cache-Control': 'no-store' }, headers));
  res.end(body);
}
function json(req, res, code, obj) {
  const body = Buffer.from(JSON.stringify(obj));
  if (body.length > 2048 && /\bgzip\b/.test(req.headers['accept-encoding'] || '')) {
    return send(res, code, zlib.gzipSync(body), { 'Content-Type': 'application/json; charset=utf-8', 'Content-Encoding': 'gzip', Vary: 'Accept-Encoding' });
  }
  send(res, code, body, { 'Content-Type': 'application/json; charset=utf-8' });
}
function readBody(req, limit) {
  return new Promise((resolve, reject) => {
    const chunks = []; let n = 0;
    req.on('data', (c) => { n += c.length; if (n > limit) { reject(Object.assign(new Error('too_large'), { code: 413 })); req.destroy(); } else chunks.push(c); });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}
function clientIp(req) { return String(req.headers['x-forwarded-for'] || req.socket.remoteAddress || '').split(',')[0].trim(); }
function sameOrigin(req) {
  const o = req.headers.origin;
  if (!o) return true;
  try { return new URL(o).host === req.headers.host; } catch { return false; }
}

// ---------- han che dang nhap sai ----------
const fails = new Map(); // key -> [timestamps]
function tooMany(key) {
  const now = Date.now(); const arr = (fails.get(key) || []).filter((t) => now - t < 15 * 60e3);
  fails.set(key, arr); return arr.length >= 6;
}
function addFail(key) { const a = fails.get(key) || []; a.push(Date.now()); fails.set(key, a); }

// ---------- du lieu theo vai tro (cache theo snapshot) ----------
let cache = { id: null, base: null, byRole: {} };
function dataFor(role) {
  const snap = store.latestSnapshot();
  if (!snap) return null;
  if (cache.id !== snap.id) {
    cache = { id: snap.id, base: prepare(JSON.parse(snap.data)), byRole: {} };
    cache.base.received = snap.received_at;
  }
  if (!cache.byRole[role]) cache.byRole[role] = Buffer.from(JSON.stringify(forRole(cache.base, role)));
  return cache.byRole[role];
}

// ---------- file tinh ----------
const TYPES = { '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png', '.woff2': 'font/woff2', '.ico': 'image/x-icon' };
function serveFile(req, res, rel, cacheable) {
  const p = path.normalize(path.join(PUBLIC, rel));
  if (!p.startsWith(PUBLIC + path.sep)) return send(res, 404, 'Not found');
  fs.readFile(p, (err, buf) => {
    if (err) return send(res, 404, 'Not found');
    const type = TYPES[path.extname(p)] || 'application/octet-stream';
    const headers = { 'Content-Type': type, 'Cache-Control': cacheable ? 'public, max-age=3600' : 'no-store' };
    if (/text|javascript|svg/.test(type) && buf.length > 1024 && /\bgzip\b/.test(req.headers['accept-encoding'] || '')) {
      headers['Content-Encoding'] = 'gzip'; headers.Vary = 'Accept-Encoding'; buf = zlib.gzipSync(buf);
    }
    res.writeHead(200, headers); res.end(buf);
  });
}

// ---------- giao dien admin + phan mo rong Ship to China (app/ext) ----------
// app.html (template, ma hoa tren GitHub) duoc chen them: nap /ext/cn-admin.js sau vmt.js va trang 'cn' truoc </main>.
// Neu cau truc app.html doi (khong tim thay cho chen) thi tra ban goc, khong lam hong trang.
let appCache = { key: '', html: null };
function appHtml() {
  try {
    const f = path.join(PUBLIC, 'app.html'), sec = path.join(__dirname, 'ext', 'cn-section.html');
    const key = fs.statSync(f).mtimeMs + ':' + fs.statSync(sec).mtimeMs;
    if (appCache.key === key) return appCache.html;
    let h = fs.readFileSync(f, 'utf8');
    const a = "load('/assets/vmt.js')";
    const m = '      </main>\n\n      <!-- ============ DRAWER';
    if (h.includes(a) && h.includes(m)) {
      h = h.replace(a, "load('/assets/vmt.js').then(function () { return load('/ext/cn-admin.js'); })");
      h = h.replace(m, fs.readFileSync(sec, 'utf8') + m);
    } else { console.error('cn-admin: khong tim thay cho chen trong app.html'); h = null; }
    appCache = { key, html: h ? Buffer.from(h) : null };
    return appCache.html;
  } catch (e) { console.error(e); return null; }
}

// ---------- dinh tuyen ----------
async function handle(req, res) {
  const url = new URL(req.url, 'http://x');
  const p = url.pathname;

  if (p === '/healthz') return json(req, res, 200, { ok: true, version: VERSION, snapshot: (store.latestMeta() || {}).gen || null });

  // Nhan du lieu tu n8n: chu ky RSA-SHA256 tren chuoi "<X-Ts>.<body>"
  if (p === '/api/ingest' && req.method === 'POST') {
    let body;
    try { body = await readBody(req, 80 * 1024 * 1024); } catch (e) { return json(req, res, e.code || 400, { error: 'body' }); }
    if (req.headers['content-encoding'] === 'gzip') { try { body = zlib.gunzipSync(body); } catch { return json(req, res, 400, { error: 'gzip' }); } }
    const ts = Number(req.headers['x-ts']);
    const sig = String(req.headers['x-sig'] || '');
    if (!ts || Math.abs(Date.now() - ts) > 15 * 60e3) { store.logIngest(false, body.length, 'ts'); return json(req, res, 401, { error: 'ts' }); }
    const ok = sig && crypto.verify('RSA-SHA256', Buffer.concat([Buffer.from(ts + '.'), body]), PUBKEY, Buffer.from(sig, 'base64'));
    if (!ok) { store.logIngest(false, body.length, 'sig'); return json(req, res, 401, { error: 'sig' }); }
    let d;
    try { d = JSON.parse(body.toString('utf8')); } catch { store.logIngest(false, body.length, 'json'); return json(req, res, 400, { error: 'json' }); }
    if (!d || !Array.isArray(d.orders) || !Array.isArray(d.ships) || !d.gen) { store.logIngest(false, body.length, 'shape'); return json(req, res, 400, { error: 'shape' }); }
    if (store.seenTs(ts)) return json(req, res, 409, { error: 'replay' });
    const id = store.saveSnapshot(d.gen, body.toString('utf8'), ts);
    store.logIngest(true, body.length, 'ok #' + id);
    return json(req, res, 200, { ok: true, id, orders: d.orders.length, ships: d.ships.length });
  }

  if (p === '/api/login' && req.method === 'POST') {
    if (!sameOrigin(req)) return json(req, res, 403, { error: 'origin' });
    let b; try { b = JSON.parse((await readBody(req, 10000)).toString()); } catch { return json(req, res, 400, { error: 'body' }); }
    const username = String(b.username || '').trim().toLowerCase();
    const ip = clientIp(req);
    if (tooMany('ip:' + ip) || tooMany('u:' + username)) return json(req, res, 429, { error: 'Sai quá nhiều lần, thử lại sau 15 phút' });
    const u = store.checkPassword(username, String(b.password || ''));
    store.logLogin(username, ip, !!u);
    if (!u) { addFail('ip:' + ip); addFail('u:' + username); return json(req, res, 401, { error: 'Sai tên đăng nhập hoặc mật khẩu' }); }
    setCookie(req, res, makeSession(u), SESSION_HOURS * 3600);
    return json(req, res, 200, { ok: true });
  }

  if (p === '/api/logout' && req.method === 'POST') {
    setCookie(req, res, '', 0);
    return json(req, res, 200, { ok: true });
  }

  if (p === '/login') return serveFile(req, res, 'login.html', false);
  if (p.startsWith('/assets/')) return serveFile(req, res, p.slice(1), true);

  const user = readSession(req);
  if (p === '/api/me') return user ? json(req, res, 200, { username: user.username, name: user.name, role: user.role }) : json(req, res, 401, { error: 'login' });
  if (p === '/api/data') {
    if (!user) return json(req, res, 401, { error: 'login' });
    const buf = dataFor(user.role);
    if (!buf) return json(req, res, 503, { error: 'Chưa có dữ liệu. Đợi n8n đồng bộ lần đầu (tối đa 15 phút).' });
    if (/\bgzip\b/.test(req.headers['accept-encoding'] || '')) return send(res, 200, zlib.gzipSync(buf), { 'Content-Type': 'application/json; charset=utf-8', 'Content-Encoding': 'gzip', Vary: 'Accept-Encoding' });
    return send(res, 200, buf, { 'Content-Type': 'application/json; charset=utf-8' });
  }
  if (p === '/api/status') {
    if (!user || user.role !== 'admin') return json(req, res, 403, { error: 'forbidden' });
    return json(req, res, 200, { snapshot: store.latestMeta(), ingest: store.recentIngest(), logins: store.recentLogins() });
  }

  // ---------- Ban Ship to China (don SCN tu trang khach) ----------
  if (p === '/cn') {
    if (!user) { res.writeHead(302, { Location: '/login' }); return res.end(); }
    return fs.readFile(path.join(__dirname, 'cn.html'), (err, buf) => err ? send(res, 500, 'Server error') : send(res, 200, buf, { 'Content-Type': 'text/html; charset=utf-8' }));
  }
  if (p.startsWith('/api/cn') && user && !(user.role in cn.CAN_EDIT)) return json(req, res, 403, { error: 'forbidden' });
  if (p === '/api/cn/summary') {
    if (!user) return json(req, res, 401, { error: 'login' });
    return json(req, res, 200, cn.summary());
  }
  if (p === '/api/cn' && req.method === 'GET') {
    if (!user) return json(req, res, 401, { error: 'login' });
    const withTest = url.searchParams.get('test') === '1';
    return json(req, res, 200, { role: user.role, name: user.name || user.username, can: cn.CAN_EDIT[user.role] || [], counts: cn.counts(withTest), orders: cn.list(user.role, { status: url.searchParams.get('status') || '', withTest }) });
  }
  const mcn = p.match(/^\/api\/cn\/(SCN\d{1,12})(\/log)?$/);
  if (mcn) {
    if (!user) return json(req, res, 401, { error: 'login' });
    if (mcn[2]) return json(req, res, 200, { log: cn.log(mcn[1]) });
    if (req.method !== 'POST') return json(req, res, 405, { error: 'method' });
    if (!sameOrigin(req) || !/application\/json/.test(req.headers['content-type'] || '')) return json(req, res, 403, { error: 'origin' });
    let b; try { b = JSON.parse((await readBody(req, 20000)).toString()); } catch { return json(req, res, 400, { error: 'Dữ liệu không hợp lệ' }); }
    const r = cn.update(mcn[1], user.role, user.username, b);
    if (r.error) return json(req, res, r.code, { error: r.error });
    return json(req, res, 200, { ok: true, order: r.order });
  }

  if (p === '/ext/cn-admin.js') {
    if (!user) return send(res, 401, '', { 'Content-Type': 'text/javascript' });
    return fs.readFile(path.join(__dirname, 'ext', 'cn-admin.js'), (err, buf) => err ? send(res, 404, '') : send(res, 200, buf, { 'Content-Type': 'text/javascript; charset=utf-8' }));
  }
  if (p === '/' || p === '/index.html') {
    if (!user) { res.writeHead(302, { Location: '/login' }); return res.end(); }
    const html = appHtml();
    if (!html) return serveFile(req, res, 'app.html', false);
    return send(res, 200, html, { 'Content-Type': 'text/html; charset=utf-8' });
  }
  return send(res, 404, 'Not found');
}

const server = http.createServer((req, res) => {
  handle(req, res).catch((e) => { console.error(e); if (!res.headersSent) send(res, 500, 'Server error'); });
});
server.listen(PORT, () => console.log('VMT Console chay o cong ' + PORT));
process.on('SIGTERM', () => server.close(() => process.exit(0)));
