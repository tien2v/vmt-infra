'use strict';
// DUNG CHUNG giua trang khach (khach/lib/cnshared.js) va trang admin (app/lib/cnshared.js).
// HAI FILE PHAI GIONG HET NHAU. Sua 1 ben thi copy sang ben kia.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const price = require('./price');

const PHOTO_MAX = 10;
const UPLOAD_MAX = 3 * 1024 * 1024;
const CN_CATS = Object.keys(price.CLASSES);
const CN_METHODS = ['express_shipping', 'standard_shipping', 'eco_shipping'];
const CN_SVCS = ['insurance', 'reinforce'];
const str = (v, max) => String(v == null ? '' : v).replace(/[\u0000-\u001f\u007f]/g, ' ').trim().slice(0, max);
// Kiem tra thong tin doanh nghiep. MST Viet Nam: 10 so, hoac 10 so + '-' + 3 so (chi nhanh)
function checkCo(b) {
  const co = { name: str(b.name, 200), taxId: str(b.taxId, 20).replace(/\s/g, ''), addr: str(b.addr, 300), email: str(b.email, 120).toLowerCase() };
  if (/^\d{13}$/.test(co.taxId)) co.taxId = co.taxId.slice(0, 10) + '-' + co.taxId.slice(10);
  if (!co.name) return { error: 'cần tên công ty' };
  if (!/^\d{10}(-\d{3})?$/.test(co.taxId)) return { error: 'mã số thuế phải là 10 số (hoặc 10 số-3 số với chi nhánh)' };
  if (!co.addr) return { error: 'cần địa chỉ công ty' };
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(co.email)) return { error: 'email nhận hoá đơn không hợp lệ' };
  return { co };
}
function validateCn(b) {
  if (!b || typeof b !== 'object') return { error: 'Dữ liệu không hợp lệ' };
  const lot = str(b.lot, 80), cat = str(b.cat, 40), rname = str(b.rname, 60), rphone = str(b.rphone, 20), raddr = str(b.raddr, 300), note = str(b.note, 500);
  if (!lot || !rname || !raddr) return { error: 'Thiếu tên lô, tên hoặc địa chỉ người nhận' };
  if (!CN_CATS.includes(cat)) return { error: 'Chọn loại hàng' };
  if (!/^[+0-9 ()-]{6,20}$/.test(rphone)) return { error: 'Số điện thoại người nhận không hợp lệ' };
  const wh = b.wh === 'HN' ? 'HN' : b.wh === 'HCM' ? 'HCM' : null; if (!wh) return { error: 'Chọn kho gửi hàng' };
  const method = CN_METHODS.includes(b.method) ? b.method : null; if (!method) return { error: 'Chọn hình thức vận chuyển' };
  const svcs = Array.isArray(b.svcs) ? [...new Set(b.svcs.filter((x) => CN_SVCS.includes(x)))] : [];
  if (!Array.isArray(b.items) || !b.items.length || b.items.length > 50) return { error: 'Cần 1–50 dòng sản phẩm' };
  const items = [];
  for (const i of b.items) {
    const name = str(i && i.name, 120), qty = Math.floor(Number(i && i.qty)), price = Math.floor(Number(i && i.price) || 0);
    if (!name || !(qty >= 1 && qty <= 1000000) || !(price >= 0 && price <= 1e11)) return { error: 'Dòng sản phẩm cần tên và số lượng hợp lệ' };
    items.push({ name, qty, price });
  }
  const wbs = Array.isArray(b.wb) ? [...new Set(b.wb.map((w) => str(w, 40).toUpperCase()).filter((w) => /^[A-Z0-9-]{4,40}$/.test(w)))].slice(0, 20) : [];
  const estW = b.estW === '' || b.estW == null ? null : Number(b.estW);
  if (estW !== null && !(estW > 0 && estW <= 100000)) return { error: 'Cân nặng ước tính không hợp lệ' };
  const estDims = Array.isArray(b.estDims) && b.estDims.length === 3 && b.estDims.every((x) => Number(x) > 0 && Number(x) <= 1000) ? b.estDims.map(Number) : null;
  const value = items.reduce((a, i) => a + i.qty * i.price, 0);
  const photos = { pkg: [], prod: [] };
  for (const k of ['pkg', 'prod']) {
    const arr = b.photos && Array.isArray(b.photos[k]) ? b.photos[k] : [];
    if (arr.length > PHOTO_MAX) return { error: 'Tối đa ' + PHOTO_MAX + ' ảnh mỗi loại' };
    for (const id of arr) { if (!/^[a-f0-9]{32}$/.test(String(id))) return { error: 'Ảnh không hợp lệ, tải lại ảnh' }; if (!photos[k].includes(id)) photos[k].push(String(id)); }
  }
  const vat = !!b.vat;
  let inv = null;
  if (vat) {
    const c = checkCo({ name: b.invCompany, taxId: b.invTax, addr: b.invAddr, email: b.invEmail });
    if (c.error) return { error: 'Lấy VAT: ' + c.error };
    inv = { company: c.co.name, taxId: c.co.taxId, addr: c.co.addr, email: c.co.email };
  }
  const est = estW || estDims ? price.quote({ cls: cat, method, weight: estW, dims: estDims, value, insurance: svcs.includes('insurance'), origin: wh, vat }) : null;
  const now = new Date().toISOString();
  return { data: {
    vat, inv, estW, estDims, est: est && est.ok ? { cw: est.cw, fee: est.customer, lines: est.lines } : null,
    note: lot, cat, recvName: rname, recvPhone: rphone, recvAddr: raddr, note2: note || null, wh, to: 'TQ', svcs,
    photos, items, wbs, wb: wbs.join(', ') || null, w: null, nw: null, dw: null, pk: null, fee: null, paid: 0, unpaid: 0, refund: null,
    value,
    fees: [{ t: method, prov: null, act: null, q: null, p: null, free: false }].concat(svcs.map((t) => ({ t, prov: null, act: null, q: null, p: null, free: false }))),
    ms: [{ t: now, s: 'PENDING' }],
  } };
}


// ===== Anh kien hang / san pham =====
// Anh luu o <thu muc du lieu khach>/uploads/<id>.jpg. Bang uploads trong khach.db ghi ai tai, cua khach nao, gan vao don nao.
function initUploads(db) {
  db.exec(`CREATE TABLE IF NOT EXISTS uploads (
    id TEXT PRIMARY KEY, owner TEXT, by TEXT NOT NULL, size INTEGER, code TEXT, kind TEXT,
    created_at TEXT DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
  )`);
}
const uploadFile = (dir, id) => path.join(dir, 'uploads', id + '.jpg');
// buf phai la JPEG (trinh duyet da nen lai). owner = username khach (null neu nhan vien tai truoc khi chon khach)
function saveUpload(db, dir, owner, by, buf) {
  if (!buf || buf.length < 200 || buf.length > UPLOAD_MAX) return { error: 'Ảnh phải nhỏ hơn 3MB' };
  if (!(buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff)) return { error: 'Chỉ nhận ảnh JPG' };
  const n = db.prepare("SELECT COUNT(*) AS n FROM uploads WHERE by = ? AND created_at > strftime('%Y-%m-%dT%H:%M:%fZ','now','-1 hour')").get(by).n;
  if (n >= 200) return { error: 'Tải quá nhiều ảnh trong 1 giờ, thử lại sau' };
  const id = crypto.randomBytes(16).toString('hex');
  fs.mkdirSync(path.join(dir, 'uploads'), { recursive: true });
  fs.writeFileSync(uploadFile(dir, id), buf, { flag: 'wx' });
  db.prepare('INSERT INTO uploads (id, owner, by, size) VALUES (?, ?, ?, ?)').run(id, owner, by, buf.length);
  return { id };
}
// Anh phai do chinh nguoi nay tai len va chua gan vao don nao
function checkUploads(db, by, photos) {
  for (const k of ['pkg', 'prod']) for (const id of photos[k]) {
    const r = db.prepare('SELECT by, code FROM uploads WHERE id = ?').get(id);
    if (!r || r.by !== by || r.code) return { error: 'Có ảnh không hợp lệ hoặc đã dùng cho đơn khác, tải lại ảnh' };
  }
  return { ok: true };
}
function claimUploads(db, owner, photos, code) {
  for (const k of ['pkg', 'prod']) for (const id of photos[k]) db.prepare('UPDATE uploads SET code = ?, owner = ?, kind = ? WHERE id = ? AND code IS NULL').run(code, owner, k, id);
}

module.exports = { validateCn, checkCo, str, initUploads, saveUpload, checkUploads, claimUploads, uploadFile, UPLOAD_MAX, PHOTO_MAX };
