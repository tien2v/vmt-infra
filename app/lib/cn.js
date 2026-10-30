'use strict';
// Don Ship to China (SCN) do khach tao tren trang khach, luu o khach.db (/khach). Trang admin doc + cap nhat.
const fs = require('node:fs');
const price = require('./price');
const { DatabaseSync } = require('node:sqlite');

const KHACH_DB = process.env.KHACH_DB || '/khach/khach.db';
let db;
function open() {
  if (db) return db;
  if (!fs.existsSync(KHACH_DB)) return null;
  db = new DatabaseSync(KHACH_DB);
  db.exec('PRAGMA busy_timeout = 5000');
  db.exec("CREATE TABLE IF NOT EXISTS notif (id INTEGER PRIMARY KEY AUTOINCREMENT, username TEXT NOT NULL, code TEXT, text TEXT NOT NULL, read INTEGER NOT NULL DEFAULT 0, created_at TEXT DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')))");
  return db;
}

// Quy trinh (anh chot 30/10): khach tao -> kho quet NHAP KHO -> dien ma doi chieu, can, kich thuoc -> Tai Loc toi lay, kho quet XUAT KHO
// -> cho thong quan -> Tai Loc bao ma chuyen phat TQ (tu dien) -> bao khach -> giao thanh cong
const STATUSES = ['PENDING', 'VN_WAREHOUSE', 'TRANSPORTING', 'CLEARED', 'DELIVERED', 'CANCELLED'];
const LEGACY = { CN_WAREHOUSE: 'CLEARED', DISPATCHED: 'CLEARED' };
const LABEL = { PENDING: 'Chờ tiếp nhận', VN_WAREHOUSE: 'Đã nhập kho VN', TRANSPORTING: 'Đã xuất kho, chờ thông quan', CLEARED: 'Đã thông quan, đang giao tại TQ', DELIVERED: 'Giao thành công', CANCELLED: 'Đã huỷ' };
const MONEY = ['fee', 'paid', 'unpaid', 'refund', 'value', 'partnerFee', 'est', 'feeLines'];
// Ai sua duoc gi: kho = trang thai, can, kien, ma van chuyen; tai chinh/sale/admin = them phi
const CAN_EDIT = {
  admin: ['status', 'w', 'dims', 'pk', 'wbCn', 'refTL', 'staffNote', 'fee', 'paid', 'recalc'],
  kho: ['status', 'w', 'dims', 'pk', 'wbCn', 'refTL', 'staffNote'],
  tc: ['fee', 'paid', 'refTL', 'staffNote', 'recalc'],
  sale: ['staffNote'],
  order: [],
};

function row(r, role) {
  const d = JSON.parse(r.data);
  const o = Object.assign(d, { code: r.code, status: LEGACY[r.status] || r.status, username: r.username, gobiz: r.gobiz, test: !!r.test, created: r.created_at, modified: r.updated_at || r.created_at });
  if (!['admin', 'tc'].includes(role)) delete o.partnerFee;
  if (role === 'kho') { for (const k of MONEY) delete o[k]; o.items = (o.items || []).map((i) => ({ name: i.name, qty: i.qty })); }
  return o;
}
function list(role, opts = {}) {
  const d = open(); if (!d) return [];
  const where = []; const args = [];
  if (opts.status && STATUSES.includes(opts.status)) { where.push('status = ?'); args.push(opts.status); }
  if (opts.active) where.push("status NOT IN ('DELIVERED','CANCELLED')");
  if (!opts.withTest) where.push('test = 0');
  const sql = 'SELECT * FROM cn_orders' + (where.length ? ' WHERE ' + where.join(' AND ') : '') + ' ORDER BY seq DESC LIMIT 1000';
  return d.prepare(sql).all(...args).map((r) => row(r, role));
}
function counts(withTest) {
  const d = open(); if (!d) return {};
  const out = {};
  for (const r of d.prepare('SELECT status, COUNT(*) n FROM cn_orders' + (withTest ? '' : ' WHERE test = 0') + ' GROUP BY status').all()) { const k = LEGACY[r.status] || r.status; out[k] = (out[k] || 0) + r.n; }
  return out;
}
function quoteOf(o) {
  return price.quote({ cls: o.cat, method: ((o.fees || []).find((f) => /shipping/.test(f.t)) || {}).t, weight: o.w, dims: o.dims, value: o.value,
    insurance: (o.svcs || []).includes('insurance'), origin: o.wh, vat: !!o.vat });
}
const vnd = (n) => (n == null ? '' : Math.round(n).toLocaleString('vi-VN') + 'đ');
// Bao khach tren trang khach (chuong thong bao) khi don doi trang thai / co ma TQ
function notifyChange(d, r, o, before, after, wbBefore) {
  const msgs = [];
  if (after !== before) {
    if (after === 'VN_WAREHOUSE') msgs.push('Kho VMT đã nhận hàng đơn ' + r.code + '.');
    if (after === 'TRANSPORTING') msgs.push('Đơn ' + r.code + ' đã xuất kho, đang chờ thông quan sang Trung Quốc' + (o.fee ? '. Phí vận chuyển: ' + vnd(o.fee) : '') + '.');
    if (after === 'CLEARED') msgs.push('Đơn ' + r.code + ' đã thông quan' + (o.wbCn ? '. Mã chuyển phát tại Trung Quốc: ' + o.wbCn : '') + '.');
    if (after === 'DELIVERED') msgs.push('Đơn ' + r.code + ' đã giao thành công.');
    if (after === 'CANCELLED') msgs.push('Đơn ' + r.code + ' đã bị huỷ. Liên hệ nhân viên nếu cần hỗ trợ.');
  } else if (o.wbCn && o.wbCn !== wbBefore && after === 'CLEARED') msgs.push('Đơn ' + r.code + ' có mã chuyển phát tại Trung Quốc: ' + o.wbCn + '.');
  for (const t of msgs) d.prepare('INSERT INTO notif (username, code, text) VALUES (?, ?, ?)').run(r.username, r.code, t);
}
function missingOf(o) {
  const m = [];
  if (!(o.w > 0)) m.push('cân nặng');
  if (!o.dims) m.push('kích thước');
  if (!(o.pk > 0)) m.push('số kiện');
  return m;
}
// Ma bill Tai Loc: "BILL TL 42909", "TL42909", "042909" deu hieu la 42909
const normRef = (v) => String(v || '').toUpperCase().replace(/\s+/g, '').replace(/^(BILL)?TL/, '').replace(/[^0-9A-Z]/g, '').replace(/^0+(?=\d)/, '');
function findByRef(v) {
  const d = open(); if (!d) return null; const n = normRef(v); if (!n) return null;
  for (const x of d.prepare("SELECT code, data FROM cn_orders WHERE status <> 'CANCELLED' ORDER BY seq DESC LIMIT 5000").all()) { const o = JSON.parse(x.data); if (o.refTL && normRef(o.refTL) === n) return x; }
  return null;
}
// Quet ma tai kho: tim theo ma SCN, ma doi chieu Tai Loc hoac van don khach gui
function findByScan(code) {
  const d = open(); if (!d) return null;
  const c = String(code || '').trim().toUpperCase().replace(/\s+/g, '');
  if (!c) return null;
  let r = d.prepare('SELECT * FROM cn_orders WHERE upper(code) = ?').get(c);
  if (r) return r;
  for (const x of d.prepare("SELECT * FROM cn_orders WHERE status NOT IN ('DELIVERED','CANCELLED') ORDER BY seq DESC LIMIT 3000").all()) {
    const o = JSON.parse(x.data);
    if ((o.refTL && normRef(o.refTL) === normRef(c)) || (o.wbs || []).includes(c) || String(o.wbCn || '').toUpperCase() === c) return x;
  }
  return null;
}
function scan(code, mode, role, staff, force, ref) {
  const d = open(); if (!d) return { code: 503, error: 'Chưa có dữ liệu' };
  if (!['admin', 'kho'].includes(role)) return { code: 403, error: 'Chỉ kho hoặc admin được quét' };
  const r = findByScan(code);
  if (!r) return { code: 404, error: 'Không tìm thấy đơn với mã ' + code };
  const o = JSON.parse(r.data); const st = LEGACY[r.status] || r.status; const who = 'staff:' + staff;
  if (mode === 'in') {
    if (st === 'PENDING') { const res = update(r.code, role, staff, { status: 'VN_WAREHOUSE' }, { action: 'Quét nhập kho', extra: { scanned: code } }); return Object.assign(res, { result: 'Đã nhập kho', missing: missingOf(o) }); }
    if (st === 'VN_WAREHOUSE') { event(r.code, who, 'Quét nhập kho lại (đã nhập trước đó)', { scanned: code }); return { order: row(r, role), result: 'Đơn đã nhập kho trước đó', missing: missingOf(o), warn: true }; }
    return { code: 409, error: 'Đơn ' + r.code + ' đang ở trạng thái "' + LABEL[st] + '", không nhập kho được' };
  }
  if (mode === 'out') {
    if (st !== 'VN_WAREHOUSE') return { code: 409, error: 'Đơn ' + r.code + ' đang "' + LABEL[st] + '". Chỉ xuất kho đơn đã nhập kho.' };
    const miss = missingOf(o);
    if (miss.length && !(force && role === 'admin')) return { code: 409, error: 'Đơn ' + r.code + ' còn thiếu: ' + miss.join(', ') + '. Điền đủ rồi quét lại.', missing: miss, order: row(r, role) };
    // Luot 1: quet ma VMT (SCN) -> cho quet bill Tai Loc. Luot 2: quet bill Tai Loc -> ghi ma doi chieu + xuat kho
    if (!ref) return { order: row(r, role), result: 'Quét tiếp mã bill Tài Lộc của đơn ' + r.code, needRef: true, missing: [] };
    const res = update(r.code, role, staff, { refTL: String(ref).trim(), status: 'TRANSPORTING' }, { action: 'Quét xuất kho (giao Tài Lộc)' + (force && miss.length ? ' — admin cho xuất khi còn thiếu: ' + miss.join(', ') : ''), extra: { scanned: code, billTL: ref } });
    if (res.error) return res;
    return Object.assign(res, { result: 'Đã xuất kho, chờ thông quan', missing: [] });
  }
  return { code: 400, error: 'Chế độ quét không hợp lệ' };
}
// Ma chuyen phat TQ do Tai Loc bao (n8n doc tin nhan roi gui sang, co chu ky)
// eta: "14.10" hoac "14/10/2026" -> YYYY-MM-DD (nam hien tai; neu lui qua 6 thang thi sang nam sau)
function parseEta(v) {
  const m = String(v || '').match(/(\d{1,2})[./-](\d{1,2})(?:[./-](\d{2,4}))?/); if (!m) return null;
  const now = new Date(Date.now() + 7 * 3600e3); let y = m[3] ? Number(m[3].length === 2 ? '20' + m[3] : m[3]) : now.getUTCFullYear();
  const dd = String(m[1]).padStart(2, '0'), mm = String(m[2]).padStart(2, '0');
  let s = y + '-' + mm + '-' + dd; if (!m[3] && Date.parse(s) < now.getTime() - 180 * 86400e3) s = (y + 1) + '-' + mm + '-' + dd;
  return isNaN(Date.parse(s)) ? null : s;
}
function track(ref, wbCn, eta, extra) {
  const d = open(); if (!d) return { code: 503, error: 'Chưa có dữ liệu' };
  const r = findByScan(ref) || (findByRef(ref) && d.prepare('SELECT * FROM cn_orders WHERE code = ?').get(findByRef(ref).code));
  if (!r) return { code: 404, error: 'Không tìm thấy đơn ' + ref };
  const b = { wbCn: String(wbCn || '').trim() }; const e = parseEta(eta); if (e) b.eta = e;
  return update(r.code, 'admin', 'tai-loc', b, { system: true, who: 'tai-loc', byName: 'Tài Lộc', action: 'Tài Lộc báo mã chuyển phát TQ (tự đọc tin nhóm Zalo)', extra });
}
const num = (v, max) => { if (v === '' || v == null) return null; const n = Number(v); return Number.isFinite(n) && n >= 0 && n <= max ? n : undefined; };
const str = (v, max) => String(v == null ? '' : v).replace(/[\u0000-\u001f\u007f]/g, ' ').trim().slice(0, max);

// Nhan truong de ghi lich su de doc (ai sua gi, tu gia tri nao sang gia tri nao)
const FIELD = { status: 'Trạng thái', w: 'Cân thực (kg)', cw: 'Cân tính cước (kg)', pk: 'Số kiện', dims: 'Kích thước (cm)', refTL: 'Mã đối chiếu Tài Lộc', wbCn: 'Mã chuyển phát TQ', eta: 'Dự kiến giao', staffNote: 'Ghi chú nội bộ', fee: 'Phí thu khách', paid: 'Đã thanh toán', feeManual: 'Phí nhập tay' };
const show = (k, v) => (v === undefined || v === null || v === '' ? '—' : k === 'status' ? (LABEL[v] || v) : k === 'dims' ? v.join('×') : (k === 'fee' || k === 'paid') ? vnd(v) : k === 'feeManual' ? (v ? 'có' : 'không') : String(v));
function writeLog(d, code, who, action, changes, extra) {
  d.prepare('INSERT INTO cn_log (code, username, action, detail) VALUES (?, ?, ?, ?)').run(code, who, action, JSON.stringify(Object.assign({ changes: changes || [] }, extra || {})));
}
// meta: { action: 'Quét nhập kho' | ..., who: 'staff:<user>' | 'tai-loc' | 'he-thong' }
function update(code, role, staff, b, meta) {
  const d = open(); if (!d) return { code: 503, error: 'Chưa có dữ liệu trang khách' };
  meta = meta || {};
  const allowed = CAN_EDIT[role] || [];
  const r = d.prepare('SELECT * FROM cn_orders WHERE code = ?').get(code);
  if (!r) return { code: 404, error: 'Không tìm thấy đơn' };
  const o = JSON.parse(r.data); let status = LEGACY[r.status] || r.status; const before = status; const wbBefore = o.wbCn || '';
  const old = Object.assign({}, o, { status });
  if (!meta.system) for (const k of Object.keys(b || {})) if (!allowed.includes(k)) return { code: 403, error: 'Không có quyền sửa: ' + k };
  const now = new Date().toISOString(); const by = meta.byName || staff;
  if ('status' in b && b.status !== status) {
    if (!STATUSES.includes(b.status)) return { code: 400, error: 'Trạng thái không hợp lệ' };
    if (status === 'CANCELLED' && role !== 'admin') return { code: 409, error: 'Đơn đã huỷ' };
    status = b.status; o.ms = (o.ms || []).concat([{ t: now, s: status, by }]);
  }
  if ('w' in b) { const v = num(b.w, 100000); if (v === undefined) return { code: 400, error: 'Cân nặng không hợp lệ' }; o.w = v; o.nw = v; }
  if ('pk' in b) { const v = num(b.pk, 10000); if (v === undefined || (v !== null && !Number.isInteger(v))) return { code: 400, error: 'Số kiện không hợp lệ' }; o.pk = v; }
  if ('dims' in b) {
    const v = b.dims;
    if (v === null || (Array.isArray(v) && v.every((x) => x === '' || x === null))) o.dims = null;
    else if (Array.isArray(v) && v.length === 3 && v.every((x) => Number(x) > 0 && Number(x) <= 1000)) o.dims = v.map(Number);
    else return { code: 400, error: 'Kích thước không hợp lệ (D, R, C cm)' };
  }
  if ('refTL' in b) {
    const v = str(b.refTL, 60) || null;
    if (v) { const dup = findByRef(v); if (dup && dup.code !== r.code) return { code: 409, error: 'Mã đối chiếu ' + v + ' đã gắn với đơn ' + dup.code }; }
    o.refTL = v;
  }
  if ('eta' in b) o.eta = b.eta || null;
  if ('wbCn' in b) {
    o.wbCn = str(b.wbCn, 200) || null;
    // co ma chuyen phat TQ khi dang cho thong quan -> tu chuyen "Da thong quan"
    if (o.wbCn && !('status' in b) && (status === 'TRANSPORTING' || status === 'VN_WAREHOUSE')) { status = 'CLEARED'; o.ms = (o.ms || []).concat([{ t: now, s: status, by }]); }
  }
  if ('staffNote' in b) o.staffNote = str(b.staffNote, 500) || null;
  if ('fee' in b) { const v = num(b.fee, 1e11); if (v === undefined) return { code: 400, error: 'Phí không hợp lệ' }; o.fee = v === null ? null : Math.round(v); o.feeManual = v !== null; }
  // Tu tinh cuoc theo bang gia doi tac (+10%) khi co can/kich thuoc, tru khi tai chinh da nhap phi tay
  if (('w' in b || 'dims' in b || b.recalc) && (b.recalc || !o.feeManual)) {
    const q = quoteOf(o);
    if (q.ok) { o.cw = q.cw; o.partnerFee = q.partner; o.fee = q.customer; o.feeLines = q.lines; o.feeManual = false; o.quoteNote = null; }
    else { o.cw = q.cw || null; o.quoteNote = q.reason; if (b.recalc) o.feeManual = false; }
  }
  if ('paid' in b) { const v = num(b.paid, 1e11); if (v === undefined) return { code: 400, error: 'Số tiền đã thanh toán không hợp lệ' }; o.paid = v === null ? 0 : Math.round(v); }
  o.unpaid = Math.max(0, (o.fee || 0) - (o.paid || 0));
  const now2 = Object.assign({}, o, { status });
  const changes = Object.keys(FIELD).filter((k) => JSON.stringify(old[k] ?? null) !== JSON.stringify(now2[k] ?? null)).map((k) => [FIELD[k], show(k, old[k]), show(k, now2[k])]);
  if (!changes.length && !meta.action) return { order: row(r, role) };
  notifyChange(d, r, o, before, status, wbBefore);
  d.prepare("UPDATE cn_orders SET status = ?, data = ?, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE seq = ?").run(status, JSON.stringify(o), r.seq);
  writeLog(d, code, meta.who || 'staff:' + staff, meta.action || 'Cập nhật', changes, meta.extra);
  return { order: row(d.prepare('SELECT * FROM cn_orders WHERE seq = ?').get(r.seq), role) };
}
// Ghi su kien khong doi du lieu (vd in tem)
function event(code, who, action, extra) { const d = open(); if (!d) return false; if (!d.prepare('SELECT 1 FROM cn_orders WHERE code = ?').get(code)) return false; writeLog(d, code, who, action, [], extra); return true; }
// Tu chuyen "Giao thanh cong" khi qua ngay du kien giao 1 ngay (anh chot 30/10)
function autoDeliver() {
  const d = open(); if (!d) return 0;
  const today = new Date(Date.now() + 7 * 3600e3).toISOString().slice(0, 10); let n = 0;
  for (const r of d.prepare("SELECT * FROM cn_orders WHERE status IN ('CLEARED','CN_WAREHOUSE','DISPATCHED')").all()) {
    const o = JSON.parse(r.data); if (!o.eta) continue;
    const due = new Date(Date.parse(o.eta + 'T00:00:00Z') + 86400e3).toISOString().slice(0, 10);
    if (today >= due) { const x = update(r.code, 'admin', 'he-thong', { status: 'DELIVERED' }, { system: true, who: 'he-thong', byName: 'tự động', action: 'Tự chuyển Giao thành công (quá ngày dự kiến ' + o.eta + ' 1 ngày)' }); if (!x.error) n++; }
  }
  return n;
}
// Cho thong bao tren web: so don cho tiep nhan + don moi nhat
function summary() {
  const d = open(); if (!d) return { pending: 0, lastSeq: 0 };
  const r = d.prepare("SELECT SUM(status = 'PENDING') AS pending, MAX(seq) AS lastSeq FROM cn_orders WHERE test = 0").get();
  const last = d.prepare('SELECT code, created_at FROM cn_orders WHERE test = 0 ORDER BY seq DESC LIMIT 1').get();
  return { pending: r.pending || 0, lastSeq: r.lastSeq || 0, last: last || null };
}
function log(code) { const d = open(); return d ? d.prepare('SELECT * FROM cn_log WHERE code = ? ORDER BY ts').all(code) : []; }

module.exports = { list, counts, update, log, summary, scan, track, event, autoDeliver, missingOf, LABEL, STATUSES, CAN_EDIT };
