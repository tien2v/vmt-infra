'use strict';
// BAN KHO TQ — https://saas.7zone.net/kho (trang rieng, nhe, song ngu Trung–Viet, "khong cho mang").
// Thiet ke: Project decisions/ban-kho-tq.md. Mang TQ -> VPS VN cham (tai ve 0,15–1 Mbps, 1 request 1–4 giay)
// nen: dien thoai tai 1 lan danh sach hang dang o / sap ve kho TQ (chi chu, nen gzip, ETag -> lan sau 304),
// moi thao tac ghi vao hang doi tren may roi gui ngam theo lo (POST /kho/api/sync, idempotent theo id).
//
// Nguon kien: (1) Gobiz — ky gui (van don / kien / san pham) + don order (hang) tu snapshot, chi trang thai
// cho nhap / da ve kho TQ; (2) don ky gui moi cua he thong (khach.db ks_orders). Gobiz van la he thong chinh:
// ban kho chi GHI vao bang rieng cua minh (kho_*), khong day gi sang Gobiz.
//
// Lich su: moi thao tac = 1 dong kho_ev (ai, luc nao tren may, luc may chu nhan, du lieu) — khong xoa.
// Anh: /data/kho_photos/YYYYMM/<id>.jpg; anh khong gan vao kien nao sau 3 ngay -> xoa; anh giu 180 ngay.
// Kho khong bao gio nhan so tien (khong gui gia, phi, so du).
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const zlib = require('node:zlib');
const { DatabaseSync } = require('node:sqlite');

const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, '..', 'data');
const PHOTO_DIR = path.join(DATA_DIR, 'kho_photos');
const PHOTO_MAX = 1.5 * 1024 * 1024;
const PHOTO_KEEP_DAYS = 180;
const ISSUE_DUE_H = 48; // anh 31/10: van de ~2 ngay chua xu ly la phai bao bo phan lien quan
let db, getBase = () => null, ksadmin = null;

// Dich vu: khoa Gobiz / he thong moi -> nhan Trung (doc to) + Viet
const SVC = {
  inspection: ['点数', 'Kiểm đếm'], counting: ['点数', 'Kiểm đếm'], check: ['验货', 'Kiểm hàng'],
  insurance: ['保价', 'Bảo hiểm'], cargo_insurance: ['保价', 'Bảo hiểm'],
  wood_brace: ['打木架', 'Đóng gỗ'], special_packaging: ['打木架', 'Đóng gỗ'],
  paper_brace: ['纸护角', 'Nẹp giấy'], bubble_wrapping: ['缠气泡膜', 'Bọt khí'],
};
// Loai loi -> bo phan nhan (anh 31/10: loi nha ban -> order; loi khach -> CSKH + khach thay)
const ISSUE = {
  short: ['少货', 'Thiếu hàng', 'order'], wrong: ['发错货', 'Sai mẫu / size', 'order'], shop_damage: ['商家货损', 'Hỏng do shop', 'order'],
  fake: ['假货', 'Hàng giả / nhái', 'order'], ship_damage: ['国内快递破损', 'Móp / ướt do ship nội địa', 'order'],
  cust_info: ['客户信息错误', 'Khách khai sai / đặt sai', 'cskh'], banned: ['违禁 / 敏感货', 'Hàng cấm / nhạy cảm', 'cskh'],
  no_info: ['缺少信息', 'Thiếu thông tin hàng', 'cskh'], wh_damage: ['仓库损坏', 'Kho làm hỏng', 'admin'], other: ['其他', 'Khác', 'cskh'],
};
const DEPT = { order: ['采购', 'NV order'], cskh: ['客服', 'CSKH'], admin: ['管理', 'Quản lý'] };
const EV_TYPES = new Set(['in', 'photo', 'count', 'issue', 'svc', 'note']);

const nowVN = () => new Date(Date.now() + 7 * 3600e3).toISOString().replace('T', ' ').slice(0, 19);
const S = (v, max) => String(v == null ? '' : v).replace(/[\u0000-\u001f\u007f]/g, ' ').trim().slice(0, max);
const N = (v) => (v === null || v === undefined || v === '' || !isFinite(Number(v)) ? null : Number(v));
const J = (s, d) => { try { return JSON.parse(s); } catch { return d; } };

function init(opts) {
  getBase = opts.base; ksadmin = opts.ksadmin || null;
  fs.mkdirSync(PHOTO_DIR, { recursive: true });
  db = new DatabaseSync(path.join(DATA_DIR, 'vmt.db'));
  db.exec(`PRAGMA busy_timeout = 5000;
    CREATE TABLE IF NOT EXISTS kho_ev (id TEXT PRIMARY KEY, code TEXT NOT NULL, type TEXT NOT NULL, who TEXT NOT NULL, at TEXT, ts TEXT DEFAULT (datetime('now', '+7 hours')), data TEXT);
    CREATE INDEX IF NOT EXISTS kho_ev_code ON kho_ev (code);
    CREATE TABLE IF NOT EXISTS kho_pkg (code TEXT PRIMARY KEY, src TEXT, st TEXT, data TEXT NOT NULL, updated_at TEXT, updated_by TEXT);
    CREATE TABLE IF NOT EXISTS kho_issue (id INTEGER PRIMARY KEY AUTOINCREMENT, ev TEXT UNIQUE, code TEXT NOT NULL, kind TEXT NOT NULL, dept TEXT NOT NULL, note TEXT, photos TEXT,
      status TEXT NOT NULL DEFAULT 'open', by TEXT, ts TEXT DEFAULT (datetime('now', '+7 hours')), due TEXT, result TEXT, done_by TEXT, done_at TEXT);
    CREATE TABLE IF NOT EXISTS kho_photo (id TEXT PRIMARY KEY, code TEXT, by TEXT, size INTEGER, file TEXT, used INTEGER NOT NULL DEFAULT 0, ts TEXT DEFAULT (datetime('now', '+7 hours')));`);
  setInterval(prune, 6 * 3600e3).unref();
  setTimeout(prune, 90e3).unref();
}
function prune() {
  try {
    const old = db.prepare("SELECT id, file FROM kho_photo WHERE (used = 0 AND ts < datetime('now', '+7 hours', '-3 days')) OR ts < datetime('now', '+7 hours', ?)").all('-' + PHOTO_KEEP_DAYS + ' days');
    for (const p of old) { try { fs.unlinkSync(path.join(PHOTO_DIR, p.file)); } catch (e) {} db.prepare('DELETE FROM kho_photo WHERE id = ?').run(p.id); }
  } catch (e) { console.error('kho prune', e); }
}

// ---------- danh sach kien cho dien thoai ----------
const svcOf = (fe, extra) => {
  const out = new Set();
  for (const f of fe || []) if (SVC[f[0]]) out.add(f[0] === 'counting' ? 'inspection' : f[0] === 'cargo_insurance' ? 'insurance' : f[0] === 'special_packaging' ? 'wood_brace' : f[0]);
  for (const k of extra || []) if (SVC[k]) out.add(k === 'counting' ? 'inspection' : k);
  return [...out];
};
let idx = { key: '', raw: null, gz: null, etag: '' };
function list() {
  const base = getBase();
  const ksVer = ksadmin ? ksadmin.list('', '', 1).map((o) => o.modified).join() : '';
  const pv = (db.prepare('SELECT MAX(updated_at) m, COUNT(*) n FROM kho_pkg').get() || {});
  const key = [base ? base.gen + ':' + base.received : '', ksVer, pv.m, pv.n].join('|');
  if (idx.key === key && idx.raw) return idx;
  const cust = (base && base.cust) || {};
  const cc = (cid) => { const c = cust[cid]; return c ? [c[0] || '', c[1] || ''] : ['', '']; };
  const rows = [];
  // Gobiz ky gui: cho nhap kho TQ / da ve kho TQ
  for (const s of (base && base.ships) || []) {
    if (s.st !== 'MERCHANT_DELIVERING' && s.st !== 'PUTAWAY') continue;
    const [code, u] = cc(s.cid);
    rows.push({ k: 'g', c: s.code, st: s.st, cc: code, cu: u, dw: s.dw || '', wb: s.wb || [], sv: svcOf(s.fe),
      pk: (s.pk || []).map((p) => [p[0], p[1], p[3], p[4], p[5], p[8] || '']),
      it: (s.pr || []).map((x) => [x[0], x[1] || '', N(x[2]), x[5] || '']), ca: s.ca || '' });
  }
  // Gobiz don order: da mua / nguoi ban dang giao / da ve kho TQ (snapshot chua co van don -> tim theo ma don)
  for (const o of (base && base.orders) || []) {
    if (!['PURCHASED', 'MERCHANT_DELIVERING', 'PUTAWAY'].includes(o.st)) continue;
    const [code, u] = cc(o.cid);
    rows.push({ k: 'o', c: o.code, st: o.st, cc: code, cu: u, dw: o.dw || '', wb: [], sv: svcOf(o.fe), shop: o.shop || '',
      it: (o.it || []).map((x) => [x[0], x[2] || '', N(x[5]) || N(x[4]), x[3] || '']), ca: o.ca || '' });
  }
  // Don ky gui moi cua he thong
  if (ksadmin) for (const o of ksadmin.list('', '', 2000)) {
    if (o.status !== 'MERCHANT_DELIVERING' && o.status !== 'PUTAWAY') continue;
    rows.push({ k: 'n', c: o.code, st: o.status, cc: '', cu: o.gobiz || o.username, dw: o.wh || '', wb: o.wb ? [o.wb] : [], sv: svcOf(null, o.svcs), wc: o.whCnName || '',
      it: (o.items || []).map((x) => [x.nameZh ? x.nameZh + ' / ' + x.name : x.name, '', N(x.qty), '']), ca: o.created || '' });
  }
  // Tien do tren ban kho (moi dien thoai thay viec nguoi khac da lam)
  const st = {};
  for (const r of db.prepare('SELECT code, st, data, updated_at, updated_by FROM kho_pkg').all()) st[r.code] = Object.assign(J(r.data, {}), { st: r.st, at: r.updated_at, by: r.updated_by });
  for (const r of rows) if (st[r.c]) r.my = st[r.c];
  const unk = Object.keys(st).filter((c) => st[c].unk).map((c) => ({ k: 'u', c, st: 'UNKNOWN', cc: '', cu: '', dw: '', wb: [], sv: [], it: [], my: st[c] }));
  const raw = Buffer.from(JSON.stringify({ v: crypto.createHash('sha1').update(key).digest('hex').slice(0, 12), at: nowVN(), rows: rows.concat(unk) }));
  idx = { key, raw, gz: zlib.gzipSync(raw, { level: 9 }), etag: '"k' + crypto.createHash('sha1').update(raw).digest('base64url').slice(0, 16) + '"' };
  return idx;
}

// ---------- ap thao tac vao trang thai kien ----------
function pkgOf(code) { const r = db.prepare('SELECT * FROM kho_pkg WHERE code = ?').get(code); return r ? Object.assign(J(r.data, {}), { _st: r.st }) : null; }
function savePkg(code, src, st, d, who) {
  db.prepare('INSERT INTO kho_pkg (code, src, st, data, updated_at, updated_by) VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT(code) DO UPDATE SET st = excluded.st, data = excluded.data, updated_at = excluded.updated_at, updated_by = excluded.updated_by')
    .run(code, src, st, JSON.stringify(d), nowVN(), who);
}
function usePhotos(ids, code) { for (const id of ids || []) db.prepare('UPDATE kho_photo SET used = 1, code = ? WHERE id = ?').run(code, S(id, 40)); }

function apply(e, who) {
  const p = pkgOf(e.code) || {}; const src = S(e.data && e.data.k, 2) || p.src || '';
  const d = e.data || {}; let st = p._st || 'NEW'; delete p._st;
  if (e.type === 'in') { // nhan kien: luu so do neu nhap tay, ma kien noi bo, kien vo chu
    p.in = p.in || { at: e.at, by: who }; if (d.unk) p.unk = 1;
    if (d.kg != null || d.l != null) p.m = { kg: N(d.kg), l: N(d.l), w: N(d.w), h: N(d.h), at: e.at, by: who };
    if (d.note) p.note = S(d.note, 300);
    st = 'IN';
  } else if (e.type === 'photo') {
    p.ph = (p.ph || []).concat([[S(d.pid, 40), S(d.kind, 10), N(d.line)]]).slice(-60); usePhotos([d.pid], e.code);
  } else if (e.type === 'count') {
    const lines = (Array.isArray(d.lines) ? d.lines : []).slice(0, 200).map((l) => ({ i: N(l.i), want: N(l.want), got: N(l.got), st: S(l.st, 12), pids: (l.pids || []).slice(0, 10).map((x) => S(x, 40)) }));
    for (const l of lines) usePhotos(l.pids, e.code);
    p.cnt = { lines, done: !!d.done, sec: N(d.sec), at: e.at, by: who };
    if (d.done && st !== 'HOLD') st = 'COUNTED';
  } else if (e.type === 'issue') {
    const kind = ISSUE[d.kind] ? d.kind : 'other';
    usePhotos(d.pids, e.code);
    const due = new Date(Date.now() + 7 * 3600e3 + ISSUE_DUE_H * 3600e3).toISOString().replace('T', ' ').slice(0, 19);
    db.prepare('INSERT OR IGNORE INTO kho_issue (ev, code, kind, dept, note, photos, by, due) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
      .run(e.id, e.code, kind, ISSUE[kind][2], S(d.note, 500), JSON.stringify((d.pids || []).slice(0, 10)), who, due);
    p.hold = 1; st = 'HOLD';
  } else if (e.type === 'svc') {
    p.svc = Object.assign(p.svc || {}, { [S(d.svc, 30)]: d.done ? { at: e.at, by: who } : null });
  } else if (e.type === 'note') { p.note = S(d.note, 300); }
  savePkg(e.code, src, st, p, who);
}

// Nhan lo thao tac tu dien thoai. Moi thao tac co id (tao tren may) -> gui lai nhieu lan khong bi ghi doi.
function sync(evs, who) {
  const ok = [];
  db.exec('BEGIN');
  try {
    for (const raw of (Array.isArray(evs) ? evs : []).slice(0, 200)) {
      const id = S(raw && raw.id, 40), code = S(raw && raw.code, 60).toUpperCase(), type = S(raw && raw.type, 10);
      if (!/^[A-Za-z0-9_-]{8,40}$/.test(id) || !code || !EV_TYPES.has(type)) continue;
      if (db.prepare('SELECT 1 FROM kho_ev WHERE id = ?').get(id)) { ok.push(id); continue; }
      const e = { id, code, type, at: S(raw.at, 30), data: raw.data && typeof raw.data === 'object' ? raw.data : {} };
      const data = JSON.stringify(e.data); if (data.length > 20000) continue;
      db.prepare('INSERT INTO kho_ev (id, code, type, who, at, data) VALUES (?, ?, ?, ?, ?, ?)').run(id, code, type, who, e.at, data);
      apply(e, who); ok.push(id);
    }
    db.exec('COMMIT');
  } catch (err) { db.exec('ROLLBACK'); throw err; }
  return ok;
}

function savePhoto(id, code, buf, who) {
  id = S(id, 40);
  if (!/^[A-Za-z0-9_-]{8,40}$/.test(id)) return { error: 'id' };
  if (db.prepare('SELECT 1 FROM kho_photo WHERE id = ?').get(id)) return { ok: true, id }; // gui lai -> bo qua
  if (!buf.length || buf.length > PHOTO_MAX || buf[0] !== 0xff || buf[1] !== 0xd8) return { error: 'Ảnh không hợp lệ' };
  const ym = nowVN().slice(0, 7).replace('-', '');
  fs.mkdirSync(path.join(PHOTO_DIR, ym), { recursive: true });
  const file = ym + '/' + id + '.jpg';
  fs.writeFileSync(path.join(PHOTO_DIR, file), buf);
  db.prepare('INSERT INTO kho_photo (id, code, by, size, file) VALUES (?, ?, ?, ?, ?)').run(id, S(code, 60).toUpperCase(), who, buf.length, file);
  return { ok: true, id };
}
function photoFile(id) { const r = db.prepare('SELECT file FROM kho_photo WHERE id = ?').get(S(id, 40)); return r ? path.join(PHOTO_DIR, r.file) : null; }

function history(code) {
  return db.prepare('SELECT id, type, who, at, ts, data FROM kho_ev WHERE code = ? ORDER BY ts, at').all(S(code, 60).toUpperCase()).map((r) => Object.assign(r, { data: J(r.data, {}) }));
}
function issues(status) {
  return db.prepare('SELECT * FROM kho_issue WHERE (? = \'\' OR status = ?) ORDER BY id DESC LIMIT 300').all(status || '', status || '')
    .map((r) => Object.assign(r, { photos: J(r.photos, []), late: r.status === 'open' && r.due < nowVN() }));
}
// Bo phan xu ly xong -> kho thay ket qua, kien het Giu lai (neu khong con loi mo)
function resolveIssue(id, result, note, who) {
  const r = db.prepare("SELECT * FROM kho_issue WHERE id = ? AND status = 'open'").get(Number(id));
  if (!r) return { error: 'Không có lỗi đang mở này' };
  const RES = ['go', 'return', 'supplement', 'cancel'];
  if (!RES.includes(result)) return { error: 'Kết quả không hợp lệ' };
  db.prepare("UPDATE kho_issue SET status = 'done', result = ?, done_by = ?, done_at = ?, note = COALESCE(note, '') || ? WHERE id = ?")
    .run(result, who, nowVN(), note ? '\n[' + who + '] ' + S(note, 300) : '', r.id);
  const evId = 'r' + crypto.randomBytes(9).toString('base64url');
  db.prepare('INSERT INTO kho_ev (id, code, type, who, at, data) VALUES (?, ?, ?, ?, ?, ?)').run(evId, r.code, 'resolve', who, nowVN(), JSON.stringify({ issue: r.id, result, note: S(note, 300) }));
  if (!db.prepare("SELECT 1 FROM kho_issue WHERE code = ? AND status = 'open'").get(r.code)) {
    const p = pkgOf(r.code) || {}; delete p._st; delete p.hold;
    savePkg(r.code, p.src || '', result === 'go' ? (p.cnt && p.cnt.done ? 'COUNTED' : 'IN') : result.toUpperCase(), p, who);
  }
  return { ok: true };
}

module.exports = { init, list, sync, savePhoto, photoFile, history, issues, resolveIssue, SVC, ISSUE, DEPT };
