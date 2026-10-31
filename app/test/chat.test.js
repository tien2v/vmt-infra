const test = require('node:test'); const assert = require('node:assert');
const { DatabaseSync } = require('node:sqlite');
const C = require('../lib/chat');
function mk() { const db = new DatabaseSync(':memory:'); db.exec('CREATE TABLE uploads (id TEXT PRIMARY KEY, owner TEXT, by TEXT, size INTEGER, code TEXT, kind TEXT, created_at TEXT)'); C.init(db); return db; }
test('2 ban chat.js giong het', () => { const fs = require('node:fs'), p = require('node:path'); assert.equal(fs.readFileSync(p.join(__dirname, '../lib/chat.js'), 'utf8'), fs.readFileSync(p.join(__dirname, '../../khach/lib/chat.js'), 'utf8')); });
test('luong chat co ban', () => {
  const db = mk();
  assert.equal(C.ensure(db, { owner: 'k1', ctx: 'don:<x>' }), null);
  const t = C.ensure(db, { owner: 'k1', gobiz: 'K1', ctx: 'don:ABC123', kind: 'order' });
  assert.equal(C.ensure(db, { owner: 'k1', ctx: 'don:ABC123' }).id, t.id);
  assert.ok(C.send(db, t, { f: 'k', body: '   ' }).error);
  const m1 = C.send(db, t, { f: 'k', body: 'Hỏi đơn' }).msg;
  let th = C.thread(db, t.id); assert.ok(th.wait_at); assert.equal(th.cust_read, m1.id);
  assert.equal(C.counts(db, 'nv1', false).free, 1);
  C.send(db, th, { f: 'note', by: 'nv1', name: 'NV', body: 'noi bo' });
  th = C.thread(db, t.id); assert.ok(th.wait_at, 'ghi chu khong tinh la tra loi'); assert.equal(th.last_text, 'Hỏi đơn');
  db.prepare("INSERT INTO uploads (id, by) VALUES ('img1', 'staff:nv1')").run();
  const m3 = C.send(db, th, { f: 's', by: 'nv1', name: 'NV', body: 'Dạ', reply: m1.id, att: [{ id: 'img1' }] }).msg;
  th = C.thread(db, t.id); assert.equal(th.wait_at, null); assert.equal(th.assignee, 'nv1');
  assert.equal(db.prepare('SELECT code FROM uploads WHERE id = ?').get('img1').code, 'chat:' + t.id);
  const k = C.messages(db, t.id, 'k', 'k'); assert.equal(k.length, 2); assert.ok(!k.some((m) => m.f === 'note')); assert.equal(k[1].reply.id, m1.id); assert.equal(k[1].by, undefined);
  assert.equal(C.messages(db, t.id, 's', 's:nv1').length, 3);
  assert.equal(C.unreadK(db, t.id, th.cust_read), 1);
  assert.equal(C.listCustomer(db, 'k1')[0].unread, 1);
  assert.equal(C.unreadCustomer(db, 'k1'), 1); C.read(db, th, 'k', m3.id); assert.equal(C.unreadCustomer(db, 'k1'), 0);
  // cam xuc: bam lai thi bo, doi emoji thi thay
  C.react(db, C.msg(db, m3.id), 'k', '❤️'); assert.deepEqual(C.view(db, C.msg(db, m3.id), 'k', 'k').re, [{ e: '❤️', n: 1, mine: true }]);
  C.react(db, C.msg(db, m3.id), 'k', '👍'); assert.deepEqual(C.view(db, C.msg(db, m3.id), 'k', 'k').re.map((r) => r.e), ['👍']);
  C.react(db, C.msg(db, m3.id), 'k', '👍'); assert.equal(C.msg(db, m3.id).reacts, null);
  assert.ok(C.react(db, C.msg(db, m3.id), 'k', 'x').error);
  // thu hoi: chi tin minh, trong 5 phut; ban goc giu cho nhan vien
  assert.equal(C.recall(db, C.msg(db, m3.id), 'khach:k1', false).code, 403);
  assert.ok(C.recall(db, C.msg(db, m1.id), 'khach:k1', false).ok);
  assert.equal(C.view(db, C.msg(db, m1.id), 'k', 'k').body, undefined); assert.ok(C.view(db, C.msg(db, m1.id), 's', '').orig.includes('Hỏi đơn'));
  db.prepare("UPDATE chat_msgs SET created_at = strftime('%Y-%m-%dT%H:%M:%fZ','now','-61 minutes') WHERE id = ?").run(m3.id);
  assert.equal(C.recall(db, C.msg(db, m3.id), 'nv1', true).code, 409);
  // giao viec / da xu ly
  C.assign(db, C.thread(db, t.id), 'nv2', 'nv1'); assert.equal(C.listStaff(db, 'mine', 'nv2', '', false).length, 1);
  C.setStatus(db, C.thread(db, t.id), 'done', 'nv2'); assert.equal(C.listStaff(db, 'done', 'nv2', '', false).length, 1);
  C.send(db, C.thread(db, t.id), { f: 'k', body: 'hỏi tiếp' }); assert.equal(C.thread(db, t.id).status, 'open');
  assert.equal(C.listStaff(db, 'all', 'nv1', 'tiếp', false).length, 1); assert.equal(C.listStaff(db, 'all', 'nv1', 'khongco', false).length, 0);
  assert.ok(C.evSince(db, 0).length > 5);
});
test('ngoai gio: tu tra loi 1 lan', (t) => {
  const db = mk(); const th = C.ensure(db, { owner: 'k1', ctx: 'vmt' });
  const sunNight = Date.parse('2026-11-01T15:00:00Z'); // CN 22:00 gio VN
  assert.equal(C.inHours(sunNight), false); assert.equal(C.inHours(Date.parse('2026-11-02T02:00:00Z')), true); // T2 9:00
  C.send(db, th, { f: 'k', body: 'gấp' });
  db.prepare("UPDATE chat_threads SET wait_at = '2026-11-01T14:00:00.000Z'").run();
  t.mock.method(Date, 'now', () => sunNight);
  assert.equal(C.oohPump(db), 1); assert.equal(C.oohPump(db), 0);
  const ms = C.messages(db, th.id, 'k', 'k'); assert.equal(ms[ms.length - 1].f, 'sys');
  assert.ok(C.thread(db, th.id).wait_at, 'tin he thong khong xoa trang thai cho');
});
test('mau cau', () => { const db = mk(); assert.ok(C.tplSave(db, { key: '/Chuyen khoan', text: 'STK...' }, 'nv').ok); assert.equal(C.tplList(db)[0].key, 'chuyen-khoan'); assert.ok(C.tplSave(db, { key: '', text: 'x' }, 'nv').error); });
test('video: luu, kiem tra, gan vao tin, don dep', async () => {
  const fs = require('node:fs'), os = require('node:os'), path = require('node:path'), { Readable } = require('node:stream');
  const db = mk(); const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'chatv-'));
  const req = (buf, len) => Object.assign(Readable.from([buf]), { headers: { 'content-length': String(len || buf.length) } });
  const mp4 = Buffer.concat([Buffer.from([0, 0, 0, 0x18]), Buffer.from('ftypisom'), Buffer.alloc(3000, 1)]);
  assert.ok((await C.fileSave(db, dir, req(Buffer.alloc(3000, 7)), { by: 'khach:k', max: 1e6 })).error, 'khong phai video');
  assert.ok((await C.fileSave(db, dir, req(mp4, 5e6), { by: 'khach:k', max: 1e6 })).error, 'qua dung luong');
  const r = await C.fileSave(db, dir, req(mp4), { by: 'khach:k', owner: 'k1', max: 1e6 }); assert.ok(r.id, r.error);
  assert.equal(fs.statSync(path.join(dir, 'chatfiles', r.id)).size, mp4.length);
  assert.ok(C.attCheck(db, [r.id], 'khach:khac').error);
  const ac = C.attCheck(db, [r.id], 'khach:k'); assert.deepEqual(ac.att, [{ id: r.id, t: 'v' }]);
  const t = C.ensure(db, { owner: 'k1', ctx: 'vmt' });
  C.send(db, t, { f: 'k', att: ac.att });
  assert.equal(C.thread(db, t.id).last_text, '[Video]');
  assert.equal(db.prepare('SELECT kind, code FROM uploads WHERE id = ?').get(r.id).kind, 'video');
  assert.ok(C.attCheck(db, [r.id], 'khach:k').error, 'da dung roi');
  // video bo ngang > 1 ngay bi xoa, video dang dung giu lai
  const r2 = await C.fileSave(db, dir, req(mp4), { by: 'khach:k', max: 1e6 });
  db.prepare("UPDATE uploads SET created_at = strftime('%Y-%m-%dT%H:%M:%fZ','now','-2 days') WHERE id IN (?, ?)").run(r.id, r2.id);
  assert.equal(C.filePurge(db, dir), 1); assert.ok(fs.existsSync(path.join(dir, 'chatfiles', r.id))); assert.ok(!fs.existsSync(path.join(dir, 'chatfiles', r2.id)));
  fs.rmSync(dir, { recursive: true, force: true });
});
test('2 ban webpush.js giong het', () => { const fs = require('node:fs'), p = require('node:path'); assert.equal(fs.readFileSync(p.join(__dirname, '../lib/webpush.js'), 'utf8'), fs.readFileSync(p.join(__dirname, '../../khach/lib/webpush.js'), 'utf8')); });
test('nhan + the thanh toan', () => {
  const db = mk(); const t = C.ensure(db, { owner: 'k1', ctx: 'don:SCN1' });
  const tags = C.tagList(db); assert.ok(tags.length >= 5, 'co nhan mac dinh');
  C.send(db, t, { f: 'k', body: 'hỏi' });
  assert.ok(C.setTags(db, C.thread(db, t.id), [tags[0].id, 999, tags[1].id], 'nv').ok);
  assert.deepEqual(C.tView(db, C.thread(db, t.id), 's').tags, [tags[0].id, tags[1].id]);
  assert.equal(C.listStaff(db, 'all', 'nv', '', false, tags[0].id).length, 1); assert.equal(C.listStaff(db, 'all', 'nv', '', false, tags[2].id).length, 0);
  assert.ok(C.tagSave(db, { name: 'VIP', color: 'xxx' }).ok); assert.equal(C.tagList(db).pop().color, 'slate');
  C.tagDelete(db, tags[0].id); assert.ok(!C.tagList(db).some((x) => x.id === tags[0].id));
  C.send(db, C.thread(db, t.id), { f: 's', by: 'nv', body: '', card: { t: 'pay', code: 'SCN1', k: 'cn' } });
  assert.equal(C.thread(db, t.id).last_text, '[Thanh toán đơn SCN1]');
  const m = C.messages(db, t.id, 'k', 'k').pop(); assert.equal(m.card.t, 'pay');
});
