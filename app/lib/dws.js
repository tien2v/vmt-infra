'use strict';
// Cong nhan du lieu MAY DO tu dong o kho TQ (can, kich thuoc, anh, chu tren bill).
// Giai doan 1 (31/10/2026): chi LUU NGUYEN du lieu may gui (chay song song voi Gobiz), chua xu ly.
// - Dia chi: POST https://saas.7zone.net/hook/dws/<ma bi mat>  (ma sinh 1 lan, luu trong kv 'dws_token')
// - Moi lan goi: luu body (gzip) vao /data/dws/YYYYMMDD/<id>.gz + 1 dong chi muc trong /data/dws.db
// - Tu xoa du lieu tho cu hon 30 ngay
// - Admin xem: GET /api/dws/info (dia chi + thong ke), /api/dws/recent, /api/dws/raw?id=
const fs = require('node:fs');
const path = require('node:path');
const zlib = require('node:zlib');
const crypto = require('node:crypto');
const { DatabaseSync } = require('node:sqlite');

const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, '..', 'data');
const RAW_DIR = path.join(DATA_DIR, 'dws');
const KEEP_DAYS = 30;
let db, store;

function init(st) {
  store = st;
  fs.mkdirSync(RAW_DIR, { recursive: true });
  db = new DatabaseSync(path.join(DATA_DIR, 'dws.db'));
  db.exec(`
    PRAGMA journal_mode = WAL;
    CREATE TABLE IF NOT EXISTS dws_raw (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      ts TEXT DEFAULT (datetime('now')), ip TEXT, method TEXT, ctype TEXT, bytes INTEGER,
      file TEXT, query TEXT, headers TEXT, preview TEXT, tracking TEXT
    );
    CREATE INDEX IF NOT EXISTS dws_raw_tracking ON dws_raw(tracking);
  `);
  setInterval(prune, 6 * 3600e3).unref();
  setTimeout(prune, 60e3).unref();
}

function token() {
  let t = store.kvGet('dws_token');
  if (!t) { t = crypto.randomBytes(18).toString('base64url'); store.kvSet('dws_token', t); }
  return t;
}
function checkToken(t) {
  const good = token();
  return typeof t === 'string' && t.length === good.length && crypto.timingSafeEqual(Buffer.from(t), Buffer.from(good));
}

// Doan ma van don trong du lieu (de tim nhanh sau nay). Khong chac dung, chi de tra cuu.
function guessTracking(text) {
  try {
    const o = JSON.parse(text);
    const keys = ['waybill', 'waybillNo', 'waybill_no', 'trackingNo', 'tracking_no', 'tracking', 'barcode', 'barCode', 'code', 'mailNo', 'billNo', 'bill_no', 'expressNo', 'express_no', 'logisticsNo', 'packageNo'];
    const stack = [o]; let n = 0;
    while (stack.length && n++ < 500) {
      const x = stack.shift();
      if (x && typeof x === 'object') {
        for (const k of Object.keys(x)) {
          const v = x[k];
          if (keys.some((kk) => kk.toLowerCase() === k.toLowerCase()) && (typeof v === 'string' || typeof v === 'number') && String(v).length >= 6 && String(v).length <= 40) return String(v);
          if (v && typeof v === 'object') stack.push(v);
        }
      }
    }
  } catch {}
  const m = String(text).match(/\b[A-Z]{0,4}\d{9,20}\b/);
  return m ? m[0] : null;
}

// Lay cac truong chu (khong phai file) trong multipart -> JSON de xem / doan ma; file chi ghi ten + kich thuoc.
function multipartFields(body, ctype) {
  const m = ctype.match(/boundary=(?:"([^"]+)"|([^;]+))/i); if (!m) return '';
  const sep = Buffer.from('--' + (m[1] || m[2]).trim());
  const out = {}; let i = body.indexOf(sep);
  while (i !== -1) {
    const next = body.indexOf(sep, i + sep.length); if (next === -1) break;
    const part = body.subarray(i + sep.length, next);
    const h = part.indexOf('\r\n\r\n');
    if (h !== -1) {
      const head = part.subarray(0, h).toString('utf8');
      const name = (head.match(/name="([^"]*)"/) || [])[1] || '?';
      const fn = (head.match(/filename="([^"]*)"/) || [])[1];
      const val = part.subarray(h + 4, part.length - 2);
      out[name] = fn !== undefined ? '[file ' + fn + ', ' + val.length + ' byte]' : val.toString('utf8').slice(0, 2000);
    }
    i = next;
  }
  return JSON.stringify(out);
}

function save(req, body, query, ip) {
  const day = new Date().toISOString().slice(0, 10).replace(/-/g, '');
  const dir = path.join(RAW_DIR, day);
  fs.mkdirSync(dir, { recursive: true });
  const ctype = String(req.headers['content-type'] || '');
  const isText = /json|text|xml|x-www-form-urlencoded/i.test(ctype) || (!ctype && body.length && body[0] < 128);
  let text = isText ? body.toString('utf8') : '';
  if (!text && /multipart\/form-data/i.test(ctype)) text = multipartFields(body, ctype);
  const hdr = {};
  for (const k of Object.keys(req.headers)) if (!/cookie|authorization/i.test(k)) hdr[k] = String(req.headers[k]).slice(0, 300);
  const r = db.prepare('INSERT INTO dws_raw (ip, method, ctype, bytes, query, headers, preview, tracking) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
    .run(ip, req.method, ctype.slice(0, 200), body.length, query.slice(0, 2000), JSON.stringify(hdr), text.slice(0, 3000), guessTracking(text || query));
  const id = Number(r.lastInsertRowid);
  const file = path.join(day, id + '.gz');
  fs.writeFileSync(path.join(RAW_DIR, file), zlib.gzipSync(body));
  db.prepare('UPDATE dws_raw SET file = ? WHERE id = ?').run(file, id);
  return id;
}

function prune() {
  try {
    const cut = new Date(Date.now() - KEEP_DAYS * 86400e3).toISOString().slice(0, 10).replace(/-/g, '');
    for (const d of fs.readdirSync(RAW_DIR)) if (/^\d{8}$/.test(d) && d < cut) fs.rmSync(path.join(RAW_DIR, d), { recursive: true, force: true });
    db.prepare("DELETE FROM dws_raw WHERE ts < datetime('now', ?)").run('-' + KEEP_DAYS + ' days');
  } catch (e) { console.error('dws prune', e.message); }
}

function info(host) {
  const c = db.prepare("SELECT COUNT(*) n, MAX(ts) last, SUM(CASE WHEN ts > datetime('now','-1 day') THEN 1 ELSE 0 END) day FROM dws_raw").get();
  return { url: 'https://' + host + '/hook/dws/' + token(), method: 'POST (JSON / form / multipart đều nhận)', total: c.n, last24h: c.day || 0, last: c.last, keepDays: KEEP_DAYS };
}
function recent(limit, q) {
  if (q) return db.prepare('SELECT id, ts, ip, method, ctype, bytes, tracking, query, substr(preview,1,800) preview FROM dws_raw WHERE tracking = ? OR preview LIKE ? ORDER BY id DESC LIMIT ?').all(q, '%' + q + '%', limit);
  return db.prepare('SELECT id, ts, ip, method, ctype, bytes, tracking, query, substr(preview,1,800) preview FROM dws_raw ORDER BY id DESC LIMIT ?').all(limit);
}
function raw(id) {
  const r = db.prepare('SELECT * FROM dws_raw WHERE id = ?').get(id);
  if (!r || !r.file) return null;
  let body = null; try { body = zlib.gunzipSync(fs.readFileSync(path.join(RAW_DIR, r.file))); } catch {}
  return { row: r, body };
}

module.exports = { init, checkToken, save, info, recent, raw, guessTracking };
