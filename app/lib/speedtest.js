'use strict';
// Trang do toc do VPS tu xa (vd. tu Trung Quoc): https://saas.7zone.net/speedtest
// Khong can dang nhap. Chi do mang, khong cham du lieu don/khach.
// - GET  /speedtest              trang do
// - GET  /speedtest/ping         phan hoi rong (do do tre)
// - GET  /speedtest/dl?mb=1..8   tai xuong byte ngau nhien (khong nen duoc)
// - POST /speedtest/ul           tai len (bo di, chi do thoi gian)
// - POST /speedtest/scan         nhan ma vua quet (do khu hoi quet -> may chu)
// - POST /speedtest/result       luu ket qua 1 lan do
// - GET  /speedtest/ket-qua.json 100 lan do gan nhat (IP da che bot)
// Tu don: giu toi da 2000 lan do va 90 ngay. Go bo: xoa file nay + speedtest.html + 1 dong trong server.js, DROP TABLE speedtest.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { DatabaseSync } = require('node:sqlite');

const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, '..', 'data');
const PAGE = path.join(__dirname, '..', 'speedtest.html');
let db, blob, pageBuf;
const hits = new Map(); // gioi han tai xuong/tai len theo IP

function init() {
  db = new DatabaseSync(path.join(DATA_DIR, 'vmt.db'));
  db.exec(`PRAGMA busy_timeout = 5000;
    CREATE TABLE IF NOT EXISTS speedtest (id INTEGER PRIMARY KEY AUTOINCREMENT, ts TEXT DEFAULT (datetime('now', '+7 hours')), ip TEXT, data TEXT NOT NULL);`);
  setInterval(prune, 6 * 3600e3).unref();
  setInterval(() => { const n = Date.now(); for (const [k, a] of hits) if (!a.some((t) => n - t < 10 * 60e3)) hits.delete(k); }, 10 * 60e3).unref();
}
function prune() {
  db.prepare("DELETE FROM speedtest WHERE ts < datetime('now', '+7 hours', '-90 days')").run();
  db.prepare('DELETE FROM speedtest WHERE id NOT IN (SELECT id FROM speedtest ORDER BY id DESC LIMIT 2000)').run();
}
// 8MB ngau nhien, tao 1 lan khi co nguoi do lan dau
const getBlob = () => blob || (blob = crypto.randomBytes(8 * 1024 * 1024));
function limited(ip, max) {
  const n = Date.now(); const a = (hits.get(ip) || []).filter((t) => n - t < 10 * 60e3);
  a.push(n); hits.set(ip, a); return a.length > max;
}
const mask = (ip) => String(ip || '').replace(/^(\d+\.\d+)\.\d+\.\d+$/, '$1.x.x').replace(/^([0-9a-f]+:[0-9a-f]+):.*$/i, '$1:…');
function drain(req, limit) {
  return new Promise((resolve) => {
    let n = 0; const chunks = [];
    req.on('data', (c) => { n += c.length; if (n > limit) req.destroy(); else if (limit < 100000) chunks.push(c); });
    req.on('end', () => resolve({ n, body: Buffer.concat(chunks) })); req.on('error', () => resolve({ n, body: Buffer.alloc(0) }));
  });
}

// Tra ve true neu da xu ly
async function handle(req, res, p, url, ip) {
  if (p !== '/speedtest' && !p.startsWith('/speedtest/')) return false;
  const nc = { 'Cache-Control': 'no-store' };
  const out = (code, type, body) => { res.writeHead(code, Object.assign({ 'Content-Type': type }, nc)); res.end(body); };
  const j = (code, obj) => out(code, 'application/json; charset=utf-8', JSON.stringify(obj));

  if (p === '/speedtest' || p === '/speedtest/') {
    if (!pageBuf) pageBuf = fs.readFileSync(PAGE);
    return out(200, 'text/html; charset=utf-8', pageBuf), true;
  }
  if (p === '/speedtest/ping') return out(200, 'text/plain', 'ok'), true;
  if (p === '/speedtest/dl') {
    if (limited(ip, 40)) return j(429, { error: 'Đo nhiều quá, đợi 10 phút' }), true;
    const mb = Math.max(1, Math.min(8, parseInt(url.searchParams.get('mb'), 10) || 1));
    res.writeHead(200, Object.assign({ 'Content-Type': 'application/octet-stream', 'Content-Length': mb * 1048576 }, nc));
    return res.end(getBlob().subarray(0, mb * 1048576)), true;
  }
  if (req.method !== 'POST' && p !== '/speedtest/ket-qua.json') return out(405, 'text/plain', ''), true;
  if (p === '/speedtest/ul') {
    if (limited(ip, 40)) return j(429, { error: 'Đo nhiều quá, đợi 10 phút' }), true;
    const r = await drain(req, 9 * 1048576);
    return j(200, { n: r.n }), true;
  }
  if (p === '/speedtest/scan') { const r = await drain(req, 2000); return j(200, { ok: true, len: r.body.length, at: Date.now() }), true; }
  if (p === '/speedtest/result') {
    if (limited(ip, 40)) return j(429, { error: 'Đo nhiều quá' }), true;
    const r = await drain(req, 20000);
    let d; try { d = JSON.parse(r.body.toString()); } catch { return j(400, { error: 'Dữ liệu không hợp lệ' }), true; }
    if (!d || typeof d !== 'object') return j(400, { error: 'Dữ liệu không hợp lệ' }), true;
    d.ua = String(req.headers['user-agent'] || '').slice(0, 200);
    const id = Number(db.prepare('INSERT INTO speedtest (ip, data) VALUES (?, ?)').run(ip, JSON.stringify(d).slice(0, 20000)).lastInsertRowid);
    return j(200, { ok: true, id }), true;
  }
  if (p === '/speedtest/ket-qua.json') {
    const rows = db.prepare('SELECT id, ts, ip, data FROM speedtest ORDER BY id DESC LIMIT 100').all()
      .map((x) => { let d = {}; try { d = JSON.parse(x.data); } catch (e) {} return Object.assign({ id: x.id, ts: x.ts, ip: mask(x.ip) }, d); });
    return j(200, { items: rows }), true;
  }
  return out(404, 'text/plain', 'Not found'), true;
}

module.exports = { init, handle };
