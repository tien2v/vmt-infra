'use strict';
// API chat phia khach (app.vominhthien.com): /api/chat/*. Du lieu + quy tac chung o lib/chat.js.
// - SSE /api/chat/stream: quet chat_ev moi giay, bao trinh duyet cua dung khach (ca tin nhan vien gui tu trang admin).
// - Day thong bao dien thoai: tin nhan vien / he thong, cho 5 giay; khach da xem thi thoi. 1 thong bao / cuoc chat (tin moi thay tin cu).
const chat = require('./chat');

let db, webpush, H;
const clients = new Set(); // { res, owner, username }
const KIND = { order: 'Đặt hàng', ship: 'Ký gửi', peer: 'Thanh toán hộ', cn: 'Ship to China' };

function init(o) {
  db = o.db; webpush = o.webpush; H = o; // H: json, readBody, sameOrigin, myOrders(user), ownerOf(user), isTest(user), dir (thu muc du lieu)
  chat.init(db);
  db.prepare("UPDATE chat_threads SET title = NULL WHERE ctx = 'vmt' AND title IS NOT NULL").run(); // ten cu 'Chat voi VMT' (khong gan ten brand)
  if (!db.prepare("SELECT 1 FROM kv WHERE k = 'chat_push_cursor'").get()) db.prepare("INSERT INTO kv (k, v) VALUES ('chat_push_cursor', ?)").run(String(db.prepare('SELECT MAX(id) AS m FROM chat_msgs').get().m || 0));
  evCur = chat.evMax(db);
  setInterval(evPump, 1000).unref();
  setInterval(pushPump, 5000).unref();
  setInterval(() => { try { chat.oohPump(db); } catch (e) { console.error('chat ooh', e.message); } }, 60e3).unref();
  const clean = () => { try { chat.purge(db); chat.filePurge(db, H.dir); } catch (e) { console.error('chat purge', e.message); } };
  setTimeout(clean, 120e3).unref(); setInterval(clean, 6 * 3600e3).unref();
  setInterval(() => { for (const c of clients) { try { c.res.write(': ping\n\n'); } catch {} } }, 25e3).unref();
}

// ---------- thoi gian thuc ----------
let evCur = 0;
function evPump() {
  if (!clients.size) { evCur = chat.evMax(db); return; }
  let rows; try { rows = chat.evSince(db, evCur); } catch (e) { return; }
  if (!rows.length) return;
  evCur = rows[rows.length - 1].id;
  for (const e of rows) {
    const to = [...clients].filter((c) => c.owner === e.owner); if (!to.length) continue;
    let out = null;
    if (e.t === 'msg' || e.t === 'upd') { const m = chat.view(db, chat.msg(db, e.mid), 'k', 'k'); if (!m) continue; out = { t: e.t, th: e.th, m }; }
    else if (e.t === 'read') out = { t: 'read', th: e.th, side: e.data.side, upto: e.data.upto };
    else if (e.t === 'typing') { if (e.data.side === 'k') continue; out = { t: 'typing', th: e.th, name: e.data.name }; }
    else continue;
    const s = 'data: ' + JSON.stringify(out) + '\n\n';
    for (const c of to) { try { c.res.write(s); } catch {} }
  }
}
let pushBusy = false;
async function pushPump() {
  if (pushBusy) return; pushBusy = true;
  try {
    const cur = Number((db.prepare("SELECT v FROM kv WHERE k = 'chat_push_cursor'").get() || {}).v || 0);
    const rows = db.prepare("SELECT id, th FROM chat_msgs WHERE id > ? AND created_at <= strftime('%Y-%m-%dT%H:%M:%fZ','now','-4 seconds') ORDER BY id LIMIT 300").all(cur);
    if (!rows.length) return;
    db.prepare("UPDATE kv SET v = ? WHERE k = 'chat_push_cursor'").run(String(rows[rows.length - 1].id));
    const ths = new Set(rows.map((r) => r.th));
    for (const th of ths) {
      const t = chat.thread(db, th); if (!t) continue;
      const n = chat.unreadK(db, t.id, t.cust_read); if (!n) continue;
      const last = db.prepare("SELECT * FROM chat_msgs WHERE th = ? AND id > ? AND f IN ('s','sys') AND recalled_at IS NULL ORDER BY id DESC LIMIT 1").get(t.id, t.cust_read);
      if (!last) continue;
      const txt = last.body ? String(last.body).replace(/\s+/g, ' ').slice(0, 140) : last.att ? (/"t":"v"/.test(last.att) ? 'Đã gửi video' : 'Đã gửi ảnh') : 'Đã gửi thẻ đơn hàng';
      const body = (n > 1 ? n + ' tin mới · ' : '') + (last.name ? last.name + ': ' : '') + txt;
      for (const u of usersOf(t.owner)) await webpush.send(u, { title: titleOf(t), body, url: '/#tin-nhan/' + t.id, tag: 'chat-' + t.id });
    }
  } catch (e) { console.error('chat push', e.message); } finally { pushBusy = false; }
}
function titleOf(t) { const code = chat.codeOf(t.ctx); return code ? (KIND[t.kind] ? KIND[t.kind] + ' ' : 'Đơn ') + code : 'Chat'; }
// Tai khoan web cua khach nay (tai khoan test noi bo: owner = 'test:' + username)
function usersOf(owner) {
  if (owner.startsWith('test:')) return [owner.slice(5)];
  return db.prepare("SELECT username FROM users WHERE active = 1 AND lower(gobiz) = ? AND COALESCE(note,'') NOT LIKE 'tai khoan test%'").all(owner).map((r) => r.username);
}

// ---------- chong spam ----------
const rate = new Map();
function hit(k, max, ms) { const now = Date.now(); const a = (rate.get(k) || []).filter((t) => now - t < ms); if (a.length >= max) { rate.set(k, a); return false; } a.push(now); rate.set(k, a); return true; }
setInterval(() => { const now = Date.now(); for (const [k, a] of rate) if (!a.some((t) => now - t < 3600e3)) rate.delete(k); }, 10 * 60e3).unref();

// ---------- API ----------
// Cuoc chat cua khach: 'vmt' luon co; 'don:<ma>' chi khi ma do la don cua chinh khach
function ctxInfo(user, ctx) {
  if (ctx === 'vmt') return { kind: 'vmt', title: null };
  const code = chat.codeOf(ctx); if (!code) return null;
  const o = H.myOrders(user).get(code); if (!o) return null;
  return { kind: o.k, title: o.title || null };
}
function canThread(user, t) { return t && t.owner === H.ownerOf(user); }

async function handle(req, res, p, url, user) {
  const { json } = H;
  if (!user) return json(req, res, 401, { error: 'login' });
  const owner = H.ownerOf(user);
  if (p === '/api/chat/stream') {
    res.writeHead(200, { 'Content-Type': 'text/event-stream; charset=utf-8', 'Cache-Control': 'no-store, no-transform', 'Content-Encoding': 'identity', 'X-Accel-Buffering': 'no', Connection: 'keep-alive' });
    res.write('retry: 4000\ndata: {"t":"hello"}\n\n');
    const c = { res, owner, username: user.username };
    clients.add(c); req.on('close', () => clients.delete(c));
    if (clients.size > 3000) { const first = clients.values().next().value; clients.delete(first); try { first.res.end(); } catch {} }
    return;
  }
  if (p === '/api/chat/file' && req.method === 'POST') { // tai video len (gui thang tung khuc, khong giu ca file trong RAM)
    if (!H.sameOrigin(req) || !/^video\//.test(req.headers['content-type'] || '')) { req.resume(); return json(req, res, 403, { error: 'Chỉ nhận video' }); }
    const r = await chat.fileSave(db, H.dir, req, { by: 'khach:' + user.username, owner, max: 100 * 1048576 });
    if (r.full) console.error('chat: kho video day');
    return json(req, res, r.error ? 400 : 200, r);
  }
  const mf = p.match(/^\/api\/chat\/f\/([a-f0-9]{32})$/);
  if (mf) { // xem video: cua cuoc chat cua khach nay, hoac khach vua tai (chua gui)
    const ok = db.prepare("SELECT 1 FROM uploads u LEFT JOIN chat_threads t ON u.code = 'chat:' || t.id WHERE u.id = ? AND u.kind = 'video' AND (u.by = ? OR t.owner = ?)").get(mf[1], 'khach:' + user.username, owner);
    if (!ok) return json(req, res, 404, { error: 'Không tìm thấy video' });
    return chat.fileServe(req, res, H.dir, mf[1]);
  }
  if (p === '/api/chat' && req.method === 'GET') {
    return json(req, res, 200, { threads: chat.listCustomer(db, owner), inHours: chat.inHours() });
  }
  if (p === '/api/chat/ctx' && req.method === 'GET') { // mo cuoc chat theo ngu canh (chua co thi tra rong, chi tao khi gui tin dau)
    const ctx = String(url.searchParams.get('ctx') || '');
    if (!ctxInfo(user, ctx)) return json(req, res, 404, { error: 'Không tìm thấy đơn này' });
    const t = chat.threadBy(db, owner, ctx);
    if (!t) return json(req, res, 200, { thread: null, msgs: [] });
    return json(req, res, 200, { thread: chat.tView(db, t, 'k'), msgs: chat.messages(db, t.id, 'k', 'k', {}) });
  }
  const mt = p.match(/^\/api\/chat\/t\/(\d{1,12})(\/read|\/typing)?$/);
  if (mt) {
    const t = chat.thread(db, mt[1]);
    if (!canThread(user, t)) return json(req, res, 404, { error: 'Không tìm thấy cuộc chat' });
    if (!mt[2] && req.method === 'GET') {
      const before = url.searchParams.get('before'), after = url.searchParams.get('after');
      return json(req, res, 200, { thread: chat.tView(db, t, 'k'), msgs: chat.messages(db, t.id, 'k', 'k', { before, after }) });
    }
    if (req.method !== 'POST' || !H.sameOrigin(req)) return json(req, res, 403, { error: 'origin' });
    let b = {}; try { b = JSON.parse((await H.readBody(req, 2000)).toString() || '{}'); } catch {}
    if (mt[2] === '/read') return json(req, res, 200, chat.read(db, t, 'k', b.upto));
    if (mt[2] === '/typing') { if (hit('ty:' + user.username, 30, 60e3)) chat.typing(db, t, 'k', ''); return json(req, res, 200, { ok: true }); }
    return json(req, res, 404, { error: 'not found' });
  }
  if (p === '/api/chat/send' && req.method === 'POST') {
    if (!H.sameOrigin(req) || !/application\/json/.test(req.headers['content-type'] || '')) return json(req, res, 403, { error: 'origin' });
    let b; try { b = JSON.parse((await H.readBody(req, 20000)).toString()); } catch { return json(req, res, 400, { error: 'Dữ liệu không hợp lệ' }); }
    if (!hit('msg:' + user.username, 40, 60e3)) return json(req, res, 429, { error: 'Anh/chị gửi hơi nhanh, đợi vài giây rồi gửi tiếp nhé' });
    let t = null;
    if (b.th) { t = chat.thread(db, b.th); if (!canThread(user, t)) return json(req, res, 404, { error: 'Không tìm thấy cuộc chat' }); }
    else {
      const ctx = String(b.ctx || ''); const info = ctxInfo(user, ctx);
      if (!info) return json(req, res, 404, { error: 'Không tìm thấy đơn này' });
      t = chat.ensure(db, { owner, gobiz: user.gobiz, ctx, kind: info.kind, title: info.title, test: H.isTest(user), by: 'khach:' + user.username });
    }
    // Anh / video: chi file chinh khach vua tai, chua dung cho viec khac
    const ac = chat.attCheck(db, b.att, 'khach:' + user.username);
    if (ac.error) return json(req, res, 400, { error: ac.error });
    const att = ac.att;
    if (att.length && !hit('img:' + user.username, 30, 3600e3)) return json(req, res, 429, { error: 'Gửi quá 30 ảnh / video trong 1 giờ, thử lại sau' });
    let card = null;
    if (b.card && b.card.code) { const o = H.myOrders(user).get(String(b.card.code)); if (!o) return json(req, res, 400, { error: 'Không tìm thấy đơn này' }); card = { code: String(b.card.code), k: o.k }; }
    const r = chat.send(db, t, { f: 'k', by: 'khach:' + user.username, name: '', body: b.body, reply: b.reply, att: att.length ? att : null, card });
    if (r.error) return json(req, res, 400, { error: r.error });
    return json(req, res, 200, { ok: true, thread: chat.tView(db, chat.thread(db, t.id), 'k'), msg: chat.view(db, r.msg, 'k', 'k') });
  }
  const mm = p.match(/^\/api\/chat\/m\/(\d{1,12})\/(react|recall)$/);
  if (mm && req.method === 'POST') {
    if (!H.sameOrigin(req)) return json(req, res, 403, { error: 'origin' });
    const m = chat.msg(db, mm[1]); const t = m && chat.thread(db, m.th);
    if (!m || !canThread(user, t) || m.f === 'note') return json(req, res, 404, { error: 'Không tìm thấy tin nhắn' });
    let b = {}; try { b = JSON.parse((await H.readBody(req, 1000)).toString() || '{}'); } catch {}
    const r = mm[2] === 'react' ? chat.react(db, m, 'k', String(b.e || '')) : chat.recall(db, m, 'khach:' + user.username, false);
    if (r.error) return json(req, res, r.code || 400, { error: r.error });
    return json(req, res, 200, { ok: true, msg: chat.view(db, chat.msg(db, m.id), 'k', 'k') });
  }
  return json(req, res, 404, { error: 'not found' });
}

const unread = (user) => { try { return chat.unreadCustomer(db, H.ownerOf(user)); } catch { return 0; } };
module.exports = { init, handle, unread };
