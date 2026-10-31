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
  H = o; // json, send, sendFile, readBody, sameOrigin, cn, customers(), staffList(), khOrders(u) -> Map code->kind, dir (thu muc khach.db), webpush, kvGet, kvSet
  setInterval(evPump, 1000).unref();
  setInterval(pushPump, 3000).unref();
  setInterval(assignPump, 2000).unref();
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

// Thong bao dien thoai cho nhan vien: khach nhan, 4 giay sau van chua ai doc -> day cho nguoi phu trach (chua ai nhan: moi NV chat).
// Cuoc chat cua tai khoan test noi bo chi bao admin. 1 thong bao / cuoc (tin moi thay tin cu).
let pushBusy = false;
async function pushPump() {
  if (pushBusy || !H.webpush) return; pushBusy = true;
  try {
    let d; try { d = db(); } catch (e) { return; }
    const cur0 = H.kvGet('chat_staff_push_cur');
    if (cur0 == null) { H.kvSet('chat_staff_push_cur', String(d.prepare('SELECT MAX(id) AS m FROM chat_msgs').get().m || 0)); return; }
    const rows = d.prepare("SELECT id, th FROM chat_msgs WHERE id > ? AND f = 'k' AND created_at <= strftime('%Y-%m-%dT%H:%M:%fZ','now','-4 seconds') ORDER BY id LIMIT 300").all(Number(cur0) || 0);
    if (!rows.length) return;
    H.kvSet('chat_staff_push_cur', String(rows[rows.length - 1].id));
    const staff = H.staffList(); const cm = custMap();
    for (const th of new Set(rows.map((r) => r.th))) {
      const t = chat.thread(d, th); if (!t) continue;
      const n = d.prepare("SELECT COUNT(*) AS n FROM chat_msgs WHERE th = ? AND id > ? AND f = 'k' AND recalled_at IS NULL").get(t.id, t.staff_read).n; if (!n) continue;
      const last = d.prepare("SELECT body, att FROM chat_msgs WHERE th = ? AND f = 'k' AND recalled_at IS NULL ORDER BY id DESC LIMIT 1").get(t.id); if (!last) continue;
      const c = cm.get(String(t.gobiz || t.owner).toLowerCase());
      const who = t.test ? 'TEST · ' + String(t.owner).replace(/^test:/, '') : (c && c.fn) || t.gobiz || t.owner;
      const code = chat.codeOf(t.ctx);
      const txt = last.body ? String(last.body).replace(/\s+/g, ' ').slice(0, 140) : /"t":"v"/.test(last.att || '') ? 'Gửi video' : 'Gửi ảnh';
      let to = t.assignee ? [t.assignee] : staff.map((x) => x.u);
      if (t.test) to = staff.filter((x) => x.role === 'admin').map((x) => x.u);
      for (const u of to) await H.webpush.send(u, { title: who + (code ? ' · ' + code : ''), body: (n > 1 ? n + ' tin mới · ' : '') + txt, url: '/chat#t' + t.id, tag: 'chat-' + t.id });
    }
  } catch (e) { console.error('chat staff push', e.message); } finally { pushBusy = false; }
}

// Tu chia khach cho NV (anh chot 31/10): khach nhan ma cuoc chat chua ai nhan -> CSKH phu trach khach -> Sale phu trach
// -> NV dang mo hop thu (it cuoc dang cho nhat) -> de "Chua ai nhan". Tai khoan test noi bo khong chia.
let asBusy = false;
function assignPump() {
  if (asBusy) return; asBusy = true;
  try {
    let d; try { d = db(); } catch (e) { return; }
    const cur0 = H.kvGet('chat_assign_cur');
    if (cur0 == null) { H.kvSet('chat_assign_cur', String(d.prepare('SELECT MAX(id) AS m FROM chat_msgs').get().m || 0)); return; }
    const rows = d.prepare("SELECT id, th FROM chat_msgs WHERE id > ? AND f = 'k' ORDER BY id LIMIT 300").all(Number(cur0) || 0);
    if (!rows.length) return;
    H.kvSet('chat_assign_cur', String(rows[rows.length - 1].id));
    const staff = H.staffList(); const ok = new Set(staff.map((x) => x.u));
    for (const th of new Set(rows.map((r) => r.th))) {
      const t = chat.thread(d, th); if (!t || t.assignee || t.test) continue;
      const own = H.custOwner(String(t.gobiz || t.owner).toLowerCase()) || {};
      let to = null, why = '';
      if (own.cskh && ok.has(own.cskh)) { to = own.cskh; why = 'CSKH phụ trách khách'; }
      else if (own.sale && ok.has(own.sale)) { to = own.sale; why = 'Sale phụ trách khách'; }
      else {
        const online = [...new Set([...clients].map((c) => c.u))].filter((u) => ok.has(u));
        if (online.length) {
          const load = (u) => d.prepare("SELECT COUNT(*) AS n FROM chat_threads WHERE assignee = ? AND status = 'open' AND wait_at IS NOT NULL").get(u).n;
          to = online.sort((a, b) => load(a) - load(b))[0]; why = 'NV đang trực, ít việc nhất';
        }
      }
      if (to) { chat.assign(d, t, to, 'he-thong'); chat.log(d, t.id, 'he-thong', 'Tự chia cuộc chat', { to, why }); }
    }
  } catch (e) { console.error('chat assign', e.message); } finally { asBusy = false; }
}

// AI goi y cau tra loi (Gemini). Theo quy tac nhan tin cua anh: viet nhu nguoi that, khong cau mau, khong "quy khach", it emoji,
// so lieu lay dung tu du lieu, khong bia. NV doc, sua roi moi gui (AI khong bao gio tu gui).
const ST = { DEPOSITED: 'Đã đặt cọc', ACCEPTED: 'Đã tiếp nhận', PROCESSING: 'Đang xử lý', PURCHASING: 'Đang mua hàng', PURCHASED: 'Đã mua hàng', MERCHANT_DELIVERING: 'Người bán đang giao tới kho TQ', PUTAWAY: 'Đã về kho Trung Quốc', TRANSPORTING: 'Đang vận chuyển về VN', READY_FOR_DELIVERY: 'Đã về kho VN, chờ giao', DELIVERING: 'Đang giao', DELIVERED: 'Hoàn thành', CANCELLED: 'Đã huỷ', REQUEST_FOR_PAY: 'Chờ thanh toán', PAYMENT_PAID: 'Đã thanh toán', TRANSACTION_COMPLETED: 'Hoàn thành', PAYMENT_CANCELLED: 'Đã huỷ', PENDING: 'Chờ tiếp nhận', VN_WAREHOUSE: 'Kho VN đã nhận', CLEARED: 'Đang giao tại TQ', RETURN: 'Trả hàng' };
const KN = { order: 'Đặt hàng hộ', ship: 'Ký gửi về VN', peer: 'Thanh toán hộ', cn: 'Ship to China' };
function ctxOf(t) {
  const u = String(t.gobiz || t.owner).toLowerCase(); const b = H.khBrief(u) || {};
  const code = chat.codeOf(t.ctx); const o = code ? (b.orders || []).find((x) => x.code === code) || null : null;
  return { cust: { u, fn: b.fn || '', code: b.code || '', bal: b.bal == null ? null : b.bal, unpaid: b.unpaid || 0 },
    order: code ? Object.assign({ code, k: t.kind }, o ? { st: o.st, stl: ST[o.st] || o.st || '', unpaid: o.unpaid || 0, v: o.v || null } : {}) : null,
    recent: (b.orders || []).slice(0, 8).map((x) => ({ code: x.code, k: x.t, stl: ST[x.st] || x.st || '', unpaid: x.unpaid || 0 })) };
}
const vnd = (n) => (n == null ? '' : Math.round(n).toLocaleString('vi-VN') + 'đ');
async function suggest(d, t, staffName) {
  if (!H.ai || !H.ai.ready()) return { error: 'Chưa cài AI (anh nhập khoá Gemini ở trang Kết nối)' };
  const c = ctxOf(t);
  const msgs = d.prepare("SELECT f, name, body, att, card, recalled_at FROM chat_msgs WHERE th = ? ORDER BY id DESC LIMIT 20").all(t.id).reverse()
    .filter((m) => !m.recalled_at).map((m) => (m.f === 'k' ? 'KHÁCH' : m.f === 'note' ? 'GHI CHÚ NỘI BỘ (khách không thấy)' : m.f === 'sys' ? 'HỆ THỐNG' : 'NV ' + (m.name || '')) + ': ' + (m.body || (m.att ? (/"t":"v"/.test(m.att) ? '[gửi video]' : '[gửi ảnh]') : m.card ? '[thẻ đơn]' : '')));
  const info = [
    'Khách: ' + (c.cust.fn || c.cust.u) + (c.cust.code ? ' (mã ' + c.cust.code + ')' : ''),
    c.cust.bal != null ? 'Số dư ví: ' + vnd(c.cust.bal) : '', c.cust.unpaid ? 'Tổng còn thiếu: ' + vnd(c.cust.unpaid) : '',
    c.order ? 'Cuộc chat về đơn ' + c.order.code + ' (' + (KN[c.order.k] || 'đơn') + ')' + (c.order.stl ? ', trạng thái: ' + c.order.stl : '') + (c.order.unpaid ? ', còn thiếu ' + vnd(c.order.unpaid) : '') : 'Cuộc chat chung (không gắn đơn)',
    c.recent.length ? 'Đơn gần đây: ' + c.recent.map((x) => x.code + ' ' + x.stl + (x.unpaid ? ' thiếu ' + vnd(x.unpaid) : '')).join('; ') : '',
  ].filter(Boolean).join('\n');
  const prompt = `Bạn đang giúp nhân viên chăm sóc khách của một công ty dịch vụ đặt hàng / ký gửi / vận chuyển hàng Trung Quốc – Việt Nam soạn câu trả lời trong khung chat.
Nhân viên tên ${staffName}. Đọc cuộc trò chuyện và thông tin dưới đây, viết 3 phương án trả lời tin nhắn mới nhất của khách.

QUY TẮC BẮT BUỘC:
- Viết như người thật đang nhắn tin: đơn giản, tự nhiên, gọn, 1–3 câu. Mỗi phương án viết khác nhau (cách mở đầu, cách kết), không lặp cụm từ của các tin nhân viên đã gửi trước đó.
- Xưng "em", gọi khách "anh" hoặc "chị" (không rõ giới tính thì dùng "anh/chị"). KHÔNG dùng văn trang trọng hay câu sáo như "Xin chào quý khách", "Trân trọng", "Cảm ơn quý khách đã tin tưởng". Không lạm dụng emoji (tối đa 1, có thể không dùng).
- Số liệu (mã đơn, số tiền, trạng thái) chỉ lấy ĐÚNG từ thông tin bên dưới, không làm tròn, không tự nghĩ ra. Thông tin không có thì nói sẽ kiểm tra rồi báo lại, hoặc hỏi thêm khách, KHÔNG bịa ngày về, giá, phí.
- Ghi chú nội bộ chỉ để hiểu bối cảnh, không nhắc lại cho khách.
- Không hứa điều không chắc (hoàn tiền, miễn phí, ngày giao cụ thể) nếu dữ liệu không có.

THÔNG TIN:
${info}

CUỘC TRÒ CHUYỆN (cũ → mới):
${msgs.join('\n')}

Trả về DUY NHẤT JSON: {"replies": ["...", "...", "..."]}`;
  const r = await H.ai.askJson(prompt, null, 30000);
  if (r.error) return { error: r.error };
  const replies = ((r.data && r.data.replies) || []).map((x) => String(x || '').replace(/\s+\n/g, '\n').trim().slice(0, 800)).filter(Boolean).slice(0, 3);
  return replies.length ? { replies } : { error: 'AI không gợi ý được, thử lại' };
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
  if (p.startsWith('/api/chat/push/')) {
    if (!H.webpush) return json(req, res, 503, { error: 'Chưa bật thông báo' });
    if (p === '/api/chat/push/key') return json(req, res, 200, { key: H.webpush.publicKey(), has: H.webpush.hasSub(me) });
    if (req.method !== 'POST' || !H.sameOrigin(req)) return json(req, res, 403, { error: 'origin' });
    let b = {}; try { b = JSON.parse((await H.readBody(req, 4000)).toString() || '{}'); } catch {}
    if (p === '/api/chat/push/sub') {
      const r = H.webpush.subscribe(me, b.sub, req.headers.host, req.headers['user-agent']); if (r.error) return json(req, res, 400, r);
      const t = await H.webpush.send(me, { title: 'Đã bật thông báo', body: 'Khách nhắn là điện thoại báo ngay, kể cả khi khoá màn hình.', url: '/chat', tag: 'bat-thong-bao' });
      return json(req, res, 200, { ok: true, sent: t.sent });
    }
    if (p === '/api/chat/push/unsub') { H.webpush.unsubscribe(me, b.endpoint); return json(req, res, 200, { ok: true }); }
    return json(req, res, 404, { error: 'not found' });
  }
  if (p === '/api/chat/file' && req.method === 'POST') { // NV gui video (Caddy admin gioi han 80MB/lan)
    if (!H.sameOrigin(req) || !/^video\//.test(req.headers['content-type'] || '')) { req.resume(); return json(req, res, 403, { error: 'Chỉ nhận video' }); }
    const r = await chat.fileSave(d, H.dir, req, { by: 'staff:' + me, owner: null, max: 75 * 1048576 });
    return json(req, res, r.error ? 400 : 200, r);
  }
  const mf = p.match(/^\/api\/chat\/f\/([a-f0-9]{32})$/);
  if (mf) { if (!d.prepare("SELECT 1 FROM uploads WHERE id = ? AND kind = 'video'").get(mf[1])) return json(req, res, 404, { error: 'Không tìm thấy video' }); return chat.fileServe(req, res, H.dir, mf[1]); }
  if (p === '/api/chat/summary') return json(req, res, 200, Object.assign(chat.counts(d, me, false), { lastId: (d.prepare("SELECT MAX(id) AS m FROM chat_msgs WHERE f = 'k'").get().m || 0) }));
  if (p === '/api/chat/inbox') {
    const f = String(url.searchParams.get('f') || 'all');
    return json(req, res, 200, { threads: decorate(chat.listStaff(d, f, me, url.searchParams.get('q') || '', test, url.searchParams.get('tag'))), counts: chat.counts(d, me, test), me: { u: me, n: user.name || me, role: user.role }, staff: H.staffList(), tags: chat.tagList(d), ai: !!(H.ai && H.ai.ready()), inHours: chat.inHours() });
  }
  if (p === '/api/chat/tags') { // danh sach nhan: ai cung xem; chi admin sua
    if (req.method === 'GET') return json(req, res, 200, { items: chat.tagList(d) });
    if (user.role !== 'admin' || !H.sameOrigin(req)) return json(req, res, 403, { error: 'Chỉ admin sửa danh sách nhãn' });
    let b = {}; try { b = JSON.parse((await H.readBody(req, 2000)).toString() || '{}'); } catch {}
    const r = b.del ? chat.tagDelete(d, b.del) : chat.tagSave(d, b);
    return r.error ? json(req, res, 400, r) : json(req, res, 200, { ok: true, items: chat.tagList(d) });
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
  const mt = p.match(/^\/api\/chat\/t\/(\d{1,12})(?:\/(send|read|typing|assign|status|log|tags|ctx|suggest))?$/);
  if (mt) {
    const t = chat.thread(d, mt[1]); if (!t) return json(req, res, 404, { error: 'Không tìm thấy cuộc chat' });
    if (!mt[2] && req.method === 'GET') return json(req, res, 200, { thread: decorate([chat.tView(d, t, 's')])[0], msgs: chat.messages(d, t.id, 's', who, { before: url.searchParams.get('before'), after: url.searchParams.get('after') }) });
    if (mt[2] === 'ctx') return json(req, res, 200, ctxOf(t)); // so lieu cho mau cau tu dien + the don
    if (mt[2] === 'log') return json(req, res, 200, { items: d.prepare('SELECT * FROM chat_log WHERE th = ? ORDER BY ts DESC LIMIT 100').all(t.id) });
    if (req.method !== 'POST' || !H.sameOrigin(req)) return json(req, res, 403, { error: 'origin' });
    let b = {}; try { b = JSON.parse((await H.readBody(req, 20000)).toString() || '{}'); } catch { return json(req, res, 400, { error: 'Dữ liệu không hợp lệ' }); }
    if (mt[2] === 'read') return json(req, res, 200, chat.read(d, t, 's', b.upto));
    if (mt[2] === 'tags') { chat.setTags(d, t, b.tags, me); return json(req, res, 200, { ok: true, thread: decorate([chat.tView(d, chat.thread(d, t.id), 's')])[0] }); }
    if (mt[2] === 'suggest') { if (!hit('ai:' + me, 60, 3600e3)) return json(req, res, 429, { error: 'Dùng gợi ý quá nhiều trong 1 giờ, nghỉ chút nhé' }); const r = await suggest(d, t, user.name || me); return json(req, res, r.error ? 502 : 200, r); }
    if (mt[2] === 'typing') { chat.typing(d, t, 's', user.name || me); return json(req, res, 200, { ok: true }); }
    if (mt[2] === 'assign') { const to = b.to ? String(b.to) : null; if (to && !H.staffList().some((s) => s.u === to)) return json(req, res, 400, { error: 'Không có nhân viên này' }); chat.assign(d, t, to, me); return json(req, res, 200, { ok: true, thread: decorate([chat.tView(d, chat.thread(d, t.id), 's')])[0] }); }
    if (mt[2] === 'status') { chat.setStatus(d, t, String(b.status || ''), me); return json(req, res, 200, { ok: true, thread: decorate([chat.tView(d, chat.thread(d, t.id), 's')])[0] }); }
    if (mt[2] === 'send') {
      if (!hit('m:' + me, 60, 60e3)) return json(req, res, 429, { error: 'Gửi quá nhanh, đợi chút' });
      const ac = chat.attCheck(d, b.att, 'staff:' + me);
      if (ac.error) return json(req, res, 400, { error: ac.error });
      const att = ac.att;
      let card = null;
      if (b.card && b.card.code) { const k = H.khOrders(String(t.gobiz || t.owner).toLowerCase()).get(String(b.card.code)); if (!k) return json(req, res, 400, { error: 'Đơn này không phải của khách' }); card = { t: b.card.t === 'pay' ? 'pay' : 'order', code: String(b.card.code), k }; }
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
// Icon FontAwesome cho trang /chat: trich tu app.css cua Lineone (380KB, kem ca bo Tailwind lam nang dien thoai)
// chi lay phan FontAwesome + dung icon trang chat dung (~10KB). Nho theo thoi gian sua 2 file.
const fs = require('node:fs');
let faCache = { key: '', css: '' };
function faCss(appCssPath, chatHtmlPath) {
  let key; try { key = fs.statSync(appCssPath).mtimeMs + ':' + fs.statSync(chatHtmlPath).mtimeMs; } catch { return ''; }
  if (faCache.key === key) return faCache.css;
  const css = fs.readFileSync(appCssPath, 'utf8');
  const used = new Set((fs.readFileSync(chatHtmlPath, 'utf8').match(/fa-[a-z0-9-]+/g) || []));
  const out = [];
  const end = (k) => { let d = 0; for (; k < css.length; k++) { if (css[k] === '{') d++; else if (css[k] === '}' && --d === 0) return k; } return css.length - 1; };
  const walk = (a, b) => {
    let p = a;
    while (p < b) {
      const ob = css.indexOf('{', p); if (ob < 0 || ob >= b) break;
      const semi = css.lastIndexOf(';', ob); const sel = css.slice(semi >= p ? semi + 1 : p, ob).trim(); const cb = end(ob); const inner = css.slice(ob + 1, cb);
      if (/^@(layer|media|supports)/.test(sel) && inner.includes('{')) walk(ob + 1, cb);
      else if (sel.startsWith('@font-face')) { if (/Font Awesome 6 Free|Font Awesome\\ 6 Free/.test(inner)) out.push(sel + '{' + inner + '}'); }
      else if (!sel.startsWith('@') && /(^|,)\s*\.fa[\w-]*/.test(sel)) {
        if (/:before|::before/.test(sel)) { const keep = sel.split(',').filter((x) => { const m = x.match(/\.(fa-[\w-]+):{1,2}before/); return m && used.has(m[1]); }); if (keep.length) out.push(keep.join(',') + '{' + inner + '}'); }
        else if (!/fa-(beat|bounce|fade|flip|shake|spin|pulse|rotate-by|stack|ul|li|border|pull|inverse|sr-only)/.test(sel)) out.push(sel + '{' + inner + '}');
      }
      p = cb + 1;
    }
  };
  walk(0, css.length);
  faCache = { key, css: out.join('\n').replace(/url\(\.\.\/fonts\//g, 'url(/assets/fonts/') };
  return faCache.css;
}
module.exports = { init, handle, faCss, ROLES };
