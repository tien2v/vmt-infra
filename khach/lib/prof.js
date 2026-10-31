'use strict';
// Ho so dung chung khach + nhan vien, du lieu o khach.db: anh dai dien, ten goi nho cua don, thong bao chung cho khach.
// 2 ban y het nhau: app/lib/prof.js va khach/lib/prof.js (sua 1 ban thi sua ca ban kia).
const fs = require('node:fs');
const path = require('node:path');

const NAME_MAX = 40; // ten goi nho: vua 1 dong tren dien thoai
const TB_MAX = 300; // chu thong bao chung
const now = () => new Date().toISOString();

function init(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS avatars (who TEXT PRIMARY KEY, id TEXT NOT NULL, at TEXT);
    CREATE TABLE IF NOT EXISTS aliases (
      owner TEXT NOT NULL, code TEXT NOT NULL, name TEXT, pend TEXT, pend_by TEXT, pend_at TEXT, at TEXT,
      PRIMARY KEY (owner, code)
    );
    CREATE TABLE IF NOT EXISTS alias_log (ts TEXT, owner TEXT, code TEXT, by TEXT, action TEXT, old TEXT, new TEXT);
    CREATE INDEX IF NOT EXISTS alias_log_oc ON alias_log (owner, code);
    CREATE TABLE IF NOT EXISTS announce (
      id INTEGER PRIMARY KEY AUTOINCREMENT, text TEXT NOT NULL, img TEXT, brand TEXT NOT NULL DEFAULT 'all',
      start_at TEXT, end_at TEXT, active INTEGER NOT NULL DEFAULT 1, by TEXT, created_at TEXT, updated_at TEXT
    );
    CREATE TABLE IF NOT EXISTS prof_log (ts TEXT, who TEXT, action TEXT, detail TEXT);
  `);
}
const plog = (db, who, action, detail) => db.prepare('INSERT INTO prof_log (ts, who, action, detail) VALUES (?, ?, ?, ?)').run(now(), who, action, detail == null ? null : String(detail));

// ---------- anh dai dien ----------
// who: 'k:<chu chat cua khach>' (= ma Gobiz, hoac 'test:<user>') | 's:<username nhan vien>'
const avCache = new Map(); // who -> { id, t }
function avatarOf(db, who) {
  const c = avCache.get(who);
  if (c && Date.now() - c.t < 60e3) return c.id;
  const r = db.prepare('SELECT id FROM avatars WHERE who = ?').get(who);
  const id = r ? r.id : null;
  avCache.set(who, { id, t: Date.now() });
  if (avCache.size > 5000) avCache.clear();
  return id;
}
// id = anh da tai len bang uploads (JPEG vuong, trinh duyet da cat + thu nho). Anh cu bi xoa (khong de rac).
function avatarSet(db, dir, who, id, upBy) {
  const up = db.prepare('SELECT id, code, by FROM uploads WHERE id = ?').get(id);
  if (!up || up.by !== upBy || (up.code && up.code !== 'avatar:' + who)) return { error: 'Ảnh không hợp lệ, chọn lại ảnh' };
  const old = db.prepare('SELECT id FROM avatars WHERE who = ?').get(who);
  db.prepare("UPDATE uploads SET code = ?, kind = 'avatar' WHERE id = ?").run('avatar:' + who, id);
  db.prepare('INSERT INTO avatars (who, id, at) VALUES (?, ?, ?) ON CONFLICT(who) DO UPDATE SET id = excluded.id, at = excluded.at').run(who, id, now());
  if (old && old.id !== id) {
    db.prepare('DELETE FROM uploads WHERE id = ?').run(old.id);
    try { fs.unlinkSync(path.join(dir, 'uploads', old.id + '.jpg')); } catch {}
  }
  avCache.delete(who);
  plog(db, who, 'Đổi ảnh đại diện', id);
  return { ok: true, id };
}
const isAvatar = (db, id) => !!db.prepare("SELECT 1 FROM avatars WHERE id = ?").get(id);

// ---------- ten goi nho don ----------
// owner = ma Gobiz cua khach (chu so huu don). Khach dat/sua thang; nhan vien chi de xuat -> cho khach xac nhan.
function clean(s) { return String(s == null ? '' : s).replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, NAME_MAX).trim(); }
function aliasMap(db, owner) {
  const out = {};
  for (const r of db.prepare('SELECT code, name, pend, pend_by FROM aliases WHERE owner = ?').all(String(owner).toLowerCase())) {
    const o = {};
    if (r.name) o.n = r.name;
    if (r.pend) { o.p = r.pend; o.pb = r.pend_by || ''; }
    if (o.n || o.p) out[r.code] = o;
  }
  return out;
}
function aliasGet(db, owner, code) { return db.prepare('SELECT * FROM aliases WHERE owner = ? AND code = ?').get(String(owner).toLowerCase(), code) || null; }
function aliasLog(db, owner, code) {
  return db.prepare('SELECT ts, by, action, old, new FROM alias_log WHERE owner = ? AND code = ? ORDER BY ts DESC LIMIT 50').all(String(owner).toLowerCase(), code);
}
function up(db, owner, code, fields) {
  db.prepare('INSERT INTO aliases (owner, code) VALUES (?, ?) ON CONFLICT(owner, code) DO NOTHING').run(owner, code);
  const keys = Object.keys(fields);
  db.prepare('UPDATE aliases SET ' + keys.map((k) => k + ' = ?').join(', ') + ', at = ? WHERE owner = ? AND code = ?').run(...keys.map((k) => fields[k]), now(), owner, code);
}
// Khach dat / sua / xoa (name rong = xoa). by = 'k:<username>'
function aliasSet(db, owner, code, name, by) {
  owner = String(owner).toLowerCase(); const n = clean(name);
  const cur = aliasGet(db, owner, code);
  if ((cur && cur.name || '') === n && !(cur && cur.pend)) return { ok: true, name: n };
  up(db, owner, code, { name: n || null, pend: null, pend_by: null, pend_at: null });
  db.prepare('INSERT INTO alias_log (ts, owner, code, by, action, old, new) VALUES (?, ?, ?, ?, ?, ?, ?)').run(now(), owner, code, by, n ? 'Khách đặt tên gợi nhớ' : 'Khách xoá tên gợi nhớ', cur && cur.name || null, n || null);
  return { ok: true, name: n };
}
// Nhan vien dat giup -> cho khach xac nhan. by = 's:<username>'
function aliasPropose(db, owner, code, name, by, byName) {
  owner = String(owner).toLowerCase(); const n = clean(name);
  if (!n) return { error: 'Nhập tên gợi nhớ' };
  const cur = aliasGet(db, owner, code);
  if (cur && cur.name === n) return { error: 'Đơn đã có đúng tên này' };
  up(db, owner, code, { pend: n, pend_by: byName || by, pend_at: now() });
  db.prepare('INSERT INTO alias_log (ts, owner, code, by, action, old, new) VALUES (?, ?, ?, ?, ?, ?, ?)').run(now(), owner, code, by, 'Nhân viên đề xuất tên gợi nhớ (chờ khách xác nhận)', cur && cur.name || null, n);
  return { ok: true, pend: n };
}
// Khach dong y / tu choi ten nhan vien de xuat
function aliasAnswer(db, owner, code, accept, by) {
  owner = String(owner).toLowerCase();
  const cur = aliasGet(db, owner, code);
  if (!cur || !cur.pend) return { error: 'Không còn tên nào chờ xác nhận' };
  if (accept) up(db, owner, code, { name: cur.pend, pend: null, pend_by: null, pend_at: null });
  else up(db, owner, code, { pend: null, pend_by: null, pend_at: null });
  db.prepare('INSERT INTO alias_log (ts, owner, code, by, action, old, new) VALUES (?, ?, ?, ?, ?, ?, ?)').run(now(), owner, code, by, accept ? 'Khách đồng ý tên nhân viên đặt' : 'Khách không dùng tên nhân viên đặt', cur.name || null, accept ? cur.pend : cur.name || null);
  return { ok: true, name: accept ? cur.pend : cur.name || '' };
}
// Them ten goi nho vao dau noi dung thong bao (chuong + day dien thoai)
function decorate(db, owner, code, text) {
  if (!code || !owner) return text;
  const r = db.prepare('SELECT name FROM aliases WHERE owner = ? AND code = ?').get(String(owner).toLowerCase(), code);
  return r && r.name && !String(text).startsWith(r.name) ? r.name + ' · ' + text : text;
}

// ---------- thong bao chung (nhan vien dang, khach xem) ----------
// Chu -> thanh nho tat duoc; co anh -> popup rieng 1 lan. brand: 'all' | 'green' (vominhthien) | 'yellow' (vmtglobal)
const annView = (r) => ({ id: r.id, text: r.text, img: r.img || null, brand: r.brand, start: r.start_at, end: r.end_at, active: !!r.active, by: r.by, created: r.created_at, updated: r.updated_at });
function annAll(db) { return db.prepare('SELECT * FROM announce ORDER BY id DESC LIMIT 100').all().map(annView); }
let annCache = null;
function annActive(db, brand) {
  if (!annCache || Date.now() - annCache.t > 30e3) {
    const t = now();
    annCache = { t: Date.now(), rows: db.prepare('SELECT * FROM announce WHERE active = 1 AND (start_at IS NULL OR start_at <= ?) AND (end_at IS NULL OR end_at > ?) ORDER BY id DESC LIMIT 10').all(t, t) };
  }
  return annCache.rows.filter((r) => r.brand === 'all' || r.brand === brand).map((r) => ({ id: r.id, text: r.text, img: r.img || null }));
}
const isAnnImg = (db, id) => !!db.prepare('SELECT 1 FROM announce WHERE img = ? AND active = 1').get(id);
function annSave(db, o, by) {
  const text = String(o.text || '').replace(/\r/g, '').trim().slice(0, TB_MAX);
  if (!text) return { error: 'Nhập nội dung thông báo' };
  const brand = ['all', 'green', 'yellow'].includes(o.brand) ? o.brand : 'all';
  const iso = (v) => { if (!v) return null; const d = new Date(v); return isNaN(d) ? undefined : d.toISOString(); };
  const start = iso(o.start), end = iso(o.end);
  if (start === undefined || end === undefined) return { error: 'Ngày giờ không hợp lệ' };
  if (start && end && end <= start) return { error: 'Giờ kết thúc phải sau giờ bắt đầu' };
  let img = o.img || null;
  if (img) {
    const u = db.prepare('SELECT id, code FROM uploads WHERE id = ?').get(img);
    if (!u) return { error: 'Ảnh không hợp lệ, tải lại ảnh' };
  }
  let id = Number(o.id) || 0;
  if (id) {
    const cur = db.prepare('SELECT * FROM announce WHERE id = ?').get(id);
    if (!cur) return { error: 'Không tìm thấy thông báo' };
    db.prepare('UPDATE announce SET text = ?, img = ?, brand = ?, start_at = ?, end_at = ?, updated_at = ? WHERE id = ?').run(text, img, brand, start, end, now(), id);
    plog(db, by, 'Sửa thông báo #' + id, text);
  } else {
    id = Number(db.prepare('INSERT INTO announce (text, img, brand, start_at, end_at, active, by, created_at) VALUES (?, ?, ?, ?, ?, 1, ?, ?)').run(text, img, brand, start, end, by, now()).lastInsertRowid);
    plog(db, by, 'Đăng thông báo #' + id, text);
  }
  if (img) db.prepare("UPDATE uploads SET code = ?, kind = 'tb' WHERE id = ?").run('tb:' + id, img);
  annCache = null;
  return { ok: true, id };
}
function annActiveSet(db, id, on, by) {
  const r = db.prepare('UPDATE announce SET active = ?, updated_at = ? WHERE id = ?').run(on ? 1 : 0, now(), Number(id) || 0);
  if (!r.changes) return { error: 'Không tìm thấy thông báo' };
  plog(db, by, (on ? 'Bật lại' : 'Tắt') + ' thông báo #' + id, null);
  annCache = null;
  return { ok: true };
}

module.exports = { init, NAME_MAX, avatarOf, avatarSet, isAvatar, clean, aliasMap, aliasGet, aliasLog, aliasSet, aliasPropose, aliasAnswer, decorate, annAll, annActive, isAnnImg, annSave, annActiveSet };
