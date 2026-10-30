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
const price = require('./lib/price');

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
  const tag = 'tai khoan test ' + (TEST.pick || 1); // doi "pick" trong test-user.json -> chon lai khach
  let g = TEST.gobiz && TEST.gobiz !== 'auto' ? TEST.gobiz : (cur && cur.gobiz !== 'auto' && cur.note === tag ? cur.gobiz : null);
  if (!g && idx.index) g = busiest(idx.index, TEST.group || 'default');
  store.upsertTest(TEST.username, g || 'auto', TEST.hash, g ? tag : 'tai khoan test');
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
    username: user.username, gobiz: user.gobiz, test: String(user.note || '').startsWith('tai khoan test'),
    name: (c && c.fn) || user.gobiz, code: (c && c.code) || '', balance: c ? Number(c.bal) : null, brand,
  };
  const cn = store.cnList(user.username).map((o) => Object.assign(o, { mine: true }));
  const companies = store.coList(user.username);
  const data = { companies, orders: s ? s.orders : [], shipments: s ? s.shipments : [], peer: s ? s.peer : [], cn, pulledAt: ix ? ix.gen : null, from: ix ? ix.from : null };
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

// ---------- kiem tra don Ship to China ----------
const CN_CATS = Object.keys(price.CLASSES);
const CN_METHODS = ['express_shipping', 'standard_shipping', 'eco_shipping'];
const CN_SVCS = ['insurance', 'reinforce'];
const str = (v, max) => String(v == null ? '' : v).replace(/[\u0000-\u001f\u007f]/g, ' ').trim().slice(0, max);
// Kiem tra thong tin doanh nghiep. MST Viet Nam: 10 so, hoac 10 so + '-' + 3 so (chi nhanh)
function checkCo(b) {
  const co = { name: str(b.name, 200), taxId: str(b.taxId, 20).replace(/\s/g, ''), addr: str(b.addr, 300), email: str(b.email, 120).toLowerCase() };
  if (/^\d{13}$/.test(co.taxId)) co.taxId = co.taxId.slice(0, 10) + '-' + co.taxId.slice(10);
  if (!co.name) return { error: 'cần tên công ty' };
  if (!/^\d{10}(-\d{3})?$/.test(co.taxId)) return { error: 'mã số thuế phải là 10 số (hoặc 10 số-3 số với chi nhánh)' };
  if (!co.addr) return { error: 'cần địa chỉ công ty' };
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(co.email)) return { error: 'email nhận hoá đơn không hợp lệ' };
  return { co };
}
function validateCn(b) {
  if (!b || typeof b !== 'object') return { error: 'Dữ liệu không hợp lệ' };
  const lot = str(b.lot, 80), cat = str(b.cat, 40), rname = str(b.rname, 60), rphone = str(b.rphone, 20), raddr = str(b.raddr, 300), note = str(b.note, 500);
  if (!lot || !rname || !raddr) return { error: 'Thiếu tên lô, tên hoặc địa chỉ người nhận' };
  if (!CN_CATS.includes(cat)) return { error: 'Chọn loại hàng' };
  if (!/^[+0-9 ()-]{6,20}$/.test(rphone)) return { error: 'Số điện thoại người nhận không hợp lệ' };
  const wh = b.wh === 'HN' ? 'HN' : b.wh === 'HCM' ? 'HCM' : null; if (!wh) return { error: 'Chọn kho gửi hàng' };
  const method = CN_METHODS.includes(b.method) ? b.method : null; if (!method) return { error: 'Chọn hình thức vận chuyển' };
  const svcs = Array.isArray(b.svcs) ? [...new Set(b.svcs.filter((x) => CN_SVCS.includes(x)))] : [];
  if (!Array.isArray(b.items) || !b.items.length || b.items.length > 50) return { error: 'Cần 1–50 dòng sản phẩm' };
  const items = [];
  for (const i of b.items) {
    const name = str(i && i.name, 120), qty = Math.floor(Number(i && i.qty)), price = Math.floor(Number(i && i.price) || 0);
    if (!name || !(qty >= 1 && qty <= 1000000) || !(price >= 0 && price <= 1e11)) return { error: 'Dòng sản phẩm cần tên và số lượng hợp lệ' };
    items.push({ name, qty, price });
  }
  const wbs = Array.isArray(b.wb) ? [...new Set(b.wb.map((w) => str(w, 40).toUpperCase()).filter((w) => /^[A-Z0-9-]{4,40}$/.test(w)))].slice(0, 20) : [];
  const estW = b.estW === '' || b.estW == null ? null : Number(b.estW);
  if (estW !== null && !(estW > 0 && estW <= 100000)) return { error: 'Cân nặng ước tính không hợp lệ' };
  const estDims = Array.isArray(b.estDims) && b.estDims.length === 3 && b.estDims.every((x) => Number(x) > 0 && Number(x) <= 1000) ? b.estDims.map(Number) : null;
  const value = items.reduce((a, i) => a + i.qty * i.price, 0);
  const vat = !!b.vat;
  let inv = null;
  if (vat) {
    const c = checkCo({ name: b.invCompany, taxId: b.invTax, addr: b.invAddr, email: b.invEmail });
    if (c.error) return { error: 'Lấy VAT: ' + c.error };
    inv = { company: c.co.name, taxId: c.co.taxId, addr: c.co.addr, email: c.co.email };
  }
  const est = estW || estDims ? price.quote({ cls: cat, method, weight: estW, dims: estDims, value, insurance: svcs.includes('insurance'), origin: wh, vat }) : null;
  const now = new Date().toISOString();
  return { data: {
    vat, inv, estW, estDims, est: est && est.ok ? { cw: est.cw, fee: est.customer, lines: est.lines } : null,
    note: lot, cat, recvName: rname, recvPhone: rphone, recvAddr: raddr, note2: note || null, wh, to: 'TQ', svcs,
    items, wbs, wb: wbs.join(', ') || null, w: null, nw: null, dw: null, pk: null, fee: null, paid: 0, unpaid: 0, refund: null,
    value,
    fees: [{ t: method, prov: null, act: null, q: null, p: null, free: false }].concat(svcs.map((t) => ({ t, prov: null, act: null, q: null, p: null, free: false }))),
    ms: [{ t: now, s: 'PENDING' }],
  } };
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
  if (p === '/api/cn' && req.method === 'POST') {
    if (!user) return json(req, res, 401, { error: 'login' });
    if (!sameOrigin(req) || !/application\/json/.test(req.headers['content-type'] || '')) return json(req, res, 403, { error: 'origin' });
    let b; try { b = JSON.parse((await readBody(req, 50000)).toString()); } catch { return json(req, res, 400, { error: 'Dữ liệu không hợp lệ' }); }
    if (b.vat && b.companyId) { // chon cong ty da luu: lay thong tin tu DB, khong tin du lieu gui len
      const co = store.coGet(user.username, b.companyId);
      if (!co) return json(req, res, 400, { error: 'Công ty xuất VAT không còn trong danh sách, chọn lại' });
      Object.assign(b, { invCompany: co.name, invTax: co.taxId, invAddr: co.addr, invEmail: co.email });
    }
    const v = validateCn(b);
    if (v.error) return json(req, res, 400, { error: v.error });
    if (store.cnCountRecent(user.username) >= 20) return json(req, res, 429, { error: 'Tạo quá nhiều đơn trong 1 giờ, vui lòng thử lại sau' });
    let saved = null;
    if (v.data.vat && !b.companyId && b.saveCompany) {
      const r = store.coSave(user.username, { name: v.data.inv.company, taxId: v.data.inv.taxId, addr: v.data.inv.addr, email: v.data.inv.email, from: 'tao-don' }, clientIp(req));
      if (r.co) { saved = r.co; v.data.inv.coId = r.co.id; }
    } else if (v.data.vat && b.companyId) v.data.inv.coId = Number(b.companyId);
    const o = store.cnCreate(user.username, user.gobiz, String(user.note || '').startsWith('tai khoan test'), v.data, clientIp(req));
    return json(req, res, 200, { ok: true, order: Object.assign(o, { mine: true }), companies: saved ? store.coList(user.username) : undefined });
  }
  if (p === '/api/companies') {
    if (!user) return json(req, res, 401, { error: 'login' });
    if (req.method !== 'POST') return json(req, res, 200, { items: store.coList(user.username) });
    if (!sameOrigin(req) || !/application\/json/.test(req.headers['content-type'] || '')) return json(req, res, 403, { error: 'origin' });
    let b; try { b = JSON.parse((await readBody(req, 5000)).toString()); } catch { return json(req, res, 400, { error: 'Dữ liệu không hợp lệ' }); }
    const c = checkCo(b);
    if (c.error) return json(req, res, 400, { error: 'Thông tin doanh nghiệp: ' + c.error });
    const r = store.coSave(user.username, Object.assign(c.co, { id: b.id || null, isDefault: !!b.isDefault }), clientIp(req));
    if (r.error) return json(req, res, r.code, { error: r.error });
    return json(req, res, 200, { ok: true, co: r.co, existed: !!r.existed, items: store.coList(user.username) });
  }
  const mco = p.match(/^\/api\/companies\/(\d{1,9})\/(delete|default)$/);
  if (mco && req.method === 'POST') {
    if (!user) return json(req, res, 401, { error: 'login' });
    if (!sameOrigin(req)) return json(req, res, 403, { error: 'origin' });
    if (mco[2] === 'delete') { const r = store.coDelete(user.username, mco[1], clientIp(req)); if (r.error) return json(req, res, r.code, { error: r.error }); }
    else { const co = store.coGet(user.username, mco[1]); if (!co) return json(req, res, 404, { error: 'Không tìm thấy công ty' }); store.coSave(user.username, Object.assign(co, { isDefault: true }), clientIp(req)); }
    return json(req, res, 200, { ok: true, items: store.coList(user.username) });
  }
  if (p === '/api/notif') {
    if (!user) return json(req, res, 401, { error: 'login' });
    if (req.method === 'POST') { if (!sameOrigin(req)) return json(req, res, 403, { error: 'origin' }); store.notifRead(user.username); return json(req, res, 200, { ok: true }); }
    return json(req, res, 200, { items: store.notifList(user.username) });
  }
  if (p === '/api/cn/quote' && req.method === 'POST') {
    if (!user) return json(req, res, 401, { error: 'login' });
    let b; try { b = JSON.parse((await readBody(req, 5000)).toString()); } catch { return json(req, res, 400, { error: 'Dữ liệu không hợp lệ' }); }
    const dims = Array.isArray(b.dims) ? b.dims.slice(0, 3) : null;
    return json(req, res, 200, price.quote({ cls: String(b.cls || ''), method: String(b.method || ''), weight: Number(b.weight) || 0, dims, value: Number(b.value) || 0, insurance: !!b.insurance, origin: b.origin === 'HCM' ? 'HCM' : 'HN', vat: !!b.vat }));
  }
  const mc = p.match(/^\/api\/cn\/(SCN\d{1,12})\/cancel$/);
  if (mc && req.method === 'POST') {
    if (!user) return json(req, res, 401, { error: 'login' });
    if (!sameOrigin(req)) return json(req, res, 403, { error: 'origin' });
    const r = store.cnCancel(user.username, mc[1], clientIp(req));
    if (r.error) return json(req, res, r.code, { error: r.error });
    return json(req, res, 200, { ok: true, order: Object.assign(r.order, { mine: true }) });
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
