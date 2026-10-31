'use strict';
// Du lieu rieng trang khach: /data/khach.db (tai khoan, nhat ky). Snapshot Gobiz doc tu DB admin (chi SELECT).
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { DatabaseSync } = require('node:sqlite');
const shared = require('./cnshared');
const ledger = require('./ledger');

const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, '..', 'data');
const ADMIN_DB = process.env.ADMIN_DB || '/admin/vmt.db';
let db, adb;

function init() {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  db = new DatabaseSync(path.join(DATA_DIR, 'khach.db'));
  db.exec(`
    PRAGMA journal_mode = WAL;
    PRAGMA busy_timeout = 5000;
    CREATE TABLE IF NOT EXISTS users (
      username TEXT PRIMARY KEY, gobiz TEXT NOT NULL, pass TEXT, pv INTEGER NOT NULL DEFAULT 1,
      active INTEGER NOT NULL DEFAULT 1, note TEXT, created_at TEXT DEFAULT (datetime('now'))
    );
    CREATE TABLE IF NOT EXISTS login_log (ts TEXT DEFAULT (datetime('now')), username TEXT, ip TEXT, ok INTEGER);
    CREATE TABLE IF NOT EXISTS kv (k TEXT PRIMARY KEY, v TEXT);
    CREATE TABLE IF NOT EXISTS cn_orders (
      seq INTEGER PRIMARY KEY AUTOINCREMENT, code TEXT UNIQUE, username TEXT NOT NULL, gobiz TEXT, test INTEGER NOT NULL DEFAULT 0,
      status TEXT NOT NULL DEFAULT 'PENDING', data TEXT NOT NULL, created_at TEXT DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')), updated_at TEXT
    );
    CREATE TABLE IF NOT EXISTS notif (id INTEGER PRIMARY KEY AUTOINCREMENT, username TEXT NOT NULL, code TEXT, text TEXT NOT NULL, read INTEGER NOT NULL DEFAULT 0, created_at TEXT DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')));
    CREATE TABLE IF NOT EXISTS pw_tokens (h TEXT PRIMARY KEY, username TEXT NOT NULL, email TEXT, ip TEXT, exp INTEGER NOT NULL, used INTEGER NOT NULL DEFAULT 0, created_at TEXT DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')));
    CREATE INDEX IF NOT EXISTS pw_tokens_u ON pw_tokens(username, created_at);
    CREATE TABLE IF NOT EXISTS gz_seen (username TEXT NOT NULL, code TEXT NOT NULL, st TEXT, ts TEXT, PRIMARY KEY (username, code));
    CREATE TABLE IF NOT EXISTS companies (
      id INTEGER PRIMARY KEY AUTOINCREMENT, username TEXT NOT NULL, name TEXT NOT NULL, tax_id TEXT NOT NULL, addr TEXT NOT NULL, email TEXT NOT NULL,
      is_default INTEGER NOT NULL DEFAULT 0, deleted INTEGER NOT NULL DEFAULT 0,
      created_at TEXT DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')), updated_at TEXT
    );
    CREATE UNIQUE INDEX IF NOT EXISTS companies_user_tax ON companies (username, tax_id) WHERE deleted = 0;
    CREATE TABLE IF NOT EXISTS co_log (ts TEXT DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')), username TEXT, co_id INTEGER, action TEXT, detail TEXT);
    CREATE TABLE IF NOT EXISTS cn_log (ts TEXT DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')), code TEXT, username TEXT, action TEXT, detail TEXT);
  `);
  shared.initUploads(db);
  ledger.init(db);
  require('./webauthn').init(db);
  // Ma don SCN bat dau tu 100001
  if (!db.prepare("SELECT 1 FROM sqlite_sequence WHERE name = 'cn_orders'").get()) db.prepare("INSERT INTO sqlite_sequence (name, seq) VALUES ('cn_orders', 100000)").run();
}
function adminDb() {
  if (adb) return adb;
  if (!fs.existsSync(ADMIN_DB)) return null;
  adb = new DatabaseSync(ADMIN_DB);
  adb.exec('PRAGMA busy_timeout = 5000');
  return adb;
}
function latestSnapshotId() { const a = adminDb(); if (!a) return null; const r = a.prepare('SELECT id FROM snapshots ORDER BY id DESC LIMIT 1').get(); return r ? r.id : null; }
function snapshot(id) { const a = adminDb(); return a ? a.prepare('SELECT id, gen, data FROM snapshots WHERE id = ?').get(id) || null : null; }

function sessionSecret() {
  const row = db.prepare('SELECT v FROM kv WHERE k = ?').get('session_secret');
  if (row) return row.v;
  const s = crypto.randomBytes(32).toString('hex');
  db.prepare('INSERT INTO kv (k, v) VALUES (?, ?)').run('session_secret', s);
  return s;
}
function hash(pw) {
  const salt = crypto.randomBytes(16);
  const h = crypto.scryptSync(pw, salt, 32, { N: 16384, r: 8, p: 1 });
  return 'scrypt$' + salt.toString('base64') + '$' + h.toString('base64');
}
function verify(pw, stored) {
  const [, s, h] = String(stored || '').split('$');
  if (!s || !h) return false;
  const want = Buffer.from(h, 'base64');
  const got = crypto.scryptSync(String(pw), Buffer.from(s, 'base64'), want.length, { N: 16384, r: 8, p: 1 });
  return want.length === got.length && crypto.timingSafeEqual(want, got);
}
const DUMMY = 'scrypt$AAAAAAAAAAAAAAAAAAAAAA==$AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=';
function getUser(u) { const r = db.prepare('SELECT * FROM users WHERE username = ?').get(String(u || '').toLowerCase()); return r ? Object.assign({}, r, { active: !!r.active }) : null; }
function checkPassword(u, pw) { const r = getUser(u); if (!r || !r.active || !r.pass) { verify(pw, DUMMY); return null; } return verify(pw, r.pass) ? r : null; }
// Tai khoan test: mat khau dat san bang ma bam (trong repo chi co ma bam, khong co mat khau)
function upsertTest(username, gobiz, passHash, note) {
  const r = getUser(username);
  if (!r) db.prepare('INSERT INTO users (username, gobiz, pass, note) VALUES (?, ?, ?, ?)').run(username, gobiz, passHash, note || null);
  else if (r.pass !== passHash || r.gobiz !== gobiz) db.prepare('UPDATE users SET gobiz = ?, pass = ?, pv = pv + 1, note = ? WHERE username = ?').run(gobiz, passHash, note || null, username);
  else if (r.note !== (note || null)) db.prepare('UPDATE users SET note = ? WHERE username = ?').run(note || null, username);
}
// Khach xem thu: chi khach trong khach-thu.json moi tu lay mat khau qua email (note 'khach thu email').
// Bi xoa khoi file -> khoa. Ban dau (31/10) co cap mat khau san (note 'khach thu') -> xoa mat khau, khach tu tao qua email.
function syncTrial(allowed) {
  for (const r of db.prepare("SELECT username, note FROM users WHERE note LIKE 'khach thu%' AND active = 1").all()) {
    if (!allowed.has(r.username)) db.prepare('UPDATE users SET active = 0, pv = pv + 1 WHERE username = ?').run(r.username);
    else if (r.note === 'khach thu') db.prepare("UPDATE users SET pass = NULL, note = 'khach thu email', pv = pv + 1 WHERE username = ?").run(r.username);
  }
}
// Tim khach Gobiz (bang gz_cust cua admin, chi doc) theo username hoac email. Tra { u, em, fn, grp } | { many: true } | null
function gobizFind(q) {
  const a = adminDb(); if (!a) return null;
  q = String(q || '').trim().toLowerCase(); if (!q || q.length > 120) return null;
  let rows;
  try { rows = q.includes('@') ? a.prepare("SELECT u, d FROM gz_cust WHERE lower(json_extract(d, '$.em')) = ? LIMIT 2").all(q) : a.prepare('SELECT u, d FROM gz_cust WHERE u = ?').all(q); } catch (e) { return null; }
  if (rows.length > 1) return { many: true };
  if (!rows.length) return null;
  let d = {}; try { d = JSON.parse(rows[0].d) || {}; } catch {}
  return { u: rows[0].u, em: String(d.em || '').trim(), fn: d.fn || '', grp: d.grp || '' };
}
// Ma tao mat khau qua email: chi luu ma bam, 30 phut, dung 1 lan
function pwTokenNew(username, email, ip) {
  const tok = crypto.randomBytes(32).toString('base64url');
  db.prepare('UPDATE pw_tokens SET used = 1 WHERE username = ? AND used = 0').run(username); // chi link moi nhat con dung
  db.prepare("INSERT INTO pw_tokens (h, username, email, ip, exp) VALUES (?, ?, ?, ?, ?)").run(crypto.createHash('sha256').update(tok).digest('hex'), username, email, ip || null, Date.now() + 30 * 60e3);
  db.prepare("DELETE FROM pw_tokens WHERE created_at < strftime('%Y-%m-%dT%H:%M:%fZ','now','-30 days')").run();
  return tok;
}
function pwTokenCount(username, ip) {
  const since = "strftime('%Y-%m-%dT%H:%M:%fZ','now','-1 hour')";
  return { u: db.prepare('SELECT COUNT(*) n FROM pw_tokens WHERE username = ? AND created_at > ' + since).get(username).n, ip: db.prepare('SELECT COUNT(*) n FROM pw_tokens WHERE ip = ? AND created_at > ' + since).get(ip || '').n };
}
function pwTokenPeek(tok) {
  const r = db.prepare('SELECT * FROM pw_tokens WHERE h = ?').get(crypto.createHash('sha256').update(String(tok || '')).digest('hex'));
  return r && !r.used && r.exp > Date.now() ? r : null;
}
// Dat mat khau bang ma: dung ma + ghi mat khau trong 1 lenh (chong bam 2 lan)
function pwTokenUse(tok, passHash) {
  const r = pwTokenPeek(tok); if (!r) return null;
  db.exec('BEGIN');
  try {
    if (db.prepare('UPDATE pw_tokens SET used = 1 WHERE h = ? AND used = 0').run(r.h).changes !== 1) { db.exec('ROLLBACK'); return null; }
    const u = getUser(r.username);
    if (u && !String(u.note || '').startsWith('khach thu')) { db.exec('ROLLBACK'); return null; } // khong dung email de chiem tai khoan noi bo
    if (!u) db.prepare("INSERT INTO users (username, gobiz, pass, note) VALUES (?, ?, ?, 'khach thu email')").run(r.username, r.username, passHash);
    else db.prepare("UPDATE users SET pass = ?, active = 1, note = 'khach thu email', pv = pv + 1 WHERE username = ?").run(passHash, r.username);
    db.exec('COMMIT');
  } catch (e) { db.exec('ROLLBACK'); throw e; }
  return getUser(r.username);
}
// Theo doi trang thai don Gobiz da bao khach (de bao thay doi)
function seenOf(username) { const m = new Map(); for (const r of db.prepare('SELECT code, st FROM gz_seen WHERE username = ?').all(username)) m.set(r.code, r.st); return m; }
function seenSave(username, rows) {
  const up = db.prepare("INSERT INTO gz_seen (username, code, st, ts) VALUES (?, ?, ?, strftime('%Y-%m-%dT%H:%M:%fZ','now')) ON CONFLICT(username, code) DO UPDATE SET st = excluded.st, ts = excluded.ts");
  db.exec('BEGIN'); try { for (const [c, st] of rows) up.run(username, c, st); db.exec('COMMIT'); } catch (e) { db.exec('ROLLBACK'); throw e; }
}
// Tai khoan dang dung web moi can bao don Gobiz doi trang thai
function watchUsers() { return db.prepare("SELECT username, gobiz FROM users WHERE active = 1 AND gobiz <> 'auto' AND (note LIKE 'khach thu%' OR note LIKE 'tai khoan test%')").all(); }
// Ma van don don ky gui Gobiz (admin: gz_ship_x, chi doc)
let wbStmt = null;
function shipWb(code) {
  const a = adminDb(); if (!a) return [];
  try { if (!wbStmt) wbStmt = a.prepare('SELECT wb FROM gz_ship_x WHERE code = ?'); const r = wbStmt.get(String(code)); const w = r ? JSON.parse(r.wb || '[]') : []; return Array.isArray(w) ? w.filter(Boolean) : []; } catch (e) { wbStmt = null; return []; }
}
function notifAdd(username, code, text) { db.prepare("INSERT INTO notif (username, code, text, kind) VALUES (?, ?, ?, 'order')").run(username, code, text); }
function watchPurge() {
  db.prepare("DELETE FROM gz_seen WHERE ts < strftime('%Y-%m-%dT%H:%M:%fZ','now','-90 days')").run();
  db.prepare("DELETE FROM notif WHERE created_at < strftime('%Y-%m-%dT%H:%M:%fZ','now','-180 days')").run();
}
function logLogin(u, ip, ok) {
  db.prepare('INSERT INTO login_log (username, ip, ok) VALUES (?, ?, ?)').run(String(u || '').slice(0, 64), ip, ok ? 1 : 0);
  db.prepare("DELETE FROM login_log WHERE ts < datetime('now', '-90 days')").run();
}
// ---------- Don Ship to China ----------
function cnRow(r) {
  const d = JSON.parse(r.data);
  delete d.staffNote; delete d.partnerFee; delete d.refTL; delete d.feeManual; // noi bo: khach khong thay
  d.ms = (d.ms || []).map((m) => ({ t: m.t, s: m.s }));
  return Object.assign(d, { code: r.code, status: ({ CN_WAREHOUSE: 'CLEARED', DISPATCHED: 'CLEARED' })[r.status] || r.status, created: r.created_at, modified: r.updated_at || r.created_at });
}
function cnCreate(username, gobiz, test, data, ip) {
  const by = 'khach:' + username;
  const chk = shared.checkUploads(db, by, data.photos || { pkg: [], prod: [] });
  if (chk.error) return chk;
  db.exec('BEGIN IMMEDIATE');
  try {
  const r = db.prepare('INSERT INTO cn_orders (code, username, gobiz, test, data) VALUES (?, ?, ?, ?, ?)').run('tmp-' + crypto.randomUUID(), username, gobiz, test ? 1 : 0, JSON.stringify(data));
  const seq = Number(r.lastInsertRowid); const code = 'SCN' + seq;
  db.prepare('UPDATE cn_orders SET code = ? WHERE seq = ?').run(code, seq);
  shared.claimUploads(db, username, data.photos || { pkg: [], prod: [] }, code);
  const np = (data.photos ? data.photos.pkg.length + data.photos.prod.length : 0);
  db.prepare('INSERT INTO cn_log (code, username, action, detail) VALUES (?, ?, ?, ?)').run(code, by, 'Khách tạo đơn', JSON.stringify({ changes: [], ip: ip || null, gobiz, photos: np }));
  db.exec('COMMIT');
  return { order: cnRow(db.prepare('SELECT * FROM cn_orders WHERE seq = ?').get(seq)) };
  } catch (e) { try { db.exec('ROLLBACK'); } catch {} throw e; }
}
function uploadSave(username, buf) { return shared.saveUpload(db, DATA_DIR, username, 'khach:' + username, buf); }
// Khach xem duoc anh minh tai, hoac anh gan vao don cua minh (ke ca don nhan vien tao gium)
function uploadCanSee(username, gobiz, id, chatOwner) {
  if (db.prepare('SELECT 1 FROM uploads u LEFT JOIN cn_orders o ON o.code = u.code WHERE u.id = ? AND (u.by = ? OR u.owner = ? OR o.username = ? OR (o.gobiz IS NOT NULL AND lower(o.gobiz) = lower(?)))').get(id, 'khach:' + username, username, username, gobiz || '')) return true;
  // Anh trong chat (ca anh nhan vien gui): thuoc cuoc chat cua khach nay
  return !!(chatOwner && db.prepare("SELECT 1 FROM uploads u JOIN chat_threads t ON u.code = 'chat:' || t.id WHERE u.id = ? AND t.owner = ?").get(id, chatOwner));
}
const uploadPath = (id) => shared.uploadFile(DATA_DIR, id);
function cnList(username, gobiz) { return db.prepare('SELECT * FROM cn_orders WHERE username = ? OR (gobiz IS NOT NULL AND lower(gobiz) = lower(?)) ORDER BY seq DESC LIMIT 500').all(username, gobiz || '').map(cnRow); }
function cnCountRecent(username) { return db.prepare("SELECT COUNT(*) AS n FROM cn_orders WHERE username = ? AND created_at > strftime('%Y-%m-%dT%H:%M:%fZ','now','-1 hour')").get(username).n; }
function cnCancel(username, code, ip, gobiz) {
  const r = db.prepare('SELECT * FROM cn_orders WHERE code = ? AND (username = ? OR (gobiz IS NOT NULL AND lower(gobiz) = lower(?)))').get(code, username, gobiz || '');
  if (!r) return { error: 'Không tìm thấy đơn', code: 404 };
  if (r.status !== 'PENDING') return { error: 'Đơn đã được kho tiếp nhận, không huỷ được. Vui lòng liên hệ nhân viên.', code: 409 };
  const d = JSON.parse(r.data); d.ms = (d.ms || []).concat([{ t: new Date().toISOString(), s: 'CANCELLED', by: 'khách' }]);
  db.prepare("UPDATE cn_orders SET status = 'CANCELLED', data = ?, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE seq = ?").run(JSON.stringify(d), r.seq);
  db.prepare('INSERT INTO cn_log (code, username, action, detail) VALUES (?, ?, ?, ?)').run(code, 'khach:' + username, 'Khách huỷ đơn', JSON.stringify({ changes: [['Trạng thái', 'Chờ tiếp nhận', 'Đã huỷ']], ip: ip || null }));
  return { order: cnRow(db.prepare('SELECT * FROM cn_orders WHERE seq = ?').get(r.seq)) };
}
// ===== Thong tin doanh nghiep xuat VAT (1 tai khoan nhieu cong ty) =====
const CO_MAX = 50;
function coRow(r) { return { id: r.id, name: r.name, taxId: r.tax_id, addr: r.addr, email: r.email, isDefault: !!r.is_default }; }
function coList(username) { return db.prepare('SELECT * FROM companies WHERE username = ? AND deleted = 0 ORDER BY is_default DESC, id').all(username).map(coRow); }
function coGet(username, id) { const r = db.prepare('SELECT * FROM companies WHERE id = ? AND username = ? AND deleted = 0').get(Number(id) || 0, username); return r ? coRow(r) : null; }
function coLog(username, id, action, detail) { db.prepare('INSERT INTO co_log (username, co_id, action, detail) VALUES (?, ?, ?, ?)').run(username, id, action, JSON.stringify(detail)); }
// c da duoc kiem tra hop le o server.js. Tra ve { co } hoac { error, code }
function coSave(username, c, ip) {
  db.exec('BEGIN IMMEDIATE');
  try {
    const dup = db.prepare('SELECT id FROM companies WHERE username = ? AND tax_id = ? AND deleted = 0').get(username, c.taxId);
    let id = c.id ? Number(c.id) : null, old = null;
    if (id) {
      old = db.prepare('SELECT * FROM companies WHERE id = ? AND username = ? AND deleted = 0').get(id, username);
      if (!old) { db.exec('ROLLBACK'); return { error: 'Không tìm thấy công ty', code: 404 }; }
      if (dup && dup.id !== id) { db.exec('ROLLBACK'); return { error: 'Mã số thuế ' + c.taxId + ' đã có trong danh sách', code: 409 }; }
      db.prepare("UPDATE companies SET name = ?, tax_id = ?, addr = ?, email = ?, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id = ?").run(c.name, c.taxId, c.addr, c.email, id);
      const ch = [['Tên công ty', old.name, c.name], ['MST', old.tax_id, c.taxId], ['Địa chỉ', old.addr, c.addr], ['Email', old.email, c.email]].filter((x) => x[1] !== x[2]);
      if (ch.length) coLog(username, id, 'Sửa', { changes: ch, ip });
    } else {
      if (dup) { db.exec('ROLLBACK'); return { co: coGet(username, dup.id), existed: true }; }
      const n = db.prepare('SELECT COUNT(*) AS n FROM companies WHERE username = ? AND deleted = 0').get(username).n;
      if (n >= CO_MAX) { db.exec('ROLLBACK'); return { error: 'Tối đa ' + CO_MAX + ' công ty', code: 409 }; }
      id = Number(db.prepare('INSERT INTO companies (username, name, tax_id, addr, email, is_default) VALUES (?, ?, ?, ?, ?, ?)').run(username, c.name, c.taxId, c.addr, c.email, n === 0 ? 1 : 0).lastInsertRowid);
      coLog(username, id, 'Thêm', { co: c, ip, from: c.from || 'cai-dat' });
    }
    if (c.isDefault) {
      db.prepare('UPDATE companies SET is_default = (id = ?) WHERE username = ? AND deleted = 0').run(id, username);
      coLog(username, id, 'Đặt mặc định', { ip });
    }
    db.exec('COMMIT');
    return { co: coGet(username, id) };
  } catch (e) { try { db.exec('ROLLBACK'); } catch {} throw e; }
}
function coDelete(username, id, ip) {
  const r = db.prepare('SELECT * FROM companies WHERE id = ? AND username = ? AND deleted = 0').get(Number(id) || 0, username);
  if (!r) return { error: 'Không tìm thấy công ty', code: 404 };
  // Xoa mem: don cu van giu ban chup thong tin cong ty
  db.prepare("UPDATE companies SET deleted = 1, is_default = 0, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id = ?").run(r.id);
  if (r.is_default) { const f = db.prepare('SELECT id FROM companies WHERE username = ? AND deleted = 0 ORDER BY id LIMIT 1').get(username); if (f) db.prepare('UPDATE companies SET is_default = 1 WHERE id = ?').run(f.id); }
  coLog(username, r.id, 'Xoá', { co: coRow(r), ip });
  return { ok: true };
}
function notifList(username) { return db.prepare('SELECT * FROM notif WHERE username = ? ORDER BY id DESC LIMIT 100').all(username).map((n) => ({ id: n.id, code: n.code, text: n.text, read: n.read, created_at: n.created_at, kind: n.kind || null })); }
function notifRead(username) { db.prepare('UPDATE notif SET read = 1 WHERE username = ? AND read = 0').run(username); }
function rawDb() { return db; }
// ---- Ten hang tieng Trung (AI dich nen): don 7 ngay gan day, chua huy, co dong hang thieu nameZh ----
function cnMissingZh(limit) {
  return db.prepare("SELECT code, data FROM cn_orders WHERE status <> 'CANCELLED' AND created_at > strftime('%Y-%m-%dT%H:%M:%fZ','now','-7 days') ORDER BY seq DESC LIMIT 200").all()
    .map((r) => { let d; try { d = JSON.parse(r.data); } catch { return null; } return { code: r.code, items: d.items || [], skip: (d.zhTry || 0) >= 3 }; })
    .filter((o) => o && !o.skip && o.items.some((i) => i && i.name && !i.nameZh)).slice(0, limit || 5);
}
// Ghi ten tieng Trung theo TEN hang (khong theo vi tri, phong khi nhan vien vua sua danh sach). ok=false: dem so lan loi, loi 3 lan thi thoi.
function cnSetZh(code, map, ok) {
  db.exec('BEGIN IMMEDIATE');
  try {
    const r = db.prepare('SELECT data FROM cn_orders WHERE code = ?').get(code);
    if (!r) { db.exec('COMMIT'); return; }
    const d = JSON.parse(r.data); let n = 0;
    for (const i of d.items || []) if (i && i.name && !i.nameZh && map[i.name]) { i.nameZh = map[i.name]; n++; }
    if (!ok) d.zhTry = (d.zhTry || 0) + 1;
    db.prepare('UPDATE cn_orders SET data = ? WHERE code = ?').run(JSON.stringify(d), code);
    if (n) db.prepare('INSERT INTO cn_log (code, username, action, detail) VALUES (?, ?, ?, ?)').run(code, 'he-thong', 'Dịch tên hàng sang tiếng Trung', JSON.stringify({ changes: [], n }));
    db.exec('COMMIT');
  } catch (e) { try { db.exec('ROLLBACK'); } catch {} throw e; }
}
// Tai khoan nhan nap tien do admin cai (doc tu DB admin, chi doc)
function adminKv(k) { const a = adminDb(); if (!a) return null; try { const r = a.prepare('SELECT v FROM kv WHERE k = ?').get(k); return r ? r.v : null; } catch (e) { return null; } }
function depositAccounts() { const a = adminDb(); if (!a) return []; try { const r = a.prepare("SELECT v FROM kv WHERE k = 'deposit_accounts'").get(); return r ? JSON.parse(r.v).filter((x) => x.active) : []; } catch (e) { return []; } }
module.exports = { cnMissingZh, cnSetZh, adminKv, depositAccounts, rawDb, uploadSave, uploadCanSee, uploadPath, coList, coGet, coSave, coDelete, notifList, notifRead, cnCreate, cnList, cnCountRecent, cnCancel, init, latestSnapshotId, snapshot, sessionSecret, getUser, checkPassword, upsertTest, syncTrial, gobizFind, pwTokenNew, pwTokenCount, pwTokenPeek, pwTokenUse, seenOf, seenSave, notifAdd, watchUsers, shipWb, watchPurge, logLogin, hash };
