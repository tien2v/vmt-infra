'use strict';
// Admin: xem don KY GUI VE VN moi (bang ks_orders trong khach.db, do trang khach tao) + cai dat kho Trung Quoc.
// Kho TQ luu kv 'cn_warehouses' trong vmt.db; trang khach doc de hien dia chi (thay {MA} bang ma khach).
const fs = require('node:fs');
const { DatabaseSync } = require('node:sqlite');
const KHACH_DB = process.env.KHACH_DB || '/khach/khach.db';

let store; let db;
function init(st) { store = st; }
function open() {
  if (db) return db;
  if (!fs.existsSync(KHACH_DB)) return null;
  db = new DatabaseSync(KHACH_DB);
  db.exec('PRAGMA busy_timeout = 5000');
  return db;
}
const hasTable = (d) => !!d.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'ks_orders'").get();

const LABEL = { MERCHANT_DELIVERING: 'Chờ tiếp nhận', PUTAWAY: 'Kho China', TRANSPORTING: 'Vận chuyển QT', READY_FOR_DELIVERY: 'Kho VN', DELIVERING: 'Đã xuất kho', DELIVERED: 'Hoàn thành', CANCELLED: 'Đã huỷ' };

function list(q, status, limit) {
  const d = open(); if (!d || !hasTable(d)) return [];
  const rows = d.prepare('SELECT * FROM ks_orders ORDER BY seq DESC LIMIT ?').all(Math.min(2000, limit || 500));
  const k = String(q || '').trim().toLowerCase();
  return rows.map((r) => {
    let x = {}; try { x = JSON.parse(r.data); } catch {}
    return { code: r.code, username: r.username, gobiz: r.gobiz, test: !!r.test, status: r.status, label: LABEL[r.status] || r.status, wb: r.wb, created: r.created_at, modified: r.updated_at || r.created_at,
      lot: x.lot || '', shop: x.shop || '', mode: x.mode, line: x.line, wh: x.wh, whCnName: x.whCnName, estW: x.estW, svcs: x.svcs || [], svcOther: x.svcOther || '', note: x.note2 || '', items: x.items || [], value: x.value || 0 };
  }).filter((o) => (!status || o.status === status) && (!k || [o.code, o.wb, o.username, o.gobiz, o.lot, o.shop].join(' ').toLowerCase().includes(k)));
}
function log(code) {
  const d = open(); if (!d || !hasTable(d)) return [];
  return d.prepare('SELECT ts, username, action, detail FROM ks_log WHERE code = ? ORDER BY ts').all(code).map((r) => { let det = {}; try { det = JSON.parse(r.detail || '{}'); } catch {} return { ts: r.ts, by: r.username, action: r.action, ip: det.ip || null, changes: det.changes || [] }; });
}

// ---- Kho Trung Quoc ----
const DEFAULT_WH = [
  { id: 'T3GZ', name: 'Kho Quảng Châu (T3)', short: 'QC', type: 'tieu', addr: '', recv: '', phone: '', active: true },
  { id: 'T3BT', name: 'Kho Bằng Tường chính ngạch (T3)', short: 'BT', type: 'chinh', addr: '', recv: '', phone: '', active: true },
  { id: 'B1BT', name: 'Kho Bằng Tường chính ngạch (B1)', short: 'BT', type: 'chinh', addr: '', recv: '', phone: '', active: true },
];
function warehouses() { try { const w = JSON.parse(store.kvGet('cn_warehouses') || 'null'); if (Array.isArray(w) && w.length) return w; } catch {} return DEFAULT_WH; }
const s = (v, max) => String(v == null ? '' : v).replace(/[\u0000-\u0009\u000b-\u001f\u007f]/g, ' ').trim().slice(0, max);
function setWarehouses(arr, by) {
  if (!Array.isArray(arr) || !arr.length || arr.length > 20) return { error: 'Danh sách kho không hợp lệ' };
  const out = []; const ids = new Set();
  for (const w of arr) {
    const id = s(w && w.id, 12).toUpperCase();
    if (!/^[A-Z0-9]{2,12}$/.test(id) || ids.has(id)) return { error: 'Mã kho phải là chữ / số, không trùng (vd T3GZ)' };
    ids.add(id);
    const type = w.type === 'chinh' ? 'chinh' : 'tieu';
    const name = s(w.name, 80); if (!name) return { error: 'Kho ' + id + ' thiếu tên' };
    out.push({ id, name, short: s(w.short, 8) || 'TQ', type, addr: s(w.addr, 400), recv: s(w.recv, 80), phone: s(w.phone, 30), active: w.active !== false });
  }
  if (!out.some((w) => w.active && w.type === 'tieu')) return { error: 'Cần ít nhất 1 kho tiểu ngạch đang bật' };
  const before = warehouses();
  if (JSON.stringify(before) === JSON.stringify(out)) return { ok: true, items: out };
  store.kvSet('cn_warehouses', JSON.stringify(out));
  // Lich su thay doi (giu 100 lan gan nhat): ai, luc nao, truong nao doi tu -> sang
  const changes = [];
  for (const w of out) {
    const o = before.find((x) => x.id === w.id);
    if (!o) { changes.push([w.id, '(chưa có)', 'Thêm kho']); continue; }
    for (const [k, lb] of [['name', 'Tên'], ['type', 'Loại'], ['addr', 'Địa chỉ'], ['recv', 'Người nhận'], ['phone', 'SĐT'], ['active', 'Bật']]) if (String(o[k]) !== String(w[k])) changes.push([w.id + ' · ' + lb, String(o[k] ?? ''), String(w[k] ?? '')]);
  }
  for (const o of before) if (!out.find((w) => w.id === o.id)) changes.push([o.id, 'Có', 'Xoá kho']);
  let hist = []; try { hist = JSON.parse(store.kvGet('cn_warehouses_log') || '[]'); } catch {}
  hist.unshift({ at: new Date().toISOString(), by, changes }); store.kvSet('cn_warehouses_log', JSON.stringify(hist.slice(0, 100)));
  return { ok: true, items: out };
}
function warehousesLog() { try { return JSON.parse(store.kvGet('cn_warehouses_log') || '[]'); } catch { return []; } }

module.exports = { init, list, log, warehouses, setWarehouses, warehousesLog, LABEL };
