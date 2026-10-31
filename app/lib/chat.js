'use strict';
// Chat theo don (khach <-> nhan vien). Du lieu trong khach.db; trang khach (khach/) va trang admin (app/) cung doc/ghi.
// 2 BAN GIONG HET: khach/lib/chat.js va app/lib/chat.js — sua ban nay thi chep sang ban kia.
// - Moi khach co 1 cuoc "Chat voi VMT" (ctx 'vmt') + moi don 1 cuoc rieng (ctx 'don:<ma>').
// - chat_ev: hang doi su kien (tin moi, sua, da xem, dang nhap...) de 2 tien trinh bao cho trinh duyet ngay (SSE), giu 2 ngay.
// - Khong bao gio xoa tin: thu hoi chi an noi dung voi khach, ban goc giu o cot orig (nhan vien xem duoc).

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const prof = require('./prof');
const RECALL_MS = 60 * 60e3; // thu hoi trong 60 phut (giong Zalo)
const BODY_MAX = 4000;
const EMOJI = ['❤️', '👍', '😂', '😮', '😢', '😡'];
const NOW = "strftime('%Y-%m-%dT%H:%M:%fZ','now')";

function init(db) {
  prof.init(db);
  db.exec(`
    CREATE TABLE IF NOT EXISTS chat_threads (
      id INTEGER PRIMARY KEY AUTOINCREMENT, owner TEXT NOT NULL, gobiz TEXT, ctx TEXT NOT NULL, kind TEXT, title TEXT,
      test INTEGER NOT NULL DEFAULT 0, assignee TEXT, status TEXT NOT NULL DEFAULT 'open',
      last_id INTEGER NOT NULL DEFAULT 0, last_at TEXT, last_from TEXT, last_text TEXT,
      cust_read INTEGER NOT NULL DEFAULT 0, staff_read INTEGER NOT NULL DEFAULT 0,
      wait_at TEXT, ooh_at TEXT, created_at TEXT DEFAULT (${NOW}), UNIQUE (owner, ctx)
    );
    CREATE INDEX IF NOT EXISTS chat_threads_last ON chat_threads (last_at);
    CREATE TABLE IF NOT EXISTS chat_msgs (
      id INTEGER PRIMARY KEY AUTOINCREMENT, th INTEGER NOT NULL, f TEXT NOT NULL, by TEXT, name TEXT, body TEXT,
      reply INTEGER, att TEXT, card TEXT, reacts TEXT, recalled_at TEXT, orig TEXT, created_at TEXT DEFAULT (${NOW})
    );
    CREATE INDEX IF NOT EXISTS chat_msgs_th ON chat_msgs (th, id);
    CREATE TABLE IF NOT EXISTS chat_ev (id INTEGER PRIMARY KEY AUTOINCREMENT, th INTEGER, owner TEXT, t TEXT NOT NULL, mid INTEGER, data TEXT, at TEXT DEFAULT (${NOW}));
    CREATE TABLE IF NOT EXISTS chat_log (ts TEXT DEFAULT (${NOW}), th INTEGER, by TEXT, action TEXT, detail TEXT);
    CREATE TABLE IF NOT EXISTS chat_tpl (id INTEGER PRIMARY KEY AUTOINCREMENT, key TEXT NOT NULL, text TEXT NOT NULL, by TEXT, updated_at TEXT DEFAULT (${NOW}));
    CREATE TABLE IF NOT EXISTS chat_tags (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL, color TEXT NOT NULL DEFAULT 'slate', sort INTEGER NOT NULL DEFAULT 0, deleted INTEGER NOT NULL DEFAULT 0);
  `);
  try { db.exec('ALTER TABLE chat_threads ADD COLUMN tags TEXT'); } catch {} // nhan cuoc chat: ',1,4,' (id chat_tags)
  if (!db.prepare('SELECT 1 FROM chat_tags LIMIT 1').get()) { // nhan mac dinh (admin sua / xoa / them duoc)
    const ins = db.prepare('INSERT INTO chat_tags (name, color, sort) VALUES (?, ?, ?)');
    [['Hỏi giá', 'info'], ['Chờ thanh toán', 'warning'], ['Khiếu nại', 'error'], ['Gấp', 'error'], ['Khách mới', 'success'], ['Đã chốt', 'success']].forEach((t, i) => ins.run(t[0], t[1], i));
  }
}

const ctxOk = (c) => c === 'vmt' || /^don:[A-Za-z0-9_-]{3,40}$/.test(String(c || ''));
const codeOf = (ctx) => (String(ctx).startsWith('don:') ? String(ctx).slice(4) : null);
const clip = (s, n) => { s = String(s == null ? '' : s).replace(/\r\n?/g, '\n').trim(); return s.length > n ? s.slice(0, n) : s; };
const j = (s, d) => { if (!s) return d; try { return JSON.parse(s); } catch { return d; } };

function ev(db, th, owner, t, mid, data) {
  db.prepare('INSERT INTO chat_ev (th, owner, t, mid, data) VALUES (?, ?, ?, ?, ?)').run(th, owner, t, mid || null, data ? JSON.stringify(data) : null);
}
function log(db, th, by, action, detail) { db.prepare('INSERT INTO chat_log (th, by, action, detail) VALUES (?, ?, ?, ?)').run(th, by, action, detail ? JSON.stringify(detail) : null); }

function thread(db, id) { return db.prepare('SELECT * FROM chat_threads WHERE id = ?').get(Number(id) || 0) || null; }
function threadBy(db, owner, ctx) { return db.prepare('SELECT * FROM chat_threads WHERE owner = ? AND ctx = ?').get(owner, ctx) || null; }
function ensure(db, o) {
  if (!ctxOk(o.ctx)) return null;
  const t = threadBy(db, o.owner, o.ctx); if (t) return t;
  db.prepare('INSERT OR IGNORE INTO chat_threads (owner, gobiz, ctx, kind, title, test) VALUES (?, ?, ?, ?, ?, ?)')
    .run(o.owner, o.gobiz || null, o.ctx, o.kind || (o.ctx === 'vmt' ? 'vmt' : null), clip(o.title, 120) || null, o.test ? 1 : 0);
  const n = threadBy(db, o.owner, o.ctx);
  log(db, n.id, o.by || null, 'Tạo cuộc chat', { ctx: o.ctx });
  return n;
}

// ---------- tin nhan ----------
function reactView(r, who) {
  const m = j(r.reacts, {}); const out = [];
  for (const e of EMOJI) if (m[e] && m[e].length) out.push({ e, n: m[e].length, mine: m[e].includes(who) });
  return out;
}
// Anh dai dien khach cua cuoc chat (chu cuoc chat -> 'k:<owner>'), nho chu cuoc chat theo id
const thOwner = new Map();
function avOfThread(db, th) {
  let o = thOwner.get(th);
  if (o === undefined) { const t = db.prepare('SELECT owner FROM chat_threads WHERE id = ?').get(th); o = t ? t.owner : null; thOwner.set(th, o); if (thOwner.size > 5000) thOwner.clear(); }
  return o ? prof.avatarOf(db, 'k:' + o) : null;
}
// side: 'k' (khach) | 's' (nhan vien). who: 'k' hoac 's:<username>'
function view(db, r, side, who) {
  if (!r) return null;
  if (side === 'k' && r.f === 'note') return null;
  const recalled = !!r.recalled_at;
  const m = { id: r.id, th: r.th, f: r.f, name: r.name || '', at: r.created_at, re: reactView(r, who) };
  if (side === 's' && r.by) m.by = r.by;
  const av = r.f === 's' && r.by ? prof.avatarOf(db, 's:' + r.by) : r.f === 'k' ? avOfThread(db, r.th) : null;
  if (av) m.av = av;
  if (recalled) { m.recalled = true; if (side === 's') m.orig = r.orig || ''; }
  else { m.body = r.body || ''; const a = j(r.att, null); if (a) m.att = a; const c = j(r.card, null); if (c) m.card = c; }
  if (r.reply) {
    const q = db.prepare('SELECT id, f, name, body, att, recalled_at FROM chat_msgs WHERE id = ?').get(r.reply);
    if (q && !(side === 'k' && q.f === 'note')) m.reply = { id: q.id, f: q.f, name: q.name || '', body: q.recalled_at ? '' : clip(q.body, 140), img: !q.recalled_at && !!j(q.att, null), vid: !q.recalled_at && (j(q.att, []) || []).some((a) => a.t === 'v'), recalled: !!q.recalled_at };
  }
  return m;
}
function messages(db, th, side, who, opt = {}) {
  const lim = Math.min(Math.max(Number(opt.limit) || 50, 1), 100);
  const noNote = side === 'k' ? " AND f <> 'note'" : '';
  let rows;
  if (opt.after) rows = db.prepare('SELECT * FROM chat_msgs WHERE th = ? AND id > ?' + noNote + ' ORDER BY id LIMIT ?').all(th, Number(opt.after), lim);
  else if (opt.before) rows = db.prepare('SELECT * FROM chat_msgs WHERE th = ? AND id < ?' + noNote + ' ORDER BY id DESC LIMIT ?').all(th, Number(opt.before), lim).reverse();
  else rows = db.prepare('SELECT * FROM chat_msgs WHERE th = ?' + noNote + ' ORDER BY id DESC LIMIT ?').all(th, lim).reverse();
  return rows.map((r) => view(db, r, side, who)).filter(Boolean);
}
function msg(db, id) { return db.prepare('SELECT * FROM chat_msgs WHERE id = ?').get(Number(id) || 0) || null; }

// f: 'k' khach | 's' nhan vien | 'note' ghi chu noi bo | 'sys' he thong. att = [{id}] anh / [{id, t:'v'}] video (da kiem tra o API). card = { t:'order', code, k }
function send(db, t, o) {
  const body = clip(o.body, BODY_MAX);
  const att = Array.isArray(o.att) && o.att.length ? o.att.slice(0, 10) : null;
  // the: 'order' = the don (bam mo don) · 'pay' = the hanh dong "Thanh toan don" (NV gui, khach bam la sang trang thanh toan)
  const card = o.card && o.card.code ? { t: o.card.t === 'pay' ? 'pay' : 'order', code: clip(o.card.code, 40), k: clip(o.card.k, 8) } : null;
  if (!body && !att && !card) return { error: 'Tin nhắn trống' };
  let reply = Number(o.reply) || null;
  if (reply) { const q = msg(db, reply); if (!q || q.th !== t.id || (o.f === 'k' && q.f === 'note')) reply = null; }
  db.exec('BEGIN IMMEDIATE');
  try {
    const id = Number(db.prepare('INSERT INTO chat_msgs (th, f, by, name, body, reply, att, card) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
      .run(t.id, o.f, o.by || null, clip(o.name, 60) || null, body || null, reply, att ? JSON.stringify(att) : null, card ? JSON.stringify(card) : null).lastInsertRowid);
    if (att) for (const a of att) db.prepare("UPDATE uploads SET code = ?, owner = ?, kind = CASE WHEN kind = 'video' THEN 'video' ELSE 'chat' END WHERE id = ? AND code IS NULL").run('chat:' + t.id, t.owner, a.id);
    if (o.f !== 'note') {
      const preview = body ? clip(body.replace(/\s+/g, ' '), 120) : att ? (att.some((a) => a.t === 'v') ? '[Video]' : '[Ảnh]') : (card.t === 'pay' ? '[Thanh toán đơn ' : '[Đơn ') + card.code + ']';
      const up = ['last_id = ?', 'last_at = ' + NOW, 'last_from = ?', 'last_text = ?'];
      const args = [id, o.f, preview];
      if (o.f === 'k') { up.push('wait_at = COALESCE(wait_at, ' + NOW + ')', 'cust_read = ?', "status = 'open'"); args.push(id); }
      if (o.f === 's') { up.push('wait_at = NULL', 'ooh_at = NULL', 'staff_read = ?'); args.push(id); if (!t.assignee && o.by) { up.push('assignee = ?'); args.push(o.by); } }
      db.prepare('UPDATE chat_threads SET ' + up.join(', ') + ' WHERE id = ?').run(...args, t.id);
    }
    ev(db, t.id, t.owner, 'msg', id, { f: o.f });
    db.exec('COMMIT');
    return { msg: msg(db, id) };
  } catch (e) { try { db.exec('ROLLBACK'); } catch {} throw e; }
}
// who: 'k' | 's:<user>'. Bam lai cung emoji -> bo
function react(db, m, who, e) {
  if (!EMOJI.includes(e) || m.recalled_at) return { error: 'Không thả được cảm xúc' };
  const r = j(m.reacts, {});
  for (const k of Object.keys(r)) { if (k !== e) r[k] = r[k].filter((x) => x !== who); if (!r[k].length) delete r[k]; }
  const list = r[e] || []; r[e] = list.includes(who) ? list.filter((x) => x !== who) : list.concat([who]); if (!r[e].length) delete r[e];
  db.prepare('UPDATE chat_msgs SET reacts = ? WHERE id = ?').run(Object.keys(r).length ? JSON.stringify(r) : null, m.id);
  const t = thread(db, m.th); ev(db, m.th, t.owner, 'upd', m.id);
  return { ok: true };
}
// Chi nguoi gui, trong 60 phut. Khach: moi tin 'k' cua cuoc minh; nhan vien: tin cua chinh minh
function recall(db, m, by, isStaff) {
  if (m.recalled_at) return { ok: true };
  const mine = isStaff ? (['s', 'note'].includes(m.f) && m.by === by) : m.f === 'k';
  if (!mine) return { error: 'Chỉ thu hồi được tin của mình', code: 403 };
  if (Date.now() - Date.parse(m.created_at) > RECALL_MS) return { error: 'Chỉ thu hồi được trong 60 phút sau khi gửi', code: 409 };
  db.prepare('UPDATE chat_msgs SET recalled_at = ' + NOW + ', orig = ? WHERE id = ?').run(JSON.stringify({ body: m.body, att: j(m.att, null), card: j(m.card, null) }), m.id);
  const t = thread(db, m.th);
  if (t.last_id === m.id) db.prepare("UPDATE chat_threads SET last_text = 'Đã thu hồi tin nhắn' WHERE id = ?").run(t.id);
  log(db, m.th, by, 'Thu hồi tin', { id: m.id });
  ev(db, m.th, t.owner, 'upd', m.id);
  return { ok: true };
}
function read(db, t, side, upto) {
  const col = side === 'k' ? 'cust_read' : 'staff_read';
  const max = db.prepare('SELECT MAX(id) AS m FROM chat_msgs WHERE th = ?').get(t.id).m || 0;
  const v = Math.min(Number(upto) || max, max);
  if (v <= t[col]) return { ok: true };
  db.prepare('UPDATE chat_threads SET ' + col + ' = ? WHERE id = ? AND ' + col + ' < ?').run(v, t.id, v);
  ev(db, t.id, t.owner, 'read', null, { side, upto: v });
  return { ok: true };
}
function typing(db, t, side, name) { ev(db, t.id, t.owner, 'typing', null, { side, name: clip(name, 40) }); }

// ---------- danh sach ----------
function unreadK(db, th, after) { return db.prepare("SELECT COUNT(*) AS n FROM chat_msgs WHERE th = ? AND id > ? AND f IN ('s','sys') AND recalled_at IS NULL").get(th, after).n; }
function unreadS(db, th, after) { return db.prepare("SELECT COUNT(*) AS n FROM chat_msgs WHERE th = ? AND id > ? AND f = 'k' AND recalled_at IS NULL").get(th, after).n; }
function tView(db, t, side) {
  const o = { id: t.id, ctx: t.ctx, code: codeOf(t.ctx), kind: t.kind, title: t.title, lastAt: t.last_at, lastFrom: t.last_from, lastText: t.last_text, lastId: t.last_id };
  if (t.last_id) { const n = db.prepare('SELECT name FROM chat_msgs WHERE id = ?').get(t.last_id); o.lastName = (n && n.name) || ''; }
  if (side === 'k') { o.unread = unreadK(db, t.id, t.cust_read); o.seenByStaff = t.staff_read; }
  else Object.assign(o, { owner: t.owner, gobiz: t.gobiz, test: !!t.test, tags: String(t.tags || '').split(',').filter(Boolean).map(Number), assignee: t.assignee, status: t.status, waitAt: t.wait_at, unread: unreadS(db, t.id, t.staff_read), seenByCust: t.cust_read });
  if (side === 's') { const av = prof.avatarOf(db, 'k:' + t.owner); if (av) o.av = av; }
  return o;
}
function listCustomer(db, owner) {
  return db.prepare('SELECT * FROM chat_threads WHERE owner = ? AND last_id > 0 ORDER BY last_at DESC LIMIT 200').all(owner).map((t) => tView(db, t, 'k'));
}
function unreadCustomer(db, owner) {
  return db.prepare("SELECT COUNT(*) AS n FROM chat_threads t WHERE t.owner = ? AND EXISTS (SELECT 1 FROM chat_msgs m WHERE m.th = t.id AND m.id > t.cust_read AND m.f IN ('s','sys') AND m.recalled_at IS NULL)").get(owner).n;
}
// f: unread | mine | free | wait | done | all. q: tim theo khach / ma don / noi dung tin
function listStaff(db, f, me, q, test, tag) {
  const w = ['t.last_id > 0'], a = [];
  if (Number(tag)) { w.push("t.tags LIKE ?"); a.push('%,' + Number(tag) + ',%'); }
  if (!test) w.push('t.test = 0');
  if (f === 'mine') { w.push('t.assignee = ?', "t.status = 'open'"); a.push(me); }
  else if (f === 'free') w.push('t.assignee IS NULL', "t.status = 'open'");
  else if (f === 'wait') w.push('t.wait_at IS NOT NULL', "t.status = 'open'");
  else if (f === 'done') w.push("t.status = 'done'");
  else if (f === 'unread') w.push("EXISTS (SELECT 1 FROM chat_msgs m WHERE m.th = t.id AND m.id > t.staff_read AND m.f = 'k')");
  q = clip(q, 60).toLowerCase();
  if (q) { w.push("(lower(t.owner) LIKE ? OR lower(t.ctx) LIKE ? OR lower(COALESCE(t.title,'')) LIKE ? OR EXISTS (SELECT 1 FROM chat_msgs m WHERE m.th = t.id AND m.f <> 'sys' AND lower(m.body) LIKE ?))"); const l = '%' + q.replace(/[%_]/g, '') + '%'; a.push(l, l, l, l); }
  return db.prepare('SELECT t.* FROM chat_threads t WHERE ' + w.join(' AND ') + ' ORDER BY (t.wait_at IS NULL), t.last_at DESC LIMIT 300').all(...a).map((t) => tView(db, t, 's'));
}
function counts(db, me, test) {
  const tw = test ? '' : ' AND t.test = 0';
  const one = (sql, ...a) => db.prepare('SELECT COUNT(*) AS n FROM chat_threads t WHERE t.last_id > 0' + tw + ' AND ' + sql).get(...a).n;
  return {
    unread: one("EXISTS (SELECT 1 FROM chat_msgs m WHERE m.th = t.id AND m.id > t.staff_read AND m.f = 'k')"),
    mine: one("t.assignee = ? AND t.status = 'open' AND t.wait_at IS NOT NULL", me),
    free: one("t.assignee IS NULL AND t.status = 'open' AND t.wait_at IS NOT NULL"),
    wait: one("t.wait_at IS NOT NULL AND t.status = 'open'"),
  };
}
function assign(db, t, to, by) {
  if ((t.assignee || null) === (to || null)) return { ok: true };
  db.prepare('UPDATE chat_threads SET assignee = ? WHERE id = ?').run(to || null, t.id);
  log(db, t.id, by, to ? 'Chuyển cuộc chat' : 'Bỏ nhận cuộc chat', { from: t.assignee || null, to: to || null });
  ev(db, t.id, t.owner, 'th', null);
  return { ok: true };
}
function setStatus(db, t, st, by) {
  if (!['open', 'done'].includes(st) || t.status === st) return { ok: true };
  db.prepare('UPDATE chat_threads SET status = ?' + (st === 'done' ? ', wait_at = NULL' : '') + ' WHERE id = ?').run(st, t.id);
  log(db, t.id, by, st === 'done' ? 'Đã xử lý' : 'Mở lại', null);
  ev(db, t.id, t.owner, 'th', null);
  return { ok: true };
}

// ---------- nhan (tag) cuoc chat ----------
const TAG_COLORS = ['slate', 'info', 'success', 'warning', 'error', 'secondary', 'primary'];
function tagList(db) { return db.prepare('SELECT id, name, color FROM chat_tags WHERE deleted = 0 ORDER BY sort, id').all(); }
function tagSave(db, o) {
  const name = clip(o.name, 30), color = TAG_COLORS.includes(o.color) ? o.color : 'slate';
  if (!name) return { error: 'Cần tên nhãn' };
  if (o.id) db.prepare('UPDATE chat_tags SET name = ?, color = ? WHERE id = ?').run(name, color, Number(o.id));
  else { if (db.prepare('SELECT COUNT(*) AS n FROM chat_tags WHERE deleted = 0').get().n >= 40) return { error: 'Tối đa 40 nhãn' }; db.prepare('INSERT INTO chat_tags (name, color, sort) VALUES (?, ?, 99)').run(name, color); }
  return { ok: true };
}
function tagDelete(db, id) { db.prepare('UPDATE chat_tags SET deleted = 1 WHERE id = ?').run(Number(id) || 0); return { ok: true }; }
function setTags(db, t, ids, by) {
  const ok = new Set(tagList(db).map((x) => x.id));
  const list = [...new Set((Array.isArray(ids) ? ids : []).map(Number).filter((x) => ok.has(x)))].slice(0, 10);
  const v = list.length ? ',' + list.join(',') + ',' : null;
  if ((t.tags || null) === v) return { ok: true };
  db.prepare('UPDATE chat_threads SET tags = ? WHERE id = ?').run(v, t.id);
  log(db, t.id, by, 'Đổi nhãn', { from: t.tags || null, to: v });
  ev(db, t.id, t.owner, 'th', null);
  return { ok: true };
}

// ---------- mau cau "/" (nhan vien) ----------
function tplList(db) { return db.prepare('SELECT id, key, text FROM chat_tpl ORDER BY key').all(); }
function tplSave(db, o, by) {
  const key = clip(o.key, 30).replace(/^\/+/, '').replace(/\s+/g, '-').toLowerCase(), text = clip(o.text, 1500);
  if (!key || !text) return { error: 'Cần tên tắt và nội dung' };
  if (o.id) db.prepare('UPDATE chat_tpl SET key = ?, text = ?, by = ?, updated_at = ' + NOW + ' WHERE id = ?').run(key, text, by, Number(o.id));
  else { if (db.prepare('SELECT COUNT(*) AS n FROM chat_tpl').get().n >= 300) return { error: 'Tối đa 300 mẫu' }; db.prepare('INSERT INTO chat_tpl (key, text, by) VALUES (?, ?, ?)').run(key, text, by); }
  return { ok: true };
}
function tplDelete(db, id) { db.prepare('DELETE FROM chat_tpl WHERE id = ?').run(Number(id) || 0); return { ok: true }; }

// ---------- gio lam viec (Thu Hai - Thu Bay, 8:30 - 18:00, gio VN) ----------
function inHours(d) {
  const v = new Date((d ? +d : Date.now()) + 7 * 3600e3); const day = v.getUTCDay(); const mins = v.getUTCHours() * 60 + v.getUTCMinutes();
  return day >= 1 && day <= 6 && mins >= 510 && mins < 1080;
}
const OOH_TEXT = 'Giờ này đang ngoài giờ làm việc (Thứ Hai – Thứ Bảy, 8:30 – 18:00) nên nhân viên trả lời hơi chậm. Tin của anh/chị vẫn ở đây, có người trực là trả lời ngay, không thì đầu ca làm việc tới sẽ trả lời.';
// Ngoai gio: khach cho 30 phut chua ai tra loi -> 1 tin he thong (moi luot cho 1 lan)
function oohPump(db) {
  if (inHours()) return 0;
  const rows = db.prepare("SELECT * FROM chat_threads WHERE wait_at IS NOT NULL AND ooh_at IS NULL AND status = 'open'").all().filter((t) => Date.now() - Date.parse(t.wait_at) >= 30 * 60e3);
  let n = 0;
  for (const t of rows) {
    if (inHours(Date.parse(t.wait_at))) continue; // khach nhan trong gio -> nhan vien phai tra loi, khong tu tra loi
    db.prepare('UPDATE chat_threads SET ooh_at = ' + NOW + ' WHERE id = ?').run(t.id);
    send(db, t, { f: 'sys', name: 'Hệ thống', body: OOH_TEXT }); n++;
  }
  return n;
}

// ---------- su kien cho SSE ----------
function evMax(db) { return db.prepare('SELECT MAX(id) AS m FROM chat_ev').get().m || 0; }
function evSince(db, cur) { return db.prepare('SELECT * FROM chat_ev WHERE id > ? ORDER BY id LIMIT 500').all(cur).map((e) => Object.assign(e, { data: j(e.data, null) })); }
function purge(db) {
  db.prepare("DELETE FROM chat_ev WHERE at < strftime('%Y-%m-%dT%H:%M:%fZ','now','-2 days')").run();
  db.prepare("DELETE FROM chat_log WHERE ts < strftime('%Y-%m-%dT%H:%M:%fZ','now','-730 days')").run();
}

// ---------- video trong chat (luu tren may chu: <thu muc du lieu khach>/chatfiles/<id>) ----------
// Giai doan 1 luu tai may (sau chuyen Cloudflare R2). Gioi han: khach 100MB / video, NV 75MB (Caddy admin 80MB);
// moi nguoi 20 video + 2GB / ngay; tong kho video toi da 40GB. Video cuoc chat da yen 30 ngay va cu hon 90 ngay -> tu xoa.
const VIDEO_CAP = 40 * 1024 ** 3;
const fileDir = (dir) => path.join(dir, 'chatfiles');
const filePath = (dir, id) => path.join(fileDir(dir), String(id).replace(/[^a-f0-9]/g, ''));
function fileSave(db, dir, req, o) {
  return new Promise((done) => {
    const len = Number(req.headers['content-length'] || 0);
    if (len > o.max) { req.resume(); return done({ error: 'Video tối đa ' + Math.round(o.max / 1048576) + 'MB, anh/chị cắt ngắn bớt hoặc quay lại chất lượng thấp hơn' }); }
    const day = db.prepare("SELECT COUNT(*) AS n, COALESCE(SUM(size),0) AS b FROM uploads WHERE by = ? AND kind = 'video' AND created_at > strftime('%Y-%m-%dT%H:%M:%fZ','now','-1 day')").get(o.by);
    if (day.n >= 20 || day.b + len > 2 * 1024 ** 3) { req.resume(); return done({ error: 'Đã gửi quá nhiều video trong 24 giờ, thử lại sau' }); }
    if (db.prepare("SELECT COALESCE(SUM(size),0) AS b FROM uploads WHERE kind = 'video'").get().b + len > VIDEO_CAP) { req.resume(); return done({ error: 'Kho video đang đầy, tạm thời gửi ảnh nhé (đã báo kỹ thuật)', full: true }); }
    const id = crypto.randomBytes(16).toString('hex');
    fs.mkdirSync(fileDir(dir), { recursive: true });
    const f = filePath(dir, id), tmp = f + '.part';
    const out = fs.createWriteStream(tmp, { flags: 'wx' });
    let n = 0, head = Buffer.alloc(0), bad = null;
    const fail = (msg) => { if (bad) return; bad = msg; req.unpipe && req.unpipe(); req.resume(); out.destroy(); fs.rm(tmp, { force: true }, () => {}); done({ error: msg }); };
    req.on('data', (c) => {
      n += c.length; if (n > o.max) return fail('Video tối đa ' + Math.round(o.max / 1048576) + 'MB');
      if (head.length < 12) head = Buffer.concat([head, c]).subarray(0, 12);
      if (!bad && !out.write(c)) { req.pause(); out.once('drain', () => req.resume()); }
    });
    req.on('error', () => fail('Mất kết nối khi gửi video, thử lại'));
    req.on('aborted', () => fail('Mất kết nối khi gửi video, thử lại'));
    req.on('end', () => {
      if (bad) return;
      const isMp4 = head.length >= 12 && head.subarray(4, 8).toString('latin1') === 'ftyp';
      const isWebm = head.length >= 4 && head.readUInt32BE(0) === 0x1a45dfa3;
      if (n < 1000 || !(isMp4 || isWebm)) return fail('Chỉ nhận video MP4 / MOV / WEBM');
      out.end(() => fs.rename(tmp, f, (e) => {
        if (e) return fail('Lỗi lưu video');
        db.prepare("INSERT INTO uploads (id, owner, by, size, kind) VALUES (?, ?, ?, ?, 'video')").run(id, o.owner || null, o.by, n);
        done({ id });
      }));
    });
  });
}
// Phat video (ho tro Range de iPhone / Android tua duoc)
function fileServe(req, res, dir, id) {
  const f = filePath(dir, id);
  fs.stat(f, (err, st) => {
    if (err) { res.writeHead(404, { 'Cache-Control': 'no-store' }); return res.end('Video đã hết hạn lưu'); }
    const fd = fs.openSync(f, 'r'); const h = Buffer.alloc(4); fs.readSync(fd, h, 0, 4, 0); fs.closeSync(fd);
    const type = h.readUInt32BE(0) === 0x1a45dfa3 ? 'video/webm' : 'video/mp4';
    const base = { 'Content-Type': type, 'Accept-Ranges': 'bytes', 'Cache-Control': 'private, max-age=604800', 'Content-Encoding': 'identity' };
    const m = /^bytes=(\d*)-(\d*)$/.exec(req.headers.range || '');
    if (m) {
      let a = m[1] === '' ? st.size - Number(m[2]) : Number(m[1]); let b = m[1] !== '' && m[2] !== '' ? Number(m[2]) : st.size - 1;
      a = Math.max(0, a); b = Math.min(b, st.size - 1);
      if (a > b) { res.writeHead(416, { 'Content-Range': 'bytes */' + st.size }); return res.end(); }
      res.writeHead(206, Object.assign(base, { 'Content-Range': 'bytes ' + a + '-' + b + '/' + st.size, 'Content-Length': b - a + 1 }));
      return fs.createReadStream(f, { start: a, end: b }).pipe(res);
    }
    res.writeHead(200, Object.assign(base, { 'Content-Length': st.size }));
    fs.createReadStream(f).pipe(res);
  });
}
// Don dep: video gui do (khong gan vao tin) qua 1 ngay; video cuoc chat yen 30 ngay va cu hon 90 ngay
function filePurge(db, dir) {
  const rows = db.prepare(`SELECT u.id FROM uploads u LEFT JOIN chat_threads t ON u.code = 'chat:' || t.id WHERE u.kind = 'video' AND (
    (u.code IS NULL AND u.created_at < strftime('%Y-%m-%dT%H:%M:%fZ','now','-1 day')) OR
    (u.created_at < strftime('%Y-%m-%dT%H:%M:%fZ','now','-90 days') AND (t.last_at IS NULL OR t.last_at < strftime('%Y-%m-%dT%H:%M:%fZ','now','-30 days'))))`).all();
  for (const r of rows) { try { fs.rmSync(filePath(dir, r.id), { force: true }); } catch {} db.prepare("UPDATE uploads SET kind = 'video-xoa', size = 0 WHERE id = ?").run(r.id); }
  try { for (const n of fs.readdirSync(fileDir(dir))) if (n.endsWith('.part')) { const p = path.join(fileDir(dir), n); if (Date.now() - fs.statSync(p).mtimeMs > 3600e3) fs.rmSync(p, { force: true }); } } catch {}
  return rows.length;
}
// Kiem tra danh sach id anh / video truoc khi gan vao tin: phai do chinh nguoi nay tai, chua dung
function attCheck(db, ids, by) {
  const att = [];
  for (const id of (Array.isArray(ids) ? ids : []).slice(0, 10)) {
    const u = db.prepare('SELECT by, code, kind FROM uploads WHERE id = ?').get(String(id));
    if (!u || u.by !== by || u.code) return { error: 'Ảnh / video không hợp lệ, chọn lại' };
    att.push(u.kind === 'video' ? { id: String(id), t: 'v' } : { id: String(id) });
  }
  return { att };
}

module.exports = { tagList, tagSave, tagDelete, setTags, fileSave, fileServe, filePurge, attCheck, init, ctxOk, codeOf, ensure, thread, threadBy, messages, msg, view, send, react, recall, read, typing, tView, listCustomer, unreadCustomer, unreadK, listStaff, counts, assign, setStatus, tplList, tplSave, tplDelete, inHours, oohPump, evMax, evSince, purge, log, EMOJI, RECALL_MS };
