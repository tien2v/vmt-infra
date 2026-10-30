'use strict';
// Sao luu ra Cloudflare R2 (S3). Khong dung thu vien ngoai.
// - khach.db (don, tien, khach): moi gio, chi gui khi co thay doi. vmt.db (admin, snapshot Gobiz): moi ngay.
// - Anh don: gui tung anh moi 1 lan.
// - Ma hoa truoc khi gui: moi file 1 khoa AES-256-GCM ngau nhien, khoa nay duoc boc bang KHOA CONG KHAI RSA.
//   Khoa bi mat (de giai ma) chi anh giu (tai ve 1 lan khi cai dat). May chu va Cloudflare deu khong mo duoc ban sao luu.
// - Giu: hourly 8 ngay, daily 120 ngay, monthly giu mai. R2 bat khoa chong xoa 7 ngay.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const zlib = require('node:zlib');
const https = require('node:https');
const { DatabaseSync } = require('node:sqlite');

const ADMIN_DB = path.join(process.env.DATA_DIR || path.join(__dirname, '..', 'data'), 'vmt.db');
const KHACH_DB = process.env.KHACH_DB || '/khach/khach.db';
const KDIR = path.dirname(KHACH_DB);
const MAGIC = Buffer.from('VMTBK1');

let store = null; // ham get/set kv do server.js truyen vao
const cfg = () => { try { return JSON.parse(store.kvGet('backup_cfg') || 'null'); } catch { return null; } };
const state = () => { try { return JSON.parse(store.kvGet('backup_state') || '{}'); } catch { return {}; } };
function setState(patch) { const s = Object.assign(state(), patch); store.kvSet('backup_state', JSON.stringify(s)); return s; }

// ---------- S3 SigV4 ----------
const sha = (b) => crypto.createHash('sha256').update(b).digest('hex');
const hmac = (k, s) => crypto.createHmac('sha256', k).update(s).digest();
const enc = (s) => encodeURIComponent(s).replace(/[!'()*]/g, (c) => '%' + c.charCodeAt(0).toString(16).toUpperCase());
// Ky SigV4 (tach rieng de kiem tra bang vi du chuan cua AWS)
function signV4(method, p, q, h, ph, keyId, secret, region, amz) {
  const day = amz.slice(0, 8);
  const names = Object.keys(h).map((x) => x.toLowerCase()).sort();
  const val = (n) => String(h[Object.keys(h).find((x) => x.toLowerCase() === n)]).trim();
  const canon = [method, p, q, names.map((n) => n + ':' + val(n)).join('\n') + '\n', names.join(';'), ph].join('\n');
  const scope = day + '/' + region + '/s3/aws4_request';
  const sts = ['AWS4-HMAC-SHA256', amz, scope, sha(canon)].join('\n');
  const kSign = hmac(hmac(hmac(hmac('AWS4' + secret, day), region), 's3'), 'aws4_request');
  return 'AWS4-HMAC-SHA256 Credential=' + keyId + '/' + scope + ',SignedHeaders=' + names.join(';') + ',Signature=' + crypto.createHmac('sha256', kSign).update(sts).digest('hex');
}
function s3(c, method, key, query, body, extraHeaders) {
  const u = new URL(c.endpoint);
  const host = u.host;
  const p = '/' + c.bucket + (key ? '/' + key.split('/').map(enc).join('/') : '');
  const q = Object.keys(query || {}).sort().map((k) => enc(k) + '=' + enc(String(query[k]))).join('&');
  const amz = new Date().toISOString().replace(/[:-]|\.\d{3}/g, '');
  const payload = body || Buffer.alloc(0); const ph = sha(payload);
  const h = Object.assign({ host, 'x-amz-content-sha256': ph, 'x-amz-date': amz }, extraHeaders || {});
  h.Authorization = signV4(method, p, q, h, ph, c.keyId, c.secret, 'auto', amz);
  if (body) h['content-length'] = body.length;
  return new Promise((ok, no) => {
    const r = https.request({ host, path: p + (q ? '?' + q : ''), method, headers: h, timeout: 120000 }, (res) => {
      const ch = []; res.on('data', (d) => ch.push(d)); res.on('end', () => ok({ status: res.statusCode, body: Buffer.concat(ch).toString() }));
    });
    r.on('error', no); r.on('timeout', () => r.destroy(new Error('timeout')));
    if (body) r.write(body); r.end();
  });
}
async function put(c, key, body) { const r = await s3(c, 'PUT', key, {}, body, { 'content-type': 'application/octet-stream' }); if (r.status !== 200) throw new Error('PUT ' + key + ' ' + r.status + ' ' + r.body.slice(0, 200)); }
async function list(c, prefix) {
  const out = []; let token = null;
  do {
    const q = { 'list-type': 2, prefix }; if (token) q['continuation-token'] = token;
    const r = await s3(c, 'GET', '', q); if (r.status !== 200) throw new Error('LIST ' + r.status + ' ' + r.body.slice(0, 200));
    for (const m of r.body.matchAll(/<Key>([^<]+)<\/Key>[\s\S]*?<LastModified>([^<]+)<\/LastModified>/g)) out.push({ key: m[1], t: Date.parse(m[2]) });
    const t = r.body.match(/<NextContinuationToken>([^<]+)</); token = /<IsTruncated>true/.test(r.body) && t ? t[1] : null;
  } while (token);
  return out;
}
async function del(c, key) { const r = await s3(c, 'DELETE', key, {}); return r.status === 204 || r.status === 200; }

// ---------- ma hoa ----------
// File: MAGIC | len(khoa boc) 2 byte | khoa boc RSA-OAEP | iv 12 | tag 16 | du lieu
function seal(pubPem, data) {
  const k = crypto.randomBytes(32), iv = crypto.randomBytes(12);
  const wrapped = crypto.publicEncrypt({ key: pubPem, padding: crypto.constants.RSA_PKCS1_OAEP_PADDING, oaepHash: 'sha256' }, k);
  const ci = crypto.createCipheriv('aes-256-gcm', k, iv); const body = Buffer.concat([ci.update(data), ci.final()]);
  const len = Buffer.alloc(2); len.writeUInt16BE(wrapped.length);
  return Buffer.concat([MAGIC, len, wrapped, iv, ci.getAuthTag(), body]);
}
function open(privPem, buf) { // dung trong cong cu khoi phuc
  if (!buf.subarray(0, 6).equals(MAGIC)) throw new Error('Không phải file sao lưu VMT');
  const n = buf.readUInt16BE(6); let o = 8; const wrapped = buf.subarray(o, o + n); o += n;
  const iv = buf.subarray(o, o + 12); o += 12; const tag = buf.subarray(o, o + 16); o += 16;
  const k = crypto.privateDecrypt({ key: privPem, padding: crypto.constants.RSA_PKCS1_OAEP_PADDING, oaepHash: 'sha256' }, wrapped);
  const d = crypto.createDecipheriv('aes-256-gcm', k, iv); d.setAuthTag(tag);
  return Buffer.concat([d.update(buf.subarray(o)), d.final()]);
}

// Chup DB nhat quan (VACUUM INTO) -> gzip -> ma hoa
function dbBlob(file) {
  if (!fs.existsSync(file)) return null;
  const tmp = path.join(require('node:os').tmpdir(), 'bk-' + crypto.randomBytes(6).toString('hex') + '.db');
  const d = new DatabaseSync(file); d.exec('PRAGMA busy_timeout = 10000');
  try { d.exec("VACUUM INTO '" + tmp.replace(/'/g, "''") + "'"); } finally { d.close(); }
  try { return zlib.gzipSync(fs.readFileSync(tmp), { level: 9 }); } finally { fs.rmSync(tmp, { force: true }); }
}
// Ten file khong bao gio trung (R2 khoa chong ghi de): gio phut giay + 4 ky tu ngau nhien
const stamp = (d) => d.toISOString().slice(0, 19).replace('T', '-').replace(/:/g, '') + '-' + crypto.randomBytes(2).toString('hex');

let running = false;
async function run(force) {
  const c = cfg(); if (!c || !c.keyId || !c.pub) return { skipped: 'chưa cài đặt' };
  if (running) return { skipped: 'đang chạy' };
  running = true; const t0 = Date.now(); const done = []; const st = state();
  try {
    const now = new Date(); const ymd = now.toISOString().slice(0, 10);
    // khach.db moi gio (chi khi doi)
    const kb = dbBlob(KHACH_DB);
    if (kb) {
      const h = sha(kb.subarray(10)); // bo header gzip (co thoi gian)
      if (force || h !== st.khachHash) {
        await put(c, 'db/hourly/' + ymd + '/khach-' + stamp(now) + '.db.gz.vmt', seal(c.pub, kb)); done.push('khach.db');
        st.khachHash = h;
      }
      if (st.khachDaily !== ymd) { await put(c, 'db/daily/khach-' + ymd + '-' + crypto.randomBytes(2).toString('hex') + '.db.gz.vmt', seal(c.pub, kb)); st.khachDaily = ymd; done.push('khach.db (ngày)'); }
      const ym = ymd.slice(0, 7);
      if (st.khachMonthly !== ym) { await put(c, 'db/monthly/khach-' + ym + '-' + crypto.randomBytes(2).toString('hex') + '.db.gz.vmt', seal(c.pub, kb)); st.khachMonthly = ym; }
    }
    // vmt.db moi ngay
    if (force || st.adminDaily !== ymd) {
      const ab = dbBlob(ADMIN_DB);
      if (ab) { await put(c, (st.adminDaily === ymd ? 'db/hourly/' + ymd + '/admin-' + stamp(now) : 'db/daily/admin-' + ymd) + '.db.gz.vmt', seal(c.pub, ab)); st.adminDaily = ymd; done.push('vmt.db'); }
    }
    // anh moi
    const dir = path.join(KDIR, 'uploads'); let nImg = 0;
    if (fs.existsSync(dir)) {
      const sent = new Set(JSON.parse(store.kvGet('backup_imgs') || '[]'));
      for (const f of fs.readdirSync(dir)) {
        if (!/^[a-f0-9]{32}\.jpg$/.test(f) || sent.has(f)) continue;
        await put(c, 'images/' + f + '.vmt', seal(c.pub, fs.readFileSync(path.join(dir, f)))); sent.add(f); nImg++;
        if (nImg % 50 === 0) store.kvSet('backup_imgs', JSON.stringify([...sent]));
      }
      store.kvSet('backup_imgs', JSON.stringify([...sent]));
      if (nImg) done.push(nImg + ' ảnh');
    }
    // don ban cu (sau khi het khoa 7 ngay)
    if (st.pruned !== ymd) {
      const lim = { 'db/hourly/': 8, 'db/daily/': 120 };
      for (const pre of Object.keys(lim)) for (const o of await list(c, pre)) if (Date.now() - o.t > lim[pre] * 86400e3) await del(c, o.key);
      st.pruned = ymd;
    }
    Object.assign(st, { lastOk: new Date().toISOString(), lastErr: null, lastDone: done.join(', ') || 'không có gì mới', ms: Date.now() - t0, fails: 0 });
    store.kvSet('backup_state', JSON.stringify(st));
    return { ok: true, done };
  } catch (e) {
    Object.assign(st, { lastErr: String(e.message || e).slice(0, 300), lastErrAt: new Date().toISOString(), fails: (st.fails || 0) + 1 });
    store.kvSet('backup_state', JSON.stringify(st));
    return { error: st.lastErr };
  } finally { running = false; }
}

// Kiem tra khoa truy cap: ghi 1 file nho, doc danh sach, xoa
async function test(c) {
  const key = 'test/kiem-tra-' + Date.now() + '.txt';
  await put(c, key, Buffer.from('ok'));
  const l = await list(c, 'test/');
  if (!l.some((o) => o.key === key)) throw new Error('Ghi được nhưng không đọc được danh sách');
  await del(c, key); // co the bi khoa chong xoa giu lai, khong sao
  return true;
}

function init(st) { store = st; setTimeout(() => run(false).catch(() => {}), 60e3); setInterval(() => run(false).catch(() => {}), 60 * 60e3); }
function status() {
  const c = cfg(); const s = state();
  return { configured: !!(c && c.keyId), endpoint: c ? c.endpoint : null, bucket: c ? c.bucket : null, keyId: c ? c.keyId.slice(0, 6) + '…' : null, keyFp: c ? c.fp : null, setAt: c ? c.at : null, setBy: c ? c.by : null,
    lastOk: s.lastOk || null, lastDone: s.lastDone || null, lastErr: s.lastErr || null, lastErrAt: s.lastErrAt || null, fails: s.fails || 0, healthy: !!(s.lastOk && Date.now() - Date.parse(s.lastOk) < 3 * 3600e3) };
}
// Luu cai dat. Tao cap khoa RSA moi neu chua co; tra ve khoa bi mat 1 LAN DUY NHAT.
async function configure(b, by) {
  const endpoint = String(b.endpoint || '').trim().replace(/\/+$/, '');
  if (!/^https:\/\/[a-z0-9]{20,40}\.(eu\.|fedramp\.)?r2\.cloudflarestorage\.com$/i.test(endpoint)) return { error: 'Endpoint phải có dạng https://xxxx.r2.cloudflarestorage.com' };
  const keyId = String(b.keyId || '').trim(), secret = String(b.secret || '').trim(), bucket = String(b.bucket || 'vmt-backup').trim();
  if (!/^[a-f0-9]{32}$/i.test(keyId)) return { error: 'Access Key ID không đúng (32 ký tự)' };
  if (!/^[a-f0-9]{64}$/i.test(secret)) return { error: 'Secret Access Key không đúng (64 ký tự)' };
  if (!/^[a-z0-9][a-z0-9-]{1,61}[a-z0-9]$/.test(bucket)) return { error: 'Tên bucket không hợp lệ' };
  const old = cfg();
  const c = { endpoint, keyId, secret, bucket, pub: old && old.pub, fp: old && old.fp, at: new Date().toISOString(), by };
  try { await test(c); } catch (e) { return { error: 'Không kết nối được R2: ' + (e.message || e) }; }
  let priv = null;
  if (!c.pub) {
    const kp = crypto.generateKeyPairSync('rsa', { modulusLength: 4096 });
    c.pub = kp.publicKey.export({ type: 'spki', format: 'pem' });
    priv = kp.privateKey.export({ type: 'pkcs8', format: 'pem' });
    c.fp = sha(c.pub).slice(0, 16).toUpperCase().match(/.{4}/g).join('-');
  }
  store.kvSet('backup_cfg', JSON.stringify(c));
  setTimeout(() => run(true).catch(() => {}), 2000);
  return { ok: true, priv, fp: c.fp };
}

module.exports = { signV4, init, run, status, configure, open, seal, s3, list };
