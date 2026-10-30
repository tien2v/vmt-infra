'use strict';
// THANH TOAN HO (chuyen te). DUNG CHUNG: khach/lib/tth.js va app/lib/tth.js PHAI GIONG HET NHAU.
// Thiet ke: project doc decisions/thanh-toan-ho.md (chot 30-31/10/2026).
// - Moi giao dich = 1 don. Ma don 12 so: 68 YY MM r DD rr k (r ngau nhien, k = so kiem tra Damm).
// - Ty gia von: tin PLA (dan tay / sau nay n8n doc Zalo). Ty gia thu khach: bang gia theo loai x moc x brand.
// - Don chua tra: gia chay theo ty gia moi. Don da tra (cho xu ly) ma ty gia TANG -> NEED_PAY, khach xac nhan tra them.
// - Tien VND so nguyen dong; so te luu bang xu (fen, x100). Moi thao tac tien di qua ledger (BEGIN IMMEDIATE).
const crypto = require('node:crypto');
const ledger = require('./ledger');

// ---------- ma don ----------
const TYPE_PREFIX = { order: '88', tth: '68', kgvn: '84', scn: '86', xk: '55', kn: '11', gd: '66', rt: '99', quy: '77' };
const DAMM = [
  [0, 3, 1, 7, 5, 9, 8, 6, 4, 2], [7, 0, 9, 2, 1, 5, 4, 8, 6, 3], [4, 2, 0, 6, 8, 7, 1, 3, 5, 9], [1, 7, 5, 0, 9, 8, 3, 4, 2, 6],
  [6, 1, 2, 3, 0, 4, 5, 9, 7, 8], [3, 6, 7, 4, 2, 0, 9, 5, 8, 1], [5, 8, 6, 9, 7, 2, 0, 1, 3, 4], [8, 9, 4, 5, 3, 6, 2, 0, 1, 7],
  [9, 4, 3, 8, 6, 1, 7, 2, 0, 5], [2, 5, 8, 1, 4, 3, 6, 7, 9, 0]];
function damm(s) { let i = 0; for (const ch of s) i = DAMM[i][ch.charCodeAt(0) - 48]; return i; }
function validOrderCode(s) { const c = String(s || '').replace(/\D/g, ''); return c.length === 12 && damm(c) === 0; }
// Gio Viet Nam cho phan ngay/thang trong ma
function vnParts(d) { const t = new Date(d.getTime() + 7 * 3600e3); return { yy: String(t.getUTCFullYear()).slice(2), mm: String(t.getUTCMonth() + 1).padStart(2, '0'), dd: String(t.getUTCDate()).padStart(2, '0') }; }
function makeCode(prefix, date, taken) {
  const { yy, mm, dd } = vnParts(date || new Date());
  for (let n = 0; n < 5000; n++) {
    const r = crypto.randomInt(0, 1000); const a = String(Math.floor(r / 100)), b = String(r % 100).padStart(2, '0');
    const base = prefix + yy + mm + a + dd + b; const code = base + damm(base);
    if (!taken(code)) return code;
  }
  throw new Error('Hết mã trong ngày');
}
// Hien thi: 3 nhom 4 so (khach khong nhan ra dau la ngay)
const fmtCode = (c) => String(c).replace(/(\d{4})(?=\d)/g, '$1 ');
// Doc ngay tu ma (noi bo): sau thang bo 1 so, 2 so tiep la ngay
function dayOf(code) { const c = String(code); return c.length === 12 ? c.slice(7, 9) + '/' + c.slice(4, 6) + '/20' + c.slice(2, 4) : null; }

// ---------- loai giao dich ----------
const TYPES = {
  alipay_cn: { label: 'Alipay China', cost: 'alipay_cn' },
  alipay_vn: { label: 'Alipay VN', cost: 'alipay_vn' },
  wechat: { label: 'WeChat', cost: 'wechat' },
  bank: { label: 'Chuyển khoản ngân hàng TQ', cost: 'bank' },
  auth: { label: 'Uỷ quyền', cost: 'alipay_cn' }, // anh chot 31/10: cao hon 20d so voi gia hien tai (tinh tren von Alipay Trung)
};
const STATUSES = ['UNPAID', 'NEED_PAY', 'QUEUED', 'PROCESSING', 'DONE', 'CANCELLED'];
const LABEL_KHACH = { UNPAID: 'Chờ thanh toán', NEED_PAY: 'Cần thanh toán thêm', QUEUED: 'Chờ xử lý', PROCESSING: 'Đang xử lý', DONE: 'Thành công', CANCELLED: 'Đã huỷ' };
const LABEL_ADMIN = { UNPAID: 'Chờ khách trả tiền', NEED_PAY: 'Chờ khách trả thêm', QUEUED: 'Chờ xử lý', PROCESSING: 'Đang xử lý', DONE: 'Thành công', CANCELLED: 'Đã huỷ' };
const OPEN = ['UNPAID', 'NEED_PAY', 'QUEUED'];

const nowIso = () => new Date().toISOString();
const str = (v, max) => String(v == null ? '' : v).replace(/[\u0000-\u001f\u007f]/g, ' ').trim().slice(0, max);
const vnd = (n) => Math.round(n).toLocaleString('vi-VN') + 'đ';
const cnyTxt = (fen) => (fen / 100).toLocaleString('vi-VN', { maximumFractionDigits: 2 }) + '¥';

function init(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS tth_orders (
      seq INTEGER PRIMARY KEY AUTOINCREMENT, code TEXT UNIQUE NOT NULL, username TEXT NOT NULL, owner TEXT NOT NULL, brand TEXT NOT NULL DEFAULT 'default',
      test INTEGER NOT NULL DEFAULT 0, status TEXT NOT NULL, type TEXT NOT NULL, cny INTEGER NOT NULL, rate INTEGER NOT NULL, fee INTEGER NOT NULL DEFAULT 0,
      total INTEGER NOT NULL, paid INTEGER NOT NULL DEFAULT 0, refunded INTEGER NOT NULL DEFAULT 0, staff TEXT, fund TEXT, cost_vnd INTEGER,
      data TEXT NOT NULL, created_at TEXT NOT NULL, updated_at TEXT, paid_at TEXT, claimed_at TEXT, done_at TEXT);
    CREATE INDEX IF NOT EXISTS tth_owner ON tth_orders (owner, seq);
    CREATE INDEX IF NOT EXISTS tth_status ON tth_orders (status, seq);
    CREATE TABLE IF NOT EXISTS tth_log (ts TEXT DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')), code TEXT, who TEXT, action TEXT, detail TEXT);
    CREATE INDEX IF NOT EXISTS tth_log_code ON tth_log (code);
    CREATE TABLE IF NOT EXISTS tth_rates (id INTEGER PRIMARY KEY AUTOINCREMENT, kind TEXT NOT NULL, data TEXT NOT NULL, raw TEXT, by TEXT NOT NULL, created_at TEXT DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')));
    CREATE TABLE IF NOT EXISTS tth_recipients (id INTEGER PRIMARY KEY AUTOINCREMENT, username TEXT NOT NULL, type TEXT NOT NULL, label TEXT, data TEXT NOT NULL,
      acct_key TEXT NOT NULL, deleted INTEGER NOT NULL DEFAULT 0, used INTEGER NOT NULL DEFAULT 0, last_used TEXT, created_at TEXT DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')));
    CREATE UNIQUE INDEX IF NOT EXISTS tth_rcp_key ON tth_recipients (username, type, acct_key) WHERE deleted = 0;
    CREATE TABLE IF NOT EXISTS tth_cust_price (owner TEXT PRIMARY KEY, delta INTEGER NOT NULL, note TEXT, by TEXT NOT NULL, updated_at TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS funds (id TEXT PRIMARY KEY, name TEXT NOT NULL, currency TEXT NOT NULL, kind TEXT NOT NULL DEFAULT 'own', active INTEGER NOT NULL DEFAULT 1,
      staff TEXT NOT NULL DEFAULT '[]', note TEXT, created_at TEXT DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')));
    CREATE TABLE IF NOT EXISTS fund_txns (id INTEGER PRIMARY KEY AUTOINCREMENT, ref TEXT UNIQUE NOT NULL, fund TEXT NOT NULL, kind TEXT NOT NULL, amount INTEGER NOT NULL,
      vnd INTEGER, code TEXT, note TEXT, photos TEXT, by TEXT NOT NULL, created_at TEXT NOT NULL, prev_hash TEXT, hash TEXT NOT NULL);
    CREATE INDEX IF NOT EXISTS fund_txns_fund ON fund_txns (fund, id);
    CREATE TRIGGER IF NOT EXISTS fund_no_update BEFORE UPDATE ON fund_txns BEGIN SELECT RAISE(ABORT, 'so quy chi duoc ghi them'); END;
    CREATE TRIGGER IF NOT EXISTS fund_no_delete BEFORE DELETE ON fund_txns BEGIN SELECT RAISE(ABORT, 'so quy chi duoc ghi them'); END;
  `);
  if (!db.prepare("SELECT 1 FROM tth_rates WHERE kind = 'price' LIMIT 1").get()) {
    const v = validatePriceTable(DEFAULT_PRICE); if (!v.error) db.prepare('INSERT INTO tth_rates (kind, data, raw, by) VALUES (?, ?, ?, ?)').run('price', JSON.stringify(v.table), 'bang anh gui 31/10/2026', 'he-thong');
  }
}
// Bang anh gui 31/10/2026: ty gia khach = von PLA + dieu chinh theo so te. 4 loai, 2 brand giong nhau. Uy quyen = +20d.
const ADJ = [[0, 200], [10, 180], [50, 160], [100, 140], [500, 120], [1000, 90], [5000, 60], [10000, 40], [20000, 35], [30000, 30], [50000, 25]];
const DEFAULT_PRICE = { brands: { default: {
  bank: ADJ.map(([min, add]) => ({ min, add })), alipay_cn: ADJ.map(([min, add]) => ({ min, add })), alipay_vn: ADJ.map(([min, add]) => ({ min, add })),
  wechat: ADJ.map(([min, add]) => ({ min, add })), auth: ADJ.map(([min, add]) => ({ min, add: add + 20 })) } } };
function log(db, code, who, action, changes, extra) {
  db.prepare('INSERT INTO tth_log (code, who, action, detail) VALUES (?, ?, ?, ?)').run(code, who, action, JSON.stringify(Object.assign({ changes: changes || [] }, extra || {})));
}
function notify(db, username, code, text) { db.prepare('INSERT INTO notif (username, code, text) VALUES (?, ?, ?)').run(username, code, text); }
function tx(db, fn) {
  db.exec('BEGIN IMMEDIATE');
  try { const r = fn(); if (r && r.error) { db.exec('ROLLBACK'); return r; } db.exec('COMMIT'); return r; }
  catch (e) { try { db.exec('ROLLBACK'); } catch {} throw e; }
}

// ---------- ty gia ----------
// Tin PLA: "Thẻ nhanh 10V: 3942 - 5V: 3944 / 1V: 3959 - 1K: 3972 / Alipay Trung 5V: ... / Alipay Việt ... / Wechat ..."
// V = van (10.000 te), K = nghin (1.000 te). Tra ve { bank: [{min, rate}], alipay_cn, alipay_vn, wechat } (min tinh bang te, giam dan)
function parsePLA(text) {
  const norm = String(text || '').normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/đ/gi, 'd').toLowerCase();
  const heads = [['bank', /the\s*nhanh/], ['alipay_cn', /alipay\s*trung/], ['alipay_vn', /alipay\s*viet/], ['wechat', /we\s*chat/]];
  const pos = [];
  for (const [k, re] of heads) { const m = re.exec(norm); if (m) pos.push({ k, at: m.index, end: m.index + m[0].length }); }
  pos.sort((a, b) => a.at - b.at);
  const out = {};
  pos.forEach((p, i) => {
    const seg = norm.slice(p.end, i + 1 < pos.length ? pos[i + 1].at : norm.length);
    const tiers = []; const re = /(\d{1,3})\s*([vk])\s*[:=]\s*(\d{3,5})/g; let m;
    while ((m = re.exec(seg))) tiers.push({ min: Number(m[1]) * (m[2] === 'v' ? 10000 : 1000), rate: Number(m[3]) });
    if (tiers.length) out[p.k] = tiers.sort((a, b) => b.min - a.min);
  });
  for (const k of Object.keys(out)) for (const t of out[k]) if (!(t.rate >= 2000 && t.rate <= 6000)) return { error: 'Tỷ giá ' + t.rate + ' không hợp lý (phải 2.000–6.000)' };
  if (!Object.keys(out).length) return { error: 'Không đọc được tỷ giá nào trong tin' };
  return { rates: out };
}
function latest(db, kind) { const r = db.prepare('SELECT * FROM tth_rates WHERE kind = ? ORDER BY id DESC LIMIT 1').get(kind); return r ? Object.assign(r, { data: JSON.parse(r.data) }) : null; }
function costRates(db) { const r = latest(db, 'cost'); return r ? r.data : {}; }
// Bang gia khach: { brands: { default: { <type>: [{min, rate} | {min, add}] }, vmtglobal: {...} } }
//   min tinh bang te (0 = duoi moc dau). rate = ty gia co dinh; add = cong vao ty gia von (von lay theo moc >= 1.000 te).
function priceTable(db) { const r = latest(db, 'price'); return r ? r.data : null; }
function validatePriceTable(t) {
  if (!t || typeof t !== 'object' || !t.brands || typeof t.brands !== 'object') return { error: 'Bảng giá thiếu brands' };
  const out = { brands: {} };
  for (const [b, types] of Object.entries(t.brands)) {
    if (!/^[a-z0-9_]{2,30}$/.test(b)) return { error: 'Tên brand không hợp lệ: ' + b };
    out.brands[b] = {};
    for (const [ty, tiers] of Object.entries(types || {})) {
      if (!TYPES[ty]) return { error: 'Loại không hợp lệ: ' + ty };
      if (!Array.isArray(tiers) || !tiers.length) return { error: b + '/' + ty + ': cần ít nhất 1 mốc' };
      const list = [];
      for (const x of tiers) {
        const min = Math.round(Number(x.min)); if (!(min >= 0 && min <= 1e8)) return { error: b + '/' + ty + ': mốc không hợp lệ' };
        if (x.rate != null) { const rate = Math.round(Number(x.rate)); if (!(rate >= 2000 && rate <= 6000)) return { error: b + '/' + ty + ': tỷ giá ' + x.rate + ' không hợp lý' }; list.push({ min, rate }); }
        else { const add = Math.round(Number(x.add)); if (!(add >= -500 && add <= 2000)) return { error: b + '/' + ty + ': phần cộng thêm không hợp lý' }; if (!TYPES[ty].cost) return { error: b + '/' + ty + ': loại này không có tỷ giá vốn PLA, phải nhập tỷ giá cố định' }; list.push({ min, add }); }
      }
      out.brands[b][ty] = list.sort((a, c) => c.min - a.min);
      if (out.brands[b][ty][out.brands[b][ty].length - 1].min !== 0) return { error: b + '/' + ty + ': phải có mốc bắt đầu từ 0' };
    }
  }
  if (!out.brands.default) return { error: 'Cần có brand default (dùng khi brand khách chưa có bảng riêng)' };
  return { table: out };
}
const pick = (tiers, cny) => tiers.find((t) => cny >= t.min) || tiers[tiers.length - 1];
// cnyFen: so te x100. owner: gia rieng khach VIP (tth_cust_price). deal: gia deal tren don { mode: 'delta'|'fixed', value, until }
// Tra ve { rate, base, cost, tierMin } hoac { error }
function rateFor(db, type, cnyFen, brand, owner, deal) {
  const t = priceTable(db); if (!t) return { error: 'Chưa có bảng tỷ giá thu khách' };
  const tiers = (t.brands[brand] && t.brands[brand][type]) || (t.brands.default && t.brands.default[type]);
  if (!tiers) return { error: 'Chưa có tỷ giá cho loại ' + (TYPES[type] || {}).label };
  const cny = cnyFen / 100; const tier = pick(tiers, cny);
  const costs = costRates(db); const ck = TYPES[type].cost; let cost = null;
  if (ck && costs[ck]) cost = pick(costs[ck], Math.max(cny, 1000)).rate; // anh khong mua vao duoi 1.000 te
  let base;
  if (tier.rate != null) base = tier.rate;
  else { if (cost == null) return { error: 'Chưa có tỷ giá vốn PLA cho loại này' }; base = cost + tier.add; }
  let rate = base; let src = 'bang';
  const cp = owner ? db.prepare('SELECT delta FROM tth_cust_price WHERE owner = ?').get(owner) : null;
  if (cp && cp.delta) { rate = base + cp.delta; src = 'vip'; }
  if (deal && (!deal.until || Date.parse(deal.until) > Date.now())) {
    if (deal.mode === 'fixed') { rate = deal.value; src = 'deal'; } else if (deal.mode === 'delta') { rate = base + deal.value; src = 'deal'; }
  }
  return { rate, base, cost, tierMin: tier.min, src };
}
const orderRate = (db, r, fen) => rateFor(db, r.type, fen == null ? r.cny : fen, r.brand, r.owner, JSON.parse(r.data).deal);
const totalOf = (cnyFen, rate, fee) => Math.round(cnyFen * rate / 100) + (fee || 0);
function quote(db, { type, cny, brand, owner }) {
  if (!TYPES[type]) return { error: 'Chọn loại giao dịch' };
  const fen = Math.round(Number(cny) * 100); if (!(fen >= 100 && fen <= 1e10)) return { error: 'Số tệ không hợp lệ' };
  const r = rateFor(db, type, fen, brand || 'default', owner || null); if (r.error) return r;
  const fee = 0; // phi dich vu: hien = 0, de san
  return { ok: true, type, cny: fen / 100, rate: r.rate, vip: r.src === 'vip', fee, total: totalOf(fen, r.rate, fee), tierMin: r.tierMin };
}
// Cap nhat ty gia von / bang gia -> tinh lai cac don dang mo
function setCost(db, text, by) {
  const p = parsePLA(text); if (p.error) return p;
  db.prepare('INSERT INTO tth_rates (kind, data, raw, by) VALUES (?, ?, ?, ?)').run('cost', JSON.stringify(p.rates), String(text).slice(0, 3000), by);
  return Object.assign({ ok: true, rates: p.rates }, reprice(db, by));
}
function setPrice(db, table, by) {
  const v = validatePriceTable(table); if (v.error) return v;
  db.prepare('INSERT INTO tth_rates (kind, data, raw, by) VALUES (?, ?, ?, ?)').run('price', JSON.stringify(v.table), null, by);
  return Object.assign({ ok: true, table: v.table }, reprice(db, by));
}
// Don chua tra: gia theo ty gia moi. Don da tra cho xu ly: ty gia TANG -> NEED_PAY; giam thi giu.
function reprice(db, by) {
  return tx(db, () => {
    let unpaid = 0, needPay = 0;
    for (const r of db.prepare("SELECT * FROM tth_orders WHERE status IN ('UNPAID','NEED_PAY','QUEUED')").all()) {
      const q = orderRate(db, r); if (q.error) continue;
      const d = JSON.parse(r.data);
      if (r.status === 'UNPAID' || (r.status === 'NEED_PAY' && r.paid === 0)) {
        if (q.rate === r.rate) continue;
        const total = totalOf(r.cny, q.rate, r.fee);
        db.prepare('UPDATE tth_orders SET rate = ?, total = ?, updated_at = ? WHERE seq = ?').run(q.rate, total, nowIso(), r.seq);
        log(db, r.code, by, 'Cập nhật tỷ giá (đơn chưa thanh toán)', [['Tỷ giá', r.rate, q.rate], ['Thành tiền', vnd(r.total), vnd(total)]]);
        unpaid++;
      } else if (q.rate > r.rate) { // QUEUED hoac NEED_PAY da tra 1 phan
        const total = totalOf(r.cny, q.rate, r.fee);
        db.prepare("UPDATE tth_orders SET status = 'NEED_PAY', rate = ?, total = ?, updated_at = ? WHERE seq = ?").run(q.rate, total, nowIso(), r.seq);
        d.needReason = 'rate'; db.prepare('UPDATE tth_orders SET data = ? WHERE seq = ?').run(JSON.stringify(d), r.seq);
        log(db, r.code, by, 'Tỷ giá tăng — chờ khách xác nhận trả thêm', [['Tỷ giá', r.rate, q.rate], ['Thành tiền', vnd(r.total), vnd(total)], ['Trạng thái', LABEL_ADMIN[r.status], LABEL_ADMIN.NEED_PAY]]);
        notify(db, r.username, r.code, 'Tỷ giá vừa tăng lên ' + q.rate + '. Đơn ' + fmtCode(r.code) + ' cần thanh toán thêm ' + vnd(total - r.paid) + ' trước khi VMT xử lý. Anh/chị vào đơn để xác nhận hoặc huỷ.');
        needPay++;
      }
    }
    return { repriced: unpaid, needPay };
  });
}

// ---------- nguoi nhan ----------
function cleanRecipient(type, b, uploadOk) {
  const r = { name: str(b.name, 80), account: str(b.account, 80), bank: str(b.bank, 120), branch: str(b.branch, 120), link: str(b.link, 1000), qr: b.qr ? String(b.qr) : null };
  if (r.qr && !/^[a-f0-9]{32}$/.test(r.qr)) return { error: 'Ảnh QR không hợp lệ, tải lại' };
  if (r.qr && uploadOk && !uploadOk(r.qr)) return { error: 'Ảnh QR không hợp lệ hoặc không phải của bạn, tải lại' };
  if (type === 'wechat') { if (!r.qr) return { error: 'WeChat bắt buộc có ảnh mã QR người nhận' }; }
  else if (type === 'alipay_cn' || type === 'alipay_vn') { if (!r.qr && (!r.account || !r.name)) return { error: 'Alipay cần tài khoản + tên người nhận (hoặc ảnh QR)' }; }
  else if (type === 'bank') { if (!r.name || !r.account || !r.bank) return { error: 'Chuyển khoản cần tên người nhận, số tài khoản, ngân hàng' }; if (!/^[0-9 ]{6,40}$/.test(r.account)) return { error: 'Số tài khoản chỉ gồm chữ số' }; }
  else if (type === 'auth') { if (!/^https?:\/\/\S{6,}$/i.test(r.link)) return { error: 'Uỷ quyền cần link thanh toán (代付) bắt đầu bằng http' }; }
  for (const k of Object.keys(r)) if (r[k] === '' || r[k] == null) delete r[k];
  return { r };
}
// Khoa nhan dien nguoi nhan (de bao "nguoi nhan moi" va chong don trung)
function acctKey(type, r) {
  const k = type === 'auth' ? (r.link || '') : type === 'wechat' ? (r.qr || '') + '|' + (r.name || '') : (r.account || r.qr || '').replace(/\s/g, '').toLowerCase();
  return crypto.createHash('sha256').update(type + ':' + k).digest('hex').slice(0, 32);
}
function recipients(db, username) {
  return db.prepare('SELECT id, type, label, data, used, last_used FROM tth_recipients WHERE username = ? AND deleted = 0 ORDER BY last_used DESC, id DESC LIMIT 200').all(username)
    .map((x) => Object.assign(x, { data: JSON.parse(x.data) }));
}
function saveRecipient(db, username, type, r, label) {
  const key = acctKey(type, r); const at = nowIso();
  const old = db.prepare('SELECT id FROM tth_recipients WHERE username = ? AND type = ? AND acct_key = ? AND deleted = 0').get(username, type, key);
  if (old) { db.prepare('UPDATE tth_recipients SET data = ?, label = COALESCE(?, label), used = used + 1, last_used = ? WHERE id = ?').run(JSON.stringify(r), label || null, at, old.id); return old.id; }
  return Number(db.prepare('INSERT INTO tth_recipients (username, type, label, data, acct_key, used, last_used) VALUES (?, ?, ?, ?, ?, 1, ?)').run(username, type, label || null, JSON.stringify(r), key, at).lastInsertRowid);
}
function deleteRecipient(db, username, id) {
  const r = db.prepare('UPDATE tth_recipients SET deleted = 1 WHERE id = ? AND username = ? AND deleted = 0').run(Number(id), username);
  return r.changes ? { ok: true } : { code: 404, error: 'Không tìm thấy người nhận' };
}

// ---------- don ----------
function rowOut(r, view) {
  const d = JSON.parse(r.data);
  const o = { code: r.code, codeFmt: fmtCode(r.code), status: r.status, statusLabel: (view === 'admin' ? LABEL_ADMIN : LABEL_KHACH)[r.status], type: r.type, typeLabel: TYPES[r.type].label,
    cny: r.cny / 100, rate: r.rate, fee: r.fee, total: r.total, paid: r.paid, need: Math.max(0, r.total - r.paid), refunded: r.refunded,
    recipient: d.recipient, note: d.note || null, bills: d.bills || [], created: r.created_at, modified: r.updated_at || r.created_at, paidAt: r.paid_at, doneAt: r.done_at,
    needReason: r.status === 'NEED_PAY' ? (d.needReason || null) : null, refundLabel: r.refunded > 0 ? (r.refunded >= r.paid + r.refunded ? 'Đã hoàn hết' : 'Hoàn 1 phần') : null };
  if (view === 'admin') Object.assign(o, { username: r.username, owner: r.owner, brand: r.brand, test: !!r.test, staff: r.staff, claimedAt: r.claimed_at, fund: r.fund,
    newRecipient: !!d.newRecipient, dupOf: d.dupOf || null, edited: d.edited || null, cancelReq: d.cancelReq || null, staffNote: d.staffNote || null, day: dayOf(r.code), cost_vnd: r.cost_vnd, costRate: d.costRate || null, deal: d.deal || null });
  if (view === 'khach' && r.status === 'CANCELLED') o.cancelReason = d.cancelReason || null;
  return o;
}
const getRow = (db, code) => db.prepare('SELECT * FROM tth_orders WHERE code = ?').get(String(code || '').replace(/\D/g, ''));
// input: { username, owner, brand, test, type, cny, recipient{}, note, saveRecipient, label, confirmDup, ip, by, uploadOk }
function create(db, b) {
  if (!TYPES[b.type]) return { code: 400, error: 'Chọn loại giao dịch' };
  const q = quote(db, { type: b.type, cny: b.cny, brand: b.brand, owner: b.owner }); if (q.error) return { code: 400, error: q.error };
  const c = cleanRecipient(b.type, b.recipient || {}, b.uploadOk); if (c.error) return { code: 400, error: c.error };
  const note = str(b.note, 200);
  const fen = Math.round(Number(b.cny) * 100); const key = acctKey(b.type, c.r);
  return tx(db, () => {
    const recent = db.prepare("SELECT code, data FROM tth_orders WHERE owner = ? AND type = ? AND cny = ? AND status <> 'CANCELLED' AND created_at > ? ORDER BY seq DESC").all(b.owner, b.type, fen, new Date(Date.now() - 30 * 60e3).toISOString())
      .find((x) => acctKey(b.type, JSON.parse(x.data).recipient || {}) === key);
    if (recent && !b.confirmDup) return { code: 409, dup: true, dupCode: recent.code, error: 'Bạn vừa tạo đơn ' + fmtCode(recent.code) + ' giống hệt (cùng người nhận, cùng số tệ). Vẫn tạo tiếp?' };
    const seen = db.prepare('SELECT 1 FROM tth_recipients WHERE type = ? AND acct_key = ? LIMIT 1').get(b.type, key) || db.prepare("SELECT 1 FROM tth_orders WHERE type = ? AND json_extract(data,'$.akey') = ? LIMIT 1").get(b.type, key);
    const code = makeCode(TYPE_PREFIX.tth, new Date(), (x) => !!db.prepare('SELECT 1 FROM tth_orders WHERE code = ?').get(x));
    const at = nowIso();
    const data = { recipient: c.r, note: note || null, akey: key, newRecipient: !seen, dupOf: recent ? recent.code : null, bills: [] };
    db.prepare('INSERT INTO tth_orders (code, username, owner, brand, test, status, type, cny, rate, fee, total, data, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
      .run(code, b.username, b.owner, b.brand || 'default', b.test ? 1 : 0, 'UNPAID', b.type, fen, q.rate, q.fee, q.total, JSON.stringify(data), at);
    if (c.r.qr) db.prepare('UPDATE uploads SET code = ?, kind = ? WHERE id = ? AND code IS NULL').run(code, 'tth_qr', c.r.qr);
    if (b.saveRecipient) saveRecipient(db, b.username, b.type, c.r, str(b.label, 60) || null);
    log(db, code, b.by, 'Tạo đơn', [], { ip: b.ip || null, type: b.type, cny: fen / 100, rate: q.rate, total: q.total, dupOf: data.dupOf, newRecipient: data.newRecipient });
    return { ok: true, order: rowOut(getRow(db, code), 'khach') };
  });
}
// Tra tu vi. expect = so tien khach nhin thay tren man hinh; khac voi so can tra hien tai -> 409 de bat popup xac nhan.
function pay(db, { owner, code, idem, expect, by, test }) {
  if (!/^[A-Za-z0-9-]{16,64}$/.test(String(idem || ''))) return { code: 400, error: 'Phiên thanh toán không hợp lệ, mở lại' };
  const key = 'TTHPAY:' + owner + ':' + idem;
  return tx(db, () => {
    const old = db.prepare('SELECT txn, amount, balance_after FROM ledger WHERE idem = ?').get(key);
    if (old) return { ok: true, replay: true, txn: old.txn, amount: -old.amount, balance: old.balance_after };
    const r = getRow(db, code);
    if (!r || r.owner !== owner) return { code: 404, error: 'Không tìm thấy đơn' };
    if (!['UNPAID', 'NEED_PAY'].includes(r.status)) return { code: 409, error: 'Đơn đang ở trạng thái ' + LABEL_KHACH[r.status] + ', không cần thanh toán' };
    let row = r;
    if (r.paid === 0) { // chua tra dong nao: chot theo ty gia hien tai
      const q = orderRate(db, r); if (q.error) return { code: 409, error: q.error };
      if (q.rate !== r.rate) { const total = totalOf(r.cny, q.rate, r.fee); db.prepare('UPDATE tth_orders SET rate = ?, total = ? WHERE seq = ?').run(q.rate, total, r.seq); row = Object.assign({}, r, { rate: q.rate, total }); }
    }
    const need = row.total - row.paid;
    if (need <= 0) return { code: 409, error: 'Đơn đã thanh toán đủ' };
    if (Math.round(Number(expect)) !== need) return { code: 409, rateChanged: true, need, rate: row.rate, error: 'Tỷ giá vừa thay đổi: tỷ giá ' + row.rate + ', số tiền cần thanh toán là ' + vnd(need) + '. Xác nhận lại để thanh toán.' };
    const w = ledger.walletView(db, owner);
    if (need > w.available) return { code: 409, short: need - w.available, need, error: 'Số dư không đủ. Cần ' + vnd(need) + ', có thể dùng ' + vnd(w.available) + ', còn thiếu ' + vnd(need - w.available) + '.' };
    const p = ledger.post(db, { owner, kind: 'PAY', amount: -need, idem: key, note: 'Thanh toán hộ ' + fmtCode(row.code) + ' (' + cnyTxt(row.cny) + ' × ' + row.rate + ')', by, lines: [{ code: row.code, amount: need }], test });
    const at = nowIso();
    db.prepare("UPDATE tth_orders SET status = 'QUEUED', paid = ?, paid_at = COALESCE(paid_at, ?), updated_at = ? WHERE seq = ?").run(row.paid + need, at, at, row.seq);
    log(db, row.code, by, 'Thanh toán (' + p.txn + ')', [['Đã thanh toán', vnd(row.paid), vnd(row.paid + need)], ['Trạng thái', LABEL_ADMIN[row.status], LABEL_ADMIN.QUEUED]], { txn: p.txn, rate: row.rate });
    notify(db, row.username, row.code, 'Đã thanh toán ' + vnd(need) + ' cho đơn ' + fmtCode(row.code) + '. Mã giao dịch ' + p.txn + '. Số dư còn ' + vnd(p.balance) + '.');
    return { ok: true, txn: p.txn, amount: need, balance: p.balance, order: rowOut(getRow(db, row.code), 'khach') };
  });
}
// Sau khi tien chuyen khoan vao vi (noi dung co ma don): tu thanh toan don do neu du tien.
function autoPayFromContent(db, owner, content, ref, by, test) {
  const digits = String(content || '').replace(/[^0-9 ]/g, ' ').replace(/\s+/g, ' ');
  const cands = new Set(); const flat = digits.replace(/\s/g, '');
  for (let i = 0; i + 12 <= flat.length; i++) { const c = flat.slice(i, i + 12); if (c.startsWith(TYPE_PREFIX.tth) && validOrderCode(c)) cands.add(c); }
  const out = [];
  for (const c of cands) {
    const r = getRow(db, c); if (!r || r.owner !== owner || !['UNPAID', 'NEED_PAY'].includes(r.status)) continue;
    const q = r.paid === 0 ? orderRate(db, r) : { rate: r.rate };
    const need = (r.paid === 0 && !q.error ? totalOf(r.cny, q.rate, r.fee) : r.total) - r.paid;
    out.push(pay(db, { owner, code: c, idem: 'AUTO-' + crypto.createHash('sha256').update(String(ref) + c).digest('hex').slice(0, 24), expect: need, by, test }));
  }
  return out;
}
// Hoan tien ve vi tu dong (huy truoc khi xu ly / giam so te): chua co dong tien nao ra khoi quy.
function refundAuto(db, r, amount, why, by, idem) {
  if (amount <= 0) return null;
  const p = ledger.post(db, { owner: r.owner, kind: 'REFUND', amount, idem, note: why + ' ' + fmtCode(r.code), by, lines: [{ code: r.code, amount: -amount }], test: !!r.test });
  return p;
}
// actor: { kind: 'khach'|'staff'|'admin'|'system', id, username? }
function cancel(db, code, actor, reason) {
  reason = str(reason, 300);
  return tx(db, () => {
    const r = getRow(db, code); if (!r) return { code: 404, error: 'Không tìm thấy đơn' };
    if (actor.kind === 'khach' && r.username !== actor.username) return { code: 404, error: 'Không tìm thấy đơn' };
    if (['DONE', 'CANCELLED'].includes(r.status)) return { code: 409, error: 'Đơn đã ' + LABEL_ADMIN[r.status].toLowerCase() };
    if (r.status === 'PROCESSING' && actor.kind !== 'admin') return { code: 403, error: 'Đơn đang xử lý: chỉ anh (admin) được huỷ. Nhân viên bấm "Yêu cầu huỷ".' };
    if (actor.kind !== 'khach' && actor.kind !== 'system' && reason.length < 3) return { code: 400, error: 'Ghi lý do huỷ' };
    const d = JSON.parse(r.data); d.cancelReason = reason || (actor.kind === 'khach' ? 'Khách huỷ' : null); delete d.cancelReq;
    const by = actor.kind + ':' + actor.id; const at = nowIso();
    const p = refundAuto(db, r, r.paid, 'Hoàn tiền huỷ đơn', by, 'TTHCXL:' + r.code);
    db.prepare("UPDATE tth_orders SET status = 'CANCELLED', paid = 0, refunded = refunded + ?, data = ?, updated_at = ? WHERE seq = ?").run(r.paid, JSON.stringify(d), at, r.seq);
    log(db, r.code, by, 'Huỷ đơn', [['Trạng thái', LABEL_ADMIN[r.status], LABEL_ADMIN.CANCELLED]].concat(r.paid ? [['Hoàn về ví', '', vnd(r.paid)]] : []), { reason, txn: p && p.txn });
    notify(db, r.username, r.code, 'Đơn ' + fmtCode(r.code) + ' đã huỷ' + (r.paid ? ', hoàn ' + vnd(r.paid) + ' về ví (mã giao dịch ' + p.txn + ')' : '') + '.');
    return { ok: true, refunded: r.paid, txn: p && p.txn };
  });
}
// Sua don: nguoi nhan / ghi chu / so te. Chi khi chua "Nhan xu ly".
function edit(db, code, actor, b) {
  return tx(db, () => {
    const r = getRow(db, code); if (!r) return { code: 404, error: 'Không tìm thấy đơn' };
    if (actor.kind === 'khach' && r.username !== actor.username) return { code: 404, error: 'Không tìm thấy đơn' };
    if (!OPEN.includes(r.status)) return { code: 409, error: 'Đơn đã ' + LABEL_ADMIN[r.status].toLowerCase() + ', không sửa được' };
    const d = JSON.parse(r.data); const ch = []; const by = actor.kind + ':' + actor.id; const at = nowIso();
    let { rate, total, status, paid } = r; let refundTxn = null;
    if (b.recipient) {
      const c = cleanRecipient(r.type, b.recipient, b.uploadOk); if (c.error) return { code: 400, error: c.error };
      for (const k of ['name', 'account', 'bank', 'branch', 'link', 'qr']) if ((d.recipient[k] || '') !== (c.r[k] || '')) ch.push(['Người nhận: ' + k, d.recipient[k] || '', c.r[k] || '']);
      if (c.r.qr && c.r.qr !== d.recipient.qr) db.prepare('UPDATE uploads SET code = ?, kind = ? WHERE id = ? AND code IS NULL').run(r.code, 'tth_qr', c.r.qr);
      d.recipient = c.r; d.akey = acctKey(r.type, c.r);
    }
    if (b.note != null) { const n = str(b.note, 200) || null; if (n !== (d.note || null)) { ch.push(['Nội dung chuyển', d.note || '', n || '']); d.note = n; } }
    if (b.cny != null) {
      const fen = Math.round(Number(b.cny) * 100); if (!(fen >= 100 && fen <= 1e10)) return { code: 400, error: 'Số tệ không hợp lệ' };
      if (fen !== r.cny) {
        const q = orderRate(db, r, fen); if (q.error) return { code: 409, error: q.error };
        rate = r.paid > 0 ? Math.max(r.rate, q.rate) : q.rate; // da tra: khong cho loi dung ty gia giam
        total = totalOf(fen, rate, r.fee);
        ch.push(['Số tệ', cnyTxt(r.cny), cnyTxt(fen)], ['Tỷ giá', r.rate, rate], ['Thành tiền', vnd(r.total), vnd(total)]);
        if (r.paid > 0 && total > r.paid) { status = 'NEED_PAY'; d.needReason = 'edit'; }
        else if (r.paid > 0 && total <= r.paid) {
          const back = r.paid - total; status = 'QUEUED';
          if (back > 0) { const p = refundAuto(db, r, back, 'Hoàn phần giảm số tệ', by, 'TTHEDIT:' + r.code + ':' + r.cny + '>' + fen + ':' + Date.now()); refundTxn = p.txn; paid = total; ch.push(['Hoàn về ví', '', vnd(back)]); }
        }
        db.prepare('UPDATE tth_orders SET cny = ? WHERE seq = ?').run(fen, r.seq);
      }
    }
    if (!ch.length) return { code: 400, error: 'Không có gì thay đổi' };
    if (actor.kind === 'khach') d.edited = { at, by };
    db.prepare('UPDATE tth_orders SET rate = ?, total = ?, status = ?, paid = ?, refunded = refunded + ?, data = ?, updated_at = ? WHERE seq = ?').run(rate, total, status, paid, r.paid - paid, JSON.stringify(d), at, r.seq);
    if (status !== r.status) ch.push(['Trạng thái', LABEL_ADMIN[r.status], LABEL_ADMIN[status]]);
    log(db, r.code, by, actor.kind === 'khach' ? 'Khách sửa đơn' : 'Sửa đơn', ch, { txn: refundTxn });
    return { ok: true, order: rowOut(getRow(db, r.code), actor.kind === 'khach' ? 'khach' : 'admin') };
  });
}
// ---- nhan vien ----
function claim(db, code, staff) {
  return tx(db, () => {
    const r = getRow(db, code); if (!r) return { code: 404, error: 'Không tìm thấy đơn' };
    if (r.status === 'PROCESSING') return { code: 409, error: 'Đơn đã có ' + r.staff + ' nhận xử lý' };
    if (r.status === 'NEED_PAY') return { code: 409, error: 'Khách chưa xác nhận trả thêm, chưa xử lý được' };
    if (r.status !== 'QUEUED') return { code: 409, error: 'Đơn đang ở trạng thái ' + LABEL_ADMIN[r.status] };
    const at = nowIso();
    const u = db.prepare("UPDATE tth_orders SET status = 'PROCESSING', staff = ?, claimed_at = ?, updated_at = ? WHERE seq = ? AND status = 'QUEUED'").run(staff, at, at, r.seq);
    if (!u.changes) return { code: 409, error: 'Đơn vừa thay đổi, tải lại' };
    log(db, r.code, 'staff:' + staff, 'Nhận xử lý', [['Trạng thái', LABEL_ADMIN.QUEUED, LABEL_ADMIN.PROCESSING]]);
    return { ok: true };
  });
}
function release(db, code, staff, isAdmin) {
  return tx(db, () => {
    const r = getRow(db, code); if (!r || r.status !== 'PROCESSING') return { code: 409, error: 'Đơn không ở trạng thái đang xử lý' };
    if (r.staff !== staff && !isAdmin) return { code: 403, error: 'Đơn do ' + r.staff + ' đang xử lý' };
    const d = JSON.parse(r.data); if (d.bills && d.bills.length) return { code: 409, error: 'Đơn đã có bill, không trả lại hàng đợi được' };
    db.prepare("UPDATE tth_orders SET status = 'QUEUED', staff = NULL, claimed_at = NULL, updated_at = ? WHERE seq = ?").run(nowIso(), r.seq);
    log(db, r.code, 'staff:' + staff, 'Trả lại hàng đợi', [['Trạng thái', LABEL_ADMIN.PROCESSING, LABEL_ADMIN.QUEUED]]);
    return { ok: true };
  });
}
function requestCancel(db, code, staff, reason) {
  reason = str(reason, 300); if (reason.length < 3) return { code: 400, error: 'Ghi lý do' };
  return tx(db, () => {
    const r = getRow(db, code); if (!r || r.status !== 'PROCESSING') return { code: 409, error: 'Chỉ yêu cầu huỷ khi đơn đang xử lý' };
    const d = JSON.parse(r.data); if (d.cancelReq) return { code: 409, error: 'Đã có yêu cầu huỷ, chờ anh duyệt' };
    d.cancelReq = { by: staff, at: nowIso(), reason };
    db.prepare('UPDATE tth_orders SET data = ?, updated_at = ? WHERE seq = ?').run(JSON.stringify(d), nowIso(), r.seq);
    log(db, r.code, 'staff:' + staff, 'Yêu cầu huỷ (chờ anh duyệt)', [], { reason });
    return { ok: true };
  });
}
function addBill(db, code, staff, uploadId, isAdmin) {
  if (!/^[a-f0-9]{32}$/.test(String(uploadId))) return { code: 400, error: 'Ảnh không hợp lệ' };
  return tx(db, () => {
    const r = getRow(db, code); if (!r || r.status !== 'PROCESSING') return { code: 409, error: 'Chỉ thêm bill khi đơn đang xử lý' };
    if (r.staff !== staff && !isAdmin) return { code: 403, error: 'Đơn do ' + r.staff + ' đang xử lý' };
    const u = db.prepare('UPDATE uploads SET code = ?, kind = ? WHERE id = ? AND code IS NULL AND by = ?').run(r.code, 'tth_bill', uploadId, 'staff:' + staff);
    if (!u.changes) return { code: 400, error: 'Ảnh không hợp lệ hoặc đã dùng cho đơn khác' };
    const d = JSON.parse(r.data); d.bills = (d.bills || []).concat([uploadId]);
    db.prepare('UPDATE tth_orders SET data = ?, updated_at = ? WHERE seq = ?').run(JSON.stringify(d), nowIso(), r.seq);
    log(db, r.code, 'staff:' + staff, 'Tải bill', [], { upload: uploadId });
    return { ok: true, bills: d.bills };
  });
}
// Hoan thanh: bat buoc co bill + chon quy. costRate: ty gia von (quy doi tac kieu PLA: tu lay theo ty gia PLA hien tai; quy te rieng: binh quan)
function complete(db, code, staff, { fundId, costRate }, isAdmin) {
  return tx(db, () => {
    const r = getRow(db, code); if (!r || r.status !== 'PROCESSING') return { code: 409, error: 'Đơn không ở trạng thái đang xử lý' };
    if (r.staff !== staff && !isAdmin) return { code: 403, error: 'Đơn do ' + r.staff + ' đang xử lý' };
    const d = JSON.parse(r.data); if (!d.bills || !d.bills.length) return { code: 400, error: 'Phải tải bill trước khi bấm Thành công' };
    if (d.cancelReq) return { code: 409, error: 'Đơn đang có yêu cầu huỷ chờ anh duyệt' };
    const f = db.prepare('SELECT * FROM funds WHERE id = ? AND active = 1').get(String(fundId || ''));
    if (!f) return { code: 400, error: 'Chọn quỹ đã dùng để trả' };
    if (!isAdmin && !JSON.parse(f.staff).includes(staff)) return { code: 403, error: 'Bạn không được giao quỹ ' + f.name };
    let cr = Math.round(Number(costRate) || 0), costVnd = null;
    if (f.currency === 'CNY' && f.kind === 'own') {
      const st = fundState(db, f.id); cr = st.avg || cr; // binh quan cac lan nap
      fundPost(db, { fund: f.id, kind: 'OUT_ORDER', amount: -r.cny, vnd: null, code: r.code, note: 'Trả đơn ' + fmtCode(r.code), by: 'staff:' + staff, ref: 'ORD:' + r.code });
    } else if (f.kind === 'partner') {
      if (!cr) { const ck = TYPES[r.type].cost; const costs = costRates(db); if (ck && costs[ck]) cr = pick(costs[ck], Math.max(r.cny / 100, 1000)).rate; }
      if (!cr) return { code: 400, error: 'Nhập tỷ giá vốn đối tác tính cho đơn này' };
      fundPost(db, { fund: f.id, kind: 'OUT_ORDER', amount: -Math.round(r.cny * cr / 100), vnd: Math.round(r.cny * cr / 100), code: r.code, note: 'Đổi tệ trả đơn ' + fmtCode(r.code) + ' (' + cnyTxt(r.cny) + ' × ' + cr + ')', by: 'staff:' + staff, ref: 'ORD:' + r.code });
    } else return { code: 400, error: 'Quỹ ' + f.name + ' không dùng để trả tệ' };
    if (cr) costVnd = Math.round(r.cny * cr / 100);
    d.costRate = cr || null;
    const at = nowIso();
    db.prepare("UPDATE tth_orders SET status = 'DONE', fund = ?, cost_vnd = ?, data = ?, done_at = ?, updated_at = ? WHERE seq = ?").run(f.id, costVnd, JSON.stringify(d), at, at, r.seq);
    log(db, r.code, 'staff:' + staff, 'Thành công', [['Trạng thái', LABEL_ADMIN.PROCESSING, LABEL_ADMIN.DONE], ['Quỹ', '', f.name]], { costRate: cr });
    notify(db, r.username, r.code, 'Đơn ' + fmtCode(r.code) + ' đã chuyển thành công ' + cnyTxt(r.cny) + '. Xem bill trong đơn.');
    return { ok: true };
  });
}
// Het han: UNPAID qua 3 ngay -> huy; ngay thu 2 nhac 1 lan
function autoExpire(db) {
  let n = 0;
  for (const r of db.prepare("SELECT * FROM tth_orders WHERE status = 'UNPAID' AND paid = 0").all()) {
    const age = Date.now() - Date.parse(r.created_at); const d = JSON.parse(r.data);
    if (age > 3 * 86400e3) { const x = cancel(db, r.code, { kind: 'system', id: 'het-han' }, 'Quá 3 ngày chưa thanh toán'); if (x.ok) n++; }
    else if (age > 2 * 86400e3 && !d.reminded) {
      d.reminded = nowIso(); db.prepare('UPDATE tth_orders SET data = ? WHERE seq = ?').run(JSON.stringify(d), r.seq);
      notify(db, r.username, r.code, 'Đơn ' + fmtCode(r.code) + ' chưa thanh toán. Đơn sẽ tự huỷ sau 1 ngày nữa nếu chưa thanh toán.');
    }
  }
  return n;
}
function listKhach(db, username) { return db.prepare('SELECT * FROM tth_orders WHERE username = ? ORDER BY seq DESC LIMIT 500').all(username).map((r) => rowOut(r, 'khach')); }
function getKhach(db, username, code) { const r = getRow(db, code); return r && r.username === username ? rowOut(r, 'khach') : null; }
function listAdmin(db, { status, staff, withTest, q } = {}) {
  const where = []; const args = [];
  if (status && STATUSES.includes(status)) { where.push('status = ?'); args.push(status); }
  if (status === 'CANCEL_REQ') where.push("status = 'PROCESSING' AND json_extract(data,'$.cancelReq') IS NOT NULL");
  if (staff) { where.push('staff = ?'); args.push(staff); }
  if (!withTest) where.push('test = 0');
  if (q) { where.push('(code LIKE ? OR username LIKE ? OR owner LIKE ?)'); const s = '%' + String(q).replace(/\s/g, '') + '%'; args.push(s, s, s); }
  return db.prepare('SELECT * FROM tth_orders' + (where.length ? ' WHERE ' + where.join(' AND ') : '') + ' ORDER BY seq DESC LIMIT 1000').all(...args).map((r) => rowOut(r, 'admin'));
}
function countsAdmin(db, withTest) {
  const out = {}; for (const r of db.prepare('SELECT status, COUNT(*) n FROM tth_orders' + (withTest ? '' : ' WHERE test = 0') + ' GROUP BY status').all()) out[r.status] = r.n;
  out.CANCEL_REQ = db.prepare("SELECT COUNT(*) n FROM tth_orders WHERE status = 'PROCESSING' AND json_extract(data,'$.cancelReq') IS NOT NULL" + (withTest ? '' : ' AND test = 0')).get().n;
  return out;
}
function logOf(db, code) { return db.prepare('SELECT ts, who, action, detail FROM tth_log WHERE code = ? ORDER BY ts').all(String(code).replace(/\D/g, '')).map((x) => Object.assign(x, { detail: JSON.parse(x.detail || '{}') })); }
// Lich su cho khach: khong lo nhan vien, quy, gia von
function logKhach(db, code) { return logOf(db, code).filter((x) => !/Nhận xử lý|Trả lại hàng đợi|Yêu cầu huỷ/.test(x.action)).map((x) => ({ ts: x.ts, action: x.action, changes: (x.detail.changes || []).filter((c) => !/^Quỹ/.test(c[0])) })); }

// ---------- quy ----------
const sha = (s) => crypto.createHash('sha256').update(s).digest('hex');
// amount: quy CNY tinh bang xu (fen); quy VND / doi tac tinh bang dong. vnd: gia von (dong) cua dong nap te.
function fundPost(db, { fund, kind, amount, vnd: v, code, note, photos, by, ref }) {
  if (!Number.isSafeInteger(amount) || amount === 0) throw new Error('Số tiền quỹ không hợp lệ');
  const old = db.prepare('SELECT id FROM fund_txns WHERE ref = ?').get(ref); if (old) return { dup: true, id: old.id };
  const at = nowIso(); const prev = db.prepare('SELECT hash FROM fund_txns ORDER BY id DESC LIMIT 1').get(); const ph = prev ? prev.hash : 'GENESIS';
  const ps = JSON.stringify(photos || []);
  const h = sha([ph, ref, fund, kind, amount, v == null ? '' : v, code || '', note || '', ps, by, at].join('|'));
  const id = Number(db.prepare('INSERT INTO fund_txns (ref, fund, kind, amount, vnd, code, note, photos, by, created_at, prev_hash, hash) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
    .run(ref, fund, kind, amount, v == null ? null : v, code || null, note || null, ps, by, at, ph, h).lastInsertRowid);
  return { id };
}
// So du + gia von binh quan (quy te): nap vao cong von, chi ra tru von theo binh quan
function fundState(db, id) {
  let bal = 0, costPool = 0;
  for (const t of db.prepare('SELECT amount, vnd FROM fund_txns WHERE fund = ? ORDER BY id').all(id)) {
    if (t.amount > 0) { bal += t.amount; costPool += t.vnd || 0; }
    else { const avg = bal > 0 ? costPool / bal : 0; bal += t.amount; costPool = Math.max(0, costPool + avg * t.amount); }
  }
  return { balance: bal, avg: bal > 0 ? Math.round(costPool / bal * 100) : null }; // avg: dong / 1 te
}
function funds(db, { staff, isAdmin } = {}) {
  return db.prepare('SELECT * FROM funds ORDER BY active DESC, id').all().filter((f) => isAdmin || JSON.parse(f.staff).includes(staff)).map((f) => {
    const st = fundState(db, f.id);
    const o = { id: f.id, name: f.name, currency: f.currency, kind: f.kind, active: !!f.active, staff: JSON.parse(f.staff), balance: f.currency === 'CNY' && f.kind === 'own' ? st.balance / 100 : st.balance };
    if (isAdmin) o.avgCost = st.avg; return o;
  });
}
function saveFund(db, b, by) {
  const id = String(b.id || '').toUpperCase().replace(/[^A-Z0-9_]/g, '').slice(0, 20); if (!id) return { code: 400, error: 'Cần mã quỹ' };
  const name = str(b.name, 60); if (!name) return { code: 400, error: 'Cần tên quỹ' };
  const currency = b.currency === 'VND' ? 'VND' : 'CNY'; const kind = b.kind === 'partner' ? 'partner' : 'own';
  const staff = Array.isArray(b.staff) ? [...new Set(b.staff.map((x) => String(x).toLowerCase().slice(0, 40)))] : [];
  const old = db.prepare('SELECT * FROM funds WHERE id = ?').get(id);
  if (old && (old.currency !== currency || old.kind !== kind) && db.prepare('SELECT 1 FROM fund_txns WHERE fund = ? LIMIT 1').get(id)) return { code: 409, error: 'Quỹ đã có giao dịch, không đổi loại tiền / kiểu quỹ được' };
  db.prepare('INSERT INTO funds (id, name, currency, kind, active, staff, note) VALUES (?, ?, ?, ?, ?, ?, ?) ON CONFLICT(id) DO UPDATE SET name = excluded.name, currency = excluded.currency, kind = excluded.kind, active = excluded.active, staff = excluded.staff, note = excluded.note')
    .run(id, name, currency, kind, b.active === false ? 0 : 1, JSON.stringify(staff), str(b.note, 200) || null);
  db.prepare('INSERT INTO tth_log (code, who, action, detail) VALUES (?, ?, ?, ?)').run('FUND:' + id, by, old ? 'Sửa quỹ' : 'Tạo quỹ', JSON.stringify({ old, new: { name, currency, kind, staff } }));
  return { ok: true };
}

// ---------- gia rieng ----------
// Gia VIP: delta dong/te cong vao bang (am = re hon). Chi admin.
function setCustPrice(db, owner, delta, note, by) {
  delta = Math.round(Number(delta)); if (!(delta >= -300 && delta <= 300)) return { code: 400, error: 'Mức điều chỉnh phải trong khoảng -300..300 đ/¥' };
  const old = db.prepare('SELECT delta FROM tth_cust_price WHERE owner = ?').get(owner);
  if (delta === 0) db.prepare('DELETE FROM tth_cust_price WHERE owner = ?').run(owner);
  else db.prepare('INSERT INTO tth_cust_price (owner, delta, note, by, updated_at) VALUES (?, ?, ?, ?, ?) ON CONFLICT(owner) DO UPDATE SET delta = excluded.delta, note = excluded.note, by = excluded.by, updated_at = excluded.updated_at').run(owner, delta, str(note, 200) || null, by, nowIso());
  db.prepare('INSERT INTO tth_log (code, who, action, detail) VALUES (?, ?, ?, ?)').run('VIP:' + owner, by, 'Đặt giá riêng thanh toán hộ', JSON.stringify({ changes: [['Điều chỉnh đ/¥', old ? old.delta : 0, delta]], note }));
  return Object.assign({ ok: true }, reprice(db, by));
}
function custPrices(db) { return db.prepare('SELECT * FROM tth_cust_price ORDER BY owner').all(); }
// Gia deal tren don (don chua tra tien). mode 'fixed' (ty gia co dinh, nen co han) | 'delta' (cong/tru vao bang, chay theo PLA).
// Thap hon gia von -> chi admin.
function setDeal(db, code, staff, b, isAdmin) {
  return tx(db, () => {
    const r = getRow(db, code); if (!r) return { code: 404, error: 'Không tìm thấy đơn' };
    if (!(['UNPAID', 'NEED_PAY'].includes(r.status) && r.paid === 0)) return { code: 409, error: 'Chỉ sửa giá khi khách chưa thanh toán' };
    const d = JSON.parse(r.data); const old = d.deal || null;
    if (b.mode === 'clear') delete d.deal;
    else {
      const mode = b.mode === 'fixed' ? 'fixed' : 'delta'; const value = Math.round(Number(b.value));
      if (mode === 'fixed' && !(value >= 2000 && value <= 6000)) return { code: 400, error: 'Tỷ giá không hợp lý' };
      if (mode === 'delta' && !(value >= -500 && value <= 500)) return { code: 400, error: 'Mức điều chỉnh không hợp lý' };
      const until = b.until ? new Date(b.until) : null; if (until && !(until.getTime() > Date.now())) return { code: 400, error: 'Hạn giá deal phải ở tương lai' };
      d.deal = { mode, value, until: until ? until.toISOString() : null, by: staff, at: nowIso(), note: str(b.note, 200) || null };
    }
    const q = rateFor(db, r.type, r.cny, r.brand, r.owner, d.deal); if (q.error) return { code: 409, error: q.error };
    if (q.cost && q.rate < q.cost && !isAdmin) return { code: 403, error: 'Giá ' + q.rate + ' thấp hơn giá vốn — chỉ anh (admin) được đặt' };
    const total = totalOf(r.cny, q.rate, r.fee);
    db.prepare('UPDATE tth_orders SET rate = ?, total = ?, data = ?, updated_at = ? WHERE seq = ?').run(q.rate, total, JSON.stringify(d), nowIso(), r.seq);
    log(db, r.code, 'staff:' + staff, d.deal ? 'Sửa giá deal' : 'Bỏ giá deal', [['Tỷ giá', r.rate, q.rate], ['Thành tiền', vnd(r.total), vnd(total)]], { old, deal: d.deal || null });
    notify(db, r.username, r.code, 'Đơn ' + fmtCode(r.code) + ' được cập nhật tỷ giá ' + q.rate + ', thành tiền ' + vnd(total) + '. Anh/chị xem và thanh toán khi đồng ý.');
    return { ok: true, rate: q.rate, total };
  });
}

module.exports = {
  setCustPrice, custPrices, setDeal,
  TYPE_PREFIX, TYPES, STATUSES, LABEL_KHACH, LABEL_ADMIN, init, damm, validOrderCode, makeCode, fmtCode, dayOf,
  parsePLA, costRates, priceTable, validatePriceTable, rateFor, quote, setCost, setPrice, reprice, latest,
  recipients, saveRecipient, deleteRecipient, create, pay, autoPayFromContent, cancel, edit, claim, release, requestCancel, addBill, complete, autoExpire,
  listKhach, getKhach, listAdmin, countsAdmin, logOf, logKhach, funds, saveFund, fundState, fundPost,
};
