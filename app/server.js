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
const extra = require('./lib/extra');

const PORT = Number(process.env.PORT || 3000);
const PUBLIC = path.join(__dirname, 'public');
const PUBKEY = fs.readFileSync(process.env.INGEST_PUBKEY_FILE || path.join(__dirname, 'ingest_pub.pem'));
const SESSION_HOURS = 12;
const COOKIE = 'vmt_s';
let VERSION = 'dev';
try { VERSION = fs.readFileSync(path.join(__dirname, 'VERSION'), 'utf8').trim().slice(0, 12); } catch {}

store.init();
extra.init(process.env.DATA_DIR || path.join(__dirname, 'data'));
const SECRET = store.sessionSecret();
store.ensureAdmin();
let UIINS = null; try { UIINS = JSON.parse(fs.readFileSync(path.join(__dirname, 'ui-inspect.json'), 'utf8')); } catch {}
store.syncUiInspect(UIINS);
const backup = require('./lib/backup');
// Tai khoan nhan nap tien ban dau (anh gui 31/10/2026). Chi ghi khi chua co cai dat nao; sau do anh sua tren trang Vi khach.
if (!store.kvGet('deposit_accounts')) {
  store.kvSet('deposit_accounts', JSON.stringify([
    { id: 'B1', label: 'Quỹ B1', bank: 'TPB', acct: '10004459488', holder: 'TRAN TUAN ANH', active: true },
    { id: 'MC', label: 'Quỹ MC', bank: 'TCB', acct: '88888868768', holder: 'NGUYEN MANH CUONG', active: true },
    { id: 'L8', label: 'Quỹ L8', bank: 'MSB', acct: '9686688887861000002', holder: 'NGUYEN VAN CAO', active: true },
  ]));
  console.log('deposit_accounts: ghi 3 tai khoan ban dau');
}
backup.init(store);
const dws = require('./lib/dws');
dws.init(store);
const xport = require('./lib/xport');
xport.init(store);
const speedtest = require('./lib/speedtest');
speedtest.init();
setInterval(() => { try { const n = cn.autoDeliver(); if (n) console.log('autoDeliver', n); } catch (e) { console.error(e); } }, 30 * 60e3);
setTimeout(() => { try { cn.autoDeliver(); } catch (e) {} }, 20e3);

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
  if (cache.id !== snap.id || cache.xv !== extra.version()) {
    cache = { id: snap.id, xv: extra.version(), base: prepare(JSON.parse(snap.data)), byRole: {} };
    cache.base.received = snap.received_at;
    try { extra.attachShips(cache.base.ships); } catch (e) { console.error('attachShips', e); }
  }
  if (!cache.byRole[role]) cache.byRole[role] = Buffer.from(JSON.stringify(forRole(cache.base, role)));
  return cache.byRole[role];
}

// Danh sach khach tu snapshot Gobiz (de nhan vien chon khi tao don gium)
const norm = (s) => String(s || '').toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/đ/g, 'd');
let custCache = { id: null, list: [] };
function customers() {
  const snap = store.latestSnapshot(); if (!snap) return [];
  if (custCache.id !== snap.id) {
    const raw = JSON.parse(snap.data);
    custCache = { id: snap.id, list: (raw.customers || []).filter((c) => c.u).map((c) => ({ u: c.u, code: c.code || '', fn: c.fn || '', _q: norm([c.u, c.code, c.fn].join(' ')) })) };
  }
  return custCache.list;
}

// ---------- quan ly khach hang ----------
let khCache = { at: 0, rows: null };
function khRows() {
  if (khCache.rows && Date.now() - khCache.at < 60e3) return khCache.rows;
  let rows = extra.allCust();
  if (!rows.length) rows = customers().map((c) => ({ u: c.u, code: c.code, fn: c.fn })); // chua co luong bo sung -> tam lay khach trong 30 ngay
  const own = extra.owners(), ns = extra.noteStats();
  const today = new Date(Date.now() + 7 * 3600e3).toISOString().slice(0, 10);
  const dayAgo = (s) => s ? Math.floor((Date.now() + 7 * 3600e3 - Date.parse(String(s).slice(0, 10) + 'T00:00:00Z')) / 86400e3) : null;
  rows = rows.map((c) => {
    const k = String(c.u).toLowerCase(), o = own[k] || {}, n = ns[k] || {};
    const last = [c.o_last, c.s_last, c.p_last].filter(Boolean).sort().pop() || null;
    const age = dayAgo(last), cage = dayAgo(c.ca);
    let seg = 'none';
    if (last) seg = age <= 30 ? 'active' : age <= 90 ? 'risk' : 'lost';
    const r = Object.assign({}, c, { k, last, age, sale: o.sale || null, cskh: o.cskh || null, tags: o.tags || null, nNote: n.n || 0, lastNote: n.last || null, remind: n.next || null, seg, isNew: cage !== null && cage <= 30 });
    r.due = !!(r.remind && r.remind.slice(0, 10) <= today);
    r.debt = (Number(c.unpaid) || 0) > 0 || (Number(c.bal) || 0) < 0;
    r._q = norm([c.u, c.code, c.fn, c.ph, c.em, c.zalo, o.tags].join(' '));
    return r;
  });
  khCache = { at: Date.now(), rows };
  return rows;
}
const KH_SEG = {
  all: () => true, mine: (r, me) => r.sale === me || r.cskh === me, due: (r) => r.due, active: (r) => r.seg === 'active', risk: (r) => r.seg === 'risk',
  lost: (r) => r.seg === 'lost', none: (r) => r.seg === 'none', isNew: (r) => r.isNew, debt: (r) => r.debt, vip: (r) => (Number(r.v90) || 0) >= 100e6,
};
function khBase(sp, all) {
  const q = norm(String(sp.get('q') || '').trim());
  const grp = String(sp.get('grp') || ''), owner = String(sp.get('owner') || '');
  return all.filter((r) => (!q || r._q.includes(q)) && (!grp || r.grp === grp) && (!owner || (owner === '-' ? !r.sale && !r.cskh : r.sale === owner || r.cskh === owner)));
}
function khList(sp, user) {
  const all = khRows(), me = user.username;
  const seg = KH_SEG[sp.get('seg')] ? sp.get('seg') : 'all';
  const base = khBase(sp, all);
  const counts = {}; for (const k in KH_SEG) counts[k] = base.filter((r) => KH_SEG[k](r, me)).length;
  let list = base.filter((r) => KH_SEG[seg](r, me));
  const sort = String(sp.get('sort') || 'last');
  const num = (v) => Number(v) || 0;
  const cmp = { last: (a, b) => String(b.last || '').localeCompare(String(a.last || '')), v90: (a, b) => num(b.v90) - num(a.v90), n90: (a, b) => (num(b.o90) + num(b.s90) + num(b.p90)) - (num(a.o90) + num(a.s90) + num(a.p90)),
    debt: (a, b) => (num(b.unpaid) - num(b.bal < 0 ? b.bal : 0)) - (num(a.unpaid) - num(a.bal < 0 ? a.bal : 0)), bal: (a, b) => num(b.bal) - num(a.bal), created: (a, b) => String(b.ca || '').localeCompare(String(a.ca || '')),
    remind: (a, b) => String(a.remind || '9').localeCompare(String(b.remind || '9')), old: (a, b) => String(a.last || '0').localeCompare(String(b.last || '0')) }[sort] || ((a, b) => 0);
  list = list.slice().sort(cmp);
  const size = Math.min(100, Math.max(10, Number(sp.get('size')) || 25)), pg = Math.max(1, Number(sp.get('p')) || 1);
  const money = user.role !== 'kho';
  const rows = list.slice((pg - 1) * size, pg * size).map((r) => { const x = Object.assign({}, r); delete x._q; if (!money) { delete x.bal; delete x.unpaid; delete x.v90; } return x; });
  const groups = [...new Set(all.map((r) => r.grp).filter(Boolean))].sort();
  const staff = store.listUsers().filter((x) => x.active && ['admin', 'sale'].includes(x.role)).map((x) => ({ u: x.username, n: x.name }));
  return { total: list.length, all: all.length, p: pg, size, rows, counts, groups, staff, me, full: extra.custCount() > 0 };
}
const khStaffList = () => store.listUsers().filter((x) => x.active && ['admin', 'sale'].includes(x.role)).map((x) => ({ u: x.username, n: x.name, role: x.role }));
extra.setActiveStaff(() => new Set(khStaffList().map((x) => x.u)));
// Gan phu trach hang loat (chi admin). b = { users:[k] | filter:{q,seg,grp,owner}, sale:{mode,u}, cskh:{mode,u}, onlyEmpty, dry }
function khAssign(b, user) {
  const all = khRows(), me = user.username;
  let rows;
  if (Array.isArray(b.users)) { const set = new Set(b.users.map((x) => String(x).toLowerCase())); rows = all.filter((r) => set.has(r.k)); }
  else { const f = b.filter || {}; const sp = new URLSearchParams({ q: f.q || '', grp: f.grp || '', owner: f.owner || '' }); const seg = KH_SEG[f.seg] ? f.seg : 'all'; rows = khBase(sp, all).filter((r) => KH_SEG[seg](r, me)); }
  const act = new Set(khStaffList().map((x) => x.u));
  const plans = {}, miss = new Set(), out = {};
  for (const fld of ['sale', 'cskh']) {
    const m = (b[fld] || {}).mode || 'keep';
    if (m === 'keep') continue;
    let target = rows;
    if (b.onlyEmpty) target = rows.filter((r) => !r[fld]);
    if (m === 'set') { const u = String((b[fld] || {}).u || ''); if (!act.has(u)) return { error: 'Nhân viên ' + (u || '?') + ' không còn hoạt động', code: 400 }; plans[fld] = new Map(target.map((r) => [r.k, u])); }
    else if (m === 'clear') plans[fld] = new Map(target.map((r) => [r.k, null]));
    else if (m === 'split') {
      const sorted = target.slice().sort((x, y) => (Number(y.v90) || 0) - (Number(x.v90) || 0)); // chia luot theo gia tri -> moi nguoi nhan khach lon / nho deu nhau
      const r = extra.splitPlan(sorted, fld, act); plans[fld] = r.plan; r.miss.forEach((x) => miss.add(x));
    } else return { error: 'Cách gán không hợp lệ', code: 400 };
  }
  if (!Object.keys(plans).length) return { error: 'Chưa chọn gán Sale hay CSKH', code: 400 };
  const per = {};
  const byK = new Map(rows.map((r) => [r.k, r]));
  for (const fld in plans) for (const [k, u] of plans[fld]) { const r = byK.get(k); if (r && r[fld] !== u) { const key = fld + ':' + (u || '-'); per[key] = (per[key] || 0) + 1; } }
  out.n = rows.length; out.per = per; out.miss = [...miss];
  if (b.dry) return out;
  if (rows.length > 20000) return { error: 'Quá nhiều khách một lần', code: 400 };
  out.changed = extra.bulk(() => { let c = 0; for (const r of rows) { const v = {}; for (const fld in plans) if (plans[fld].has(r.k)) v[fld] = plans[fld].get(r.k); if (Object.keys(v).length && extra.assign(r.k, v, me)) c++; } return c; });
  khCache.at = 0;
  return out;
}
function khDetail(u, user) {
  const r = khRows().find((x) => x.k === u);
  if (!r) return null;
  const c = Object.assign({}, r); delete c._q;
  // don 30 ngay gan nhat tu ban dong bo Gobiz
  let orders = [];
  try {
    dataFor('admin'); const b = cache.base || {}; const cust = b.cust || {};
    const idOf = Object.keys(cust).find((id) => String(cust[id][1] || '').toLowerCase() === u);
    if (idOf) {
      for (const o of b.orders || []) if (String(o.cid) === idOf) orders.push({ t: 'order', code: o.code, st: o.st, ca: o.ca, v: Math.round((Number(o.tv) || 0) * (Number(o.rate) || 0)), fee: o.fee, unpaid: o.unpaid, img: o.img, shop: o.shop, mk: o.mk });
      for (const s of b.ships || []) if (String(s.cid) === idOf) orders.push({ t: 'ship', code: s.code, st: s.st, ca: s.ca, fee: s.fee, unpaid: s.unpaid, img: s.img, wb: (s.wb || [])[0] || null, kg: s.aw });
    }
    for (const x of b.peer || []) if (String(x.cu || '').toLowerCase() === u) orders.push({ t: 'peer', code: x.code, st: x.st, ca: x.ca, cny: x.amount, v: x.xa, unpaid: x.unpaid, ppt: x.ppt, bn: x.bn });
  } catch (e) { console.error('khDetail', e); }
  orders.sort((a, b) => String(b.ca || '').localeCompare(String(a.ca || '')));
  let wallet = null;
  try { const w = cn.ledger.walletView(cn.fin(), u); if (w && (w.balance || w.creditLimit || w.held || w.pendingOrders)) wallet = w; } catch (e) {}
  const money = user.role !== 'kho';
  if (!money) { delete c.bal; delete c.unpaid; delete c.v90; wallet = null; orders = orders.map((o) => { const x = Object.assign({}, o); delete x.v; delete x.fee; delete x.unpaid; return x; }); }
  const staff = store.listUsers().filter((x) => x.active && ['admin', 'sale'].includes(x.role)).map((x) => ({ u: x.username, n: x.name }));
  return { c, orders: orders.slice(0, 200), notes: extra.notes(u), log: extra.log(u), wallet, staff, canEdit: user.role !== 'tc' };
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
// Anh chot 30/10: khong dung chu "no", dung chu "thieu" (Con no -> Con thieu, Cong no -> Khoan thieu)
function noDebt(t) {
  return t.replace(/Còn nợ/g, 'Còn thiếu').replace(/còn nợ/g, 'còn thiếu').replace(/Công nợ/g, 'Khoản thiếu').replace(/công nợ/g, 'khoản thiếu')
    .replace(/'Nợ '/g, "'Thiếu '").replace(/>Nợ</g, '>Thiếu<').replace(/tổng nợ/g, 'tổng thiếu').replace(/đơn nợ/g, 'đơn thiếu').replace(/Khách nợ/g, 'Khách thiếu').replace(/khách nợ/g, 'khách thiếu')
    .replace(/\|nợ\|/g, '|thiếu|').replace(/, nợ,/g, ', tiền thiếu,');
}
let vmtJsCache = { key: '', buf: null };
function vmtJs() {
  try { const f = path.join(PUBLIC, 'assets', 'vmt.js'); const key = String(fs.statSync(f).mtimeMs); if (vmtJsCache.key !== key) vmtJsCache = { key, buf: Buffer.from(noDebt(fs.readFileSync(f, 'utf8'))) }; return vmtJsCache.buf; } catch (e) { return null; }
}
function appHtml() {
  try {
    const f = path.join(PUBLIC, 'app.html'), sec = path.join(__dirname, 'ext', 'cn-section.html'), ksec = path.join(__dirname, 'ext', 'kh-section.html');
    const key = fs.statSync(f).mtimeMs + ':' + fs.statSync(sec).mtimeMs + ':' + fs.statSync(ksec).mtimeMs;
    if (appCache.key === key) return appCache.html;
    let h = fs.readFileSync(f, 'utf8');
    const a = "load('/assets/vmt.js')";
    const m = '      </main>\n\n      <!-- ============ DRAWER';
    if (h.includes(a) && h.includes(m)) {
      h = h.replace(a, "load('/assets/vmt.js').then(function () { return load('/ext/cn-admin.js'); }).then(function () { return load('/ext/kh-admin.js'); })");
      h = h.replace(m, fs.readFileSync(sec, 'utf8') + fs.readFileSync(ksec, 'utf8') + m);
    } else { console.error('cn-admin: khong tim thay cho chen trong app.html'); h = null; }
    if (h) h = noDebt(h);
    appCache = { key, html: h ? Buffer.from(h) : null };
    return appCache.html;
  } catch (e) { console.error(e); return null; }
}

// ---------- dinh tuyen ----------
async function handle(req, res) {
  const url = new URL(req.url, 'http://x');
  const p = url.pathname;

  if (p === '/healthz') return json(req, res, 200, { ok: true, version: VERSION, snapshot: (store.latestMeta() || {}).gen || null });
  // Trang do toc do tu xa (vd. tu Trung Quoc), khong can dang nhap
  if (p === '/speedtest' || p.startsWith('/speedtest/')) return speedtest.handle(req, res, p, url, clientIp(req));

  // May do tu dong kho TQ ban du lieu vao (ma bi mat nam trong duong dan). Chi luu tho, tra loi nhanh.
  const mdws = p.match(/^\/hook\/dws\/([A-Za-z0-9_-]{10,64})\/?$/);
  if (mdws) {
    if (!dws.checkToken(mdws[1])) return json(req, res, 404, { code: 404, success: false, msg: 'not found' });
    if (req.method === 'GET' && !url.search) return json(req, res, 200, { code: 200, success: true, msg: 'ok' });
    let body; try { body = await readBody(req, 30 * 1024 * 1024); } catch (e) { return json(req, res, e.code || 400, { code: 400, success: false, msg: 'body' }); }
    if (req.headers['content-encoding'] === 'gzip') { try { body = zlib.gunzipSync(body); } catch {} }
    let id; try { id = dws.save(req, body, url.search.slice(1), clientIp(req)); } catch (e) { console.error('dws', e); return json(req, res, 500, { code: 500, success: false, msg: 'save error' }); }
    return json(req, res, 200, { code: 200, success: true, msg: 'ok', id });
  }

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

  // Du lieu bo sung (van don / san pham / kien ky gui + danh sach khach Gobiz). Chu ky RSA giong /api/ingest.
  if (p === '/api/ingest2' && req.method === 'POST') {
    let body;
    try { body = await readBody(req, 80 * 1024 * 1024); } catch (e) { return json(req, res, e.code || 400, { error: 'body' }); }
    if (req.headers['content-encoding'] === 'gzip') { try { body = zlib.gunzipSync(body); } catch { return json(req, res, 400, { error: 'gzip' }); } }
    const ts = Number(req.headers['x-ts']); const sig = String(req.headers['x-sig'] || '');
    if (!ts || Math.abs(Date.now() - ts) > 15 * 60e3) return json(req, res, 401, { error: 'ts' });
    if (!(sig && crypto.verify('RSA-SHA256', Buffer.concat([Buffer.from(ts + '.'), body]), PUBKEY, Buffer.from(sig, 'base64')))) return json(req, res, 401, { error: 'sig' });
    let d; try { d = JSON.parse(body.toString('utf8')); } catch { return json(req, res, 400, { error: 'json' }); }
    try { const r = extra.ingest(d); store.logIngest(true, body.length, 'extra ' + r.ships + ' don, ' + r.cust + ' khach'); return json(req, res, 200, Object.assign({ ok: true }, r)); }
    catch (e) { console.error('ingest2', e); return json(req, res, 500, { error: 'save' }); }
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
  if (p === '/assets/vmt.js') { const b = vmtJs(); if (b) return send(res, 200, b, { 'Content-Type': 'text/javascript; charset=utf-8' }); }
  if (p.startsWith('/ext/vendor/') && /^[a-z0-9.-]+\.js$/.test(p.slice(12))) return fs.readFile(path.join(__dirname, 'ext', 'vendor', p.slice(12)), (err, buf) => err ? send(res, 404, '') : send(res, 200, buf, { 'Content-Type': 'text/javascript; charset=utf-8', 'Cache-Control': 'public, max-age=86400' }));
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

  // ---- Quan ly khach hang (ban Sale / CSKH) ----
  if (p === '/api/kh' || p.startsWith('/api/kh/')) {
    if (!user) return json(req, res, 401, { error: 'login' });
    if (!['admin', 'sale', 'tc'].includes(user.role)) return json(req, res, 403, { error: 'forbidden' });
    const by = user.username;
    if (req.method === 'GET' && p === '/api/kh') return json(req, res, 200, khList(url.searchParams, user));
    if (p === '/api/kh/staffcfg' && req.method === 'GET') return json(req, res, 200, { cfg: extra.staffCfg(), staff: khStaffList(), groups: [...new Set(khRows().map((r) => r.grp).filter(Boolean))].sort(), canEdit: user.role === 'admin' });
    if ((p === '/api/kh/staffcfg' || p === '/api/kh/assign') && req.method === 'POST') {
      if (!sameOrigin(req)) return json(req, res, 403, { error: 'origin' });
      if (user.role !== 'admin') return json(req, res, 403, { error: 'Chỉ anh (admin) được gán khách hàng loạt / đổi phân công brand' });
      let b = {}; try { b = JSON.parse((await readBody(req, 2e6)).toString() || '{}'); } catch { return json(req, res, 400, { error: 'Dữ liệu không hợp lệ' }); }
      if (p === '/api/kh/staffcfg') {
        const act = new Set(khStaffList().map((x) => x.u)), st = {};
        for (const u in (b.staff || {})) { if (!act.has(u)) continue; const x = b.staff[u] || {}; const brands = (Array.isArray(x.brands) ? x.brands : []).map(String).slice(0, 10); const kind = ['sale', 'cskh', 'both'].includes(x.kind) ? x.kind : 'sale'; if (brands.length) st[u] = { brands, kind }; }
        const old = extra.staffCfg(); extra.setStaffCfg({ staff: st, auto: !!b.auto, by: user.username, at: new Date().toISOString() });
        console.log('kh staffcfg by', user.username, JSON.stringify(old), '->', JSON.stringify(st));
        return json(req, res, 200, { ok: true, cfg: extra.staffCfg() });
      }
      const r = khAssign(b, user);
      return json(req, res, r.error ? r.code : 200, r.error ? { error: r.error } : r);
    }
    if (req.method === 'GET' && p === '/api/kh/todo') {
      const vn = (d) => new Date(Date.now() + 7 * 3600e3 + d * 86400e3).toISOString().slice(0, 10);
      const today = vn(0), me = user.username;
      const list = extra.reminders(vn(7)).map((r) => Object.assign(r, { due: r.remind.slice(0, 10) <= today, late: r.remind.slice(0, 10) < today, mine: r.by === me || r.sale === me || r.cskh === me }));
      const rows = khRows(), mineOf = (r) => r.sale === me || r.cskh === me;
      const cnt = (f) => rows.filter(f).length;
      const top = (f, key) => rows.filter(f).sort((a, b) => (Number(b[key]) || 0) - (Number(a[key]) || 0)).slice(0, 30).map((r) => ({ u: r.u, k: r.k, code: r.code, fn: r.fn, ph: r.ph, grp: r.grp, last: r.last, age: r.age, v90: user.role === 'kho' ? null : r.v90, unpaid: r.unpaid, bal: r.bal, sale: r.sale, cskh: r.cskh, nNote: r.nNote, lastNote: r.lastNote }));
      // khach sap roi: chi tieu 90 ngay lon truoc; uu tien khach chua co ghi cham soc 14 ngay
      const stale = (r) => !r.lastNote || r.lastNote.slice(0, 10) < vn(-14);
      return json(req, res, 200, {
        today, me, reminders: list, staff: store.listUsers().filter((x) => x.active && ['admin', 'sale'].includes(x.role)).map((x) => ({ u: x.username, n: x.name })),
        risk: top((r) => r.seg === 'risk' && stale(r), 'v90'), riskN: cnt((r) => r.seg === 'risk'), riskMine: cnt((r) => r.seg === 'risk' && mineOf(r)),
        debt: top((r) => (Number(r.unpaid) || 0) > 0, 'unpaid'), debtN: cnt((r) => (Number(r.unpaid) || 0) > 0),
        fresh: top((r) => r.isNew && !r.nNote, 'v90'), freshN: cnt((r) => r.isNew && !r.nNote),
        noOwner: cnt((r) => r.seg === 'active' && !r.sale && !r.cskh),
      });
    }
    const mk = p.match(/^\/api\/kh\/([^/]{1,80})(\/note(?:\/(\d+)\/done)?|\/owner)?$/);
    if (!mk) return json(req, res, 404, { error: 'not found' });
    const u = decodeURIComponent(mk[1]).toLowerCase();
    if (req.method === 'GET' && !mk[2]) { const r = khDetail(u, user); return r ? json(req, res, 200, r) : json(req, res, 404, { error: 'Không có khách này' }); }
    if (req.method !== 'POST' || !sameOrigin(req)) return json(req, res, 403, { error: 'origin' });
    if (user.role === 'tc') return json(req, res, 403, { error: 'Tài chính chỉ xem' });
    if (!extra.getCust(u) && !customers().some((c) => String(c.u).toLowerCase() === u)) return json(req, res, 404, { error: 'Không có khách này' });
    let b = {}; try { b = JSON.parse((await readBody(req, 10000)).toString() || '{}'); } catch { return json(req, res, 400, { error: 'Dữ liệu không hợp lệ' }); }
    let r;
    if (mk[2] === '/owner') r = extra.setOwner(u, b, by);
    else if (mk[3]) r = extra.doneNote(u, mk[3], by);
    else r = extra.addNote(u, b, by);
    if (r.error) return json(req, res, r.code || 400, { error: r.error });
    return json(req, res, 200, khDetail(u, user));
  }

  // ---- Ket noi: may do kho TQ + khoa Xport (chi admin) ----
  if (p === '/ket-noi' || p.startsWith('/api/dws/') || p === '/api/xport' || p === '/api/xport/test') {
    if (!user) { if (p === '/ket-noi') { res.writeHead(302, { Location: '/login' }); return res.end(); } return json(req, res, 401, { error: 'login' }); }
    if (user.role !== 'admin') return p === '/ket-noi' ? send(res, 403, 'Chỉ quản trị được vào trang này') : json(req, res, 403, { error: 'forbidden' });
    if (p === '/ket-noi') return fs.readFile(path.join(__dirname, 'connect.html'), (err, buf) => err ? send(res, 404, '') : send(res, 200, buf, { 'Content-Type': 'text/html; charset=utf-8' }));
    if (p === '/api/dws/info') return json(req, res, 200, dws.info(req.headers.host || 'saas.7zone.net'));
    if (p === '/api/dws/recent') return json(req, res, 200, { items: dws.recent(Math.min(200, Number(url.searchParams.get('limit')) || 50), String(url.searchParams.get('q') || '').slice(0, 60)) });
    if (p === '/api/dws/raw') {
      const r = dws.raw(Number(url.searchParams.get('id')));
      if (!r) return json(req, res, 404, { error: 'not found' });
      return send(res, 200, r.body || Buffer.alloc(0), { 'Content-Type': r.row.ctype || 'application/octet-stream', 'Content-Disposition': 'inline; filename="dws-' + r.row.id + '"' });
    }
    if (p === '/api/xport' && req.method === 'GET') return json(req, res, 200, xport.view());
    if (req.method !== 'POST' || !sameOrigin(req)) return json(req, res, 403, { error: 'origin' });
    if (p === '/api/xport') {
      let b; try { b = JSON.parse((await readBody(req, 5000)).toString()); } catch { return json(req, res, 400, { error: 'Dữ liệu không hợp lệ' }); }
      const r = xport.setCreds(b.accessKey, b.accessSecret, b.userId, user.username);
      if (r.error) return json(req, res, 400, r);
      store.kvSet('xport_sigmode', '');
      await xport.test();
      return json(req, res, 200, { ok: true, view: xport.view() });
    }
    if (p === '/api/xport/test') { await xport.test(); return json(req, res, 200, { ok: true, view: xport.view() }); }
  }

  // ---------- Ban Ship to China (don SCN tu trang khach) ----------
  if (p === '/cn') {
    if (!user) { res.writeHead(302, { Location: '/login' }); return res.end(); }
    return fs.readFile(path.join(__dirname, 'cn.html'), (err, buf) => err ? send(res, 500, 'Server error') : send(res, 200, buf, { 'Content-Type': 'text/html; charset=utf-8' }));
  }
  // Ma chuyen phat TQ tu Tai Loc (n8n doc tin nhan, ky RSA giong /api/ingest): { ref: SCN/ma doi chieu, wbCn }
  // ---- sao luu (chi admin) ----
  if (p === '/backup' || p.startsWith('/api/backup')) {
    if (!user) { if (p === '/backup') { res.writeHead(302, { Location: '/login' }); return res.end(); } return json(req, res, 401, { error: 'login' }); }
    if (user.role !== 'admin') return p === '/backup' ? send(res, 403, 'Chỉ quản trị được vào trang này') : json(req, res, 403, { error: 'forbidden' });
    if (p === '/backup') return fs.readFile(path.join(__dirname, 'backup.html'), (err, buf) => err ? send(res, 404, '') : send(res, 200, buf, { 'Content-Type': 'text/html; charset=utf-8' }));
    if (p === '/api/backup' && req.method === 'GET') return json(req, res, 200, backup.status());
    if (req.method !== 'POST' || !sameOrigin(req)) return json(req, res, 403, { error: 'origin' });
    if (p === '/api/backup/run') { const r = await backup.run(true); return json(req, res, r.error ? 500 : 200, Object.assign(r, { status: backup.status() })); }
    if (p === '/api/backup/config') {
      let b; try { b = JSON.parse((await readBody(req, 5000)).toString()); } catch { return json(req, res, 400, { error: 'Dữ liệu không hợp lệ' }); }
      const r = await backup.configure(b, user.username);
      console.log('backup config by', user.username, r.error ? 'FAIL ' + r.error : 'ok');
      return json(req, res, r.error ? 400 : 200, r);
    }
    return json(req, res, 404, { error: 'not found' });
  }
  // ---- n8n (ky RSA) day giao dich ngan hang vao vi moi / tao yeu cau nap tay (van can anh duyet) ----
  if ((p === '/api/fin/deposits' || p === '/api/fin/claude-request' || p === '/api/fin/deposit-flags' || p === '/api/fin/report') && req.method === 'POST') {
    let body; try { body = await readBody(req, 500000); } catch { return json(req, res, 400, { error: 'body' }); }
    const ts = Number(req.headers['x-ts']); const sig = String(req.headers['x-sig'] || '');
    if (!ts || Math.abs(Date.now() - ts) > 15 * 60e3) return json(req, res, 401, { error: 'ts' });
    if (!(sig && crypto.verify('RSA-SHA256', Buffer.concat([Buffer.from(ts + '.'), body]), PUBKEY, Buffer.from(sig, 'base64')))) return json(req, res, 401, { error: 'sig' });
    let b; try { b = JSON.parse(body.toString('utf8')); } catch { return json(req, res, 400, { error: 'json' }); }
    if (p === '/api/fin/report') { const r = cn.ledger.report(cn.fin()); const nm = {}; for (const c of customers()) nm[String(c.u).toLowerCase()] = c.u; for (const w of r.neg) w.khach = nm[w.owner] || w.owner; return json(req, res, 200, r); }
    if (p === '/api/fin/deposit-flags') { // co bat/tat Cuong (MC), Cao (L8) do luong Gobiz tinh theo so du vi
      const f = { MC: b.MC === 'tat' ? 'tat' : 'bat', L8: b.L8 === 'tat' ? 'tat' : 'bat', at: new Date().toISOString(), src: String(b.src || '').slice(0, 80) };
      store.kvSet('deposit_flags', JSON.stringify(f)); return json(req, res, 200, { ok: true, flags: f });
    }
    const db = cn.fin(), L = cn.ledger;
    if (p === '/api/fin/claude-request') {
      const owner = String(b.owner || '').toLowerCase();
      if (!customers().some((c) => String(c.u).toLowerCase() === owner)) return json(req, res, 400, { error: 'Không có khách này' });
      if (b.kind !== 'TOPUP_MANUAL') return json(req, res, 400, { error: 'Chỉ tạo được yêu cầu nạp tay' });
      const r = L.request(db, { kind: 'TOPUP_MANUAL', owner, amount: b.amount, note: String(b.note || ''), by: 'claude' });
      return json(req, res, r.error ? r.code : 200, r);
    }
    const gobizSet = new Set(customers().map((c) => String(c.u).toLowerCase()));
    const isLive = (owner) => { const u = db.prepare('SELECT note FROM users WHERE lower(gobiz) = ? LIMIT 1').get(owner); return u && String(u.note || '').startsWith('tai khoan test') ? 'test' : (store.kvGet('wallet_live') === '1'); };
    const out = [];
    for (const it of (Array.isArray(b.items) ? b.items : []).slice(0, 300)) { try { out.push(L.deposit(db, it, gobizSet, isLive)); } catch (e) { out.push({ ref: it && it.ref, status: 'error', error: String(e.message || e) }); } }
    // Nap va tra luon: sau khi cong vi, thu tra cac lenh dang cho cua khach vua nap
    const paidIntents = [];
    for (const x of out) if (x.status === 'credited') { const ow = (db.prepare('SELECT owner FROM deposits WHERE ref = ?').get(x.ref) || {}).owner; if (ow) { try { paidIntents.push(...L.intentsRun(db, ow, isLive(ow) === 'test')); } catch (e) { console.error('intent', e); } } }
    const al = L.alertsTake(db);
    const nm = {}; for (const c of customers()) nm[String(c.u).toLowerCase()] = c.u + (c.fn ? ' - ' + c.fn : '');
    for (const c of al.claims) c.khach = nm[c.owner] || c.owner;
    return json(req, res, 200, { ok: true, results: out.filter((x) => !x.dup), dup: out.filter((x) => x.dup).length, alerts: al, intents: paidIntents });
  }
  if (p === '/api/cn/track' && req.method === 'POST') {
    let body; try { body = await readBody(req, 20000); } catch { return json(req, res, 400, { error: 'body' }); }
    const ts = Number(req.headers['x-ts']); const sig = String(req.headers['x-sig'] || '');
    if (!ts || Math.abs(Date.now() - ts) > 15 * 60e3) return json(req, res, 401, { error: 'ts' });
    if (!(sig && crypto.verify('RSA-SHA256', Buffer.concat([Buffer.from(ts + '.'), body]), PUBKEY, Buffer.from(sig, 'base64')))) return json(req, res, 401, { error: 'sig' });
    let b; try { b = JSON.parse(body.toString('utf8')); } catch { return json(req, res, 400, { error: 'json' }); }
    const r = cn.track(String(b.ref || ''), String(b.wbCn || ''), String(b.eta || ''), { msgId: b.msgId || null, text: String(b.text || '').slice(0, 500) });
    if (r.error) return json(req, res, r.code, { error: r.error });
    return json(req, res, 200, { ok: true, code: r.order.code, status: r.order.status });
  }
  if (p.startsWith('/api/cn') && user && !(user.role in cn.CAN_EDIT)) return json(req, res, 403, { error: 'forbidden' });
  if (p === '/api/cn/scan' && req.method === 'POST') {
    if (!user) return json(req, res, 401, { error: 'login' });
    if (!sameOrigin(req)) return json(req, res, 403, { error: 'origin' });
    let b; try { b = JSON.parse((await readBody(req, 5000)).toString()); } catch { return json(req, res, 400, { error: 'Dữ liệu không hợp lệ' }); }
    const r = cn.scan(String(b.code || ''), String(b.mode || ''), user.role, user.username, !!b.force, b.ref ? String(b.ref) : '');
    if (r.error) return json(req, res, r.code, { error: r.error, missing: r.missing || null, order: r.order || null });
    return json(req, res, 200, { ok: true, order: r.order, result: r.result, missing: r.missing || [], warn: !!r.warn, needRef: !!r.needRef });
  }
  // ---- tai chinh: vi khach, han muc, yeu cau nap tay / dieu chinh / hoan (anh duyet) ----
  if (p.startsWith('/api/fin/')) {
    if (!user) return json(req, res, 401, { error: 'login' });
    if (!['admin', 'tc', 'sale'].includes(user.role)) return json(req, res, 403, { error: 'forbidden' });
    const L = cn.ledger, db = cn.fin(), by = 'staff:' + user.username;
    if (p === '/api/fin/wallets' && req.method === 'GET') {
      const cs = customers(); const names = cs.map((c) => String(c.u).toLowerCase());
      db.exec('BEGIN IMMEDIATE'); let rows;
      try { rows = cs.map((c) => { const o = String(c.u).toLowerCase(); return Object.assign({ u: c.u, gobizCode: c.code, fn: c.fn, code: L.codeOf(db, o, names) }, L.walletView(db, o)); }); db.exec('COMMIT'); }
      catch (e) { try { db.exec('ROLLBACK'); } catch {} throw e; }
      return json(req, res, 200, { items: rows, role: user.role, pending: L.requests(db, 'pending').length });
    }
    const mw = p.match(/^\/api\/fin\/wallet\/([^/]{1,80})$/);
    if (mw && req.method === 'GET') {
      const o = decodeURIComponent(mw[1]).toLowerCase();
      db.prepare('INSERT INTO wallet_log (owner, by, action, detail) VALUES (?, ?, ?, ?)').run(o, by, 'Xem ví', '{}');
      return json(req, res, 200, { wallet: L.walletView(db, o), txns: L.txnsOf(db, o, 200), log: db.prepare('SELECT * FROM wallet_log WHERE owner = ? ORDER BY ts DESC LIMIT 100').all(o) });
    }
    if (p === '/api/fin/accounts' && req.method === 'GET') return json(req, res, 200, { items: JSON.parse(store.kvGet('deposit_accounts') || '[]'), banks: require('./lib/vietqr').BANKS });
    if (p === '/api/fin/deposits' && req.method === 'GET') return json(req, res, 200, { items: L.deposits(db, url.searchParams.get('status') || '') });
    if (p === '/api/fin/report' && req.method === 'GET') { if (!['admin', 'tc'].includes(user.role)) return json(req, res, 403, { error: 'forbidden' }); return json(req, res, 200, L.report(db)); }
    if (p === '/api/fin/claims' && req.method === 'GET') { const nm = {}; for (const c of customers()) nm[String(c.u).toLowerCase()] = c.u + (c.fn ? ' - ' + c.fn : ''); return json(req, res, 200, { items: L.claims(db, url.searchParams.get('status') || 'open').map((c) => Object.assign(c, { khach: nm[c.owner] || c.owner, code: (db.prepare('SELECT code FROM cust_codes WHERE owner = ?').get(c.owner) || {}).code })) }); }
    if (p === '/api/fin/requests' && req.method === 'GET') return json(req, res, 200, { items: L.requests(db, url.searchParams.get('status') || '') });
    if (req.method !== 'POST' || !sameOrigin(req) || !/application\/json/.test(req.headers['content-type'] || '')) return json(req, res, 403, { error: 'origin' });
    let b; try { b = JSON.parse((await readBody(req, 5000)).toString()); } catch { return json(req, res, 400, { error: 'Dữ liệu không hợp lệ' }); }
    const owner = String(b.owner || '').toLowerCase();
    const known = () => customers().some((c) => String(c.u).toLowerCase() === owner);
    if (p === '/api/fin/credit') {
      if (user.role !== 'admin') return json(req, res, 403, { error: 'Chỉ anh (admin) được cấp hạn mức' });
      if (!known()) return json(req, res, 400, { error: 'Không có khách này' });
      const r = L.setCredit(db, owner, b.limit, b.days, by); return json(req, res, r.error ? r.code : 200, r);
    }
    if (p === '/api/fin/request') {
      if (!['admin', 'tc'].includes(user.role)) return json(req, res, 403, { error: 'Chỉ tài chính / admin được tạo yêu cầu' });
      if (!known()) return json(req, res, 400, { error: 'Không có khách này' });
      const r = L.request(db, { kind: String(b.kind || ''), owner, amount: b.amount, codes: b.codes, note: b.note, by }); return json(req, res, r.error ? r.code : 200, r);
    }
    if (p === '/api/fin/accounts') {
      if (user.role !== 'admin') return json(req, res, 403, { error: 'Chỉ anh (admin) được sửa tài khoản nhận tiền' });
      const Q = require('./lib/vietqr'); const items = [];
      for (const x of (Array.isArray(b.items) ? b.items : []).slice(0, 20)) {
        const it = { id: String(x.id || '').toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 10), label: String(x.label || '').trim().slice(0, 60), bank: String(x.bank || ''), acct: String(x.acct || '').replace(/\s/g, ''), holder: String(x.holder || '').trim().toUpperCase().slice(0, 60), active: !!x.active };
        if (!it.id || !it.label || !it.holder) return json(req, res, 400, { error: 'Mỗi tài khoản cần mã quỹ, tên hiển thị, tên chủ tài khoản' });
        try { Q.payload(it.bank, it.acct, 10000, 'TEST'); } catch (e) { return json(req, res, 400, { error: it.id + ': ' + e.message }); }
        if (items.some((y) => y.id === it.id)) return json(req, res, 400, { error: 'Trùng mã quỹ ' + it.id });
        items.push(it);
      }
      const old = store.kvGet('deposit_accounts') || '[]';
      store.kvSet('deposit_accounts', JSON.stringify(items));
      db.prepare('INSERT INTO wallet_log (owner, by, action, detail) VALUES (?, ?, ?, ?)').run('*', by, 'Sửa tài khoản nhận nạp tiền', JSON.stringify({ old: JSON.parse(old), new: items }));
      return json(req, res, 200, { ok: true, items });
    }
    if (p === '/api/fin/claim') {
      if (!['admin', 'tc'].includes(user.role)) return json(req, res, 403, { error: 'Chỉ tài chính / admin' });
      const r = L.claimResolve(db, b.id, b.action === 'reject' ? 'reject' : 'assign', String(b.ref || ''), by, String(b.note || '').slice(0, 200));
      return json(req, res, r.error ? r.code : 200, r);
    }
    if (p === '/api/fin/hold') {
      if (!['admin', 'tc'].includes(user.role)) return json(req, res, 403, { error: 'Chỉ tài chính / admin' });
      if (b.owner && !known()) return json(req, res, 400, { error: 'Không có khách này' });
      const r = L.resolveDeposit(db, String(b.ref || ''), b.action === 'ignore' ? 'ignore' : 'assign', owner, by, String(b.note || '').slice(0, 200));
      return json(req, res, r.error ? r.code : 200, r);
    }
    const md = p.match(/^\/api\/fin\/request\/(\d{1,9})\/(approve|reject)$/);
    if (md) {
      if (user.role !== 'admin') return json(req, res, 403, { error: 'Chỉ anh (admin) được duyệt' });
      const q = db.prepare('SELECT owner FROM fin_requests WHERE id = ?').get(Number(md[1]));
      const isTest = q && db.prepare('SELECT 1 FROM cn_orders WHERE lower(gobiz) = ? AND test = 1 LIMIT 1').get(q.owner);
      const r = L.decide(db, md[1], md[2] === 'approve', by, String(b.note || '').slice(0, 300), !!isTest, Array.isArray(b.bills) ? b.bills : []);
      return json(req, res, r.error ? r.code : 200, r);
    }
    return json(req, res, 404, { error: 'not found' });
  }
  const mtx = p.match(/^\/api\/cn\/(SCN\d{1,12})\/txns$/);
  if (mtx) { if (!user) return json(req, res, 401, { error: 'login' }); return json(req, res, 200, { items: ['kho', 'order'].includes(user.role) ? [] : cn.ledger.txnsOfOrder(cn.fin(), mtx[1]) }); }
  if (p === '/api/cn/customers') {
    if (!user) return json(req, res, 401, { error: 'login' });
    const q = norm(url.searchParams.get('q') || ''); if (q.length < 2) return json(req, res, 200, { items: [] });
    const items = customers().filter((c) => c._q.includes(q)).slice(0, 20).map((c) => ({ u: c.u, code: c.code, fn: c.fn }));
    return json(req, res, 200, { items });
  }
  const mcc = p.match(/^\/api\/cn\/customers\/([^/]{1,80})\/companies$/);
  if (mcc) { if (!user) return json(req, res, 401, { error: 'login' }); return json(req, res, 200, { items: cn.companiesOf(decodeURIComponent(mcc[1])) }); }
  if (p === '/api/cn/create' && req.method === 'POST') {
    if (!user) return json(req, res, 401, { error: 'login' });
    if (!['admin', 'sale', 'tc', 'kho'].includes(user.role)) return json(req, res, 403, { error: 'Không có quyền tạo đơn' });
    if (!sameOrigin(req) || !/application\/json/.test(req.headers['content-type'] || '')) return json(req, res, 403, { error: 'origin' });
    let b; try { b = JSON.parse((await readBody(req, 50000)).toString()); } catch { return json(req, res, 400, { error: 'Dữ liệu không hợp lệ' }); }
    const c = customers().find((x) => String(x.u).toLowerCase() === String(b.customer || '').toLowerCase());
    if (!c) return json(req, res, 400, { error: 'Chọn khách hàng trong danh sách' });
    const r = cn.create(user.username, c, b, clientIp(req));
    if (r.error) return json(req, res, r.code, { error: r.error });
    return json(req, res, 200, { ok: true, order: r.order });
  }
  if (p === '/api/cn/upload' && req.method === 'POST') {
    if (!user) return json(req, res, 401, { error: 'login' });
    if (!sameOrigin(req) || req.headers['content-type'] !== 'image/jpeg') return json(req, res, 403, { error: 'origin' });
    let buf; try { buf = await readBody(req, 3 * 1024 * 1024); } catch { return json(req, res, 413, { error: 'Ảnh phải nhỏ hơn 3MB' }); }
    const r = cn.uploadSave(user.username, buf);
    if (r.error) return json(req, res, 400, { error: r.error });
    return json(req, res, 200, { ok: true, id: r.id });
  }
  const mimg = p.match(/^\/cnimg\/([a-f0-9]{32})\.jpg$/);
  if (mimg) {
    if (!user || !cn.uploadExists(mimg[1])) return send(res, 404, 'Not found');
    return fs.readFile(cn.uploadPath(mimg[1]), (err, buf) => err ? send(res, 404, 'Not found') : send(res, 200, buf, { 'Content-Type': 'image/jpeg', 'Cache-Control': 'private, max-age=86400' }));
  }
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
    if (url.searchParams.get('event') === 'print' && req.method === 'POST') { cn.event(mcn[1], 'staff:' + user.username, 'In tem mã vạch', {}); return json(req, res, 200, { ok: true }); }
    if (req.method !== 'POST') return json(req, res, 405, { error: 'method' });
    if (!sameOrigin(req) || !/application\/json/.test(req.headers['content-type'] || '')) return json(req, res, 403, { error: 'origin' });
    let b; try { b = JSON.parse((await readBody(req, 20000)).toString()); } catch { return json(req, res, 400, { error: 'Dữ liệu không hợp lệ' }); }
    const r = cn.update(mcn[1], user.role, user.username, b);
    if (r.error) return json(req, res, r.code, { error: r.error });
    return json(req, res, 200, { ok: true, order: r.order });
  }

  if (p === '/ext/kh-admin.js') {
    if (!user) return send(res, 401, '', { 'Content-Type': 'text/javascript' });
    return fs.readFile(path.join(__dirname, 'ext', 'kh-admin.js'), (err, buf) => err ? send(res, 404, '') : send(res, 200, buf, { 'Content-Type': 'text/javascript; charset=utf-8' }));
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
