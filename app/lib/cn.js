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
  return db;
}

const STATUSES = ['PENDING', 'VN_WAREHOUSE', 'TRANSPORTING', 'CN_WAREHOUSE', 'DISPATCHED', 'DELIVERED', 'CANCELLED'];
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
  const o = Object.assign(d, { code: r.code, status: r.status, username: r.username, gobiz: r.gobiz, test: !!r.test, created: r.created_at, modified: r.updated_at || r.created_at });
  if (!['admin', 'tc'].includes(role)) delete o.partnerFee;
  if (role === 'kho') { for (const k of MONEY) delete o[k]; o.items = (o.items || []).map((i) => ({ name: i.name, qty: i.qty })); }
  return o;
}
function list(role, opts = {}) {
  const d = open(); if (!d) return [];
  const where = []; const args = [];
  if (opts.status && STATUSES.includes(opts.status)) { where.push('status = ?'); args.push(opts.status); }
  if (!opts.withTest) where.push('test = 0');
  const sql = 'SELECT * FROM cn_orders' + (where.length ? ' WHERE ' + where.join(' AND ') : '') + ' ORDER BY seq DESC LIMIT 1000';
  return d.prepare(sql).all(...args).map((r) => row(r, role));
}
function counts(withTest) {
  const d = open(); if (!d) return {};
  const out = {};
  for (const r of d.prepare('SELECT status, COUNT(*) n FROM cn_orders' + (withTest ? '' : ' WHERE test = 0') + ' GROUP BY status').all()) out[r.status] = r.n;
  return out;
}
const num = (v, max) => { if (v === '' || v == null) return null; const n = Number(v); return Number.isFinite(n) && n >= 0 && n <= max ? n : undefined; };
const str = (v, max) => String(v == null ? '' : v).replace(/[\u0000-\u001f\u007f]/g, ' ').trim().slice(0, max);

function update(code, role, staff, b) {
  const d = open(); if (!d) return { code: 503, error: 'Chưa có dữ liệu trang khách' };
  const allowed = CAN_EDIT[role] || [];
  const r = d.prepare('SELECT * FROM cn_orders WHERE code = ?').get(code);
  if (!r) return { code: 404, error: 'Không tìm thấy đơn' };
  const o = JSON.parse(r.data); let status = r.status; const changes = [];
  for (const k of Object.keys(b || {})) if (!allowed.includes(k)) return { code: 403, error: 'Không có quyền sửa: ' + k };
  if ('status' in b && b.status !== status) {
    if (!STATUSES.includes(b.status)) return { code: 400, error: 'Trạng thái không hợp lệ' };
    if (status === 'CANCELLED' && role !== 'admin') return { code: 409, error: 'Đơn đã huỷ' };
    status = b.status; o.ms = (o.ms || []).concat([{ t: new Date().toISOString(), s: status, by: staff }]); changes.push('status=' + status);
  }
  if ('w' in b) { const v = num(b.w, 100000); if (v === undefined) return { code: 400, error: 'Cân nặng không hợp lệ' }; o.w = v; o.nw = v; changes.push('w=' + v); }
  if ('pk' in b) { const v = num(b.pk, 10000); if (v === undefined || (v !== null && !Number.isInteger(v))) return { code: 400, error: 'Số kiện không hợp lệ' }; o.pk = v; changes.push('pk=' + v); }
  if ('dims' in b) {
    const v = b.dims;
    if (v === null || (Array.isArray(v) && v.every((x) => x === '' || x === null))) o.dims = null;
    else if (Array.isArray(v) && v.length === 3 && v.every((x) => Number(x) > 0 && Number(x) <= 1000)) o.dims = v.map(Number);
    else return { code: 400, error: 'Kích thước không hợp lệ (D, R, C cm)' };
    changes.push('dims');
  }
  if ('refTL' in b) { o.refTL = str(b.refTL, 60) || null; changes.push('refTL=' + (o.refTL || '')); }
  if ('wbCn' in b) { o.wbCn = str(b.wbCn, 200) || null; changes.push('wbCn'); }
  if ('staffNote' in b) { o.staffNote = str(b.staffNote, 500) || null; changes.push('note'); }
  if ('fee' in b) { const v = num(b.fee, 1e11); if (v === undefined) return { code: 400, error: 'Phí không hợp lệ' }; o.fee = v === null ? null : Math.round(v); o.feeManual = v !== null; changes.push('fee=' + o.fee + ' (tay)'); }
  // Tu tinh cuoc theo bang gia doi tac (+10%) khi kho nhap can/kich thuoc, tru khi tai chinh da nhap phi tay
  if (('w' in b || 'dims' in b || b.recalc) && (b.recalc || !o.feeManual)) {
    const q = price.quote({ cls: o.cat, method: ((o.fees || []).find((f) => /shipping/.test(f.t)) || {}).t, weight: o.w, dims: o.dims, value: o.value, insurance: (o.svcs || []).includes('insurance') });
    if (q.ok) { o.cw = q.cw; o.partnerFee = q.partner; o.fee = q.customer; o.feeLines = q.lines; o.feeManual = false; o.quoteNote = null; changes.push('auto fee=' + q.customer); }
    else { o.cw = q.cw || null; o.quoteNote = q.reason; if (b.recalc) o.feeManual = false; changes.push('auto: ' + q.reason); }
  }
  if ('paid' in b) { const v = num(b.paid, 1e11); if (v === undefined) return { code: 400, error: 'Số tiền đã thanh toán không hợp lệ' }; o.paid = v === null ? 0 : Math.round(v); changes.push('paid=' + o.paid); }
  o.unpaid = Math.max(0, (o.fee || 0) - (o.paid || 0));
  if (!changes.length) return { order: row(r, role) };
  d.prepare("UPDATE cn_orders SET status = ?, data = ?, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE seq = ?").run(status, JSON.stringify(o), r.seq);
  d.prepare('INSERT INTO cn_log (code, username, action, detail) VALUES (?, ?, ?, ?)').run(code, 'staff:' + staff, 'update', changes.join(' '));
  return { order: row(d.prepare('SELECT * FROM cn_orders WHERE seq = ?').get(r.seq), role) };
}
// Cho thong bao tren web: so don cho tiep nhan + don moi nhat
function summary() {
  const d = open(); if (!d) return { pending: 0, lastSeq: 0 };
  const r = d.prepare("SELECT SUM(status = 'PENDING') AS pending, MAX(seq) AS lastSeq FROM cn_orders WHERE test = 0").get();
  const last = d.prepare('SELECT code, created_at FROM cn_orders WHERE test = 0 ORDER BY seq DESC LIMIT 1').get();
  return { pending: r.pending || 0, lastSeq: r.lastSeq || 0, last: last || null };
}
function log(code) { const d = open(); return d ? d.prepare('SELECT * FROM cn_log WHERE code = ? ORDER BY ts').all(code) : []; }

module.exports = { list, counts, update, log, summary, STATUSES, CAN_EDIT };
