const test = require('node:test'); const assert = require('node:assert');
const { DatabaseSync } = require('node:sqlite');
const L = require('../lib/ledger'); const T = require('../lib/tth');
function mk() { const db = new DatabaseSync(':memory:');
  db.exec("CREATE TABLE cn_orders (seq INTEGER PRIMARY KEY AUTOINCREMENT, code TEXT, username TEXT, gobiz TEXT, test INTEGER DEFAULT 0, status TEXT, data TEXT, created_at TEXT, updated_at TEXT); CREATE TABLE notif (id INTEGER PRIMARY KEY AUTOINCREMENT, username TEXT, code TEXT, text TEXT, read INTEGER DEFAULT 0, created_at TEXT); CREATE TABLE uploads (id TEXT PRIMARY KEY, owner TEXT, by TEXT, size INTEGER, code TEXT, kind TEXT, created_at TEXT); CREATE TABLE cn_log (ts TEXT, code TEXT, username TEXT, action TEXT, detail TEXT);");
  L.init(db); T.init(db); return db; }
const PLA = `Tỷ giá hiện tại: [PLA]\n🌸 Thẻ nhanh\n10V: 3942 - 5V: 3944\n1V: 3959 - 1K: 3972\n🌸 Alipay Trung\n5V: 3960 - 1V: 3962 - 1K: 3977\n🌸 Alipay Việt\n5V: 3960 - 1V: 3962 - 1K: 3977\n🌸 Wechat\n5V: 3942 - 1V: 3944 - 1K: 3964`;
const PRICE = { brands: { default: { alipay_cn: [{ min: 0, add: 60 }, { min: 1000, add: 30 }], wechat: [{ min: 0, add: 60 }], bank: [{ min: 0, add: 40 }], alipay_vn: [{ min: 0, add: 50 }], auth: [{ min: 0, rate: 4300 }] } } };
test('ma don', () => { const c = T.makeCode('68', new Date('2026-11-30T05:00:00Z'), () => false); assert.equal(c.length, 12); assert.ok(c.startsWith('682611')); assert.equal(c.slice(7, 9), '30'); assert.ok(T.validOrderCode(c));
  const bad = c.slice(0, 11) + ((+c[11] + 1) % 10); assert.ok(!T.validOrderCode(bad)); const sw = c.slice(0, 9) + c[10] + c[9] + c[11]; if (c[9] !== c[10]) assert.ok(!T.validOrderCode(sw)); assert.equal(T.dayOf(c), '30/11/2026'); });
test('doc tin PLA', () => { const p = T.parsePLA(PLA); assert.deepEqual(p.rates.bank, [{ min: 100000, rate: 3942 }, { min: 50000, rate: 3944 }, { min: 10000, rate: 3959 }, { min: 1000, rate: 3972 }]); assert.equal(p.rates.wechat[2].rate, 3964); assert.equal(p.rates.alipay_vn[0].rate, 3960); });
test('luong day du', () => { const db = mk(); T.setCost(db, PLA, 'admin'); assert.ok(T.setPrice(db, PRICE, 'admin').ok);
  const q = T.quote(db, { type: 'alipay_cn', cny: 500, brand: 'default' }); assert.equal(q.rate, 3977 + 60); assert.equal(q.total, 500 * 4037);
  const q2 = T.quote(db, { type: 'alipay_cn', cny: 12000.5, brand: 'x' }); assert.equal(q2.rate, 3962 + 30); assert.equal(q2.total, Math.round(1200050 * 3992 / 100));
  assert.equal(T.create(db, { username: 'k', owner: 'k', type: 'wechat', cny: 100, recipient: { name: 'a' }, by: 'khach:k' }).error, 'WeChat bắt buộc có ảnh mã QR người nhận');
  const c = T.create(db, { username: 'k', owner: 'k', type: 'alipay_cn', cny: 1000, recipient: { name: 'Li', account: '138000' }, by: 'khach:k', saveRecipient: true }); assert.ok(c.ok, c.error);
  const code = c.order.code; assert.equal(c.order.status, 'UNPAID'); assert.equal(c.order.total, 1000 * (3977 + 30));
  const dup = T.create(db, { username: 'k', owner: 'k', type: 'alipay_cn', cny: 1000, recipient: { name: 'Li', account: '138000' }, by: 'khach:k' }); assert.ok(dup.dup);
  // nap vi
  L.tx(db, () => L.post(db, { owner: 'k', kind: 'TOPUP', amount: 100000000, idem: 'D1', by: 't' }));
  const bad = T.pay(db, { owner: 'k', code, idem: 'aaaaaaaaaaaaaaaa1', expect: 1, by: 'khach:k' }); assert.ok(bad.rateChanged);
  const p = T.pay(db, { owner: 'k', code, idem: 'aaaaaaaaaaaaaaaa1', expect: bad.need, by: 'khach:k' }); assert.ok(p.ok, p.error); assert.equal(p.amount, 4007000);
  const again = T.pay(db, { owner: 'k', code, idem: 'aaaaaaaaaaaaaaaa1', expect: bad.need, by: 'khach:k' }); assert.ok(again.replay);
  assert.equal(L.walletView(db, 'k').balance, 100000000 - 4007000);
  // ty gia giam: giu nguyen; tang: NEED_PAY
  T.setCost(db, PLA.replace('1K: 3977', '1K: 3970').replace('1K: 3977', '1K: 3970'), 'a'); assert.equal(T.getKhach(db, 'k', code).status, 'QUEUED');
  T.setCost(db, PLA.replace('1K: 3977', '1K: 3987'), 'a'); const o = T.getKhach(db, 'k', code); assert.equal(o.status, 'NEED_PAY'); assert.equal(o.need, 1000 * 10);
  assert.equal(T.claim(db, code, 'nv1').code, 409);
  assert.ok(T.pay(db, { owner: 'k', code, idem: 'bbbbbbbbbbbbbbbb2', expect: 10000, by: 'khach:k' }).ok);
  // giam so te khi dang cho xu ly -> hoan phan giam
  const e = T.edit(db, code, { kind: 'khach', id: 'k', username: 'k' }, { cny: 900 }); assert.ok(e.ok, e.error); assert.equal(e.order.status, 'QUEUED'); assert.equal(e.order.paid, 900 * 4047);
  assert.equal(L.walletView(db, 'k').balance, 100000000 - 900 * 4047);
  // xu ly
  assert.ok(T.claim(db, code, 'nv1').ok); assert.equal(T.claim(db, code, 'nv2').code, 409);
  assert.equal(T.cancel(db, code, { kind: 'staff', id: 'nv1' }, 'abc').code, 403);
  assert.equal(T.edit(db, code, { kind: 'khach', id: 'k', username: 'k' }, { note: 'x' }).code, 409);
  T.saveFund(db, { id: 'PLA', name: 'PLA', currency: 'VND', kind: 'partner', staff: ['nv1'] }, 'admin');
  assert.equal(T.complete(db, code, 'nv1', { fundId: 'PLA' }).error, 'Phải tải bill trước khi bấm Thành công');
  db.prepare("INSERT INTO uploads (id, by) VALUES ('0123456789abcdef0123456789abcdef', 'staff:nv1')").run();
  assert.ok(T.addBill(db, code, 'nv1', '0123456789abcdef0123456789abcdef').ok);
  const done = T.complete(db, code, 'nv1', { fundId: 'PLA' }); assert.ok(done.ok, done.error);
  const a = T.listAdmin(db, { withTest: true })[0]; assert.equal(a.status, 'DONE'); assert.equal(a.costRate, 3987); assert.equal(a.cost_vnd, 900 * 3987);
  assert.ok(L.verify(db).ok);
  // huy don da tra -> hoan du
  const c2 = T.create(db, { username: 'k', owner: 'k', type: 'bank', cny: 2000, recipient: { name: 'Wang', account: '6222 0000 1111', bank: 'ICBC' }, by: 'khach:k' }); const q3 = T.getKhach(db, 'k', c2.order.code);
  { const pp = T.pay(db, { owner: 'k', code: q3.code, idem: 'cccccccccccccccc3', expect: q3.need, by: 'khach:k' }); assert.ok(pp.ok, JSON.stringify(pp)); }
  const before = L.walletView(db, 'k').balance; assert.ok(T.cancel(db, q3.code, { kind: 'khach', id: 'k', username: 'k' }).ok); assert.equal(L.walletView(db, 'k').balance, before + q3.need);
  assert.ok(L.verify(db).ok);
  // quy te rieng: binh quan
  T.saveFund(db, { id: 'ALI2', name: 'Alipay 2', currency: 'CNY', staff: ['nv1'] }, 'admin');
  T.fundPost(db, { fund: 'ALI2', kind: 'BUY', amount: 100000, vnd: 1000 * 3950, by: 'x', ref: 'b1' }); T.fundPost(db, { fund: 'ALI2', kind: 'BUY', amount: 100000, vnd: 1000 * 3970, by: 'x', ref: 'b2' });
  assert.equal(T.fundState(db, 'ALI2').avg, 3960);
  // QR theo don: tu tra
  const c4 = T.create(db, { username: 'k', owner: 'k', type: 'alipay_vn', cny: 100, recipient: { name: 'Z', account: '1' }, by: 'khach:k' });
  const r4 = T.autoPayFromContent(db, 'k', 'NAP 3HK7Q25 ' + T.fmtCode(c4.order.code), 'ref1', 'ngan-hang', false); assert.ok(r4[0].ok, JSON.stringify(r4));
});
