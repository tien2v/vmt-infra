'use strict';
// Du lieu bo sung tu Gobiz (n8n luong "Dong bo bo sung", ky RSA giong /api/ingest):
// - Ky gui: van don (waybills), san pham (products), kien (parcels) cua tung don -> bang gz_ship_x
// - Khach hang: toan bo khach Gobiz + thong ke don (moi lan chi gui khach co thay doi, 1 gio gui du 1 lan) -> bang gz_cust
// Quan ly khach (sale / CSKH): ghi chu cham soc, nguoi phu trach, nhac lai -> cust_note, cust_owner (ghi them, co log)
const { DatabaseSync } = require('node:sqlite');
const path = require('node:path');
const fs = require('node:fs');

let db;
let ver = 0;
let activeStaff = null; // ham tra Set username nhan vien dang hoat dong (server gan)
function setActiveStaff(f) { activeStaff = f; } // tang moi khi du lieu ky gui bo sung doi -> server lam moi cache /api/data

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
  let ns = 0, nc = 0; const fresh = [];
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
    const had = db.prepare('SELECT 1 FROM gz_cust WHERE u = ?');
    const recent = new Date(Date.now() + 7 * 3600e3 - 3 * 86400e3).toISOString().slice(0, 10);
    for (const c of (Array.isArray(d.cust) ? d.cust : []).slice(0, 50000)) {
      if (!c || !c.u) continue;
      const k = String(c.u).toLowerCase().slice(0, 80);
      if (!had.get(k) && String(c.ca || '') >= recent) fresh.push({ k, grp: c.grp || 'default' });
      uc.run(k, S(c.code, 30), JSON.stringify(c), now); nc++;
    }
    db.exec('COMMIT');
  } catch (e) { db.exec('ROLLBACK'); throw e; }
  if (ns) ver = now;
  let auto = 0;
  if (fresh.length && staffCfg().auto && activeStaff) {
    try {
      const act = activeStaff();
      bulk(() => {
        const ps = splitPlan(fresh, 'sale', act).plan, pc = splitPlan(fresh, 'cskh', act).plan;
        for (const r of fresh) { const v = {}; if (ps.get(r.k)) v.sale = ps.get(r.k); if (pc.get(r.k)) v.cskh = pc.get(r.k); if (Object.keys(v).length && !db.prepare('SELECT 1 FROM cust_owner WHERE u = ? AND (sale IS NOT NULL OR cskh IS NOT NULL)').get(r.k) && assign(r.k, v, 'he-thong', 'Tự chia khách mới theo brand')) auto++; }
      });
    } catch (e) { console.error('auto split', e); }
  }
  return { ships: ns, cust: nc, auto };
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

// Viec nhac chua xong, han toi 'until' (YYYY-MM-DD), kem thong tin khach rut gon
function reminders(until) {
  return db.prepare("SELECT n.*, c.d AS cd, o.sale, o.cskh FROM cust_note n LEFT JOIN gz_cust c ON c.u = n.u LEFT JOIN cust_owner o ON o.u = n.u WHERE n.done = 0 AND n.remind IS NOT NULL AND substr(n.remind, 1, 10) <= ? ORDER BY n.remind, n.id LIMIT 500").all(until).map((r) => {
    let c = {}; try { c = r.cd ? JSON.parse(r.cd) : {}; } catch {}
    return { id: r.id, u: c.u || r.u, k: r.u, code: c.code || null, fn: c.fn || null, ph: c.ph || null, grp: c.grp || null, kind: r.kind, text: r.text, remind: r.remind, by: r.by, ts: r.ts, sale: r.sale || null, cskh: r.cskh || null };
  });
}

// Gan phu trach 1 phan (chi doi truong duoc truyen: sale / cskh; null = bo trong). Tra ve true neu co doi.
function assign(u, v, by, why) {
  u = String(u).toLowerCase();
  const old = db.prepare('SELECT * FROM cust_owner WHERE u = ?').get(u) || {};
  const sale = 'sale' in v ? (v.sale || null) : (old.sale || null), cskh = 'cskh' in v ? (v.cskh || null) : (old.cskh || null);
  const ch = [['Sale phụ trách', old.sale || null, sale], ['CSKH phụ trách', old.cskh || null, cskh]].filter((x) => x[1] !== x[2]);
  if (!ch.length) return false;
  db.prepare("INSERT INTO cust_owner (u, sale, cskh, tags, by, ts) VALUES (?, ?, ?, ?, ?, datetime('now', '+7 hours')) ON CONFLICT(u) DO UPDATE SET sale = excluded.sale, cskh = excluded.cskh, by = excluded.by, ts = excluded.ts").run(u, sale, cskh, old.tags || null, by);
  db.prepare('INSERT INTO cust_log (u, by, action, detail) VALUES (?, ?, ?, ?)').run(u, by, why || 'Gán phụ trách hàng loạt', JSON.stringify({ changes: ch }));
  return true;
}
function bulk(fn) { db.exec('BEGIN'); try { const r = fn(); db.exec('COMMIT'); return r; } catch (e) { db.exec('ROLLBACK'); throw e; } }
// Cau hinh nhan vien <-> brand: { username: { brands: ['default','vmtglobal'], kind: 'sale'|'cskh'|'both' } }, auto: tu chia khach moi
function kvGet(k) { const r = db.prepare('SELECT v FROM kv WHERE k = ?').get(k); return r ? r.v : null; }
function kvSet(k, v) { db.prepare('INSERT INTO kv (k, v) VALUES (?, ?) ON CONFLICT(k) DO UPDATE SET v = excluded.v').run(k, v); }
function staffCfg() { try { return JSON.parse(kvGet('kh_staff_brand') || '{}'); } catch { return {}; } }
function setStaffCfg(c) { kvSet('kh_staff_brand', JSON.stringify(c)); }
// Nhan vien cua 1 brand cho 1 viec (sale / cskh), xep theo ten de chia deu on dinh
function staffOf(brand, field, active) {
  const c = staffCfg().staff || {};
  return Object.keys(c).filter((u) => active.has(u) && (c[u].brands || []).includes(brand) && (c[u].kind === 'both' || c[u].kind === field)).sort();
}
// Chia deu: moi nhan vien nhan luot ke tiep, bat dau tu nguoi dang it khach nhat
function splitPlan(rows, field, active) {
  const load = {}; for (const r of db.prepare('SELECT ' + (field === 'sale' ? 'sale' : 'cskh') + ' AS x, COUNT(*) n FROM cust_owner WHERE x IS NOT NULL GROUP BY x').all()) load[r.x] = r.n;
  const plan = new Map(), byBrand = {};
  for (const r of rows) (byBrand[r.grp || 'default'] = byBrand[r.grp || 'default'] || []).push(r);
  const miss = [];
  for (const b in byBrand) {
    const st = staffOf(b, field, active);
    if (!st.length) { miss.push(b); continue; }
    for (const r of byBrand[b]) { st.sort((x, y) => (load[x] || 0) - (load[y] || 0) || x.localeCompare(y)); plan.set(r.k, st[0]); load[st[0]] = (load[st[0]] || 0) + 1; }
  }
  return { plan, miss };
}

module.exports = { setActiveStaff, assign, bulk, staffCfg, setStaffCfg, splitPlan, reminders, init, ingest, version, attachShips, allCust, custCount, getCust, owners, noteStats, notes, log, addNote, doneNote, setOwner };
