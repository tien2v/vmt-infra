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
    CREATE TABLE IF NOT EXISTS users (
      username TEXT PRIMARY KEY, gobiz TEXT NOT NULL, pass TEXT, pv INTEGER NOT NULL DEFAULT 1,
      active INTEGER NOT NULL DEFAULT 1, note TEXT, created_at TEXT DEFAULT (datetime('now'))
    );
    CREATE TABLE IF NOT EXISTS login_log (ts TEXT DEFAULT (datetime('now')), username TEXT, ip TEXT, ok INTEGER);
    CREATE TABLE IF NOT EXISTS kv (k TEXT PRIMARY KEY, v TEXT);
  `);
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
module.exports = { init, latestSnapshotId, snapshot, sessionSecret, getUser, checkPassword, upsertTest, logLogin, hash };
