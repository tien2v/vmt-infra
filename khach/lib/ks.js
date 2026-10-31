'use strict';
// Don KY GUI VE VN cua he thong moi (khong day sang Gobiz). Ma don 12 so dau 84 (ban-lam-viec-va-ma-don).
// Quy tac anh chot 31/10 (Project: decisions/tao-don.md muc 3, 4):
// - 1 don = 1 ma van don. Dan nhieu ma -> tao nhieu don (dung chung thong tin van chuyen).
// - Chon bao hiem / kiem dem -> bat buoc khai hang (ten, SL, gia tri).
// - Thuong mai dien tu (TMDT, ma 'tieu'): kho T3 Quang Chau. Chinh ngach: he thong tu chia theo can uoc tinh: >= 100kg -> B1, < 100kg -> T3 (khach khong chon).
// - Line = chang trong nuoc sau thong quan: ve HN co Tieu chuan / Tiet kiem; ve HCM them Uu tien (bay).
// - Khoa chong trung: cung khach + cung ma van don (don chua huy).
const crypto = require('node:crypto');
const tth = require('./tth');

const PREFIX = '84';
const MAX_ORDERS = 50;
const CHINH_B1_KG = 100;
const LINES = { TC: 'standard_shipping', TK: 'eco_shipping', UT: 'express_shipping', CN: 'official_shipping' };
const SVCS = ['insurance', 'wood_brace', 'counting', 'paper_brace', 'bubble_wrapping'];
const SVC_NAME = { insurance: 'Bảo hiểm', wood_brace: 'Đóng gỗ', counting: 'Kiểm đếm', paper_brace: 'Nẹp giấy', bubble_wrapping: 'Cuốn bọt khí' };
// Kho TQ mac dinh (dia chi anh gui 31/10) — admin sua o saas.7zone.net/ky-gui -> Kho Trung Quoc (kv 'cn_warehouses').
// {MA} = ky hieu khach ghi tren kien: "HN-username" / "SG-username" (username = ten dang nhap web khach dang quen dung).
const DEFAULT_WH = [
  { id: 'T3GZ', name: 'Kho Quảng Châu (T3)', short: 'QC', type: 'tieu', recv: '{MA}', addr: '广州市，花都区，花东镇，{MA}花都大道东129号6号仓库101房(2号武越仓）', zip: '510890', phone: '13719002017', phoneAgent: '13060999201', phoneOrder: '18566814214', active: true },
  { id: 'T3BT', name: 'Kho Bằng Tường chính ngạch (T3)', short: 'BT', type: 'chinh', recv: '{MA}李高翔', addr: '广西壮族自治区, 崇左市, 凭祥市, 凭祥镇 {MA}南山希望小学坡底DGVMT443仓库DG', zip: '532699', phone: '13878623546', phoneAgent: '', phoneOrder: '', active: true },
  { id: 'B1BT', name: 'Kho Bằng Tường chính ngạch (B1)', short: 'BT', type: 'chinh', recv: '{MA}1826B1', addr: '广西壮族自治区崇左市凭祥市1826B1皇龙居15栋6-{MA}12号仓库1826B1', zip: '532600', phone: '13084919998', phoneAgent: '', phoneOrder: '', active: true },
];

let db; let adminKv = () => null;
function init(database, kvReader) {
  db = database; adminKv = kvReader;
  db.exec(`CREATE TABLE IF NOT EXISTS ks_orders (
    seq INTEGER PRIMARY KEY AUTOINCREMENT, code TEXT UNIQUE NOT NULL, username TEXT NOT NULL, gobiz TEXT, test INTEGER NOT NULL DEFAULT 0,
    status TEXT NOT NULL DEFAULT 'MERCHANT_DELIVERING', wb TEXT NOT NULL, data TEXT NOT NULL,
    created_at TEXT DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')), updated_at TEXT
  );
  CREATE UNIQUE INDEX IF NOT EXISTS ks_orders_wb ON ks_orders (username, wb) WHERE status <> 'CANCELLED';
  CREATE TABLE IF NOT EXISTS ks_log (ts TEXT DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')), code TEXT NOT NULL, username TEXT, action TEXT NOT NULL, detail TEXT);
  CREATE INDEX IF NOT EXISTS ks_log_code ON ks_log (code);
  CREATE TABLE IF NOT EXISTS ks_defaults (owner TEXT PRIMARY KEY, data TEXT NOT NULL, by TEXT, updated_at TEXT DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')));`);
}

function warehouses() {
  let w = null; try { w = JSON.parse(adminKv('cn_warehouses') || 'null'); } catch {}
  return Array.isArray(w) && w.length ? w : DEFAULT_WH;
}
// Kho TQ cho don: tieu ngach -> kho tieu ngach dau tien dang bat; chinh ngach -> B1 neu >= 100kg, con lai T3
function pickWh(mode, estW) {
  const on = warehouses().filter((w) => w.active !== false && w.type === mode);
  if (!on.length) return null;
  if (mode === 'chinh') {
    const want = estW >= CHINH_B1_KG ? 'B1' : 'T3';
    return on.find((w) => String(w.id).startsWith(want)) || on[0];
  }
  return on[0];
}
// Nhom khach dai ly dung SDT kho rieng (kv 'cn_agent_groups', vd "kghn28,tango")
function agentGroups() { return String(adminKv('cn_agent_groups') || '').toLowerCase().split(/[\s,;]+/).filter(Boolean); }
// Ky hieu khach tren kien: HN-username / SG-username
const markOf = (dest, kh) => (dest === 'HCM' ? 'SG' : 'HN') + '-' + String(kh || '');
// Dia chi kho hien cho khach. mark = ky hieu (null: de nguyen {MA} cho trinh duyet tu thay theo kho nhan khach chon)
function whView(w, mark, group) {
  if (!w) return null;
  const sub = (x) => (mark == null ? String(x || '') : String(x || '').replace(/\{MA\}/g, mark));
  const agent = group && w.phoneAgent && agentGroups().includes(String(group).toLowerCase());
  return { id: w.id, name: w.name, addr: sub(w.addr), recv: sub(w.recv), phone: agent ? w.phoneAgent : (w.phone || ''), zip: w.zip || '', ready: !!w.addr };
}

const str = (v, max) => String(v == null ? '' : v).replace(/[\u0000-\u001f\u007f]/g, ' ').trim().slice(0, max);
function parseWbs(v) {
  const raw = Array.isArray(v) ? v : String(v || '').split(/[\s,;]+/);
  const out = []; const bad = [];
  for (const x of raw) { const w = str(x, 60).toUpperCase(); if (!w) continue; if (/^[A-Z0-9-]{4,40}$/.test(w)) { if (!out.includes(w)) out.push(w); } else bad.push(w); }
  return { wbs: out, bad };
}

// Kiem tra du lieu khach gui -> { wbs, data } hoac { error }
function validate(b) {
  if (!b || typeof b !== 'object') return { error: 'Dữ liệu không hợp lệ' };
  const { wbs, bad } = parseWbs(b.wbs);
  if (bad.length) return { error: 'Mã vận đơn không hợp lệ: ' + bad.slice(0, 3).join(', ') + ' (chỉ gồm chữ, số, dấu gạch, 4–40 ký tự)' };
  if (!wbs.length) return { error: 'Nhập mã vận đơn' };
  if (wbs.length > MAX_ORDERS) return { error: 'Tối đa ' + MAX_ORDERS + ' mã vận đơn mỗi lần' };
  const mode = b.mode === 'chinh' ? 'chinh' : 'tieu';
  const wh = b.wh === 'HCM' ? 'HCM' : b.wh === 'HN' ? 'HN' : null;
  if (!wh) return { error: 'Chọn kho nhận tại Việt Nam' };
  let line = mode === 'chinh' ? 'CN' : (['TC', 'TK', 'UT'].includes(b.line) ? b.line : null);
  if (!line) return { error: 'Chọn hình thức vận chuyển' };
  if (line === 'UT' && wh !== 'HCM') return { error: 'Vận chuyển ưu tiên chỉ áp dụng cho hàng về kho TP.HCM' };
  const estW = b.estW === '' || b.estW == null ? null : Number(String(b.estW).replace(',', '.'));
  if (estW !== null && !(estW > 0 && estW <= 100000)) return { error: 'Cân nặng ước tính không hợp lệ' };
  if (mode === 'chinh' && !estW) return { error: 'Hàng chính ngạch: nhập cân nặng ước tính để hệ thống chọn kho nhận phù hợp' };
  const svcs = Array.isArray(b.svcs) ? [...new Set(b.svcs.filter((x) => SVCS.includes(x)))] : [];
  const svcOther = str(b.svcOther, 200);
  const items = [];
  for (const i of (Array.isArray(b.items) ? b.items : []).slice(0, 51)) {
    const name = str(i && i.name, 120); const nameZh = str(i && i.nameZh, 120);
    const qty = Math.floor(Number(i && i.qty)); const price = Math.round((Number(i && i.price) || 0) * 100) / 100;
    if (!name && !nameZh && !(price > 0)) continue; // dong trong
    if (!(name || nameZh) || !(qty >= 1 && qty <= 1e6) || !(price >= 0 && price <= 1e9)) return { error: 'Dòng hàng cần tên và số lượng hợp lệ' };
    items.push(Object.assign({ name: name || nameZh, qty, price }, nameZh ? { nameZh } : {}));
  }
  if (items.length > 50) return { error: 'Tối đa 50 dòng hàng' };
  if (items.length && wbs.length > 1) return { error: 'Khai hàng thì mỗi đơn 1 mã vận đơn — tạo từng đơn, hoặc bỏ phần hàng để tạo nhiều đơn cùng lúc' };
  const value = Math.round(items.reduce((a, i) => a + i.qty * i.price, 0) * 100) / 100;
  if (svcs.includes('insurance') && !(items.length && value > 0)) return { error: 'Chọn bảo hiểm: cần khai hàng và giá trị (tệ) để tính bảo hiểm' };
  if (svcs.includes('counting') && !items.length) return { error: 'Chọn kiểm đếm: cần khai tên hàng và số lượng để kho đếm' };
  const whCn = pickWh(mode, estW || 0);
  if (!whCn) return { error: 'Kho Trung Quốc cho hình thức này đang tạm dừng, liên hệ VMT' };
  return { wbs, data: {
    lot: str(b.lot, 80), shop: str(b.shop, 120), items, value, svcs, svcOther, note2: str(b.note, 500),
    mode, line, wh, estW, whCn: whCn.id, whCnName: whCn.name, whCnShort: whCn.short || 'TQ',
  } };
}

function rowOf(r, ctx) {
  const d = JSON.parse(r.data);
  delete d.staffNote;
  const w = warehouses().find((x) => x.id === d.whCn);
  const ship = LINES[d.line] || 'standard_shipping';
  return {
    code: r.code, status: r.status, nu: true, mine: true,
    wh: d.whCnShort || 'TQ', to: d.wh, note: d.lot || null, shop: d.shop || null, img: null,
    fee: d.fee ?? null, value: d.value || 0, rate: null, w: d.w ?? null, vol: null, dw: null, nw: null,
    paid: d.paid || 0, refund: 0, unpaid: d.unpaid || 0, claim: null, ship: null,
    wb: r.wb, wbs: [r.wb], expPk: null, pk: d.pk ?? null,
    created: r.created_at, modified: r.updated_at || r.created_at, statusAt: r.updated_at || r.created_at,
    fees: [{ t: ship, prov: null, act: null, q: null, p: null, free: false }].concat((d.svcs || []).map((t) => ({ t, prov: null, act: null, q: null, p: null, free: false }))),
    ms: (d.ms || []).map((m) => ({ t: m.t, s: m.s })),
    items: d.items || [], svcs: d.svcs || [], svcOther: d.svcOther || '', note2: d.note2 || '', mode: d.mode, line: d.line, estW: d.estW,
    whCnName: d.whCnName, mark: markOf(d.wh, r.gobiz || r.username), whAddr: whView(w, markOf(d.wh, r.gobiz || r.username), ctx && ctx.group),
  };
}

// Tao nhieu don (moi ma van don 1 don) trong 1 giao dich: trung 1 ma la khong tao gi
function create(username, gobiz, test, v, ip, ctx, by) {
  const actor = by || ('khach:' + username);
  const now = new Date().toISOString();
  db.exec('BEGIN IMMEDIATE');
  try {
    const dup = v.wbs.filter((wb) => db.prepare("SELECT 1 FROM ks_orders WHERE username = ? AND wb = ? AND status <> 'CANCELLED'").get(username, wb));
    if (dup.length) { db.exec('ROLLBACK'); return { error: 'Mã vận đơn đã có đơn: ' + dup.slice(0, 5).join(', ') + (dup.length > 5 ? '…' : ''), dup }; }
    const taken = (c) => !!db.prepare('SELECT 1 FROM ks_orders WHERE code = ?').get(c);
    const codes = [];
    for (const wb of v.wbs) {
      const code = tth.makeCode(PREFIX, new Date(), taken);
      const data = Object.assign({}, v.data, { ms: [{ t: now, s: 'MERCHANT_DELIVERING', by: actor }], fee: null, paid: 0, unpaid: 0 });
      db.prepare('INSERT INTO ks_orders (code, username, gobiz, test, wb, data) VALUES (?, ?, ?, ?, ?, ?)').run(code, username, gobiz, test ? 1 : 0, wb, JSON.stringify(data));
      db.prepare('INSERT INTO ks_log (code, username, action, detail) VALUES (?, ?, ?, ?)').run(code, actor, by ? 'Nhân viên tạo đơn giúp khách' : 'Khách tạo đơn', JSON.stringify({ changes: [], ip: ip || null, wb, batch: v.wbs.length > 1 ? v.wbs.length : undefined }));
      codes.push(code);
    }
    db.exec('COMMIT');
    return { orders: codes.map((c) => rowOf(db.prepare('SELECT * FROM ks_orders WHERE code = ?').get(c), ctx)) };
  } catch (e) { try { db.exec('ROLLBACK'); } catch {} throw e; }
}

function list(username, gobiz, ctx) {
  return db.prepare('SELECT * FROM ks_orders WHERE username = ? OR (gobiz IS NOT NULL AND lower(gobiz) = lower(?)) ORDER BY seq DESC LIMIT 1000').all(username, gobiz || '').map((r) => rowOf(r, ctx));
}
function countRecent(username) { return db.prepare("SELECT COUNT(*) AS n FROM ks_orders WHERE username = ? AND created_at > strftime('%Y-%m-%dT%H:%M:%fZ','now','-1 hour')").get(username).n; }
// Vận đơn đã có đơn (để form báo trùng trước khi bấm)
function existing(username, wbs) {
  return wbs.filter((wb) => db.prepare("SELECT 1 FROM ks_orders WHERE username = ? AND wb = ? AND status <> 'CANCELLED'").get(username, wb));
}

// Khach tu huy khi hang chua ve kho TQ
function cancel(username, gobiz, code, ip, ctx) {
  db.exec('BEGIN IMMEDIATE');
  try {
    const r = db.prepare('SELECT * FROM ks_orders WHERE code = ? AND (username = ? OR (gobiz IS NOT NULL AND lower(gobiz) = lower(?)))').get(code, username, gobiz || '');
    if (!r) { db.exec('ROLLBACK'); return { error: 'Không tìm thấy đơn', code: 404 }; }
    if (r.status !== 'MERCHANT_DELIVERING') { db.exec('ROLLBACK'); return { error: 'Hàng đã về kho, không tự huỷ được. Liên hệ VMT để được hỗ trợ', code: 409 }; }
    const d = JSON.parse(r.data); const now = new Date().toISOString();
    d.ms = (d.ms || []).concat([{ t: now, s: 'CANCELLED', by: 'khach:' + username }]);
    db.prepare("UPDATE ks_orders SET status = 'CANCELLED', data = ?, updated_at = ? WHERE code = ?").run(JSON.stringify(d), now, code);
    db.prepare('INSERT INTO ks_log (code, username, action, detail) VALUES (?, ?, ?, ?)').run(code, 'khach:' + username, 'Khách huỷ đơn', JSON.stringify({ changes: [['Trạng thái', 'Chờ tiếp nhận', 'Đã huỷ']], ip: ip || null }));
    db.exec('COMMIT');
    return { order: rowOf(db.prepare('SELECT * FROM ks_orders WHERE code = ?').get(code), ctx) };
  } catch (e) { try { db.exec('ROLLBACK'); } catch {} throw e; }
}

// ---- Cai dat ky gui mac dinh (anh chot 31/10 16h): kien khach KHONG tao don, tren kien chi co username / ma khach
// -> kho TQ quet nhap kho, he thong tu tao don theo cai dat nay. Muon dich vu khac thi khach tao don truoc khi kho nhap / vao bao.
// Chi gom dich vu khong can khai hang: dong go, nep giay, cuon bot khi. Kiem dem / bao hiem can khai hang -> phai tao don.
const DEF_SVCS = ['wood_brace', 'paper_brace', 'bubble_wrapping'];
const DEF0 = { wh: 'HN', line: 'TC', svcs: [], brand: false };
function getDefault(owner) {
  const r = db.prepare('SELECT data, updated_at FROM ks_defaults WHERE owner = ?').get(String(owner || '').toLowerCase());
  if (!r) return Object.assign({ set: false }, DEF0);
  let d = {}; try { d = JSON.parse(r.data); } catch {}
  return Object.assign({}, DEF0, d, { set: true, at: r.updated_at });
}
function setDefault(owner, b, by, ip) {
  owner = String(owner || '').toLowerCase();
  const wh = b.wh === 'HCM' ? 'HCM' : 'HN';
  let line = ['TC', 'TK', 'UT'].includes(b.line) ? b.line : 'TC';
  if (line === 'UT' && wh !== 'HCM') return { error: 'Vận chuyển ưu tiên chỉ áp dụng cho hàng về kho TP.HCM' };
  const svcs = Array.isArray(b.svcs) ? [...new Set(b.svcs.filter((x) => DEF_SVCS.includes(x)))] : [];
  const d = { wh, line, svcs, brand: !!b.brand };
  const old = getDefault(owner);
  db.prepare('INSERT INTO ks_defaults (owner, data, by, updated_at) VALUES (?, ?, ?, ?) ON CONFLICT(owner) DO UPDATE SET data = excluded.data, by = excluded.by, updated_at = excluded.updated_at').run(owner, JSON.stringify(d), by, new Date().toISOString());
  const L = { TC: 'Tiêu chuẩn', TK: 'Tiết kiệm', UT: 'Ưu tiên' };
  const ch = [];
  if (old.wh !== d.wh) ch.push(['Kho nhận', old.wh, d.wh]);
  if (old.line !== d.line) ch.push(['Vận chuyển', L[old.line], L[d.line]]);
  if (old.svcs.join(',') !== d.svcs.join(',')) ch.push(['Dịch vụ', old.svcs.map((x) => SVC_NAME[x]).join(', ') || 'Không', d.svcs.map((x) => SVC_NAME[x]).join(', ') || 'Không']);
  if (!!old.brand !== d.brand) ch.push(['Hàng thương hiệu', old.brand ? 'Có' : 'Không', d.brand ? 'Có' : 'Không']);
  db.prepare('INSERT INTO ks_log (code, username, action, detail) VALUES (?, ?, ?, ?)').run('MACDINH:' + owner, by, 'Sửa cài đặt ký gửi mặc định', JSON.stringify({ changes: ch, ip: ip || null }));
  return { ok: true, def: getDefault(owner) };
}

module.exports = { getDefault, setDefault, DEF_SVCS, init, validate, create, list, cancel, existing, countRecent, warehouses, pickWh, whView, markOf, agentGroups, parseWbs, DEFAULT_WH, SVC_NAME, LINES, CHINH_B1_KG };
