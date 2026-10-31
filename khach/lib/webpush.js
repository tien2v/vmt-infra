'use strict';
// Thong bao day (Web Push) cho trang khach — tu viet, khong thu vien ngoai.
// Chuan: RFC 8291 (ma hoa aes128gcm) + RFC 8292 (VAPID). Apple (web.push.apple.com) va Google (fcm) deu dung chuan nay.
// - Khoa VAPID sinh 1 lan, luu trong khach.db (bang kv).
// - Moi khach toi da 10 thiet bi; thiet bi bao 404/410 (go app, tat quyen) -> xoa; loi 5 lan lien tiep -> xoa.
// - Thong bao trong chuong (bang notif, do ca admin lan trang khach ghi) duoc day len dien thoai: quet bang moi 20 giay.

const crypto = require('node:crypto');
const https = require('node:https');

const b64u = (b) => Buffer.from(b).toString('base64url');
const fromB64u = (s) => Buffer.from(String(s), 'base64url');
const hmac = (key, data) => crypto.createHmac('sha256', key).update(data).digest();

let db = null;
let VAPID = null; // { pub: Buffer(65), key: KeyObject }
const SUBJECT = 'https://app.vominhthien.com';
const MAX_SUBS = 10;

function init(database) {
  db = database;
  db.exec(`CREATE TABLE IF NOT EXISTS push_subs (
    id INTEGER PRIMARY KEY AUTOINCREMENT, username TEXT NOT NULL, endpoint TEXT NOT NULL UNIQUE, p256dh TEXT NOT NULL, auth TEXT NOT NULL,
    host TEXT, ua TEXT, fails INTEGER NOT NULL DEFAULT 0, created_at TEXT DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')), last_ok TEXT)`);
  db.exec('CREATE INDEX IF NOT EXISTS push_subs_user ON push_subs (username)');
  let row = db.prepare("SELECT v FROM kv WHERE k = 'vapid'").get();
  if (!row) {
    const { privateKey } = crypto.generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
    const jwk = privateKey.export({ format: 'jwk' });
    db.prepare("INSERT INTO kv (k, v) VALUES ('vapid', ?)").run(JSON.stringify(jwk));
    row = { v: JSON.stringify(jwk) };
  }
  const jwk = JSON.parse(row.v);
  VAPID = { key: crypto.createPrivateKey({ key: jwk, format: 'jwk' }), pub: Buffer.concat([Buffer.from([4]), fromB64u(jwk.x), fromB64u(jwk.y)]) };
  // Lan dau chay: bat dau tu thong bao moi nhat, khong day lai thong bao cu
  if (!db.prepare("SELECT 1 FROM kv WHERE k = 'push_cursor'").get()) {
    const m = db.prepare('SELECT MAX(id) AS m FROM notif').get();
    db.prepare("INSERT INTO kv (k, v) VALUES ('push_cursor', ?)").run(String((m && m.m) || 0));
  }
}
const publicKey = () => b64u(VAPID.pub);

// ---- ma hoa noi dung (RFC 8291) ----
function encrypt(payload, p256dh, authSecret, opts = {}) {
  const uaPub = fromB64u(p256dh);
  const auth = fromB64u(authSecret);
  if (uaPub.length !== 65 || auth.length !== 16) throw new Error('khoa thiet bi khong hop le');
  const ecdh = crypto.createECDH('prime256v1');
  if (opts.asPrivate) ecdh.setPrivateKey(opts.asPrivate); else ecdh.generateKeys();
  const asPub = ecdh.getPublicKey();
  const shared = ecdh.computeSecret(uaPub);
  const salt = opts.salt || crypto.randomBytes(16);
  const prkKey = hmac(auth, shared);
  const ikm = hmac(prkKey, Buffer.concat([Buffer.from('WebPush: info\0'), uaPub, asPub, Buffer.from([1])]));
  const prk = hmac(salt, ikm);
  const cek = hmac(prk, Buffer.from('Content-Encoding: aes128gcm\0\x01')).subarray(0, 16);
  const nonce = hmac(prk, Buffer.from('Content-Encoding: nonce\0\x01')).subarray(0, 12);
  const c = crypto.createCipheriv('aes-128-gcm', cek, nonce);
  const body = Buffer.concat([c.update(Buffer.concat([Buffer.from(payload), Buffer.from([2])])), c.final(), c.getAuthTag()]);
  const head = Buffer.alloc(21); salt.copy(head, 0); head.writeUInt32BE(4096, 16); head[20] = 65;
  return Buffer.concat([head, asPub, body]);
}

// ---- chu ky VAPID (RFC 8292) ----
function vapidHeader(endpoint) {
  const aud = new URL(endpoint).origin;
  const h = b64u(JSON.stringify({ typ: 'JWT', alg: 'ES256' }));
  const p = b64u(JSON.stringify({ aud, exp: Math.floor(Date.now() / 1000) + 12 * 3600, sub: SUBJECT }));
  const sig = crypto.sign('sha256', Buffer.from(h + '.' + p), { key: VAPID.key, dsaEncoding: 'ieee-p1363' });
  return 'vapid t=' + h + '.' + p + '.' + b64u(sig) + ', k=' + publicKey();
}

function post(sub, body, ttl, urgency, topic) {
  return new Promise((ok) => {
    let u; try { u = new URL(sub.endpoint); } catch { return ok(0); }
    const headers = { 'Content-Type': 'application/octet-stream', 'Content-Encoding': 'aes128gcm', 'Content-Length': body.length, TTL: String(ttl), Urgency: urgency, Authorization: vapidHeader(sub.endpoint) };
    if (topic) headers.Topic = topic; // cung topic -> dich vu day thay the ban cu dang cho
    const req = https.request(u, { method: 'POST', headers, timeout: 10000 }, (res) => { res.resume(); ok(res.statusCode); });
    req.on('timeout', () => req.destroy());
    req.on('error', () => ok(0));
    req.end(body);
  });
}

// Gui 1 thong bao toi moi thiet bi cua khach. msg = { title, body, url, tag }
async function send(username, msg) {
  const subs = db.prepare('SELECT * FROM push_subs WHERE username = ?').all(username);
  let sent = 0; const codes = [];
  for (const s of subs) {
    let body; try { body = encrypt(JSON.stringify(msg), s.p256dh, s.auth); } catch { db.prepare('DELETE FROM push_subs WHERE id = ?').run(s.id); continue; }
    const topic = msg.tag ? crypto.createHash('sha256').update(msg.tag).digest('base64url').slice(0, 32) : null;
    const code = await post(s, body, 24 * 3600, 'high', topic); codes.push(code);
    if (code >= 200 && code < 300) { sent++; db.prepare("UPDATE push_subs SET fails = 0, last_ok = strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id = ?").run(s.id); }
    else if (code === 404 || code === 410) db.prepare('DELETE FROM push_subs WHERE id = ?').run(s.id);
    else { db.prepare('UPDATE push_subs SET fails = fails + 1 WHERE id = ?').run(s.id); db.prepare('DELETE FROM push_subs WHERE id = ? AND fails >= 5').run(s.id); }
  }
  return { sent, codes };
}

function subscribe(username, sub, host, ua) {
  const ep = String((sub && sub.endpoint) || '');
  const k = (sub && sub.keys) || {};
  if (!/^https:\/\//.test(ep) || ep.length > 1000) return { error: 'Thiết bị không hợp lệ' };
  if (fromB64u(k.p256dh || '').length !== 65 || fromB64u(k.auth || '').length !== 16) return { error: 'Thiết bị không hợp lệ' };
  db.prepare(`INSERT INTO push_subs (username, endpoint, p256dh, auth, host, ua) VALUES (?, ?, ?, ?, ?, ?)
    ON CONFLICT(endpoint) DO UPDATE SET username = excluded.username, p256dh = excluded.p256dh, auth = excluded.auth, host = excluded.host, ua = excluded.ua, fails = 0`)
    .run(username, ep, k.p256dh, k.auth, String(host || '').slice(0, 100), String(ua || '').slice(0, 300));
  // Giu toi da 10 thiet bi moi nhat / khach
  db.prepare(`DELETE FROM push_subs WHERE username = ? AND id NOT IN (SELECT id FROM push_subs WHERE username = ? ORDER BY id DESC LIMIT ${MAX_SUBS})`).run(username, username);
  return { ok: true };
}
function unsubscribe(username, endpoint) { db.prepare('DELETE FROM push_subs WHERE username = ? AND endpoint = ?').run(username, String(endpoint || '')); }
const hasSub = (username) => !!db.prepare('SELECT 1 FROM push_subs WHERE username = ? LIMIT 1').get(username);

// ---- day thong bao chuong len dien thoai ----
// urlOf(code) -> duong dan mo dung don; kindOf(n) -> nhan nhom (Don hang / Tai chinh ...)
let busy = false;
async function pump(urlOf, titleOf) {
  if (busy) return; busy = true;
  try {
    const cur = Number((db.prepare("SELECT v FROM kv WHERE k = 'push_cursor'").get() || {}).v || 0);
    const rows = db.prepare('SELECT n.* FROM notif n WHERE n.id > ? ORDER BY n.id LIMIT 200').all(cur);
    if (!rows.length) return;
    db.prepare("UPDATE kv SET v = ? WHERE k = 'push_cursor'").run(String(rows[rows.length - 1].id));
    const withSub = new Set(db.prepare('SELECT DISTINCT username FROM push_subs').all().map((r) => r.username));
    for (const n of rows) {
      if (!withSub.has(n.username)) continue;
      await send(n.username, { title: titleOf(n), body: n.text, url: urlOf(n.code), tag: n.code ? 'don-' + n.code : 'tb-' + n.id });
    }
  } catch (e) { console.error('push', e.message); } finally { busy = false; }
}

module.exports = { init, publicKey, encrypt, send, subscribe, unsubscribe, hasSub, pump };
