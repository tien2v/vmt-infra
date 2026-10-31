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
// GIONG khach/lib/ks.js DEFAULT_WH (2 container rieng nen chep 2 noi; sua 1 ben thi sua ben kia)
const DEFAULT_WH = [
  { id: 'T3GZ', name: 'Kho Quảng Châu (T3)', short: 'QC', type: 'tieu', recv: '{MA}', addr: '广州市，花都区，花东镇，{MA}花都大道东129号6号仓库101房(2号武越仓）', zip: '510890', phone: '13719002017', phoneAgent: '13060999201', phoneOrder: '18566814214', active: true },
  { id: 'T3BT', name: 'Kho Bằng Tường chính ngạch (T3)', short: 'BT', type: 'chinh', recv: '{MA}李高翔', addr: '广西壮族自治区, 崇左市, 凭祥市, 凭祥镇 {MA}南山希望小学坡底DGVMT443仓库DG', zip: '532699', phone: '13878623546', phoneAgent: '', phoneOrder: '', active: true },
  { id: 'B1BT', name: 'Kho Bằng Tường chính ngạch (B1)', short: 'BT', type: 'chinh', recv: '{MA}1826B1', addr: '广西壮族自治区崇左市凭祥市1826B1皇龙居15栋6-{MA}12号仓库1826B1', zip: '532600', phone: '13084919998', phoneAgent: '', phoneOrder: '', active: true },
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
    out.push({ id, name, short: s(w.short, 8) || 'TQ', type, addr: s(w.addr, 400), recv: s(w.recv, 80), zip: s(w.zip, 12), phone: s(w.phone, 30), phoneAgent: s(w.phoneAgent, 30), phoneOrder: s(w.phoneOrder, 30), active: w.active !== false });
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
    for (const [k, lb] of [['name', 'Tên'], ['type', 'Loại'], ['addr', 'Địa chỉ'], ['recv', 'Người nhận'], ['zip', 'Mã bưu chính'], ['phone', 'SĐT'], ['phoneAgent', 'SĐT đại lý'], ['phoneOrder', 'SĐT đơn order'], ['active', 'Bật']]) if (String(o[k]) !== String(w[k])) changes.push([w.id + ' · ' + lb, String(o[k] ?? ''), String(w[k] ?? '')]);
  }
  for (const o of before) if (!out.find((w) => w.id === o.id)) changes.push([o.id, 'Có', 'Xoá kho']);
  let hist = []; try { hist = JSON.parse(store.kvGet('cn_warehouses_log') || '[]'); } catch {}
  hist.unshift({ at: new Date().toISOString(), by, changes }); store.kvSet('cn_warehouses_log', JSON.stringify(hist.slice(0, 100)));
  return { ok: true, items: out };
}
function agentGroups() { return String(store.kvGet('cn_agent_groups') || ''); }
function setAgentGroups(v, by) {
  const g = [...new Set(String(v || '').toLowerCase().split(/[\s,;]+/).filter((x) => /^[a-z0-9_.-]{1,40}$/.test(x)))].join(',');
  const old = agentGroups(); if (old === g) return;
  store.kvSet('cn_agent_groups', g);
  let hist = []; try { hist = JSON.parse(store.kvGet('cn_warehouses_log') || '[]'); } catch {}
  hist.unshift({ at: new Date().toISOString(), by, changes: [['Nhóm khách đại lý (SĐT riêng)', old, g]] }); store.kvSet('cn_warehouses_log', JSON.stringify(hist.slice(0, 100)));
}
function warehousesLog() { try { return JSON.parse(store.kvGet('cn_warehouses_log') || '[]'); } catch { return []; } }

// ---- Tu tao don khi kien ve kho TQ ma khach chua tao don (anh chot 31/10 16h) ----
// Ben ban kho goi: autoCreate({ mark, wb, by }). mark = chu tren kien: username / ma khach, co the kem HN- / SG- / @@ phia truoc.
// Khong co don -> tao don ky gui theo cai dat mac dinh cua khach (ks_defaults); co san don cung khach + van don -> tra lai don do.
const tth = require('./tth');
function parseMark(mark) {
  let m = String(mark || '').trim(); let dest = null; let brand = false;
  for (let i = 0; i < 3; i++) {
    if (/^@@/.test(m)) { brand = true; m = m.slice(2); }
    const x = /^(HN|SG|HCM)[-_ ]/i.exec(m); if (x) { dest = /^HN/i.test(x[1]) ? 'HN' : 'HCM'; m = m.slice(x[0].length); }
  }
  return { key: m.replace(/\s+/g, '').toLowerCase(), dest, brand };
}
function resolveOwner(d, key, isKnown) {
  if (!key) return null;
  try { const r = d.prepare('SELECT owner FROM cust_codes WHERE upper(code) = upper(?)').get(key); if (r) return r.owner; } catch {}
  if (!/^[a-z0-9_.@-]{2,64}$/.test(key)) return null;
  // username Gobiz (khach cu) hoac tai khoan web moi
  if (isKnown && isKnown(key)) return key;
  try { if (d.prepare('SELECT 1 FROM users WHERE lower(username) = ? OR lower(gobiz) = ?').get(key, key)) return key; } catch {}
  return null;
}
function autoCreate(o) {
  const d = open(); if (!d || !hasTable(d)) return { error: 'Chưa có dữ liệu ký gửi' };
  const wb = String(o.wb || '').trim().toUpperCase();
  if (!/^[A-Z0-9-]{4,40}$/.test(wb)) return { error: 'Mã vận đơn không hợp lệ' };
  const pm = parseMark(o.mark); const own = resolveOwner(d, pm.key, o.isKnown);
  if (!own) return { error: 'Không nhận ra khách từ ký hiệu trên kiện' };
  const by = String(o.by || 'he-thong').slice(0, 60);
  d.exec('BEGIN IMMEDIATE');
  try {
    const ex = d.prepare("SELECT code FROM ks_orders WHERE wb = ? AND status <> 'CANCELLED' AND (lower(username) = ? OR lower(gobiz) = ?)").get(wb, own, own);
    if (ex) { d.exec('COMMIT'); return { ok: true, code: ex.code, existed: true }; }
    let def = {}; try { def = JSON.parse((d.prepare('SELECT data FROM ks_defaults WHERE owner = ?').get(own) || {}).data || '{}'); } catch {}
    const wh = pm.dest || (def.wh === 'HCM' ? 'HCM' : 'HN');
    let line = ['TC', 'TK', 'UT'].includes(def.line) ? def.line : 'TC'; if (line === 'UT' && wh !== 'HCM') line = 'TC';
    const w = warehouses().find((x) => x.active !== false && x.type === 'tieu') || warehouses()[0];
    const now = new Date().toISOString();
    const data = { lot: '', shop: '', items: [], value: 0, svcs: (def.svcs || []).filter((x) => ['wood_brace', 'paper_brace', 'bubble_wrapping'].includes(x)), svcOther: '', note2: '',
      brand: pm.brand || !!def.brand, auto: true, mode: 'tieu', line, wh, estW: null, whCn: w.id, whCnName: w.name, whCnShort: w.short || 'TQ',
      ms: [{ t: now, s: 'MERCHANT_DELIVERING', by }], fee: null, paid: 0, unpaid: 0 };
    const code = tth.makeCode('84', new Date(), (c) => !!d.prepare('SELECT 1 FROM ks_orders WHERE code = ?').get(c));
    d.prepare('INSERT INTO ks_orders (code, username, gobiz, test, wb, data) VALUES (?, ?, ?, 0, ?, ?)').run(code, own, own, wb, JSON.stringify(data));
    d.prepare('INSERT INTO ks_log (code, username, action, detail) VALUES (?, ?, ?, ?)').run(code, by, 'Tự tạo đơn khi kiện về kho TQ (theo cài đặt mặc định)', JSON.stringify({ changes: [], mark: String(o.mark || '').slice(0, 80), wb, def: Object.keys(def).length ? def : null }));
    try { d.prepare('INSERT INTO notif (username, code, text) VALUES (?, ?, ?)').run(own, code, 'Kiện ' + wb + ' vừa về kho Trung Quốc. Hệ thống đã tạo đơn ký gửi theo cài đặt mặc định của anh/chị.'); } catch {}
    d.exec('COMMIT');
    return { ok: true, code, existed: false, owner: own, wh, line, svcs: data.svcs, brand: data.brand };
  } catch (e) { try { d.exec('ROLLBACK'); } catch {} throw e; }
}

module.exports = { autoCreate, parseMark, init, list, log, warehouses, setWarehouses, warehousesLog, agentGroups, setAgentGroups, LABEL };
