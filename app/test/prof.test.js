const test = require('node:test'); const assert = require('node:assert');
const { DatabaseSync } = require('node:sqlite');
const fs = require('node:fs'); const os = require('node:os'); const path = require('node:path');
const P = require('../lib/prof');
const sh = require('../lib/cnshared');
function mk() { const db = new DatabaseSync(':memory:'); sh.initUploads(db); P.init(db); return db; }
const JPG = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff]), Buffer.alloc(300)]);

test('2 ban prof.js giong het', () => { assert.equal(fs.readFileSync(path.join(__dirname, '../lib/prof.js'), 'utf8'), fs.readFileSync(path.join(__dirname, '../../khach/lib/prof.js'), 'utf8')); });

test('anh dai dien: chi anh minh tai, anh cu bi xoa', () => {
  const db = mk(); const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'prof-'));
  const a = sh.saveUpload(db, dir, null, 'khach:u1', JPG).id, b = sh.saveUpload(db, dir, null, 'khach:u1', JPG).id;
  assert.ok(P.avatarSet(db, dir, 'k:g1', a, 'khach:u2').error);
  assert.ok(P.avatarSet(db, dir, 'k:g1', a, 'khach:u1').ok); assert.equal(P.avatarOf(db, 'k:g1'), a);
  assert.ok(P.avatarSet(db, dir, 'k:g1', b, 'khach:u1').ok);
  assert.equal(fs.existsSync(path.join(dir, 'uploads', a + '.jpg')), false); assert.ok(P.isAvatar(db, b)); assert.ok(!P.isAvatar(db, a));
});

test('ten goi nho: khach dat, NV de xuat cho khach xac nhan, co log', () => {
  const db = mk();
  assert.equal(P.aliasSet(db, 'G1', 'QT1', '  Lô   áo  ', 'k:u1').name, 'Lô áo');
  assert.equal(P.aliasSet(db, 'g1', 'QT1', 'x'.repeat(60), 'k:u1').name.length, P.NAME_MAX);
  assert.ok(P.aliasPropose(db, 'g1', 'QT1', '', 's:nv').error);
  assert.equal(P.aliasPropose(db, 'g1', 'QT1', 'Áo đông', 's:nv', 'Lan').pend, 'Áo đông');
  assert.deepEqual(P.aliasMap(db, 'g1').QT1.p, 'Áo đông');
  assert.equal(P.aliasMap(db, 'g1').QT1.n, 'x'.repeat(40), 'chua xac nhan thi chua doi ten');
  assert.equal(P.aliasAnswer(db, 'g1', 'QT1', false, 'k:u1').name, 'x'.repeat(40));
  P.aliasPropose(db, 'g1', 'QT1', 'Áo đông', 's:nv', 'Lan');
  assert.equal(P.aliasAnswer(db, 'g1', 'QT1', true, 'k:u1').name, 'Áo đông');
  assert.ok(P.aliasAnswer(db, 'g1', 'QT1', true, 'k:u1').error);
  assert.equal(P.decorate(db, 'g1', 'QT1', 'Đơn QT1 đã về'), 'Áo đông · Đơn QT1 đã về');
  assert.equal(P.aliasLog(db, 'g1', 'QT1').length, 6);
  assert.equal(P.aliasSet(db, 'g1', 'QT1', '', 'k:u1').name, ''); assert.equal(P.aliasMap(db, 'g1').QT1, undefined);
});

test('thong bao chung: theo brand, han, bat tat', () => {
  const db = mk();
  assert.ok(P.annSave(db, { text: ' ' }, 'nv').error);
  assert.ok(P.annSave(db, { text: 'a', start: '2026-11-02T00:00:00Z', end: '2026-11-01T00:00:00Z' }, 'nv').error);
  const id = P.annSave(db, { text: 'Kho nghỉ lễ', brand: 'green' }, 'nv').id;
  P.annSave(db, { text: 'Sắp tới', start: new Date(Date.now() + 864e5).toISOString() }, 'nv');
  assert.deepEqual(P.annActive(db, 'green').map((a) => a.id), [id]);
  assert.equal(P.annActive(db, 'yellow').length, 0);
  assert.ok(P.annActiveSet(db, id, false, 'nv').ok); assert.equal(P.annActive(db, 'green').length, 0);
});
