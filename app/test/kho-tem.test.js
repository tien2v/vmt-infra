// Tem 9710: so lieu doi chieu voi tem Gobiz that (Project design/tem-9710-mau-thuc.md, du lieu API 9710-stamp 31/10/2026)
const test = require('node:test'); const assert = require('node:assert');
const fs = require('node:fs'); const os = require('node:os'); const path = require('node:path');
process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'khotem-'));
// bang kv cua store (kho doc / ghi cai dat chung file vmt.db)
new (require('node:sqlite').DatabaseSync)(path.join(process.env.DATA_DIR, 'vmt.db')).exec('CREATE TABLE kv (k TEXT PRIMARY KEY, v TEXT)');
const kho = require('../lib/kho');
const base = {
  gen: 1, received: 1, cust: { 408614: ['MHG288', 'vuthuy1'], 1: ['UHL943', 'minhchau22'] },
  orders: [{ code: 'QT00ABC', st: 'PURCHASED', cid: 1, it: [], fe: [] }],
  ships: [
    { code: 'MHG288_99272037', st: 'PUTAWAY', cid: 408614, dw: 'HN', ca: '2026-10-27 08:20', fe: [['standard_shipping']], wb: ['830016421012'],
      pr: [['GIÀY DA', null, 30, 33, null, '']], rcv: ['Vu Thuy', '0982442829', '93 hoàng văn thái, Phường Khương Đình, Quận Thanh Xuân, Thành phố Hà Nội'],
      pk: [['830016421012', 27.8, 23.52, 70, 64, 63, 'PUTAWAY', '', '', '830016421012'], ['8261300011', 26.05, 23.477, 71, 64, 62, 'PUTAWAY', '', '', '830016421012']] },
    { code: 'MHG288_99272019', st: 'PUTAWAY', cid: 408614, dw: 'HN', ca: '2026-10-27 09:23', fe: [['eco_shipping'], ['inspection']], wb: ['777455715251330'],
      pr: [['GIÀY THỂ THAO', null, 2, 7.7, null, '']], rcv: ['Vu Thuy', '0982442829', '93 hoàng văn thái'], pk: [['777455715251330', 2.45, 2.66, 56, 38, 15, 'PUTAWAY', '', '']] },
    { code: 'UHL943_1', st: 'PUTAWAY', cid: 1, dw: 'HN', ca: '2026-10-31', fe: [], wb: ['YT1'], pr: [['TÚI', null, 10, 1, null, '']], pk: [['YT1', 2, 1.6, 31, 21, 20, 'PUTAWAY', '', '']] },
  ],
};
kho.init({ base: () => base });

test('kien con cua van don nhieu kien: ma kien + (ma van don), STT, tien hang ca don >= 1 trieu -> de trong', () => {
  const r = kho.stamp('MHG288_99272037', '8261300011'); assert.ok(r.ok, r.error);
  const t = r.tem;
  assert.equal(t.pkg, '8261300011'); assert.equal(t.wb, '830016421012'); assert.equal(t.stt, 2); assert.equal(t.tot, 2);
  assert.equal(t.val, 3603600); assert.equal(t.cod, null); // 30 x 33 te x 3.640 — y tem Gobiz (total_value 3.603.600, de trong)
  assert.equal(t.maxKg, 26.05); assert.equal(t.wh, 'HN'); assert.equal(t.route, 'CN9710'); assert.equal(t.user, 'vuthuy1'); assert.equal(t.cc, 'MHG288');
  assert.equal(t.rcv.name, 'Vu Thuy');
});
test('van don 1 kien: ma kien = ma van don, khong in ngoac; duoi 1 trieu -> in tien', () => {
  const t = kho.stamp('MHG288_99272019').tem;
  assert.equal(t.pkg, '777455715251330'); assert.equal(t.wb, ''); assert.equal(t.stt, 1); assert.equal(t.tot, 1);
  assert.equal(t.cod, 56056); // 2 x 7,7 te x 3.640 = 2 x 28.028 (Gobiz in 56.056)
  assert.equal(t.line, 'TK'); assert.deepEqual(t.svcs, ['点数']); assert.equal(t.goods, 'GIÀY THỂ THAO');
});
test('nguong + ty gia trong cai dat', () => {
  assert.ok(kho.setTemCfg({ maxCod: 50000, rateKs: 3640, route: 'CN9710', logo: 'KITITU', paper: 'A6', unkWh: 'HN', senders: 'JI SHI TRADING\nHONG KONG XIN FA' }, 'admin').ok);
  assert.equal(kho.stamp('MHG288_99272019').tem.cod, null);
  assert.ok(kho.setTemCfg(Object.assign(kho.temCfg(), { maxCod: 1000000 }), 'admin').ok);
  assert.ok(kho.setTemCfg(Object.assign(kho.temCfg(), { maxCod: 'abc' }), 'admin').error);
});
test('don chua co dia chi (chua dong bo): khach co don khac -> lay dia chi do; khong co -> ngau nhien, van in duoc', () => {
  const r = kho.stamp('UHL943_1'); assert.ok(r.ok, r.error); assert.ok(r.tem.rcv.fake); assert.match(r.tem.rcv.phone, /^04\d{8}$/); assert.match(r.tem.rcv.addr, /Hà Nội/);
  base.ships[2].cid = 408614; base.gen++; // cung khach vuthuy1 -> lay dia chi don gan nhat
  assert.equal(kho.stamp('UHL943_1').tem.rcv.name, 'Vu Thuy'); base.ships[2].cid = 1;
});
test('don order: chua in tren he thong moi', () => { assert.match(kho.stamp('QT00ABC').error, /Gobiz/); });
test('kien vo chu: nguoi nhan tu sinh SDT 04, co dinh theo ma; in o tram -> hang doi -> tram in xong ghi lich su', () => {
  kho.sync([{ id: 'evunk000001', code: 'ZZ123', type: 'in', at: '2026-10-31 17:00:00', data: { unk: 1, goods: 'Áo', goodsQty: 3 } }], 'kho1');
  const a = kho.stamp('ZZ123').tem, b = kho.stamp('ZZ123').tem;
  assert.ok(a.unk); assert.match(a.rcv.phone, /^04\d{8}$/); assert.deepEqual(a.rcv, b.rcv); assert.equal(a.goods, 'Áo');
  kho.sync([{ id: 'evprint0001', code: 'ZZ123', type: 'print', at: '2026-10-31 17:01:00', data: { pkg: 'ZZ123', where: 'station' } }], 'kho1');
  kho.sync([{ id: 'evprint0001', code: 'ZZ123', type: 'print', at: '2026-10-31 17:01:00', data: { pkg: 'ZZ123', where: 'station' } }], 'kho1'); // gui lai: khong nhan doi
  const jobs = kho.printTake('tram1'); assert.equal(jobs.length, 1); assert.ok(jobs[0].ok); assert.equal(kho.printTake('tram2').length, 0);
  assert.ok(kho.printDone(jobs[0].id, null, 'tram1').ok);
  assert.equal(kho.stamp('ZZ123').tem.printed, 1);
  assert.ok(kho.history('ZZ123').some((e) => e.type === 'printed'));
});
