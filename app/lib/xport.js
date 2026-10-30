'use strict';
// Ket noi Xport (xportcn.com) — mua hang / lay van don Taobao, 1688 qua API.
// Khoa (AccessKey + AccessSecret) anh tu nhap o trang /ket-noi (chi admin), luu trong kv, KHONG nam tren GitHub.
// Chu ky theo tai lieu: MD5(accessKey + timestamp + nonce + accessSecret) chu HOA, dat trong header.
const crypto = require('node:crypto');

const BASE = 'https://www.xportcn.com';
let store;
function init(st) { store = st; }

function creds() {
  try { return JSON.parse(store.kvGet('xport_creds') || 'null'); } catch { return null; }
}
function setCreds(accessKey, accessSecret, userId, by) {
  accessKey = String(accessKey || '').trim(); accessSecret = String(accessSecret || '').trim();
  if (!/^[\w-]{6,128}$/.test(accessKey) || !/^[\w-]{6,256}$/.test(accessSecret)) return { error: 'AccessKey / AccessSecret không hợp lệ' };
  store.kvSet('xport_creds', JSON.stringify({ accessKey, accessSecret, userId: String(userId || '').trim(), by, at: new Date().toISOString() }));
  return { ok: true };
}
function view() {
  const c = creds();
  if (!c) return { configured: false };
  return { configured: true, accessKey: c.accessKey.slice(0, 4) + '…' + c.accessKey.slice(-4), userId: c.userId || '', by: c.by, at: c.at, lastTest: JSON.parse(store.kvGet('xport_last_test') || 'null') };
}

function headers(c, mode) {
  const ts = String(Date.now());
  const nonce = crypto.randomBytes(16).toString('hex');
  const raw = mode === 'kv'
    ? 'access-key=' + c.accessKey + '&nonce-str=' + nonce + '&timestamp=' + ts + '&' + c.accessSecret
    : c.accessKey + ts + nonce + c.accessSecret;
  const h = { 'access-key': c.accessKey, timestamp: ts, 'nonce-str': nonce, signature: crypto.createHash('md5').update(raw).digest('hex').toUpperCase(), 'Content-Type': 'application/json' };
  if (c.userId) h['user-id'] = c.userId;
  return h;
}

// Goi API. mode: kieu chu ky da thu thanh cong (luu lai); thu ca 2 kieu neu chua biet.
async function call(method, pathQ, body) {
  const c = creds(); if (!c) return { error: 'Chưa nhập khoá Xport' };
  const modes = store.kvGet('xport_sigmode') ? [store.kvGet('xport_sigmode')] : ['concat', 'kv'];
  let last;
  for (const m of modes) {
    try {
      const r = await fetch(BASE + pathQ, { method, headers: headers(c, m), body: body ? JSON.stringify(body) : undefined, signal: AbortSignal.timeout(20000) });
      const t = await r.text(); let j = null; try { j = JSON.parse(t); } catch {}
      last = { http: r.status, code: j && j.code, msg: j && j.msg, data: j && j.data, text: j ? undefined : t.slice(0, 300) };
      if (j && j.code === 200) { if (!store.kvGet('xport_sigmode')) store.kvSet('xport_sigmode', m); return last; }
      if (!(j && /sign|签名/i.test(String(j.msg || '')))) return last; // loi khac loi chu ky -> khong thu kieu kia
    } catch (e) { last = { error: String(e.message || e) }; }
  }
  return last;
}

// Thu ket noi: xem 1 san pham Taobao mau trong tai lieu (chi doc, khong mua).
async function test() {
  const r = await call('POST', '/open/product/multiLanguage/detail/get', { itemId: '971200796489', language: 'vi' });
  const out = { at: new Date().toISOString(), ok: !!(r && r.code === 200), http: r && r.http, code: r && r.code, msg: (r && (r.msg || r.error || r.text)) || '' };
  store.kvSet('xport_last_test', JSON.stringify(out));
  return out;
}

module.exports = { init, setCreds, view, call, test };
