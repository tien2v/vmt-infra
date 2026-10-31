'use strict';
// API chat phia nhan vien (saas.7zone.net): trang /chat + /api/chat/*. Du lieu o khach.db (cn.fin()), quy tac chung o lib/chat.js.
// Vai tro duoc chat: admin, sale, order, tc (kho khong vao). SSE /api/chat/stream bao moi tin cua moi khach cho nhan vien dang mo.
const path = require('node:path');
const chat = require('./chat');

const ROLES = ['admin', 'sale', 'order', 'tc'];
let H, ready = false;
const clients = new Set(); // { res, u }
function db() { const d = H.cn.fin(); if (!ready) { chat.init(d); ready = true; evCur = chat.evMax(d); } return d; }

function init(o) {
  H = o; // json, send, sendFile, readBody, sameOrigin, cn, customers(), staffList(), khOrders(u) -> Map code->kind
  setInterval(evPump, 1000).unref();
  setInterval(() => { for (const c of clients) { try { c.res.write(': ping\n\n'); } catch {} } }, 25e3).unref();
}
let evCur = 0;
function evPump() {
  if (!clients.size) return;
  let d, rows; try { d = db(); rows = chat.evSince(d, evCur); } catch (e) { return; }
  if (!rows.length) return;
  evCur = rows[rows.length - 1].id;
  for (const e of rows) {
    let out = null;
    if (e.t === 'msg' || e.t === 'upd') { const r = chat.msg(d, e.mid); if (!r) continue; out = { t: e.t, th: e.th, m: chat.view(d, r, 's', '') }; }
    else if (e.t === 'read') out = { t: 'read', th: e.th, side: e.data.side, upto: e.data.upto };
    else if (e.t === 'typing') { if (e.data.side !== 'k') continue; out = { t: 'typing', th: e.th }; }
    else if (e.t === 'th') out = { t: 'th', th: e.th };
    if (!out) continue;
    const s = 'data: ' + JSON.stringify(out) + '\n\n';
    for (const c of clients) {
      if (out.m && out.m.re) { const m = Object.assign({}, out.m, { re: chat.view(d, chat.msg(d, e.mid), 's', 's:' + c.u).re }); try { c.res.write('data: ' + JSON.stringify(Object.assign({}, out, { m })) + '\n\n'); } catch {} continue; }
      try { c.res.write(s); } catch {}
    }
  }
}

// ten khach (Gobiz) de hien trong hop thu; tai khoan test noi bo: owner 'test:<user>'
function custMap() { const m = new Map(); for (const c of H.customers()) m.set(String(c.u).toLowerCase(), c); return m; }
function decorate(list) {
  const m = custMap();
  return list.map((t) => { const c = m.get(String(t.gobiz || t.owner).toLowerCase()); return Object.assign(t, { fn: c ? c.fn : '', ccode: c ? c.code : '', u: c ? c.u : t.gobiz || t.owner }); });
}
const rate = new Map();
function hit(k, max, ms) { const now = Date.now(); const a = (rate.get(k) || []).filter((t) => now - t < ms); if (a.length >= max) return false; a.push(now); rate.set(k, a); if (rate.size > 500) rate.clear(); return true; }

async function handle(req, res, p, url, user) {
  const { json } = H;
  if (!user) { if (p === '/chat') { res.writeHead(302, { Location: '/login' }); return res.end(); } return json(req, res, 401, { error: 'login' }); }
  if (!ROLES.includes(user.role)) return p === '/chat' ? H.send(res, 403, 'Tài khoản này không dùng chat khách') : json(req, res, 403, { error: 'forbidden' });
  if (p === '/chat') return H.sendFile(req, res, path.join(__dirname, '..', 'chat.html'), 'no-cache');
  let d; try { d = db(); } catch (e) { return json(req, res, 503, { error: e.message }); }
  const me = user.username, who = 's:' + me, test = url.searchParams.get('test') === '1';
  if (p === '/api/chat/stream') {
    res.writeHead(200, { 'Content-Type': 'text/event-stream; charset=utf-8', 'Cache-Control': 'no-store, no-transform', 'Content-Encoding': 'identity', 'X-Accel-Buffering': 'no', Connection: 'keep-alive' });
    res.write('retry: 4000\ndata: {"t":"hello"}\n\n');
    const c = { res, u: me }; clients.add(c); req.on('close', () => clients.delete(c));
    return;
  }
  if (p === '/api/chat/summary') return json(req, res, 200, Object.assign(chat.counts(d, me, false), { lastId: (d.prepare("SELECT MAX(id) AS m FROM chat_msgs WHERE f = 'k'").get().m || 0) }));
  if (p === '/api/chat/inbox') {
    const f = String(url.searchParams.get('f') || 'all');
    return json(req, res, 200, { threads: decorate(chat.listStaff(d, f, me, url.searchParams.get('q') || '', test)), counts: chat.counts(d, me, test), me: { u: me, n: user.name || me, role: user.role }, staff: H.staffList(), inHours: chat.inHours() });
  }
  if (p === '/api/chat/tpl') {
    if (req.method === 'GET') return json(req, res, 200, { items: chat.tplList(d) });
    if (!H.sameOrigin(req)) return json(req, res, 403, { error: 'origin' });
    let b = {}; try { b = JSON.parse((await H.readBody(req, 5000)).toString() || '{}'); } catch {}
    const r = b.del ? chat.tplDelete(d, b.del) : chat.tplSave(d, b, me);
    return r.error ? json(req, res, 400, r) : json(req, res, 200, { ok: true, items: chat.tplList(d) });
  }
  if (p === '/api/chat/start' && req.method === 'POST') { // nhan vien mo cuoc chat voi khach (chung hoac theo don)
    if (!H.sameOrigin(req)) return json(req, res, 403, { error: 'origin' });
    let b = {}; try { b = JSON.parse((await H.readBody(req, 2000)).toString() || '{}'); } catch {}
    const u = String(b.u || '').trim().toLowerCase();
    const c = custMap().get(u); if (!c) return json(req, res, 404, { error: 'Không có khách này' });
    let ctx = 'vmt', kind = 'vmt';
    if (b.code) { const k = H.khOrders(u).get(String(b.code)); if (!k) return json(req, res, 404, { error: 'Đơn ' + b.code + ' không phải của khách này (hoặc quá 30 ngày)' }); ctx = 'don:' + b.code; kind = k; }
    const t = chat.ensure(d, { owner: u, gobiz: c.u, ctx, kind, by: who });
    return json(req, res, 200, { thread: decorate([chat.tView(d, t, 's')])[0] });
  }
  const mt = p.match(/^\/api\/chat\/t\/(\d{1,12})(?:\/(send|read|typing|assign|status|log))?$/);
  if (mt) {
    const t = chat.thread(d, mt[1]); if (!t) return json(req, res, 404, { error: 'Không tìm thấy cuộc chat' });
    if (!mt[2] && req.method === 'GET') return json(req, res, 200, { thread: decorate([chat.tView(d, t, 's')])[0], msgs: chat.messages(d, t.id, 's', who, { before: url.searchParams.get('before'), after: url.searchParams.get('after') }) });
    if (mt[2] === 'log') return json(req, res, 200, { items: d.prepare('SELECT * FROM chat_log WHERE th = ? ORDER BY ts DESC LIMIT 100').all(t.id) });
    if (req.method !== 'POST' || !H.sameOrigin(req)) return json(req, res, 403, { error: 'origin' });
    let b = {}; try { b = JSON.parse((await H.readBody(req, 20000)).toString() || '{}'); } catch { return json(req, res, 400, { error: 'Dữ liệu không hợp lệ' }); }
    if (mt[2] === 'read') return json(req, res, 200, chat.read(d, t, 's', b.upto));
    if (mt[2] === 'typing') { chat.typing(d, t, 's', user.name || me); return json(req, res, 200, { ok: true }); }
    if (mt[2] === 'assign') { const to = b.to ? String(b.to) : null; if (to && !H.staffList().some((s) => s.u === to)) return json(req, res, 400, { error: 'Không có nhân viên này' }); chat.assign(d, t, to, me); return json(req, res, 200, { ok: true, thread: decorate([chat.tView(d, chat.thread(d, t.id), 's')])[0] }); }
    if (mt[2] === 'status') { chat.setStatus(d, t, String(b.status || ''), me); return json(req, res, 200, { ok: true, thread: decorate([chat.tView(d, chat.thread(d, t.id), 's')])[0] }); }
    if (mt[2] === 'send') {
      if (!hit('m:' + me, 60, 60e3)) return json(req, res, 429, { error: 'Gửi quá nhanh, đợi chút' });
      const att = [];
      for (const id of (Array.isArray(b.att) ? b.att : []).slice(0, 10)) {
        const u = d.prepare('SELECT by, code FROM uploads WHERE id = ?').get(String(id));
        if (!u || u.by !== 'staff:' + me || u.code) return json(req, res, 400, { error: 'Ảnh không hợp lệ, tải lại' });
        att.push({ id: String(id) });
      }
      let card = null;
      if (b.card && b.card.code) { const k = H.khOrders(String(t.gobiz || t.owner).toLowerCase()).get(String(b.card.code)); if (!k) return json(req, res, 400, { error: 'Đơn này không phải của khách' }); card = { code: String(b.card.code), k }; }
      const r = chat.send(d, t, { f: b.note ? 'note' : 's', by: me, name: user.name || me, body: b.body, reply: b.reply, att: att.length ? att : null, card });
      if (r.error) return json(req, res, 400, { error: r.error });
      return json(req, res, 200, { ok: true, msg: chat.view(d, r.msg, 's', who), thread: decorate([chat.tView(d, chat.thread(d, t.id), 's')])[0] });
    }
  }
  const mm = p.match(/^\/api\/chat\/m\/(\d{1,12})\/(react|recall)$/);
  if (mm && req.method === 'POST') {
    if (!H.sameOrigin(req)) return json(req, res, 403, { error: 'origin' });
    const m = chat.msg(d, mm[1]); if (!m) return json(req, res, 404, { error: 'Không tìm thấy tin' });
    let b = {}; try { b = JSON.parse((await H.readBody(req, 1000)).toString() || '{}'); } catch {}
    const r = mm[2] === 'react' ? chat.react(d, m, who, String(b.e || '')) : chat.recall(d, m, me, true);
    if (r.error) return json(req, res, r.code || 400, { error: r.error });
    return json(req, res, 200, { ok: true, msg: chat.view(d, chat.msg(d, m.id), 's', who) });
  }
  return json(req, res, 404, { error: 'not found' });
}
module.exports = { init, handle, ROLES };
