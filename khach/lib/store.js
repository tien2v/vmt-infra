'use strict';
// Du lieu rieng trang khach: /data/khach.db (tai khoan, nhat ky). Snapshot Gobiz doc tu DB admin (chi SELECT).
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { DatabaseSync } = require('node:sqlite');

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
    CREATE TABLE IF NOT EXISTS companies (
      id INTEGER PRIMARY KEY AUTOINCREMENT, username TEXT NOT NULL, name TEXT NOT NULL, tax_id TEXT NOT NULL, addr TEXT NOT NULL, email TEXT NOT NULL,
      is_default INTEGER NOT NULL DEFAULT 0, deleted INTEGER NOT NULL DEFAULT 0,
      created_at TEXT DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')), updated_at TEXT
    );
    CREATE UNIQUE INDEX IF NOT EXISTS companies_user_tax ON companies (username, tax_id) WHERE deleted = 0;
    CREATE TABLE IF NOT EXISTS co_log (ts TEXT DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')), username TEXT, co_id INTEGER, action TEXT, detail TEXT);
    CREATE TABLE IF NOT EXISTS cn_log (ts TEXT DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')), code TEXT, username TEXT, action TEXT, detail TEXT);
  `);
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
  const r = db.prepare('INSERT INTO cn_orders (code, username, gobiz, test, data) VALUES (?, ?, ?, ?, ?)').run('tmp-' + crypto.randomUUID(), username, gobiz, test ? 1 : 0, JSON.stringify(data));
  const seq = Number(r.lastInsertRowid); const code = 'SCN' + seq;
  db.prepare('UPDATE cn_orders SET code = ? WHERE seq = ?').run(code, seq);
  db.prepare('INSERT INTO cn_log (code, username, action, detail) VALUES (?, ?, ?, ?)').run(code, 'khach:' + username, 'Khách tạo đơn', JSON.stringify({ changes: [], ip: ip || null, gobiz }));
  return cnRow(db.prepare('SELECT * FROM cn_orders WHERE seq = ?').get(seq));
}
function cnList(username) { return db.prepare('SELECT * FROM cn_orders WHERE username = ? ORDER BY seq DESC LIMIT 500').all(username).map(cnRow); }
function cnCountRecent(username) { return db.prepare("SELECT COUNT(*) AS n FROM cn_orders WHERE username = ? AND created_at > strftime('%Y-%m-%dT%H:%M:%fZ','now','-1 hour')").get(username).n; }
function cnCancel(username, code, ip) {
  const r = db.prepare('SELECT * FROM cn_orders WHERE code = ? AND username = ?').get(code, username);
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
function notifList(username) { return db.prepare('SELECT id, code, text, read, created_at FROM notif WHERE username = ? ORDER BY id DESC LIMIT 50').all(username); }
function notifRead(username) { db.prepare('UPDATE notif SET read = 1 WHERE username = ? AND read = 0').run(username); }
module.exports = { coList, coGet, coSave, coDelete, notifList, notifRead, cnCreate, cnList, cnCountRecent, cnCancel, init, latestSnapshotId, snapshot, sessionSecret, getUser, checkPassword, upsertTest, logLogin, hash };
