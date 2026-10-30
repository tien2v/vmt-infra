'use strict';
// Du lieu bo sung tu Gobiz (n8n luong "Dong bo bo sung", ky RSA giong /api/ingest):
// - Ky gui: van don (waybills), san pham (products), kien (parcels) cua tung don -> bang gz_ship_x
// - Khach hang: toan bo khach Gobiz + thong ke don (moi lan chi gui khach co thay doi, 1 gio gui du 1 lan) -> bang gz_cust
// Quan ly khach (sale / CSKH): ghi chu cham soc, nguoi phu trach, nhac lai -> cust_note, cust_owner (ghi them, co log)
const { DatabaseSync } = require('node:sqlite');
const path = require('node:path');
const fs = require('node:fs');

let db;
let ver = 0; // tang moi khi du lieu ky gui bo sung doi -> server lam moi cache /api/data

function init(dataDir) {
  fs.mkdirSync(dataDir, { recursive: true });
  db = new DatabaseSync(path.join(dataDir, 'vmt.db'));
  db.exec(`
    CREATE TABLE IF NOT EXISTS gz_ship_x (code TEXT PRIMARY KEY, wb TEXT, pr TEXT, pk TEXT, ts INTEGER);
    CREATE TABLE IF NOT EXISTS gz_cust (u TEXT PRIMARY KEY, code TEXT, d TEXT, ts INTEGER);
    CREATE TABLE IF NOT EXISTS cust_note (id INTEGER PRIMARY KEY AUTOINCREMENT, u TEXT NOT NULL, kind TEXT, text TEXT, remind TEXT, done INTEGER DEFAULT 0, by TEXT, ts TEXT DEFAULT (datetime('now', '+7 hours')));
    CREATE INDEX IF NOT EXISTS cust_note_u ON cust_note(u);
    CREATE TABLE IF NOT EXISTS cust_owner (u TEXT PRIMARY KEY, sale TEXT, cskh TEXT, tags TEXT, by TEXT, ts TEXT DEFAULT (datetime('now', '+7 hours')));
    CREATE TABLE IF NOT EXISTS cust_log (id INTEGER PRIMARY KEY AUTOINCREMENT, u TEXT, by TEXT, action TEXT, detail TEXT, ts TEXT DEFAULT (datetime('now', '+7 hours')));
  `);
  ver = Number((db.prepare('SELECT MAX(ts) m FROM gz_ship_x').get() || {}).m || 0);
}

const S = (v, n = 300) => (v === null || v === undefined ? null : String(v).slice(0, n));
const N = (v) => (v === null || v === undefined || v === '' || !isFinite(Number(v)) ? null : Number(v));

// d = { ships: [{ code, wb:[..], pr:[[ten, anh, sl, don gia, link, thuoc tinh]], pk:[[ma, kg, quy doi, D, R, C, trang thai, gio, anh]] }], cust: [...] }
function ingest(d) {
  const now = Date.now();
  let ns = 0, nc = 0;
  db.exec('BEGIN');
  try {
    const up = db.prepare('INSERT INTO gz_ship_x (code, wb, pr, pk, ts) VALUES (?, ?, ?, ?, ?) ON CONFLICT(code) DO UPDATE SET wb = excluded.wb, pr = excluded.pr, pk = excluded.pk, ts = excluded.ts');
    for (const s of (Array.isArray(d.ships) ? d.ships : []).slice(0, 20000)) {
      if (!s || !s.code) continue;
      const wb = (Array.isArray(s.wb) ? s.wb : []).map((x) => S(x, 60)).filter(Boolean).slice(0, 50);
      const pr = (Array.isArray(s.pr) ? s.pr : []).slice(0, 100).map((x) => [S(x[0], 200), S(x[1], 400), N(x[2]), N(x[3]), S(x[4], 400), S(x[5], 200)]);
      const pk = (Array.isArray(s.pk) ? s.pk : []).slice(0, 200).map((x) => [S(x[0], 60), N(x[1]), N(x[2]), N(x[3]), N(x[4]), N(x[5]), S(x[6], 40), S(x[7], 20), S(x[8], 400)]);
      up.run(S(s.code, 60), JSON.stringify(wb), JSON.stringify(pr), JSON.stringify(pk), now); ns++;
    }
    const uc = db.prepare('INSERT INTO gz_cust (u, code, d, ts) VALUES (?, ?, ?, ?) ON CONFLICT(u) DO UPDATE SET code = excluded.code, d = excluded.d, ts = excluded.ts');
    for (const c of (Array.isArray(d.cust) ? d.cust : []).slice(0, 50000)) {
      if (!c || !c.u) continue;
      uc.run(String(c.u).toLowerCase().slice(0, 80), S(c.code, 30), JSON.stringify(c), now); nc++;
    }
    db.exec('COMMIT');
  } catch (e) { db.exec('ROLLBACK'); throw e; }
  if (ns) ver = now;
  return { ships: ns, cust: nc };
}

function version() { return ver; }

// Gan van don / san pham / kien vao danh sach ky gui (goi khi lam moi cache). money=false -> bo don gia.
function attachShips(ships) {
  if (!ships || !ships.length) return;
  const get = db.prepare('SELECT wb, pr, pk FROM gz_ship_x WHERE code = ?');
  for (const s of ships) {
    const r = get.get(s.code); if (!r) continue;
    try { s.wb = JSON.parse(r.wb); s.pr = JSON.parse(r.pr); s.pk = JSON.parse(r.pk); } catch {}
  }
}

// ---- khach hang ----
function allCust() {
  return db.prepare('SELECT u, d FROM gz_cust').all().map((r) => { try { return JSON.parse(r.d); } catch { return null; } }).filter(Boolean);
}
function custCount() { return (db.prepare('SELECT COUNT(*) n FROM gz_cust').get() || {}).n || 0; }
function getCust(u) { const r = db.prepare('SELECT d FROM gz_cust WHERE u = ?').get(String(u).toLowerCase()); try { return r ? JSON.parse(r.d) : null; } catch { return null; } }
function owners() { const m = {}; for (const r of db.prepare('SELECT * FROM cust_owner').all()) m[r.u] = r; return m; }
function noteStats() {
  const m = {};
  for (const r of db.prepare("SELECT u, COUNT(*) n, MAX(ts) last, SUM(CASE WHEN remind IS NOT NULL AND done = 0 THEN 1 ELSE 0 END) open, MIN(CASE WHEN remind IS NOT NULL AND done = 0 THEN remind END) next FROM cust_note GROUP BY u").all()) m[r.u] = r;
  return m;
}
function notes(u) { return db.prepare('SELECT * FROM cust_note WHERE u = ? ORDER BY id DESC LIMIT 200').all(String(u).toLowerCase()); }
function log(u) { return db.prepare('SELECT * FROM cust_log WHERE u = ? ORDER BY id DESC LIMIT 100').all(String(u).toLowerCase()); }
const KINDS = ['note', 'call', 'zalo', 'meet', 'care', 'complain'];
function addNote(u, b, by) {
  u = String(u).toLowerCase();
  const text = String(b.text || '').trim().slice(0, 2000);
  if (!text) return { error: 'Chưa nhập nội dung', code: 400 };
  const kind = KINDS.includes(b.kind) ? b.kind : 'note';
  const remind = /^\d{4}-\d{2}-\d{2}( \d{2}:\d{2})?$/.test(String(b.remind || '')) ? String(b.remind) : null;
  const r = db.prepare('INSERT INTO cust_note (u, kind, text, remind, by) VALUES (?, ?, ?, ?, ?)').run(u, kind, text, remind, by);
  db.prepare('INSERT INTO cust_log (u, by, action, detail) VALUES (?, ?, ?, ?)').run(u, by, 'Thêm ghi chú', JSON.stringify({ id: Number(r.lastInsertRowid), kind, remind }));
  return { ok: true };
}
function doneNote(u, id, by) {
  u = String(u).toLowerCase();
  const r = db.prepare('UPDATE cust_note SET done = 1 WHERE id = ? AND u = ? AND done = 0').run(Number(id), u);
  if (!r.changes) return { error: 'Không tìm thấy việc cần nhắc', code: 404 };
  db.prepare('INSERT INTO cust_log (u, by, action, detail) VALUES (?, ?, ?, ?)').run(u, by, 'Xong việc nhắc', JSON.stringify({ id: Number(id) }));
  return { ok: true };
}
function setOwner(u, b, by) {
  u = String(u).toLowerCase();
  const old = db.prepare('SELECT * FROM cust_owner WHERE u = ?').get(u) || {};
  const v = { sale: S(b.sale, 40) || null, cskh: S(b.cskh, 40) || null, tags: S((Array.isArray(b.tags) ? b.tags : String(b.tags || '').split(',')).map((x) => String(x).trim()).filter(Boolean).slice(0, 10).join(','), 300) || null };
  db.prepare("INSERT INTO cust_owner (u, sale, cskh, tags, by, ts) VALUES (?, ?, ?, ?, ?, datetime('now', '+7 hours')) ON CONFLICT(u) DO UPDATE SET sale = excluded.sale, cskh = excluded.cskh, tags = excluded.tags, by = excluded.by, ts = excluded.ts").run(u, v.sale, v.cskh, v.tags, by);
  const ch = [['Sale phụ trách', old.sale || null, v.sale], ['CSKH phụ trách', old.cskh || null, v.cskh], ['Nhãn', old.tags || null, v.tags]].filter((x) => x[1] !== x[2]);
  if (ch.length) db.prepare('INSERT INTO cust_log (u, by, action, detail) VALUES (?, ?, ?, ?)').run(u, by, 'Đổi phụ trách / nhãn', JSON.stringify({ changes: ch }));
  return { ok: true };
}

module.exports = { init, ingest, version, attachShips, allCust, custCount, getCust, owners, noteStats, notes, log, addNote, doneNote, setOwner };
