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
const ledger = require('./lib/ledger');
const webpush = require('./lib/webpush');
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
// Khach that cho xem thu (khach-thu.json = danh sach username Gobiz): tu tao mat khau qua email Gobiz, xem don cua chinh ho,
// nhan thong bao khi don doi trang thai; don tao tren web moi danh dau test; vi moi khoa. Xoa khoi file -> tai khoan bi khoa.
let TRIAL = new Set();
try { TRIAL = new Set(JSON.parse(fs.readFileSync(path.join(__dirname, 'khach-thu.json'), 'utf8')).map((x) => String((x && x.username) || '').trim().toLowerCase()).filter(Boolean)); } catch {}
store.syncTrial(TRIAL);
const isTestAcc = (u) => /^(tai khoan test|khach thu)/.test(String((u && u.note) || '')); // don tao ra la don thu
const walletAcc = (u) => String((u && u.note) || '').startsWith('tai khoan test'); // vi moi: chi tai khoan test noi bo

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
    kindOf = new Map();
    for (const v of idx.index.byUser.values()) { for (const x of v.orders) kindOf.set(x.code, 'order'); for (const x of v.shipments) kindOf.set(x.code, 'ship'); for (const x of v.peer) kindOf.set(x.code, 'peer'); }
    try { gzwatch.run(store, idx.index.byUser, store.watchUsers(), store.shipWb); } catch (e) { console.error('gzwatch', e.message); }
  }
  return idx.index;
}
// Ma don -> loai (de link thong bao mo dung trang chi tiet)
let kindOf = new Map();
const gzwatch = require('./lib/gzwatch');
// Snapshot Gobiz moi ~15 phut: kiem tra moi phut de bao khach som (khong can ai mo web)
setInterval(() => { try { index(); } catch (e) { console.error('index', e.message); } }, 60e3).unref();
setInterval(() => { try { store.watchPurge(); } catch {} }, 24 * 3600e3).unref();
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
  // ogTitle / ogDesc: chu hien khi chia se link (Zalo, Facebook…) — slogan anh chot 31/10/2026
  green: { name: 'Vominhthien', tag: 'Logistics', host: 'app.vominhthien.com', ogTitle: 'Vominhthien Logistics', ogDesc: 'Nền tảng mua hàng tận xưởng, ký gửi tận kho cho mọi nhà kinh doanh' },
  yellow: { name: 'VMT Global', tag: 'Cùng nhau tiến bước', host: 'app.vmtglobal.com', ogTitle: 'VMT Global', ogDesc: 'Thương mại Trung - Việt · Giải pháp toàn diện' },
};
const hostBrand = (req) => (/vmtglobal/i.test(req.headers.host || '') ? 'yellow' : 'green');

// ---------- cai app (PWA) ----------
const PWA_COLOR = { green: { bg: '#e2e9df', theme: '#0f1922' }, yellow: { bg: '#eee9df', theme: '#172530' } };
function manifest(b) {
  return JSON.stringify({
    id: '/', name: BRAND[b].name, short_name: BRAND[b].name, description: 'Đặt hàng, ký gửi, thanh toán hộ, theo dõi đơn',
    lang: 'vi', start_url: '/?src=app', scope: '/', display: 'standalone', orientation: 'portrait',
    background_color: PWA_COLOR[b].bg, theme_color: PWA_COLOR[b].theme,
    icons: [
      { src: '/pwa/icon-192.png', sizes: '192x192', type: 'image/png', purpose: 'any' },
      { src: '/pwa/icon-512.png', sizes: '512x512', type: 'image/png', purpose: 'any' },
      { src: '/pwa/icon-mask-512.png', sizes: '512x512', type: 'image/png', purpose: 'maskable' },
    ],
  });
}
function pwaFile(req, res, name) {
  const b = hostBrand(req);
  const map = { 'icon-192.png': '192', 'icon-512.png': '512', 'icon-mask-512.png': 'mask-512', 'apple-touch-icon.png': '180' };
  if (!map[name]) return send(res, 404, 'Not found');
  fs.readFile(path.join(__dirname, 'pwa', b + '-' + map[name] + '.png'), (err, buf) => err ? send(res, 404, 'Not found') : send(res, 200, buf, { 'Content-Type': 'image/png', 'Cache-Control': 'public, max-age=604800' }));
}
const PWA_EVENTS = new Set(['shown', 'install_click', 'installed', 'dismissed', 'later', 'standalone', 'open_browser']);
function pwaInit() {
  store.rawDb().exec("CREATE TABLE IF NOT EXISTS pwa_log (id INTEGER PRIMARY KEY AUTOINCREMENT, username TEXT, event TEXT NOT NULL, platform TEXT, ua TEXT, created_at TEXT DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')))");
}
pwaInit();
webpush.init(store.rawDb());
// ---- Chat theo don (khach <-> nhan vien), xem lib/chat.js ----
const chatk = require('./lib/chatk');
store.rawDb().exec(`CREATE TABLE IF NOT EXISTS login_creds (cred_id TEXT PRIMARY KEY, username TEXT NOT NULL, jwk TEXT NOT NULL, count INTEGER NOT NULL DEFAULT 0, label TEXT, created_at TEXT DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')), last_used TEXT, disabled INTEGER NOT NULL DEFAULT 0)`);
// Day thong bao chuong len dien thoai (quet bang notif 20 giay/lan; admin cung ghi vao bang nay)
const PUSH_TITLE = { order: 'Đơn hàng', money: 'Tài chính', support: 'Hỗ trợ', system: 'Thông báo' };
setInterval(() => webpush.pump(
  (code) => (code && /^DUYET-\d+$/.test(code) ? '/duyet/' + code.slice(6) : code && /^SCN\d+$/.test(code) ? '/#don/cn/' + code : code && kindOf.has(code) ? '/#don/' + kindOf.get(code) + '/' + encodeURIComponent(code) : '/#tong-quan'),
  (n) => PUSH_TITLE[notifKind(n).kind] || 'Thông báo'), 20000).unref();
// Thong ke cai app chi giu 180 ngay
const pwaPurge = () => { try { store.rawDb().prepare("DELETE FROM pwa_log WHERE created_at < strftime('%Y-%m-%dT%H:%M:%fZ','now','-180 days')").run(); } catch {} };
pwaPurge(); setInterval(pwaPurge, 24 * 3600e3).unref();
// ---- AI (Gemini): dien form tu tin nhan / anh + dich ten hang sang tieng Trung ----
const ai = require('./lib/ai');
// Khach duyet anh kiem hang do kho TQ gui (doc DB admin, tra loi qua may chu admin)
const duyet = require('./lib/duyet');
duyet.init(store.adminKv);
ai.init(store.adminKv);
const ks = require('./lib/ks');
ks.init(store.rawDb(), store.adminKv);
store.rawDb().exec("CREATE TABLE IF NOT EXISTS ai_log (id INTEGER PRIMARY KEY AUTOINCREMENT, username TEXT, kind TEXT, ok INTEGER, ms INTEGER, imgs INTEGER, created_at TEXT DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')))");
const aiLog = (u, kind, ok, ms, imgs) => { try { store.rawDb().prepare('INSERT INTO ai_log (username, kind, ok, ms, imgs) VALUES (?, ?, ?, ?, ?)').run(u, kind, ok ? 1 : 0, ms, imgs || 0); } catch {} };
const aiPurge = () => { try { store.rawDb().prepare("DELETE FROM ai_log WHERE created_at < strftime('%Y-%m-%dT%H:%M:%fZ','now','-90 days')").run(); } catch {} };
aiPurge(); setInterval(aiPurge, 24 * 3600e3).unref();
const aiCount = (u) => store.rawDb().prepare("SELECT COUNT(*) AS n FROM ai_log WHERE username = ? AND created_at > strftime('%Y-%m-%dT%H:%M:%fZ','now','-1 hour')").get(u).n;
// Don thieu ten tieng Trung (khach / nhan vien go tay): tu dich nen, 10 phut/lan, moi lan toi da 5 don
let zhBusy = false;
async function zhPump() {
  if (zhBusy || !ai.ready()) return; zhBusy = true;
  try {
    for (const o of store.cnMissingZh(5)) {
      const names = [...new Set(o.items.filter((i) => i && i.name && !i.nameZh).map((i) => i.name))];
      const t0 = Date.now(); const r = await ai.toZh(names);
      aiLog('he-thong', 'zh', !r.error, Date.now() - t0, 0);
      const map = {}; if (r.ok) names.forEach((n, k) => { if (r.zh[k]) map[n] = r.zh[k]; });
      store.cnSetZh(o.code, map, !!r.ok);
    }
  } catch (e) { console.error('zhPump', e.message); } finally { zhBusy = false; }
}
setTimeout(zhPump, 60e3).unref(); setInterval(zhPump, 10 * 60e3).unref();
try { store.rawDb().exec('ALTER TABLE notif ADD COLUMN kind TEXT'); } catch {} // loai thong bao ghi thang (neu noi ghi co truyen)
// Phan loai thong bao cho cac tab: order | money | support | system; act = can khach lam gi do
function notifKind(n) {
  const t = String(n.text || '').toLowerCase();
  const act = /cần thanh toán|thanh toán thêm|chưa thanh toán|xem và thanh toán|cần anh\/chị|xác nhận|đồng ý|lấy hàng tại kho/.test(t);
  let kind = n.kind;
  if (!kind) {
    if (/phiếu hỗ trợ|khiếu nại|ticket/.test(t)) kind = 'support';
    else if (/^đã nhận .*vào ví|rút tiền|nạp tiền|khoản chuyển|^đã thanh toán|được hoàn|hoàn .* về ví|mã giao dịch|tín dụng|số dư/.test(t)) kind = 'money';
    else if (n.code) kind = 'order';
    else kind = 'system';
  }
  return { kind, act };
}

const owner = (user) => String(user.gobiz || user.username).toLowerCase();
// Chu cuoc chat: khach that = ma Gobiz; tai khoan test noi bo = chinh username (khong lan vao chat cua khach that dang muon du lieu)
const chatOwner = (user) => (walletAcc(user) ? 'test:' + user.username : owner(user));
// Ma don cua khach -> loai (de mo chat theo don): don Gobiz + Ship to China + ky gui moi. Nho 30 giay / tai khoan.
const myOrdCache = new Map();
function myOrders(user) {
  const c = myOrdCache.get(user.username); if (c && Date.now() - c.at < 30e3) return c.m;
  const m = new Map(); const ix = index(); const s = ix ? ix.byUser.get(String(user.gobiz).toLowerCase()) : null;
  if (s) { for (const x of s.orders) m.set(x.code, { k: 'order' }); for (const x of s.shipments) m.set(x.code, { k: 'ship' }); for (const x of s.peer) m.set(x.code, { k: 'peer' }); }
  for (const x of store.cnList(user.username, user.gobiz)) m.set(x.code, { k: 'cn' });
  try { for (const x of ks.list(user.username, user.gobiz, { group: custGroup(user) })) m.set(x.code, { k: 'ship' }); } catch (e) {}
  myOrdCache.set(user.username, { at: Date.now(), m });
  if (myOrdCache.size > 2000) myOrdCache.clear();
  return m;
}
function custGroup(user) { const ix = index(); const x = ix ? ix.byUser.get(String(user.gobiz).toLowerCase()) : null; return (x && x.cust && x.cust.grp) || ''; }
function gobizNames() { const ix = index(); return ix ? [...ix.byUser.keys()] : []; }
function payload(user) {
  const ix = index();
  const s = ix ? ix.byUser.get(String(user.gobiz).toLowerCase()) : null;
  const c = s && s.cust;
  const brand = c ? brandOf(c.grp) : 'green';
  const me = {
    username: user.username, gobiz: user.gobiz, test: isTestAcc(user),
    name: (c && c.fn) || user.gobiz, gobizCode: (c && c.code) || '', balance: c ? Number(c.bal) : null, brand,
  };
  // Ma khach moi (= ma nap tien), tach khoi Gobiz. Vi moi: tam thoi chi bat cho tai khoan test.
  me.code = ledger.codeOf(store.rawDb(), owner(user), gobizNames());
  me.walletOn = walletAcc(user);
  me.chatUnread = chatk.unread(user);
  me.ai = ai.ready();
  me.appInstalled = !!store.rawDb().prepare("SELECT 1 FROM pwa_log WHERE username = ? AND event IN ('standalone','installed') LIMIT 1").get(user.username);
  if (me.walletOn) { me.wallet = ledger.walletView(store.rawDb(), owner(user)); me.hasPin = ledger.hasPin(store.rawDb(), owner(user)); }
  const cn = store.cnList(user.username, user.gobiz).map((o) => Object.assign(o, { mine: true }));
  // Ky gui he thong moi (ma 84…) gop vao danh sach ky gui cung don Gobiz; dia chi kho TQ kem ma khach
  me.grp = (c && c.grp) || ''; me.kh = me.code || owner(user); // ky hieu tren kien = MA KHACH (khach ghi username van nhan duoc)
  me.khUser = owner(user); me.ksDef = ks.getDefault(me.khUser);
  const ksNew = ks.list(user.username, user.gobiz, { group: me.grp });
  me.whCn = ks.warehouses().filter((w) => w.active !== false).map((w) => Object.assign(ks.whView(w, null, me.grp), { type: w.type }));
  const companies = store.coList(user.username);
  // Ma van don don ky gui Gobiz (luong n8n bo sung -> bang gz_ship_x cua admin)
  const gship = s ? s.shipments.map((x) => { const w = store.shipWb(x.code); return w.length ? Object.assign({}, x, { wb: w[0], wbs: w }) : x; }) : [];
  const approvals = duyet.pending(owner(user)); // kho TQ gui anh can khach xac nhan
  const data = { approvals, companies, orders: s ? s.orders : [], shipments: ksNew.concat(gship), peer: s ? s.peer : [], cn, pulledAt: ix ? ix.gen : null, from: ix ? ix.from : null };
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
function loginPage(req, res, file) {
  fs.readFile(path.join(__dirname, file || 'login.html'), 'utf8', (err, html) => {
    if (err) return send(res, 500, 'Server error');
    const b = hostBrand(req);
    const B = BRAND[b];
    send(res, 200, html.replaceAll('{{BRAND}}', b).replaceAll('{{NAME}}', B.name).replaceAll('{{OGTITLE}}', B.ogTitle).replaceAll('{{OGDESC}}', B.ogDesc).replaceAll('{{TAG}}', B.tag).replaceAll('{{HOST}}', B.host), { 'Content-Type': 'text/html; charset=utf-8' });
  });
}

// Email tao mat khau. Link chi ve dung ten mien cua minh (khong tin Host tu trinh duyet)
const mail = require('./lib/mail');
mail.init({ kvGet: store.adminKv, kvSet: () => {} }); // cau hinh SMTP nhap o admin /ket-noi; trang khach chi doc
const HOSTS = ['app.vominhthien.com', 'app.vmtglobal.com'];
function linkHost(req) {
  const h = String(req.headers.host || '').toLowerCase();
  if (HOSTS.includes(h)) return 'https://' + h;
  if (process.env.NODE_ENV !== 'production' && /^localhost:\d+$/.test(h)) return 'http://' + h;
  return 'https://' + HOSTS[0];
}
const maskEmail = (e) => { const [a, d] = String(e).split('@'); return (a.length <= 2 ? a[0] + '*' : a.slice(0, 2) + '***') + '@' + d; };
const escH = (t) => String(t).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
function pwMailText(g, bn, link) {
  return 'Chào ' + (g.fn || g.u) + ',\n\n' + bn + ' vừa chuyển sang hệ thống mới. Anh/chị bấm link dưới đây để tạo mật khẩu cho tài khoản ' + g.u + ':\n\n' + link +
    '\n\nLink dùng được 1 lần, trong 30 phút. Tạo xong là đăng nhập được ngay, đơn hàng cũ vẫn đầy đủ.\n\nNếu anh/chị không yêu cầu thì cứ bỏ qua email này, tài khoản vẫn an toàn.\n\n' + bn;
}
function pwMailHtml(g, bn, link) {
  return '<div style="font-family:Arial,sans-serif;font-size:15px;line-height:1.6;color:#1d2a33;max-width:520px">' +
    '<p>Chào ' + escH(g.fn || g.u) + ',</p><p>' + escH(bn) + ' vừa chuyển sang hệ thống mới. Anh/chị bấm nút dưới đây để tạo mật khẩu cho tài khoản <b>' + escH(g.u) + '</b>:</p>' +
    '<p style="margin:24px 0"><a href="' + escH(link) + '" style="background:#379e1a;color:#fff;text-decoration:none;padding:12px 22px;border-radius:10px;font-weight:bold;display:inline-block">Tạo mật khẩu</a></p>' +
    '<p style="color:#6b6b6b;font-size:13px">Link dùng được 1 lần, trong 30 phút. Tạo xong là đăng nhập được ngay, đơn hàng cũ vẫn đầy đủ.<br>Nếu anh/chị không yêu cầu thì cứ bỏ qua email này, tài khoản vẫn an toàn.</p>' +
    '<p style="color:#9a9a9a;font-size:12px">Nút không bấm được thì copy link này: ' + escH(link) + '</p></div>';
}

// Kiem tra don + anh: dung chung voi trang admin (lib/cnshared.js, 2 ban giong het nhau)
const { validateCn, checkCo, str, initUploads, saveUpload, checkUploads, claimUploads, uploadFile, UPLOAD_MAX } = require('./lib/cnshared');
chatk.init({ db: store.rawDb(), webpush, json, readBody, sameOrigin, myOrders, ownerOf: chatOwner, isTest: walletAcc });
// Trang chinh: giao dien template (ma hoa) + chen phan chat (khach/chat.js, code rieng khong thuoc template)
let idxHtml = { key: '', buf: null, gz: null };
function indexHtml(req, res) {
  const f = path.join(PUBLIC, 'index.html'), cf = path.join(__dirname, 'chat.js');
  let key; try { key = fs.statSync(f).mtimeMs + ':' + fs.statSync(cf).mtimeMs; } catch { return send(res, 404, 'Not found'); }
  if (idxHtml.key !== key) {
    const tag = '<script src="/chat.js?v=' + encodeURIComponent(String(fs.statSync(cf).mtimeMs | 0) + VERSION.slice(0, 7)) + '" defer></script>';
    let h = fs.readFileSync(f, 'utf8'); h = h.includes('</body>') ? h.replace('</body>', tag + '</body>') : h + tag;
    const buf = Buffer.from(h); idxHtml = { key, buf, gz: zlib.gzipSync(buf) };
  }
  if (/\bgzip\b/.test(req.headers['accept-encoding'] || '')) return send(res, 200, idxHtml.gz, { 'Content-Type': 'text/html; charset=utf-8', 'Content-Encoding': 'gzip', Vary: 'Accept-Encoding' });
  return send(res, 200, idxHtml.buf, { 'Content-Type': 'text/html; charset=utf-8' });
}
let chatJs = { m: 0, gz: null, raw: null };
function serveChatJs(req, res) {
  const f = path.join(__dirname, 'chat.js');
  fs.stat(f, (err, st) => {
    if (err) return send(res, 404, 'Not found');
    if (chatJs.m !== st.mtimeMs) { const raw = fs.readFileSync(f); chatJs = { m: st.mtimeMs, raw, gz: zlib.gzipSync(raw) }; }
    const gzOk = /\bgzip\b/.test(req.headers['accept-encoding'] || '');
    res.writeHead(200, Object.assign({ 'Content-Type': 'text/javascript; charset=utf-8', 'Cache-Control': 'public, max-age=604800, immutable' }, gzOk ? { 'Content-Encoding': 'gzip', Vary: 'Accept-Encoding' } : {}));
    res.end(gzOk ? chatJs.gz : chatJs.raw);
  });
}

async function handle(req, res) {
  const url = new URL(req.url, 'http://x');
  const p = url.pathname;
  if (p === '/healthz') return json(req, res, 200, { ok: true, version: VERSION, snapshot: index() ? index().gen : null });

  if (p === '/api/login' && req.method === 'POST') {
    if (!sameOrigin(req)) return json(req, res, 403, { error: 'origin' });
    let b; try { b = JSON.parse((await readBody(req, 10000)).toString()); } catch { return json(req, res, 400, { error: 'Dữ liệu không hợp lệ' }); }
    let username = String(b.username || '').trim().toLowerCase();
    const ip = clientIp(req);
    if (tooMany('ip:' + ip) || tooMany('u:' + username)) return json(req, res, 429, { error: 'Sai quá nhiều lần, thử lại sau 15 phút' });
    index(); // dam bao tai khoan test da gan khach
    if (username.includes('@')) { const g = store.gobizFind(username); if (g && g.u) username = g.u; } // dang nhap bang email Gobiz
    const known = store.getUser(username);
    const u = store.checkPassword(username, String(b.password || ''));
    store.logLogin(username, ip, !!u);
    if (!u) {
      addFail('ip:' + ip); addFail('u:' + username);
      if ((!known || !known.pass) && TRIAL.has(username)) return json(req, res, 401, { error: 'Lần đầu vào hệ thống mới, anh/chị bấm "Tạo mật khẩu qua email" bên dưới nhé', first: true });
      return json(req, res, 401, { error: 'Sai tên đăng nhập hoặc mật khẩu' });
    }
    setCookie(res, makeSession(u), SESSION_HOURS * 3600);
    return json(req, res, 200, { ok: true, username: u.username });
  }
  // ---------- Lan dau vao he thong moi / quen mat khau: gui link tao mat khau toi email Gobiz ----------
  if (p === '/api/pw/request' && req.method === 'POST') {
    if (!sameOrigin(req)) return json(req, res, 403, { error: 'origin' });
    let b; try { b = JSON.parse((await readBody(req, 4000)).toString()); } catch { return json(req, res, 400, { error: 'Dữ liệu không hợp lệ' }); }
    const q = String(b.id || '').trim().toLowerCase(); const ip = clientIp(req);
    if (!q) return json(req, res, 400, { error: 'Nhập tên đăng nhập hoặc email' });
    if (tooMany('pw:' + ip)) return json(req, res, 429, { error: 'Thử quá nhiều lần, đợi 15 phút rồi thử lại' });
    const g = store.gobizFind(q);
    if (!g) { addFail('pw:' + ip); return json(req, res, 404, { error: 'Không thấy tài khoản này. Anh/chị nhập đúng tên đăng nhập hoặc email đang dùng để đặt hàng' }); }
    if (g.many) return json(req, res, 400, { error: 'Email này đang gắn với nhiều tài khoản, anh/chị nhập tên đăng nhập giúp em' });
    if (!TRIAL.has(g.u)) return json(req, res, 403, { error: 'Hệ thống mới đang chạy thử với một số khách. Anh/chị vẫn đặt hàng ở trang cũ như bình thường nhé' });
    const cur = store.getUser(g.u);
    if (cur && !String(cur.note || '').startsWith('khach thu')) return json(req, res, 403, { error: 'Tài khoản này không đổi mật khẩu qua email được, nhắn nhân viên chăm sóc giúp em' });
    if (!/^[^\s@<>"]+@[^\s@<>"]+\.[a-z]{2,}$/i.test(g.em)) return json(req, res, 400, { error: 'Tài khoản chưa có email. Anh/chị nhắn nhân viên chăm sóc để cập nhật email nhé' });
    const c = store.pwTokenCount(g.u, ip);
    if (c.u >= 3 || c.ip >= 10) return json(req, res, 429, { error: 'Đã gửi email mấy lần rồi, anh/chị kiểm tra hộp thư (cả mục Spam / Quảng cáo) hoặc đợi 1 tiếng rồi thử lại' });
    const tok = store.pwTokenNew(g.u, g.em, ip);
    const link = linkHost(req) + '/dat-mat-khau#' + tok;
    const brand = mail.brandOfGroup(g.grp); const bn = BRAND[brand === 'vmtglobal' ? 'yellow' : 'green'].name;
    const r = await mail.send(brand, g.em, 'Tạo mật khẩu vào hệ thống mới ' + bn, pwMailText(g, bn, link), pwMailHtml(g, bn, link));
    if (r.error) { console.error('pw mail', g.u, r.error); return json(req, res, 503, { error: 'Chưa gửi được email lúc này, anh/chị thử lại sau ít phút hoặc nhắn nhân viên chăm sóc' }); }
    return json(req, res, 200, { ok: true, to: maskEmail(g.em) });
  }
  if (p === '/api/pw/check' && req.method === 'POST') {
    let b; try { b = JSON.parse((await readBody(req, 2000)).toString()); } catch { return json(req, res, 400, { error: 'Dữ liệu không hợp lệ' }); }
    const r = store.pwTokenPeek(b.token);
    return r ? json(req, res, 200, { ok: true, username: r.username }) : json(req, res, 410, { error: 'Link đã hết hạn hoặc đã dùng rồi. Anh/chị quay lại trang đăng nhập, bấm "Tạo mật khẩu qua email" để nhận link mới' });
  }
  if (p === '/api/pw/set' && req.method === 'POST') {
    if (!sameOrigin(req)) return json(req, res, 403, { error: 'origin' });
    let b; try { b = JSON.parse((await readBody(req, 4000)).toString()); } catch { return json(req, res, 400, { error: 'Dữ liệu không hợp lệ' }); }
    const pw = String(b.password || '');
    if (pw.length < 8 || pw.length > 100) return json(req, res, 400, { error: 'Mật khẩu cần ít nhất 8 ký tự' });
    if (/^\d+$/.test(pw) || new Set(pw).size < 4) return json(req, res, 400, { error: 'Mật khẩu dễ đoán quá, anh/chị thêm chữ hoặc ký tự khác nhé' });
    const r = store.pwTokenPeek(b.token);
    if (r && pw.toLowerCase().includes(r.username)) return json(req, res, 400, { error: 'Mật khẩu không nên chứa tên đăng nhập' });
    const u = store.pwTokenUse(b.token, store.hash(pw));
    if (!u) return json(req, res, 410, { error: 'Link đã hết hạn hoặc đã dùng rồi. Anh/chị quay lại trang đăng nhập để nhận link mới' });
    store.logLogin(u.username, clientIp(req) + ' email', true);
    setCookie(res, makeSession(u), SESSION_HOURS * 3600);
    return json(req, res, 200, { ok: true, username: u.username });
  }
  // ---------- Dang nhap bang Face ID / van tay (passkey) ----------
  // Tach rieng voi Face ID thanh toan (vi): dang nhap chi mo phien xem; tra tien van can PIN / Face ID cua vi.
  if (p.startsWith('/api/passkey/')) {
    const user = readSession(req);
    const WA = require('./lib/webauthn');
    const host = String(req.headers.host || '').toLowerCase(); const rpId = host.replace(/:\d+$/, '');
    const origin = (/^(localhost|127\.0\.0\.1)$/.test(rpId) ? 'http://' : 'https://') + host;
    if (req.method !== 'POST' || !sameOrigin(req)) return json(req, res, 403, { error: 'origin' });
    let b; try { b = JSON.parse((await readBody(req, 20000)).toString() || '{}'); } catch { return json(req, res, 400, { error: 'Dữ liệu không hợp lệ' }); }
    const db = store.rawDb(); const ip = clientIp(req);
    if (p === '/api/passkey/login-challenge' || p === '/api/passkey/login') {
      if (tooMany('ip:' + ip)) return json(req, res, 429, { error: 'Thử sai nhiều lần, vui lòng đợi 15 phút' });
      const username = String(b.username || '').trim().toLowerCase();
      const u = store.getUser(username);
      const creds = u && u.active ? db.prepare('SELECT cred_id FROM login_creds WHERE username = ? AND disabled = 0').all(username).map((x) => x.cred_id) : [];
      if (p === '/api/passkey/login-challenge') {
        if (!creds.length) return json(req, res, 400, { error: 'Máy này chưa bật đăng nhập bằng Face ID, đăng nhập bằng mật khẩu' });
        return json(req, res, 200, { challenge: WA.challenge('login:' + username, 'login', null), rpId, creds });
      }
      try {
        const w = b.cred || {};
        WA.take(String(b.challenge || ''), 'login:' + username, 'login', null);
        const c = db.prepare('SELECT * FROM login_creds WHERE cred_id = ? AND username = ? AND disabled = 0').get(String(w.id || ''), username);
        if (!c || !u || !u.active) throw new Error('Face ID trên máy này không còn hiệu lực, đăng nhập bằng mật khẩu');
        const n = WA.verifyAssert(w, { jwk: JSON.parse(c.jwk), count: c.count }, b.challenge, origin, rpId);
        db.prepare("UPDATE login_creds SET count = ?, last_used = strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE cred_id = ?").run(n, c.cred_id);
        store.logLogin(username, ip + ' faceid', true);
        setCookie(res, makeSession(u), SESSION_HOURS * 3600);
        return json(req, res, 200, { ok: true });
      } catch (e) { addFail('ip:' + ip); store.logLogin(username, ip + ' faceid', false); return json(req, res, 401, { error: e.message || 'Xác thực không thành công' }); }
    }
    if (!user) return json(req, res, 401, { error: 'login' });
    if (p === '/api/passkey/list') return json(req, res, 200, { items: db.prepare('SELECT cred_id AS id, label, created_at, last_used FROM login_creds WHERE username = ? AND disabled = 0 ORDER BY created_at DESC').all(user.username) });
    if (p === '/api/passkey/reg-challenge') {
      const ex = db.prepare('SELECT cred_id FROM login_creds WHERE username = ? AND disabled = 0').all(user.username).map((x) => x.cred_id);
      return json(req, res, 200, { challenge: WA.challenge('login:' + user.username, 'login-reg', null), rpId, exclude: ex, user: { id: WA.b64u(crypto.createHash('sha256').update('vmt-login:' + user.username).digest().subarray(0, 16)), name: user.username } });
    }
    if (p === '/api/passkey/register') {
      // Bat Face ID dang nhap phai nhap lai mat khau (chong ai muon may / lay duoc phien dang nhap tu them thiet bi cua ho)
      if (tooMany('u:' + user.username)) return json(req, res, 429, { error: 'Thử sai nhiều lần, vui lòng đợi 15 phút' });
      if (!store.checkPassword(user.username, String(b.password || ''))) { addFail('u:' + user.username); return json(req, res, 401, { error: 'Mật khẩu không đúng' }); }
      try {
        WA.take(String(b.challenge || ''), 'login:' + user.username, 'login-reg', null);
        const r = WA.verifyRegister(b.cred || {}, b.challenge, origin, rpId);
        if (db.prepare('SELECT 1 FROM login_creds WHERE cred_id = ?').get(r.credId)) return json(req, res, 409, { error: 'Máy này đã bật rồi' });
        db.prepare('INSERT INTO login_creds (cred_id, username, jwk, count, label) VALUES (?, ?, ?, ?, ?)').run(r.credId, user.username, JSON.stringify(r.jwk), r.count, String(b.label || '').slice(0, 60) || 'Thiết bị');
        // toi da 10 thiet bi / tai khoan
        db.prepare('UPDATE login_creds SET disabled = 1 WHERE username = ? AND disabled = 0 AND cred_id NOT IN (SELECT cred_id FROM login_creds WHERE username = ? AND disabled = 0 ORDER BY created_at DESC LIMIT 10)').run(user.username, user.username);
        store.logLogin(user.username, ip + ' faceid_on', true);
        return json(req, res, 200, { ok: true, id: r.credId });
      } catch (e) { return json(req, res, 400, { error: e.message || 'Không bật được Face ID' }); }
    }
    if (p === '/api/passkey/remove') {
      db.prepare('UPDATE login_creds SET disabled = 1 WHERE username = ? AND cred_id = ?').run(user.username, String(b.id || ''));
      store.logLogin(user.username, ip + ' faceid_off', true);
      return json(req, res, 200, { ok: true });
    }
    return json(req, res, 404, { error: 'not found' });
  }
  if (p === '/api/logout') { setCookie(res, '', 0); res.writeHead(302, { Location: '/login' }); return res.end(); }
  if (p === '/login') return loginPage(req, res);
  if (p === '/dat-mat-khau') return loginPage(req, res, 'matkhau.html');
  if (p === '/manifest.webmanifest') return send(res, 200, manifest(hostBrand(req)), { 'Content-Type': 'application/manifest+json; charset=utf-8', 'Cache-Control': 'public, max-age=3600' });
  if (p === '/sw.js') return fs.readFile(path.join(__dirname, 'sw.js'), (err, buf) => err ? send(res, 404, 'Not found') : send(res, 200, buf, { 'Content-Type': 'text/javascript; charset=utf-8', 'Service-Worker-Allowed': '/' }));
  if (p === '/offline.html') return fs.readFile(path.join(__dirname, 'offline.html'), (err, buf) => err ? send(res, 404, 'Not found') : send(res, 200, buf, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'public, max-age=86400' }));
  if (p === '/apple-touch-icon.png') return pwaFile(req, res, 'apple-touch-icon.png');
  // Anh xem truoc khi chia se link (Zalo, Facebook, Messenger…): 1200x630 theo thuong hieu
  if (p === '/og.jpg') return fs.readFile(path.join(__dirname, 'pwa', hostBrand(req) + '-og.jpg'), (err, buf) => err ? send(res, 404, 'Not found') : send(res, 200, buf, { 'Content-Type': 'image/jpeg', 'Cache-Control': 'public, max-age=604800' }));
  const mp = p.match(/^\/pwa\/([a-z0-9-]+\.png)$/);
  if (mp) return pwaFile(req, res, mp[1]);
  if (p.startsWith('/assets/') || p === '/icons.js' || p === '/manifest.json') return serveFile(req, res, p.slice(1), true);
  if (p === '/chat.js') return serveChatJs(req, res);

  const user = readSession(req);
  if (p.startsWith('/api/chat')) return chatk.handle(req, res, p, url, user);
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
    const cr = store.cnCreate(user.username, user.gobiz, isTestAcc(user), v.data, clientIp(req));
    if (cr.error) return json(req, res, 400, { error: cr.error });
    const o = cr.order;
    return json(req, res, 200, { ok: true, order: Object.assign(o, { mine: true }), companies: saved ? store.coList(user.username) : undefined });
  }
  // ---- Ky gui ve VN (he thong moi) ----
  if (p === '/api/ks' && req.method === 'POST') {
    if (!user) return json(req, res, 401, { error: 'login' });
    if (!sameOrigin(req) || !/application\/json/.test(req.headers['content-type'] || '')) return json(req, res, 403, { error: 'origin' });
    let b; try { b = JSON.parse((await readBody(req, 100000)).toString()); } catch { return json(req, res, 400, { error: 'Dữ liệu không hợp lệ' }); }
    const v = ks.validate(b);
    if (v.error) return json(req, res, 400, { error: v.error });
    if (ks.countRecent(user.username) + v.wbs.length > 200) return json(req, res, 429, { error: 'Tạo quá nhiều đơn trong 1 giờ, vui lòng thử lại sau' });
    const r = ks.create(user.username, user.gobiz, isTestAcc(user), v, clientIp(req), { group: custGroup(user) });
    if (r.error) return json(req, res, 409, r);
    return json(req, res, 200, { ok: true, orders: r.orders, merged: r.merged });
  }
  if (p === '/api/ks/default') {
    if (!user) return json(req, res, 401, { error: 'login' });
    if (req.method === 'GET') return json(req, res, 200, { def: ks.getDefault(owner(user)) });
    if (req.method !== 'POST' || !sameOrigin(req)) return json(req, res, 403, { error: 'origin' });
    let b; try { b = JSON.parse((await readBody(req, 5000)).toString()); } catch { return json(req, res, 400, { error: 'Dữ liệu không hợp lệ' }); }
    const r = ks.setDefault(owner(user), b, 'khach:' + user.username, clientIp(req));
    return json(req, res, r.error ? 400 : 200, r);
  }
  if (p === '/api/ks/check' && req.method === 'POST') {
    if (!user) return json(req, res, 401, { error: 'login' });
    let b; try { b = JSON.parse((await readBody(req, 20000)).toString()); } catch { return json(req, res, 400, { error: 'Dữ liệu không hợp lệ' }); }
    const { wbs } = ks.parseWbs(b.wbs);
    return json(req, res, 200, ks.existing(user.username, wbs.slice(0, 200), user.gobiz));
  }
  const mkv = p.match(/^\/api\/ks\/(84\d{10})\/svcs$/);
  if (mkv && req.method === 'POST') {
    if (!user) return json(req, res, 401, { error: 'login' });
    if (!sameOrigin(req)) return json(req, res, 403, { error: 'origin' });
    let b; try { b = JSON.parse((await readBody(req, 5000)).toString()); } catch { return json(req, res, 400, { error: 'Dữ liệu không hợp lệ' }); }
    const r = ks.setSvcs(user.username, user.gobiz, mkv[1], b, 'khach:' + user.username, clientIp(req));
    if (r.error) return json(req, res, r.code || 400, { error: r.error });
    return json(req, res, 200, { ok: true, order: r.order });
  }
  const mks = p.match(/^\/api\/ks\/(84\d{10})\/cancel$/);
  if (mks && req.method === 'POST') {
    if (!user) return json(req, res, 401, { error: 'login' });
    if (!sameOrigin(req)) return json(req, res, 403, { error: 'origin' });
    const r = ks.cancel(user.username, user.gobiz, mks[1], clientIp(req), { group: custGroup(user) });
    if (r.error) return json(req, res, r.code, { error: r.error });
    return json(req, res, 200, { ok: true, order: r.order });
  }
  if (p === '/api/ai/ks' && req.method === 'POST') {
    if (!user) return json(req, res, 401, { error: 'login' });
    if (!sameOrigin(req) || !/application\/json/.test(req.headers['content-type'] || '')) return json(req, res, 403, { error: 'origin' });
    if (!ai.ready()) return json(req, res, 503, { error: 'Tính năng điền nhanh đang tạm dừng, anh/chị nhập tay giúp em nhé' });
    if (aiCount(user.username) >= 30) return json(req, res, 429, { error: 'Dùng điền nhanh quá nhiều trong 1 giờ, thử lại sau' });
    let b; try { b = JSON.parse((await readBody(req, 4 * 1024 * 1024)).toString()); } catch { return json(req, res, 413, { error: 'Ảnh quá lớn hoặc dữ liệu không hợp lệ' }); }
    const text = String(b.text || '').slice(0, 8000);
    const imgs = (Array.isArray(b.images) ? b.images : []).slice(0, 4).map((x) => String(x || '')).filter((x) => /^[A-Za-z0-9+/=]{200,}$/.test(x)).map((data) => ({ mime: 'image/jpeg', data }));
    if (!text.trim() && !imgs.length) return json(req, res, 400, { error: 'Dán tin nhắn hoặc thêm ảnh trước' });
    const t0 = Date.now(); const r = await ai.ksFill(text, imgs);
    aiLog(user.username, 'ks', !r.error, Date.now() - t0, imgs.length);
    if (r.error) return json(req, res, 502, { error: r.error });
    return json(req, res, 200, r);
  }
  // Dien nhanh form Ship to China: { text, images: [base64 JPEG] } -> du lieu goi y (khach xem lai roi moi gui)
  if (p === '/api/ai/cn' && req.method === 'POST') {
    if (!user) return json(req, res, 401, { error: 'login' });
    if (!sameOrigin(req) || !/application\/json/.test(req.headers['content-type'] || '')) return json(req, res, 403, { error: 'origin' });
    if (!ai.ready()) return json(req, res, 503, { error: 'Tính năng điền nhanh đang tạm dừng, anh/chị nhập tay giúp em nhé' });
    if (aiCount(user.username) >= 30) return json(req, res, 429, { error: 'Dùng điền nhanh quá nhiều trong 1 giờ, thử lại sau' });
    let b; try { b = JSON.parse((await readBody(req, 4 * 1024 * 1024)).toString()); } catch { return json(req, res, 413, { error: 'Ảnh quá lớn hoặc dữ liệu không hợp lệ' }); }
    const text = String(b.text || '').slice(0, 8000);
    const imgs = (Array.isArray(b.images) ? b.images : []).slice(0, 4).map((x) => String(x || '')).filter((x) => /^[A-Za-z0-9+/=]{200,}$/.test(x)).map((data) => ({ mime: 'image/jpeg', data }));
    if (!text.trim() && !imgs.length) return json(req, res, 400, { error: 'Dán tin nhắn hoặc thêm ảnh trước' });
    const t0 = Date.now(); const r = await ai.cnFill(text, imgs);
    aiLog(user.username, 'cn', !r.error, Date.now() - t0, imgs.length);
    if (r.error) return json(req, res, 502, { error: r.error });
    return json(req, res, 200, r);
  }
  if (p === '/api/upload' && req.method === 'POST') {
    if (!user) return json(req, res, 401, { error: 'login' });
    if (!sameOrigin(req) || req.headers['content-type'] !== 'image/jpeg') return json(req, res, 403, { error: 'origin' });
    let buf; try { buf = await readBody(req, UPLOAD_MAX); } catch { return json(req, res, 413, { error: 'Ảnh phải nhỏ hơn 3MB' }); }
    const r = store.uploadSave(user.username, buf);
    if (r.error) return json(req, res, 400, { error: r.error });
    return json(req, res, 200, { ok: true, id: r.id });
  }
  const mu = p.match(/^\/u\/([a-f0-9]{32})\.jpg$/);
  if (mu) {
    if (!user || !store.uploadCanSee(user.username, user.gobiz, mu[1], chatOwner(user))) return send(res, 404, 'Not found');
    return fs.readFile(store.uploadPath(mu[1]), (err, buf) => err ? send(res, 404, 'Not found') : send(res, 200, buf, { 'Content-Type': 'image/jpeg', 'Cache-Control': 'private, max-age=86400' }));
  }
  // ---- vi + thanh toan (tam thoi chi tai khoan test) ----
  if (p.startsWith('/api/wallet') || p === '/api/pay') {
    if (!user) return json(req, res, 401, { error: 'login' });
    if (!walletAcc(user)) return json(req, res, 403, { error: 'Ví mới đang chạy thử, chưa mở cho tài khoản này' });
    const db = store.rawDb(), o = owner(user);
    if (p === '/api/wallet' && req.method === 'GET') {
      const code = ledger.codeOf(db, o, gobizNames());
      return json(req, res, 200, { code, canTopup: store.depositAccounts().length > 0, wallet: ledger.walletView(db, o), hasPin: ledger.hasPin(db, o), faceIds: db.prepare('SELECT cred_id AS id, label, created_at, last_used FROM webauthn_creds WHERE owner = ? AND disabled = 0').all(o), txns: ledger.txnsOf(db, o, 100), intent: ledger.intentOf(db, o), withdraws: db.prepare("SELECT id, amount, note, status, decide_note, created_at, txn, bills FROM fin_requests WHERE owner = ? AND kind = 'WITHDRAW' ORDER BY id DESC LIMIT 10").all(o).map((x) => Object.assign(x, { bills: JSON.parse(x.bills || '[]') })), claims: ledger.claims(db, null, o).slice(0, 10).map((c) => ({ id: c.id, amount: c.amount, at: c.at, status: c.status, note: c.decide_note, created: c.created_at })) });
    }
    // QR nap tien: phai nhap so tien truoc; tai khoan nhan chon theo so tien + gio (luat giong Gobiz)
    if (p === '/api/wallet/qr' && req.method === 'GET') {
      const code = ledger.codeOf(db, o, gobizNames()); const Q = require('./lib/vietqr'); const R = require('./lib/depositrule');
      let flags = {}; try { flags = JSON.parse(store.adminKv('deposit_flags') || '{}'); } catch (e) {}
      const amt = Math.round(Number(url.searchParams.get('amount') || 0));
      if (amt > 5e9) return json(req, res, 400, { error: 'Số tiền quá lớn' });
      const r = R.pick(amt, code, flags, store.depositAccounts());
      if (r.error) return json(req, res, 400, { error: r.error });
      const x = r.account;
      return json(req, res, 200, { qr: Q.payload(x.bank, x.acct, amt, code), amount: amt, code, bankName: (Q.BANKS[x.bank] || [])[1] || x.bank, acct: x.acct, holder: x.holder, validUntil: r.validUntil });
    }
    if (req.method !== 'POST' || !sameOrigin(req) || !/application\/json/.test(req.headers['content-type'] || '')) return json(req, res, 403, { error: 'origin' });
    let b; try { b = JSON.parse((await readBody(req, 20000)).toString()); } catch { return json(req, res, 400, { error: 'Dữ liệu không hợp lệ' }); }
    // Xac thuc lenh tien: PIN hoac Face ID / van tay (WebAuthn). bind = noi dung lenh, doi noi dung la phai xac thuc lai.
    const WA = require('./lib/webauthn');
    const host = String(req.headers.host || '').toLowerCase(); const rpId = host.replace(/:\d+$/, '');
    const origin = (/^(localhost|127\.0\.0\.1)$/.test(rpId) ? 'http://' : 'https://') + host;
    const codesKey = (c) => (Array.isArray(c) ? c : []).map((x) => String(x).toUpperCase()).sort();
    const bindOf = (purpose) => purpose === 'withdraw' ? { amount: Math.round(Number(b.amount)) || 0, acct: String(b.acct || '').replace(/\s/g, '') } : purpose === 'register' ? null : { codes: codesKey(b.codes) };
    const auth = (purpose) => {
      if (!b.webauthn) return ledger.checkPin(db, o, String(b.pin || ''));
      try {
        const w = b.webauthn; WA.take(String(w.challenge || ''), o, purpose, bindOf(purpose));
        const c = db.prepare('SELECT * FROM webauthn_creds WHERE cred_id = ? AND owner = ? AND disabled = 0').get(String(w.id || ''), o);
        if (!c) return { code: 401, error: 'Thiết bị này chưa bật Face ID cho ví, dùng PIN' };
        const n = WA.verifyAssert(w, { jwk: JSON.parse(c.jwk), count: c.count }, w.challenge, origin, rpId);
        db.prepare("UPDATE webauthn_creds SET count = ?, last_used = strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE cred_id = ?").run(n, c.cred_id);
        return { ok: true, via: 'faceid:' + c.cred_id.slice(0, 8) };
      } catch (e) { return { code: 401, error: e.message || 'Xác thực Face ID không thành công' }; }
    };
    if (p === '/api/wallet/webauthn/challenge') {
      const purpose = ['pay', 'intent', 'withdraw', 'register'].includes(b.purpose) ? b.purpose : '';
      if (!purpose) return json(req, res, 400, { error: 'Sai mục đích' });
      const creds = db.prepare('SELECT cred_id FROM webauthn_creds WHERE owner = ? AND disabled = 0').all(o).map((x) => x.cred_id);
      if (purpose !== 'register' && !creds.length) return json(req, res, 400, { error: 'Chưa bật Face ID' });
      return json(req, res, 200, { challenge: WA.challenge(o, purpose, bindOf(purpose)), rpId, creds, user: { id: WA.b64u(crypto.createHash('sha256').update('vmt:' + o).digest().subarray(0, 16)), name: user.username } });
    }
    if (p === '/api/wallet/webauthn/register') {
      const pc = ledger.checkPin(db, o, String(b.pin || ''));
      if (pc.error) return json(req, res, pc.code, pc);
      try {
        WA.take(String(b.challenge || ''), o, 'register', null);
        const r = WA.verifyRegister(b.cred || {}, b.challenge, origin, rpId);
        if (db.prepare('SELECT 1 FROM webauthn_creds WHERE cred_id = ?').get(r.credId)) return json(req, res, 409, { error: 'Thiết bị này đã bật rồi' });
        const label = String(b.label || '').slice(0, 60) || 'Thiết bị';
        db.prepare('INSERT INTO webauthn_creds (cred_id, owner, jwk, count, label) VALUES (?, ?, ?, ?, ?)').run(r.credId, o, JSON.stringify(r.jwk), r.count, label);
        db.prepare('INSERT INTO wallet_log (owner, by, action, detail) VALUES (?, ?, ?, ?)').run(o, 'khach:' + user.username + ' ' + clientIp(req), 'faceid_on', JSON.stringify({ cred: r.credId.slice(0, 8), label }));
        return json(req, res, 200, { ok: true, id: r.credId });
      } catch (e) { return json(req, res, 400, { error: e.message || 'Không bật được Face ID' }); }
    }
    if (p === '/api/wallet/webauthn/remove') {
      const pc = ledger.checkPin(db, o, String(b.pin || ''));
      if (pc.error) return json(req, res, pc.code, pc);
      const n = db.prepare('UPDATE webauthn_creds SET disabled = 1 WHERE cred_id = ? AND owner = ? AND disabled = 0').run(String(b.id || ''), o).changes;
      if (n) db.prepare('INSERT INTO wallet_log (owner, by, action, detail) VALUES (?, ?, ?, ?)').run(o, 'khach:' + user.username + ' ' + clientIp(req), 'faceid_off', JSON.stringify({ cred: String(b.id).slice(0, 8) }));
      return json(req, res, n ? 200 : 404, n ? { ok: true } : { error: 'Không tìm thấy thiết bị' });
    }
    if (p === '/api/wallet/pin') {
      if (tooMany('pinset:' + user.username)) return json(req, res, 429, { error: 'Thử quá nhiều lần, đợi 15 phút' });
      if (!store.checkPassword(user.username, String(b.password || ''))) { addFail('pinset:' + user.username); return json(req, res, 401, { error: 'Mật khẩu đăng nhập không đúng' }); }
      const r = ledger.setPin(db, o, String(b.pin || ''), 'khach:' + user.username + ' ' + clientIp(req));
      return json(req, res, r.error ? r.code : 200, r);
    }
    if (p === '/api/wallet/intent' || p === '/api/wallet/withdraw') {
      const pc = auth(p === '/api/wallet/intent' ? 'intent' : 'withdraw');
      if (pc.error) return json(req, res, pc.code, pc);
      if (p === '/api/wallet/intent') {
        const r = ledger.intentCreate(db, o, b.codes, 'khach:' + user.username + (pc.via ? ' ' + pc.via : ''));
        if (r.error) return json(req, res, r.code, r);
        const code = ledger.codeOf(db, o, gobizNames()); const Q = require('./lib/vietqr'); const R = require('./lib/depositrule');
        let flags = {}; try { flags = JSON.parse(store.adminKv('deposit_flags') || '{}'); } catch (e) {}
        const k = R.pick(r.short, code, flags, store.depositAccounts()); if (k.error) return json(req, res, 400, { error: k.error });
        const x = k.account;
        return json(req, res, 200, Object.assign(r, { qr: Q.payload(x.bank, x.acct, r.short, code), amount: r.short, code, bankName: (Q.BANKS[x.bank] || [])[1] || x.bank, acct: x.acct, holder: x.holder, validUntil: k.validUntil }));
      }
      const amt = Math.round(Number(b.amount)); const bank = String(b.bank || '').trim().slice(0, 60), acct = String(b.acct || '').replace(/\s/g, '').slice(0, 30), holder = String(b.holder || '').trim().toUpperCase().slice(0, 60);
      if (!bank || !/^[0-9A-Za-z]{5,30}$/.test(acct) || holder.length < 3) return json(req, res, 400, { error: 'Nhập đủ ngân hàng, số tài khoản, tên chủ tài khoản' });
      const r = ledger.request(db, { kind: 'WITHDRAW', owner: o, amount: amt, note: 'Rút về ' + bank + ' ' + acct + ' ' + holder + (b.note ? ' — ' + String(b.note).slice(0, 100) : ''), by: 'khach:' + user.username + ' ' + clientIp(req) + (pc.via ? ' ' + pc.via : '') });
      return json(req, res, r.error ? r.code : 200, r);
    }
    if (p === '/api/wallet/claim') {
      const r = ledger.claimCreate(db, o, b, 'khach:' + user.username);
      return json(req, res, r.error ? r.code : 200, r);
    }
    if (p === '/api/pay') {
      const pc = auth('pay');
      if (pc.error) return json(req, res, pc.code, pc);
      const r = ledger.pay(db, o, b.codes, String(b.idem || ''), 'khach:' + user.username + (pc.via ? ' ' + pc.via : ''), true, Array.isArray(b.confirm) ? b.confirm : []);
      if (r.error) return json(req, res, r.code, r);
      return json(req, res, 200, Object.assign(r, { wallet: ledger.walletView(db, o), orders: store.cnList(user.username, user.gobiz) }));
    }
    return json(req, res, 404, { error: 'not found' });
  }
  const mtx = p.match(/^\/api\/cn\/(SCN\d{1,12})\/txns$/);
  if (mtx) {
    if (!user) return json(req, res, 401, { error: 'login' });
    if (!store.cnList(user.username, user.gobiz).some((x) => x.code === mtx[1])) return json(req, res, 404, { error: 'Không tìm thấy đơn' });
    return json(req, res, 200, { items: ledger.txnsOfOrder(store.rawDb(), mtx[1]).map((t) => ({ txn: t.txn, kind: t.kindLabel, amount: t.amount, at: t.created_at })) });
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
  if (p.startsWith('/api/push/')) {
    if (!user) return json(req, res, 401, { error: 'login' });
    if (p === '/api/push/key') return json(req, res, 200, { key: webpush.publicKey(), has: webpush.hasSub(user.username) });
    if (req.method !== 'POST' || !sameOrigin(req)) return json(req, res, 403, { error: 'origin' });
    let b; try { b = JSON.parse((await readBody(req, 4000)).toString()); } catch { return json(req, res, 400, { error: 'Dữ liệu không hợp lệ' }); }
    if (p === '/api/push/sub') {
      const r = webpush.subscribe(user.username, b.sub, req.headers.host, req.headers['user-agent']);
      if (r.error) return json(req, res, 400, r);
      if (!b.test) return json(req, res, 200, { ok: true });
      const t = await webpush.send(user.username, { title: 'Đã bật thông báo', body: 'Từ giờ anh/chị sẽ nhận báo ngay khi có tin nhắn, hàng về hoặc cần thanh toán.', url: '/#tong-quan', tag: 'bat-thong-bao' });
      return json(req, res, 200, { ok: true, sent: t.sent, codes: t.codes });
    }
    if (p === '/api/push/unsub') { webpush.unsubscribe(user.username, b.endpoint); return json(req, res, 200, { ok: true }); }
    return json(req, res, 404, { error: 'not found' });
  }
  if (p === '/api/pwa' && req.method === 'POST') {
    if (!user) return json(req, res, 401, { error: 'login' });
    if (!sameOrigin(req)) return json(req, res, 403, { error: 'origin' });
    let b; try { b = JSON.parse((await readBody(req, 2000)).toString()); } catch { return json(req, res, 400, { error: 'bad' }); }
    const ev = String(b.event || '');
    if (!PWA_EVENTS.has(ev)) return json(req, res, 400, { error: 'bad' });
    const db = store.rawDb();
    // 'standalone' (dang mo bang app) chi ghi 1 lan/ngay/khach de khong phinh bang
    if (ev === 'standalone' && db.prepare("SELECT 1 FROM pwa_log WHERE username = ? AND event = 'standalone' AND created_at > strftime('%Y-%m-%dT%H:%M:%fZ','now','-1 day')").get(user.username)) return json(req, res, 200, { ok: true });
    db.prepare('INSERT INTO pwa_log (username, event, platform, ua) VALUES (?, ?, ?, ?)').run(user.username, ev, String(b.platform || '').slice(0, 20), String(req.headers['user-agent'] || '').slice(0, 300));
    return json(req, res, 200, { ok: true });
  }
  // ---- Khach duyet anh kiem hang / de xuat dong goi (kho TQ gui) ----
  const md = p.match(/^\/duyet\/(\d{1,10})$/);
  if (md) { if (!user) { res.writeHead(302, { Location: '/login' }); return res.end(); } return fs.readFile(path.join(__dirname, 'duyet.html'), (err, buf) => err ? send(res, 404, 'Not found') : send(res, 200, buf, { 'Content-Type': 'text/html; charset=utf-8' })); }
  const mda = p.match(/^\/api\/duyet\/(\d{1,10})$/);
  if (mda) {
    if (!user) return json(req, res, 401, { error: 'login' });
    if (req.method === 'POST') {
      if (!sameOrigin(req)) return json(req, res, 403, { error: 'origin' });
      let b; try { b = JSON.parse((await readBody(req, 5000)).toString()); } catch { return json(req, res, 400, { error: 'Dữ liệu không hợp lệ' }); }
      const r = await duyet.reply(Number(mda[1]), owner(user), !!b.ok, b.note, user.username);
      return json(req, res, r.error ? 400 : 200, r);
    }
    const a = duyet.get(Number(mda[1]), owner(user));
    return a ? json(req, res, 200, Object.assign(a, { brand: hostBrand(req) })) : json(req, res, 404, { error: 'Không tìm thấy yêu cầu xác nhận' });
  }
  const mdp = p.match(/^\/api\/duyet\/(\d{1,10})\/photo\/([A-Za-z0-9_-]{8,40})$/);
  if (mdp) {
    if (!user) return send(res, 401, '');
    const f = duyet.photoFile(mdp[2], Number(mdp[1]), owner(user));
    if (!f) return send(res, 404, 'Not found');
    return fs.readFile(f, (err, buf) => err ? send(res, 404, 'Not found') : send(res, 200, buf, { 'Content-Type': 'image/jpeg', 'Cache-Control': 'private, max-age=2592000, immutable' }));
  }
  if (p === '/api/notif') {
    if (!user) return json(req, res, 401, { error: 'login' });
    if (req.method === 'POST') { if (!sameOrigin(req)) return json(req, res, 403, { error: 'origin' }); store.notifRead(user.username); return json(req, res, 200, { ok: true }); }
    return json(req, res, 200, { items: store.notifList(user.username).map((n) => Object.assign(n, notifKind(n), /^DUYET-\d+$/.test(n.code || '') ? { url: '/duyet/' + n.code.slice(6) } : {})) });
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
    const r = store.cnCancel(user.username, mc[1], clientIp(req), user.gobiz);
    if (r.error) return json(req, res, r.code, { error: r.error });
    return json(req, res, 200, { ok: true, order: Object.assign(r.order, { mine: true }) });
  }
  if (p === '/' || p === '/index.html') {
    if (!user) return loginPage(req, res); // tra thang trang dang nhap (khong chuyen huong) de Zalo / Facebook doc duoc anh xem truoc
    return indexHtml(req, res);
  }
  return send(res, 404, 'Not found');
}

http.createServer((req, res) => {
  handle(req, res).catch((e) => { console.error(e); if (!res.headersSent) send(res, 500, 'Server error'); });
}).listen(PORT, () => console.log('Trang khach chay o cong ' + PORT));
