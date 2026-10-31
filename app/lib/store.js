'use strict';
// Luu tru bang SQLite co san trong Node 22 (file /data/vmt.db, nam trong volume -> khong mat khi cap nhat)
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { DatabaseSync } = require('node:sqlite');

const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, '..', 'data');
let db;

const ROLES = ['admin', 'sale', 'order', 'kho', 'tc'];

function init() {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  db = new DatabaseSync(path.join(DATA_DIR, 'vmt.db'));
  db.exec(`
    PRAGMA journal_mode = WAL;
    CREATE TABLE IF NOT EXISTS users (
      username TEXT PRIMARY KEY, name TEXT, role TEXT NOT NULL, pass TEXT NOT NULL,
      pv INTEGER NOT NULL DEFAULT 1, active INTEGER NOT NULL DEFAULT 1, created_at TEXT DEFAULT (datetime('now'))
    );
    CREATE TABLE IF NOT EXISTS snapshots (
      id INTEGER PRIMARY KEY AUTOINCREMENT, gen TEXT, ts INTEGER, bytes INTEGER, data TEXT,
      received_at TEXT DEFAULT (datetime('now'))
    );
    CREATE TABLE IF NOT EXISTS ingest_log (ts TEXT DEFAULT (datetime('now')), ok INTEGER, bytes INTEGER, note TEXT);
    CREATE TABLE IF NOT EXISTS login_log (ts TEXT DEFAULT (datetime('now')), username TEXT, ip TEXT, ok INTEGER);
    CREATE TABLE IF NOT EXISTS kv (k TEXT PRIMARY KEY, v TEXT);
    CREATE TABLE IF NOT EXISTS pw_tokens (h TEXT PRIMARY KEY, username TEXT NOT NULL, email TEXT, ip TEXT, exp INTEGER NOT NULL, used INTEGER NOT NULL DEFAULT 0, created_at TEXT DEFAULT (datetime('now')));
    CREATE INDEX IF NOT EXISTS pw_tokens_u ON pw_tokens (username, created_at);
  `);
  // 31/10: nhan vien dang nhap bang ten hoac email; dat mat khau qua link gui email (DB cu chua co cot email -> them)
  if (!db.prepare("SELECT 1 FROM pragma_table_info('users') WHERE name = 'email'").get()) db.exec('ALTER TABLE users ADD COLUMN email TEXT');
  db.exec('CREATE UNIQUE INDEX IF NOT EXISTS users_email ON users (email) WHERE email IS NOT NULL');
}

function sessionSecret() {
  if (process.env.SESSION_SECRET) return process.env.SESSION_SECRET;
  const row = db.prepare('SELECT v FROM kv WHERE k = ?').get('session_secret');
  if (row) return row.v;
  const s = crypto.randomBytes(32).toString('hex');
  db.prepare('INSERT INTO kv (k, v) VALUES (?, ?)').run('session_secret', s);
  return s;
}

// Mat khau: scrypt + muoi ngau nhien
function hash(pw) {
  const salt = crypto.randomBytes(16);
  const h = crypto.scryptSync(pw, salt, 32, { N: 16384, r: 8, p: 1 });
  return 'scrypt$' + salt.toString('base64') + '$' + h.toString('base64');
}
function verify(pw, stored) {
  const [, s, h] = String(stored).split('$');
  if (!s || !h) return false;
  const want = Buffer.from(h, 'base64');
  const got = crypto.scryptSync(pw, Buffer.from(s, 'base64'), want.length, { N: 16384, r: 8, p: 1 });
  return crypto.timingSafeEqual(want, got);
}
// Mat khau de go: chu thuong + so, bo ky tu de nham (0 o 1 l i)
function randomPassword(n = 12) {
  const a = 'abcdefghjkmnpqrstuvwxyz23456789';
  let s = ''; const b = crypto.randomBytes(n);
  for (let i = 0; i < n; i++) s += a[b[i] % a.length];
  return s;
}

function getUser(username) {
  const u = db.prepare('SELECT * FROM users WHERE username = ?').get(String(username || '').toLowerCase());
  return u ? Object.assign({}, u, { active: !!u.active }) : null;
}
// Ten dang nhap hoac email -> tai khoan
function findLogin(id) {
  id = String(id || '').trim().toLowerCase();
  if (!id.includes('@')) return getUser(id);
  const r = db.prepare('SELECT username FROM users WHERE email = ?').get(id);
  return r ? getUser(r.username) : null;
}
function checkPassword(username, pw) {
  const u = findLogin(username);
  if (!u || !u.active) { verify(pw, 'scrypt$AAAAAAAAAAAAAAAAAAAAAA==$AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA='); return null; }
  return verify(pw, u.pass) ? u : null;
}
function addUser(username, role, name) {
  username = String(username).trim().toLowerCase();
  if (!/^[a-z0-9._-]{3,32}$/.test(username)) throw new Error('Tên đăng nhập chỉ gồm chữ thường, số, . _ - (3-32 ký tự)');
  if (!ROLES.includes(role)) throw new Error('Vai trò phải là: ' + ROLES.join(', '));
  if (getUser(username)) throw new Error('Đã có tài khoản ' + username);
  const pw = randomPassword();
  db.prepare('INSERT INTO users (username, name, role, pass) VALUES (?, ?, ?, ?)').run(username, name || username, role, hash(pw));
  return pw;
}
function resetPassword(username) {
  const u = getUser(username);
  if (!u) throw new Error('Không có tài khoản ' + username);
  const pw = randomPassword();
  db.prepare('UPDATE users SET pass = ?, pv = pv + 1, active = 1 WHERE username = ?').run(hash(pw), u.username);
  return pw;
}
// Tai khoan nhan vien khai san (ten + email, chua co mat khau: pass '!' khong dang nhap duoc) — nhan vien tu dat mat khau qua email.
// Chi them tai khoan chua co / dien email con trong; khong doi vai tro, mat khau, trang thai cua tai khoan da co.
function seedStaff(list) {
  let n = 0;
  for (const x of Array.isArray(list) ? list : []) {
    const u = String(x && x.username || '').trim().toLowerCase(), email = String(x && x.email || '').trim().toLowerCase();
    if (!/^[a-z0-9._-]{3,32}$/.test(u) || !ROLES.includes(x.role) || (email && !/^[^\s@]+@[^\s@]+\.[a-z]{2,}$/.test(email))) continue;
    const cur = getUser(u);
    if (!cur) { db.prepare("INSERT INTO users (username, name, role, pass, email) VALUES (?, ?, ?, '!', ?)").run(u, String(x.name || u).slice(0, 60), x.role, email || null); n++; }
    else if (email && !cur.email && !db.prepare('SELECT 1 FROM users WHERE email = ?').get(email)) db.prepare('UPDATE users SET email = ? WHERE username = ?').run(email, u);
  }
  return n;
}
// Link dat mat khau: 30 phut, dung 1 lan, chi link moi nhat con dung; luu ma bam, khong luu link; tu xoa sau 30 ngay
const sha = (t) => crypto.createHash('sha256').update(String(t || '')).digest('hex');
function pwTokenNew(username, email, ip) {
  const tok = crypto.randomBytes(24).toString('base64url');
  db.prepare('UPDATE pw_tokens SET used = 1 WHERE username = ? AND used = 0').run(username);
  db.prepare('INSERT INTO pw_tokens (h, username, email, ip, exp) VALUES (?, ?, ?, ?, ?)').run(sha(tok), username, email, ip || null, Date.now() + 30 * 60e3);
  db.prepare("DELETE FROM pw_tokens WHERE created_at < datetime('now', '-30 days')").run();
  return tok;
}
function pwTokenCount(username, ip) {
  const since = "datetime('now', '-1 hour')";
  return { u: db.prepare('SELECT COUNT(*) n FROM pw_tokens WHERE username = ? AND created_at > ' + since).get(username).n, ip: db.prepare('SELECT COUNT(*) n FROM pw_tokens WHERE ip = ? AND created_at > ' + since).get(ip || '').n };
}
function pwTokenPeek(tok) {
  const r = db.prepare('SELECT * FROM pw_tokens WHERE h = ?').get(sha(tok));
  if (!r) return { error: 'Link không đúng · 链接无效' };
  if (r.used) return { error: 'Link đã dùng hoặc đã có link mới hơn · 链接已使用' };
  if (r.exp < Date.now()) return { error: 'Link đã hết hạn (30 phút) · 链接已过期' };
  const u = getUser(r.username);
  if (!u || !u.active) return { error: 'Tài khoản đã khoá · 账号已停用' };
  return { h: r.h, user: u };
}
function pwTokenUse(tok, pw) {
  const r = pwTokenPeek(tok); if (r.error) return r;
  db.exec('BEGIN');
  try {
    if (db.prepare('UPDATE pw_tokens SET used = 1 WHERE h = ? AND used = 0').run(r.h).changes !== 1) { db.exec('ROLLBACK'); return { error: 'Link đã dùng · 链接已使用' }; }
    db.prepare('UPDATE users SET pass = ?, pv = pv + 1 WHERE username = ?').run(hash(pw), r.user.username);
    db.exec('COMMIT');
  } catch (e) { db.exec('ROLLBACK'); throw e; }
  return { ok: true, user: getUser(r.user.username) };
}
function setActive(username, on) {
  const r = db.prepare('UPDATE users SET active = ?, pv = pv + 1 WHERE username = ?').run(on ? 1 : 0, String(username).toLowerCase());
  if (!r.changes) throw new Error('Không có tài khoản ' + username);
}
// Don tai khoan tam 'claude-ui' (da tat 30/10, go han 31/10)
function dropTempUsers() { db.prepare("DELETE FROM users WHERE username = 'claude-ui' AND role = 'ui'").run(); }
function listUsers() { return db.prepare("SELECT username, name, role, email, active, pass = '!' AS no_pass, created_at FROM users ORDER BY role, username").all(); }

// Lan dau chay: tao tai khoan admin, mat khau ghi vao /data/admin-password.txt de anh doc 1 lan
function ensureAdmin() {
  const n = db.prepare('SELECT COUNT(*) AS n FROM users').get().n;
  if (n > 0) return;
  const user = process.env.ADMIN_USER || 'tien2v';
  const pw = addUser(user, 'admin', 'Anh Tiến');
  const f = path.join(DATA_DIR, 'admin-password.txt');
  fs.writeFileSync(f, `Tai khoan: ${user}\nMat khau: ${pw}\n`, { mode: 0o600 });
  console.log('Da tao tai khoan admin ' + user + ' (mat khau trong ' + f + ')');
}

function saveSnapshot(gen, data, ts) {
  const r = db.prepare('INSERT INTO snapshots (gen, ts, bytes, data) VALUES (?, ?, ?, ?)').run(gen, ts, Buffer.byteLength(data), data);
  db.prepare('DELETE FROM snapshots WHERE id NOT IN (SELECT id FROM snapshots ORDER BY id DESC LIMIT 8)').run();
  return Number(r.lastInsertRowid);
}
function seenTs(ts) { return !!db.prepare('SELECT 1 FROM snapshots WHERE ts = ?').get(ts); }
function latestSnapshot() { return db.prepare('SELECT id, gen, data, received_at FROM snapshots ORDER BY id DESC LIMIT 1').get() || null; }
function latestMeta() { return db.prepare('SELECT id, gen, bytes, received_at FROM snapshots ORDER BY id DESC LIMIT 1').get() || null; }
function logIngest(ok, bytes, note) {
  db.prepare('INSERT INTO ingest_log (ok, bytes, note) VALUES (?, ?, ?)').run(ok ? 1 : 0, bytes, note);
  db.prepare("DELETE FROM ingest_log WHERE ts < datetime('now', '-30 days')").run();
}
function logLogin(username, ip, ok) {
  db.prepare('INSERT INTO login_log (username, ip, ok) VALUES (?, ?, ?)').run(username, ip, ok ? 1 : 0);
  db.prepare("DELETE FROM login_log WHERE ts < datetime('now', '-90 days')").run();
}
function recentIngest() { return db.prepare('SELECT * FROM ingest_log ORDER BY rowid DESC LIMIT 20').all(); }
function recentLogins() { return db.prepare('SELECT * FROM login_log ORDER BY rowid DESC LIMIT 30').all(); }

function kvGet(k) { const r = db.prepare('SELECT v FROM kv WHERE k = ?').get(k); return r ? r.v : null; }
function kvSet(k, v) { db.prepare('INSERT INTO kv (k, v) VALUES (?, ?) ON CONFLICT(k) DO UPDATE SET v = excluded.v').run(k, v); }
const rawDb = () => db;
module.exports = { rawDb, findLogin, seedStaff, pwTokenNew, pwTokenCount, pwTokenPeek, pwTokenUse, kvGet, kvSet, dropTempUsers, init, sessionSecret, ensureAdmin, getUser, checkPassword, addUser, resetPassword, setActive, listUsers, saveSnapshot, seenTs, latestSnapshot, latestMeta, logIngest, logLogin, recentIngest, recentLogins, ROLES };
