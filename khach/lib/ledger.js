'use strict';
// SO GIAO DICH + VI KHACH. DUNG CHUNG: khach/lib/ledger.js va app/lib/ledger.js PHAI GIONG HET NHAU.
// Nguyen tac (decisions/finance-ledger.md):
// - So cai chi ghi them: trigger chan UPDATE/DELETE tren ledger, ledger_lines.
// - Moi giao dich 1 ma GDyymm###### + 1 khoa chong trung (idem, UNIQUE). Gui lai cung khoa -> tra ket qua cu.
// - Moi thao tac tien chay trong BEGIN IMMEDIATE: doc so du + con thieu THAT trong DB roi moi ghi.
// - So nguyen dong. So tien do may chu tinh, khong nhan tu trinh duyet (tru nap tay / dieu chinh co duyet).
// - Chuoi bam: moi dong luu hash(dong truoc + noi dung) de phat hien sua thang vao DB.
// - Chu vi (owner) = ten Gobiz viet thuong.
const crypto = require('node:crypto');

// ---------- Ma khach = ma nap tien: 1 so + 5 chu/so + 1 so kiem tra (vd 3HK7Q25) ----------
const CS = '23456789ABCDEFGHJKMNPQRSTUVWXYZ'; // 31 ky tu, bo 0 O 1 I L
const HEAD = '23456789';
function checkOf(s6) { let h = 0; for (let i = 0; i < 6; i++) h += CS.indexOf(s6[i]) * (i + 1); return h % 31; } // 31 la so nguyen to: sai 1 ky tu / dao 2 ky tu canh nhau luon lam doi gia tri
function normCode(s) { return String(s || '').toUpperCase().replace(/[^0-9A-Z]/g, ''); }
function validCode(s) {
  const c = normCode(s);
  if (!/^[2-9][23456789ABCDEFGHJKMNPQRSTUVWXYZ]{5}[0-9]$/.test(c)) return false;
  const h = checkOf(c.slice(0, 6)); return h < 10 && String(h) === c[6];
}
function genCode(taken, gobizNames) {
  for (let n = 0; n < 100000; n++) {
    const r = crypto.randomBytes(6);
    let s = HEAD[r[0] % 8]; for (let i = 1; i < 6; i++) s += CS[r[i] % 31];
    if (!/[A-Z]/.test(s.slice(1))) continue;
    const h = checkOf(s); if (h >= 10) continue;
    const code = s + h; const low = code.toLowerCase();
    if (taken(code)) continue;
    if (gobizNames.some((u) => u && low.includes(u))) continue; // Gobiz nap theo "noi dung co chua username"
    return code;
  }
  throw new Error('Không tạo được mã khách');
}

// ---------- bang ----------
function init(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS cust_codes (owner TEXT PRIMARY KEY, code TEXT UNIQUE NOT NULL, created_at TEXT DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')));
    CREATE TABLE IF NOT EXISTS wallets (owner TEXT PRIMARY KEY, balance INTEGER NOT NULL DEFAULT 0, credit_limit INTEGER NOT NULL DEFAULT 0, credit_days INTEGER NOT NULL DEFAULT 30, neg_since TEXT, test INTEGER NOT NULL DEFAULT 0, updated_at TEXT);
    CREATE TABLE IF NOT EXISTS ledger (
      id INTEGER PRIMARY KEY AUTOINCREMENT, txn TEXT UNIQUE NOT NULL, idem TEXT UNIQUE NOT NULL, owner TEXT NOT NULL, kind TEXT NOT NULL,
      amount INTEGER NOT NULL, balance_after INTEGER NOT NULL, note TEXT, by TEXT NOT NULL, test INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL, prev_hash TEXT, hash TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS ledger_lines (txn TEXT NOT NULL, code TEXT NOT NULL, amount INTEGER NOT NULL);
    CREATE INDEX IF NOT EXISTS ledger_owner ON ledger (owner, id);
    CREATE INDEX IF NOT EXISTS ledger_lines_code ON ledger_lines (code);
    CREATE TRIGGER IF NOT EXISTS ledger_no_update BEFORE UPDATE ON ledger BEGIN SELECT RAISE(ABORT, 'so cai chi duoc ghi them'); END;
    CREATE TRIGGER IF NOT EXISTS ledger_no_delete BEFORE DELETE ON ledger BEGIN SELECT RAISE(ABORT, 'so cai chi duoc ghi them'); END;
    CREATE TRIGGER IF NOT EXISTS lines_no_update BEFORE UPDATE ON ledger_lines BEGIN SELECT RAISE(ABORT, 'so cai chi duoc ghi them'); END;
    CREATE TRIGGER IF NOT EXISTS lines_no_delete BEFORE DELETE ON ledger_lines BEGIN SELECT RAISE(ABORT, 'so cai chi duoc ghi them'); END;
    CREATE TABLE IF NOT EXISTS pins (owner TEXT PRIMARY KEY, hash TEXT NOT NULL, fails INTEGER NOT NULL DEFAULT 0, locked_until TEXT, set_at TEXT, set_by TEXT);
    CREATE TABLE IF NOT EXISTS fin_requests (
      id INTEGER PRIMARY KEY AUTOINCREMENT, kind TEXT NOT NULL, owner TEXT NOT NULL, amount INTEGER NOT NULL, codes TEXT, note TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'pending', created_by TEXT NOT NULL, created_at TEXT DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
      decided_by TEXT, decided_at TEXT, decide_note TEXT, txn TEXT);
    CREATE TABLE IF NOT EXISTS deposits (
      ref TEXT PRIMARY KEY, src TEXT, bank_ref TEXT, rec TEXT, amount INTEGER NOT NULL, content TEXT, at TEXT,
      status TEXT NOT NULL, owner TEXT, code TEXT, reason TEXT, txn TEXT, req_id INTEGER,
      created_at TEXT DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')), decided_by TEXT, decided_at TEXT);
    CREATE TABLE IF NOT EXISTS wallet_log (ts TEXT DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')), owner TEXT, by TEXT, action TEXT, detail TEXT);
  `);
}
const nowIso = () => new Date().toISOString();
const sha = (s) => crypto.createHash('sha256').update(s).digest('hex');
const KIND = { TOPUP: 'Nạp tiền', TOPUP_MANUAL: 'Nạp tay', PAY: 'Thanh toán đơn', REFUND: 'Hoàn tiền về ví', ADJUST: 'Điều chỉnh', REVERSAL: 'Giao dịch đảo' };
const vnd = (n) => Math.round(n).toLocaleString('vi-VN') + 'đ';
function tx(db, fn) {
  db.exec('BEGIN IMMEDIATE');
  try { const r = fn(); if (r && r.error) { db.exec('ROLLBACK'); return r; } db.exec('COMMIT'); return r; }
  catch (e) { try { db.exec('ROLLBACK'); } catch {} throw e; }
}
function wlog(db, owner, by, action, detail) { db.prepare('INSERT INTO wallet_log (owner, by, action, detail) VALUES (?, ?, ?, ?)').run(owner, by, action, JSON.stringify(detail || {})); }

// ---------- vi ----------
function walletRow(db, owner) {
  let w = db.prepare('SELECT * FROM wallets WHERE owner = ?').get(owner);
  if (!w) w = { owner, balance: 0, credit_limit: 0, credit_days: 30, neg_since: null, test: 0 };
  return w;
}
function walletView(db, owner) {
  const w = walletRow(db, owner);
  const overdue = !!(w.neg_since && Date.now() - Date.parse(w.neg_since) > w.credit_days * 86400e3);
  const creditOk = w.credit_limit > 0 && !overdue;
  const pending = db.prepare("SELECT COALESCE(SUM(json_extract(data,'$.unpaid')),0) AS s FROM cn_orders WHERE lower(gobiz) = ? AND status NOT IN ('CANCELLED','RETURN')").get(owner).s;
  return {
    owner, balance: w.balance, creditLimit: w.credit_limit, creditDays: w.credit_days, negSince: w.neg_since, overdue, creditOk,
    dueAt: w.neg_since ? new Date(Date.parse(w.neg_since) + w.credit_days * 86400e3).toISOString() : null,
    available: w.balance + (creditOk ? w.credit_limit : 0), // dung de THANH TOAN
    withdrawable: Math.max(0, w.balance - pending), // dung de RUT: khong tinh tin dung, tru tien don chua tra
    pendingOrders: pending,
  };
}
function nextTxn(db) {
  const r = db.prepare("SELECT seq FROM sqlite_sequence WHERE name = 'ledger'").get();
  const n = (r ? r.seq : 0) + 1; const d = new Date();
  return 'GD' + String(d.getUTCFullYear()).slice(2) + String(d.getUTCMonth() + 1).padStart(2, '0') + String(n).padStart(6, '0');
}
// Ghi 1 giao dich. CHI goi ben trong tx(). amount: + vao vi, - ra vi.
function post(db, { owner, kind, amount, idem, note, by, lines, test }) {
  if (!Number.isSafeInteger(amount) || amount === 0) throw new Error('Số tiền không hợp lệ');
  const w = walletRow(db, owner);
  const bal = w.balance + amount;
  const txn = nextTxn(db); const at = nowIso();
  const prev = db.prepare('SELECT hash FROM ledger ORDER BY id DESC LIMIT 1').get();
  const prevHash = prev ? prev.hash : 'GENESIS';
  const ls = (lines || []).map((l) => [l.code, l.amount]);
  const hash = sha([prevHash, txn, idem, owner, kind, amount, bal, note || '', by, at, JSON.stringify(ls)].join('|'));
  db.prepare('INSERT INTO ledger (txn, idem, owner, kind, amount, balance_after, note, by, test, created_at, prev_hash, hash) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
    .run(txn, idem, owner, kind, amount, bal, note || null, by, test ? 1 : 0, at, prevHash, hash);
  for (const [code, a] of ls) db.prepare('INSERT INTO ledger_lines (txn, code, amount) VALUES (?, ?, ?)').run(txn, code, a);
  const negSince = bal < 0 ? (w.neg_since || at) : null;
  db.prepare(`INSERT INTO wallets (owner, balance, credit_limit, credit_days, neg_since, test, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(owner) DO UPDATE SET balance = excluded.balance, neg_since = excluded.neg_since, updated_at = excluded.updated_at`)
    .run(owner, bal, w.credit_limit, w.credit_days, negSince, test ? 1 : (w.test || 0), at);
  return { txn, balance: bal, at };
}
function byIdem(db, idem) { return db.prepare('SELECT txn, amount, balance_after, created_at FROM ledger WHERE idem = ?').get(idem); }

// ---------- don hang (cn_orders trong khach.db) ----------
function orderLog(db, code, who, action, changes, extra) {
  db.prepare('INSERT INTO cn_log (code, username, action, detail) VALUES (?, ?, ?, ?)').run(code, who, action, JSON.stringify(Object.assign({ changes }, extra || {})));
}
function notify(db, username, code, text) { db.prepare('INSERT INTO notif (username, code, text) VALUES (?, ?, ?)').run(username, code, text); }
function setPaid(db, r, d, newPaid, txn) {
  d.paid = newPaid; d.unpaid = ['CANCELLED', 'RETURN'].includes(r.status) ? 0 : Math.max(0, (d.fee || 0) - newPaid);
  d.txns = (d.txns || []).concat([txn]);
  db.prepare("UPDATE cn_orders SET data = ?, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE seq = ?").run(JSON.stringify(d), r.seq);
}

// Khach thanh toan 1 hoac nhieu don. TAT CA HOAC KHONG.
// idem: ma phien do trinh duyet sinh 1 lan khi mo hop thanh toan.
function pay(db, owner, codes, idem, by, test) {
  codes = [...new Set((codes || []).map(String))].filter((c) => /^SCN\d{1,12}$/.test(c));
  if (!codes.length || codes.length > 100) return { code: 400, error: 'Chọn đơn cần thanh toán' };
  if (!/^[A-Za-z0-9-]{16,64}$/.test(String(idem || ''))) return { code: 400, error: 'Phiên thanh toán không hợp lệ, mở lại' };
  const key = 'PAY:' + owner + ':' + idem;
  return tx(db, () => {
    const old = byIdem(db, key);
    if (old) return { ok: true, replay: true, txn: old.txn, amount: -old.amount, balance: old.balance_after };
    const rows = []; let total = 0;
    for (const c of codes) {
      const r = db.prepare('SELECT * FROM cn_orders WHERE code = ? AND lower(gobiz) = ?').get(c, owner);
      if (!r) return { code: 404, error: 'Không tìm thấy đơn ' + c };
      if (['CANCELLED', 'RETURN'].includes(r.status)) return { code: 409, error: 'Đơn ' + c + ' đã huỷ / trả hàng' };
      const d = JSON.parse(r.data);
      if (d.fee == null) return { code: 409, error: 'Đơn ' + c + ' chưa có phí' };
      const need = Math.max(0, Math.round(d.fee) - Math.round(d.paid || 0));
      if (need <= 0) return { code: 409, error: 'Đơn ' + c + ' đã thanh toán đủ' };
      rows.push({ r, d, need }); total += need;
    }
    const w = walletView(db, owner);
    if (total > w.available) return { code: 409, error: 'Số dư không đủ. Cần ' + vnd(total) + ', có thể dùng ' + vnd(w.available) + ', còn thiếu ' + vnd(total - w.available) + '.', short: total - w.available };
    const p = post(db, { owner, kind: 'PAY', amount: -total, idem: key, note: 'Thanh toán ' + codes.join(', '), by, lines: rows.map((x) => ({ code: x.r.code, amount: x.need })), test });
    for (const x of rows) {
      const before = x.d.paid || 0;
      setPaid(db, x.r, x.d, before + x.need, p.txn);
      orderLog(db, x.r.code, by, 'Thanh toán (' + p.txn + ')', [['Đã thanh toán', vnd(before), vnd(before + x.need)]], { txn: p.txn, amount: x.need });
    }
    notify(db, rows[0].r.username, rows.length === 1 ? rows[0].r.code : null, 'Đã thanh toán ' + vnd(total) + ' cho ' + codes.join(', ') + '. Mã giao dịch ' + p.txn + '. Số dư còn ' + vnd(p.balance) + '.');
    return { ok: true, txn: p.txn, amount: total, balance: p.balance };
  });
}

// ---------- yeu cau can duyet: nap tay, dieu chinh, hoan tien ----------
// kind: TOPUP_MANUAL (+), ADJUST (+/-), REFUND (+, gan don; khong qua so da thu cua don)
function request(db, { kind, owner, amount, codes, note, by }) {
  if (!['TOPUP_MANUAL', 'ADJUST', 'REFUND'].includes(kind)) return { code: 400, error: 'Loại yêu cầu không hợp lệ' };
  amount = Math.round(Number(amount));
  if (!Number.isSafeInteger(amount) || amount === 0 || Math.abs(amount) > 1e11) return { code: 400, error: 'Số tiền không hợp lệ' };
  if (kind !== 'ADJUST' && amount < 0) return { code: 400, error: 'Số tiền phải dương' };
  note = String(note || '').trim().slice(0, 500); if (note.length < 5) return { code: 400, error: 'Ghi rõ lý do (ít nhất 5 ký tự)' };
  const cs = (codes || []).map(String).filter((c) => /^SCN\d{1,12}$/.test(c));
  if (kind === 'REFUND') {
    if (cs.length !== 1) return { code: 400, error: 'Hoàn tiền phải gắn đúng 1 đơn' };
    const r = db.prepare('SELECT data FROM cn_orders WHERE code = ? AND lower(gobiz) = ?').get(cs[0], owner);
    if (!r) return { code: 404, error: 'Đơn không thuộc khách này' };
  }
  const id = Number(db.prepare('INSERT INTO fin_requests (kind, owner, amount, codes, note, created_by) VALUES (?, ?, ?, ?, ?, ?)').run(kind, owner, amount, JSON.stringify(cs), note, by).lastInsertRowid);
  wlog(db, owner, by, 'Tạo yêu cầu ' + KIND[kind], { id, amount, codes: cs, note });
  return { ok: true, id };
}
function decide(db, id, approve, by, dnote, test) {
  return tx(db, () => {
    const q = db.prepare('SELECT * FROM fin_requests WHERE id = ?').get(Number(id));
    if (!q) return { code: 404, error: 'Không tìm thấy yêu cầu' };
    if (q.status !== 'pending') return { code: 409, error: 'Yêu cầu đã được xử lý trước đó (' + q.status + ')' };
    if (!approve) {
      db.prepare("UPDATE fin_requests SET status = 'rejected', decided_by = ?, decided_at = ?, decide_note = ? WHERE id = ? AND status = 'pending'").run(by, nowIso(), dnote || null, q.id);
      wlog(db, q.owner, by, 'Từ chối yêu cầu #' + q.id, { note: dnote }); return { ok: true };
    }
    const codes = JSON.parse(q.codes || '[]'); let lines = [];
    if (q.amount < 0) { const w = walletView(db, q.owner); if (q.amount + w.available < 0) return { code: 409, error: 'Trừ ' + vnd(-q.amount) + ' sẽ làm ví âm quá hạn mức tín dụng' }; }
    if (q.kind === 'REFUND') { // kiem tra lai LUC DUYET
      const r = db.prepare('SELECT * FROM cn_orders WHERE code = ?').get(codes[0]); const d = JSON.parse(r.data);
      const paid = Math.round(d.paid || 0);
      if (q.amount > paid) return { code: 409, error: 'Đơn ' + codes[0] + ' mới thu ' + vnd(paid) + ', không hoàn ' + vnd(q.amount) + ' được' };
      lines = [{ code: codes[0], amount: -q.amount }];
    }
    const p = post(db, { owner: q.owner, kind: q.kind, amount: q.amount, idem: 'REQ:' + q.id, note: q.note, by: q.created_by + ' / duyệt: ' + by, lines, test });
    db.prepare("UPDATE fin_requests SET status = 'approved', decided_by = ?, decided_at = ?, decide_note = ?, txn = ? WHERE id = ? AND status = 'pending'").run(by, nowIso(), dnote || null, p.txn, q.id);
    if (q.kind === 'REFUND') {
      const r = db.prepare('SELECT * FROM cn_orders WHERE code = ?').get(codes[0]); const d = JSON.parse(r.data); const before = d.paid || 0;
      setPaid(db, r, d, before - q.amount, p.txn);
      d.refund = (d.refund || 0) + q.amount; db.prepare('UPDATE cn_orders SET data = ? WHERE seq = ?').run(JSON.stringify(d), r.seq);
      orderLog(db, r.code, by, 'Hoàn tiền về ví (' + p.txn + ')', [['Đã thanh toán', vnd(before), vnd(before - q.amount)]], { txn: p.txn, amount: q.amount, request: q.id });
      notify(db, r.username, r.code, 'Đơn ' + r.code + ' được hoàn ' + vnd(q.amount) + ' về ví. Mã giao dịch ' + p.txn + '.');
    } else {
      const u = db.prepare('SELECT username FROM cn_orders WHERE lower(gobiz) = ? ORDER BY seq DESC LIMIT 1').get(q.owner);
      if (u) notify(db, u.username, null, (q.amount > 0 ? 'Ví được cộng ' : 'Ví bị trừ ') + vnd(Math.abs(q.amount)) + ' (' + KIND[q.kind] + '). Mã giao dịch ' + p.txn + '.');
    }
    wlog(db, q.owner, by, 'Duyệt yêu cầu #' + q.id, { txn: p.txn });
    return { ok: true, txn: p.txn, balance: p.balance };
  });
}
function requests(db, status) { return db.prepare('SELECT * FROM fin_requests' + (status ? ' WHERE status = ?' : '') + ' ORDER BY id DESC LIMIT 300').all(...(status ? [status] : [])).map((q) => Object.assign(q, { codes: JSON.parse(q.codes || '[]'), kindLabel: KIND[q.kind] })); }

// ---------- han muc tin dung (chi admin) ----------
function setCredit(db, owner, limit, days, by) {
  limit = Math.round(Number(limit)); days = Math.round(Number(days));
  if (!(limit >= 0 && limit <= 1e11)) return { code: 400, error: 'Hạn mức không hợp lệ' };
  if (!(days >= 15 && days <= 30)) return { code: 400, error: 'Thời hạn âm phải từ 15 đến 30 ngày' };
  return tx(db, () => {
    const w = walletRow(db, owner);
    db.prepare(`INSERT INTO wallets (owner, balance, credit_limit, credit_days, updated_at) VALUES (?, 0, ?, ?, ?)
      ON CONFLICT(owner) DO UPDATE SET credit_limit = excluded.credit_limit, credit_days = excluded.credit_days, updated_at = excluded.updated_at`).run(owner, limit, days, nowIso());
    wlog(db, owner, by, 'Đổi hạn mức tín dụng', { changes: [['Hạn mức', vnd(w.credit_limit), vnd(limit)], ['Thời hạn', w.credit_days + ' ngày', days + ' ngày']] });
    return { ok: true };
  });
}

// ---------- ma PIN 6 so ----------
function hashPin(pin, salt) { return crypto.scryptSync(pin, salt, 32, { N: 16384 }).toString('hex'); }
function setPin(db, owner, pin, by) {
  if (!/^\d{6}$/.test(String(pin))) return { code: 400, error: 'Mã PIN phải gồm 6 số' };
  if (/^(\d)\1{5}$/.test(pin) || ['123456', '654321', '012345', '234567', '345678', '456789', '987654'].includes(pin)) return { code: 400, error: 'Mã PIN quá dễ đoán, chọn mã khác' };
  const salt = crypto.randomBytes(16).toString('hex');
  db.prepare('INSERT INTO pins (owner, hash, fails, locked_until, set_at, set_by) VALUES (?, ?, 0, NULL, ?, ?) ON CONFLICT(owner) DO UPDATE SET hash = excluded.hash, fails = 0, locked_until = NULL, set_at = excluded.set_at, set_by = excluded.set_by')
    .run(owner, salt + ':' + hashPin(pin, salt), nowIso(), by);
  wlog(db, owner, by, 'Đặt / đổi mã PIN', {});
  return { ok: true };
}
function hasPin(db, owner) { return !!db.prepare('SELECT 1 FROM pins WHERE owner = ?').get(owner); }
function checkPin(db, owner, pin) {
  const p = db.prepare('SELECT * FROM pins WHERE owner = ?').get(owner);
  if (!p) return { code: 409, error: 'Chưa đặt mã PIN thanh toán' };
  if (p.locked_until && Date.parse(p.locked_until) > Date.now()) return { code: 429, error: 'Nhập sai PIN quá nhiều lần. Thử lại sau ' + Math.ceil((Date.parse(p.locked_until) - Date.now()) / 60000) + ' phút.' };
  const [salt, h] = p.hash.split(':');
  const ok = /^\d{6}$/.test(String(pin)) && crypto.timingSafeEqual(Buffer.from(hashPin(String(pin), salt), 'hex'), Buffer.from(h, 'hex'));
  if (ok) { db.prepare('UPDATE pins SET fails = 0, locked_until = NULL WHERE owner = ?').run(owner); return { ok: true }; }
  const fails = p.fails + 1; const lock = fails >= 5 ? new Date(Date.now() + 30 * 60e3).toISOString() : null;
  db.prepare('UPDATE pins SET fails = ?, locked_until = ? WHERE owner = ?').run(lock ? 0 : fails, lock, owner);
  wlog(db, owner, 'he-thong', 'Nhập sai PIN', { fails, locked: !!lock });
  return { code: lock ? 429 : 401, error: lock ? 'Sai PIN 5 lần, khoá thanh toán 30 phút' : 'Sai mã PIN (còn ' + (5 - fails) + ' lần)' };
}

// ---------- nap tien tu ngan hang (SePay -> Lark Base quy B1 -> n8n ky -> day) ----------
// Quy tac (decisions/vi-nap-rut-chung-tu.md):
// - Noi dung co DUNG 1 ma khach hop le (co so kiem tra, co trong he thong) va khong co username Gobiz -> cong vi.
// - Co ma khach + co username Gobiz -> hang cho (tranh Gobiz va web moi cung cong).
// - Khong co ma khach -> bo qua (tien cua Gobiz). Duoi 10.000d -> hang cho.
// - Vi moi chua mo cho khach that -> hang cho (khong cong).
// - Moi khoan chi xu ly 1 lan (ref UNIQUE); cong vi dung idem DEP:<ref>.
function findCodes(db, content) {
  const c = normCode(content); const found = new Set();
  for (let i = 0; i + 7 <= c.length; i++) { const w = c.slice(i, i + 7); if (validCode(w) && db.prepare('SELECT 1 FROM cust_codes WHERE code = ?').get(w)) found.add(w); }
  return [...found];
}
function gobizHit(content, code, gobizSet) {
  const low = String(content || '').toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/đ/g, 'd');
  const toks = low.split(/[^a-z0-9_]+/).filter((t) => t && !normCode(t).includes(code));
  for (const t of toks) if (gobizSet.has(t)) return t;
  const joined = toks.join(''); if (gobizSet.has(joined)) return joined;
  return null;
}
function deposit(db, item, gobizSet, isLive) {
  const ref = String(item.ref || '').slice(0, 120); const amount = Math.round(Number(item.amount));
  if (!ref || !Number.isSafeInteger(amount) || amount <= 0) return { ref, status: 'invalid' };
  return tx(db, () => {
    const old = db.prepare('SELECT status, txn FROM deposits WHERE ref = ?').get(ref);
    if (old) return { ref, status: old.status, txn: old.txn, dup: true };
    const content = String(item.content || '').slice(0, 500);
    const codes = findCodes(db, content);
    let status = 'ignored', owner = null, code = null, reason = 'Không có mã khách (tiền Gobiz)', txn = null;
    if (!codes.length) { // tu dung 7 ky tu giong ma khach nhung sai so kiem tra -> co the khach go nham, treo de nguoi xem
      const near = String(content).toUpperCase().split(/[^0-9A-Z]+/).find((t) => /^[2-9][23456789ABCDEFGHJKMNPQRSTUVWXYZ]{5}[0-9]$/.test(t) && /[A-Z]/.test(t.slice(1, 6)));
      if (near) { status = 'hold'; reason = 'Có "' + near + '" giống mã khách nhưng sai — có thể khách gõ nhầm'; }
    }
    if (codes.length > 1) { status = 'hold'; reason = 'Nội dung có nhiều mã khách: ' + codes.join(', '); }
    else if (codes.length === 1) {
      code = codes[0]; owner = db.prepare('SELECT owner FROM cust_codes WHERE code = ?').get(code).owner;
      const g = gobizHit(content, code, gobizSet);
      if (g) { status = 'hold'; reason = 'Nội dung có cả mã khách và username Gobiz "' + g + '" — kiểm tra Gobiz đã nạp chưa'; }
      else if (amount < 10000) { status = 'hold'; reason = 'Dưới mức nạp tối thiểu 10.000đ'; }
      else if (!isLive(owner)) { status = 'hold'; reason = 'Ví mới chưa mở cho khách này'; }
      else {
        const p = post(db, { owner, kind: 'TOPUP', amount, idem: 'DEP:' + ref, note: 'Chuyển khoản ' + (item.bankRef || '') + ': ' + content.slice(0, 120), by: 'ngan-hang:' + (item.src || 'b1'), test: isLive(owner) === 'test' });
        status = 'credited'; reason = null; txn = p.txn;
        const u = db.prepare('SELECT username FROM users WHERE lower(gobiz) = ? LIMIT 1').get(owner);
        if (u) notify(db, u.username, null, 'Đã nhận ' + vnd(amount) + ' vào ví. Mã giao dịch ' + p.txn + '. Số dư ' + vnd(p.balance) + '.');
      }
    }
    db.prepare('INSERT INTO deposits (ref, src, bank_ref, rec, amount, content, at, status, owner, code, reason, txn) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
      .run(ref, String(item.src || 'b1'), String(item.bankRef || ''), String(item.rec || ''), amount, content, String(item.at || ''), status, owner, code, reason, txn);
    return { ref, status, txn, reason };
  });
}
function deposits(db, status) { return db.prepare('SELECT * FROM deposits' + (status ? ' WHERE status = ?' : " WHERE status <> 'ignored'") + ' ORDER BY created_at DESC LIMIT 300').all(...(status ? [status] : [])); }
// Xu ly khoan treo: gan cho khach (tao yeu cau nap tay cho anh duyet) hoac bo qua (tien Gobiz)
function resolveDeposit(db, ref, action, owner, by, note) {
  return tx(db, () => {
    const d = db.prepare('SELECT * FROM deposits WHERE ref = ?').get(ref);
    if (!d) return { code: 404, error: 'Không có khoản này' };
    if (d.status !== 'hold') return { code: 409, error: 'Khoản này đã xử lý (' + d.status + ')' };
    if (action === 'ignore') {
      db.prepare("UPDATE deposits SET status = 'ignored_manual', decided_by = ?, decided_at = ?, reason = reason || ' | ' || ? WHERE ref = ? AND status = 'hold'").run(by, nowIso(), note || 'bỏ qua', ref);
      return { ok: true };
    }
    const o = String(owner || d.owner || '').toLowerCase(); if (!o) return { code: 400, error: 'Chọn khách' };
    const r = request(db, { kind: 'TOPUP_MANUAL', owner: o, amount: d.amount, note: 'Gán khoản chuyển khoản ' + (d.bank_ref || d.ref) + ' (' + d.content.slice(0, 80) + ')' + (note ? ' — ' + note : ''), by });
    if (r.error) return r;
    db.prepare("UPDATE deposits SET status = 'assigned', owner = ?, req_id = ?, decided_by = ?, decided_at = ? WHERE ref = ? AND status = 'hold'").run(o, r.id, by, nowIso(), ref);
    return { ok: true, requestId: r.id };
  });
}

// ---------- tra cuu ----------
function txnsOf(db, owner, limit) {
  return db.prepare('SELECT txn, kind, amount, balance_after, note, by, created_at FROM ledger WHERE owner = ? ORDER BY id DESC LIMIT ?').all(owner, limit || 100)
    .map((t) => Object.assign(t, { kindLabel: KIND[t.kind] || t.kind, lines: db.prepare('SELECT code, amount FROM ledger_lines WHERE txn = ?').all(t.txn) }));
}
function txnsOfOrder(db, code) {
  return db.prepare('SELECT l.txn, l.kind, l.amount AS total, x.amount, l.by, l.created_at FROM ledger_lines x JOIN ledger l ON l.txn = x.txn WHERE x.code = ? ORDER BY l.id').all(code)
    .map((t) => Object.assign(t, { kindLabel: KIND[t.kind] || t.kind }));
}
function codeOf(db, owner, gobizNames) {
  const r = db.prepare('SELECT code FROM cust_codes WHERE owner = ?').get(owner); if (r) return r.code;
  const code = genCode((c) => !!db.prepare('SELECT 1 FROM cust_codes WHERE code = ?').get(c), (gobizNames || []).map((x) => String(x).toLowerCase()));
  db.prepare('INSERT OR IGNORE INTO cust_codes (owner, code) VALUES (?, ?)').run(owner, code);
  return db.prepare('SELECT code FROM cust_codes WHERE owner = ?').get(owner).code;
}
// Doi soat: chuoi bam con nguyen + so du tung vi = tong so cai
function verify(db) {
  const errs = []; let prev = 'GENESIS';
  for (const t of db.prepare('SELECT * FROM ledger ORDER BY id').all()) {
    const ls = db.prepare('SELECT code, amount FROM ledger_lines WHERE txn = ? ORDER BY rowid').all(t.txn).map((l) => [l.code, l.amount]);
    const h = sha([prev, t.txn, t.idem, t.owner, t.kind, t.amount, t.balance_after, t.note || '', t.by, t.created_at, JSON.stringify(ls)].join('|'));
    if (t.prev_hash !== prev || t.hash !== h) errs.push('Chuỗi bị sửa tại ' + t.txn);
    prev = t.hash;
  }
  for (const w of db.prepare('SELECT w.owner, w.balance, COALESCE((SELECT SUM(amount) FROM ledger l WHERE l.owner = w.owner),0) AS s FROM wallets w').all())
    if (w.balance !== w.s) errs.push('Ví ' + w.owner + ': số dư ' + w.balance + ' ≠ tổng sổ ' + w.s);
  return { ok: !errs.length, errs, at: nowIso() };
}

module.exports = { deposit, deposits, resolveDeposit, findCodes, init, validCode, normCode, genCode, codeOf, walletView, pay, request, decide, requests, setCredit, setPin, hasPin, checkPin, txnsOf, txnsOfOrder, verify, KIND };
