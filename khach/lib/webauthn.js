'use strict';
// Face ID / van tay (WebAuthn / passkey) — tu viet, khong thu vien ngoai.
// Dien thoai tu xac thuc khuon mat / van tay va KY bang khoa rieng nam trong chip; may chu chi giu KHOA CONG KHAI.
// Khong luu anh khuon mat, khong luu van tay.
const crypto = require('node:crypto');

// ---- CBOR toi gian (du de doc attestationObject + khoa COSE) ----
function cbor(buf) {
  let o = 0;
  function len(ai) {
    if (ai < 24) return ai;
    if (ai === 24) return buf[o++];
    if (ai === 25) { const v = buf.readUInt16BE(o); o += 2; return v; }
    if (ai === 26) { const v = buf.readUInt32BE(o); o += 4; return v; }
    if (ai === 27) { const v = Number(buf.readBigUInt64BE(o)); o += 8; return v; }
    throw new Error('cbor len');
  }
  function item() {
    const b = buf[o++]; const mt = b >> 5, ai = b & 31;
    if (mt === 0) return len(ai);
    if (mt === 1) return -1 - len(ai);
    if (mt === 2) { const n = len(ai); const v = buf.subarray(o, o + n); o += n; return Buffer.from(v); }
    if (mt === 3) { const n = len(ai); const v = buf.toString('utf8', o, o + n); o += n; return v; }
    if (mt === 4) { const n = len(ai); const a = []; for (let i = 0; i < n; i++) a.push(item()); return a; }
    if (mt === 5) { const n = len(ai); const m = new Map(); for (let i = 0; i < n; i++) { const k = item(); m.set(k, item()); } return m; }
    if (mt === 7) { if (ai === 20) return false; if (ai === 21) return true; if (ai === 22) return null; }
    throw new Error('cbor type ' + mt);
  }
  const v = item(); return { value: v, end: o };
}
const b64u = (b) => Buffer.from(b).toString('base64url');
const unb = (s) => Buffer.from(String(s || ''), 'base64url');
const sha = (b) => crypto.createHash('sha256').update(b).digest();

function coseToJwk(m) {
  const kty = m.get(1), alg = m.get(3);
  if (kty === 2 && alg === -7) return { kty: 'EC', crv: 'P-256', x: b64u(m.get(-2)), y: b64u(m.get(-3)), alg: 'ES256' };
  if (kty === 3 && alg === -257) return { kty: 'RSA', n: b64u(m.get(-1)), e: b64u(m.get(-2)), alg: 'RS256' };
  throw new Error('Thiết bị dùng loại khoá chưa hỗ trợ');
}
function parseAuthData(ad) {
  const r = { rpIdHash: ad.subarray(0, 32), flags: ad[32], count: ad.readUInt32BE(33) };
  r.up = !!(r.flags & 1); r.uv = !!(r.flags & 4); r.at = !!(r.flags & 64);
  if (r.at) {
    let o = 37 + 16; const n = ad.readUInt16BE(o); o += 2;
    r.credId = ad.subarray(o, o + n); o += n;
    r.cose = cbor(ad.subarray(o)).value;
  }
  return r;
}
function checkClient(cd, type, challenge, origin) {
  const c = JSON.parse(cd.toString('utf8'));
  if (c.type !== type) throw new Error('Sai loại xác thực');
  if (c.challenge !== challenge) throw new Error('Phiên xác thực hết hạn, thử lại');
  if (c.origin !== origin) throw new Error('Sai trang web');
}
// Dang ky: tra ve { credId, jwk, count }
function verifyRegister({ clientDataJSON, attestationObject }, challenge, origin, rpId) {
  const cd = unb(clientDataJSON); checkClient(cd, 'webauthn.create', challenge, origin);
  const att = cbor(unb(attestationObject)).value;
  const a = parseAuthData(att.get('authData'));
  if (!a.rpIdHash.equals(sha(rpId))) throw new Error('Sai tên miền');
  if (!a.up || !a.uv) throw new Error('Thiết bị chưa xác thực khuôn mặt / vân tay');
  if (!a.at) throw new Error('Thiếu khoá');
  return { credId: b64u(a.credId), jwk: coseToJwk(a.cose), count: a.count };
}
// Xac thuc khi thanh toan: tra ve count moi
function verifyAssert({ clientDataJSON, authenticatorData, signature }, cred, challenge, origin, rpId) {
  const cd = unb(clientDataJSON); checkClient(cd, 'webauthn.get', challenge, origin);
  const ad = unb(authenticatorData); const a = parseAuthData(ad);
  if (!a.rpIdHash.equals(sha(rpId))) throw new Error('Sai tên miền');
  if (!a.up || !a.uv) throw new Error('Chưa xác thực khuôn mặt / vân tay');
  const key = crypto.createPublicKey({ key: cred.jwk, format: 'jwk' });
  const ok = crypto.verify('sha256', Buffer.concat([ad, sha(cd)]), cred.jwk.kty === 'RSA' ? { key, padding: crypto.constants.RSA_PKCS1_PADDING } : key, unb(signature));
  if (!ok) throw new Error('Chữ ký không hợp lệ');
  if (a.count !== 0 && a.count <= cred.count) throw new Error('Thiết bị nghi bị sao chép, xác thực bị từ chối');
  return a.count;
}

// ---- thu thach dung 1 lan, gan voi chu vi + muc dich + noi dung lenh (don, so tien) ----
const pending = new Map();
function challenge(owner, purpose, bind) {
  const c = b64u(crypto.randomBytes(32));
  pending.set(c, { owner, purpose, bind: JSON.stringify(bind || null), exp: Date.now() + 3 * 60e3 });
  for (const [k, v] of pending) if (v.exp < Date.now()) pending.delete(k);
  return c;
}
function take(c, owner, purpose, bind) {
  const v = pending.get(c); pending.delete(c);
  if (!v || v.exp < Date.now() || v.owner !== owner || v.purpose !== purpose) throw new Error('Phiên xác thực hết hạn, thử lại');
  if (v.bind !== JSON.stringify(bind || null)) throw new Error('Nội dung lệnh đã thay đổi, xác thực lại');
}
function init(db) {
  db.exec(`CREATE TABLE IF NOT EXISTS webauthn_creds (cred_id TEXT PRIMARY KEY, owner TEXT NOT NULL, jwk TEXT NOT NULL, count INTEGER NOT NULL DEFAULT 0,
    label TEXT, created_at TEXT DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')), last_used TEXT, disabled INTEGER NOT NULL DEFAULT 0)`);
}
module.exports = { init, cbor, parseAuthData, coseToJwk, verifyRegister, verifyAssert, challenge, take, b64u, unb };
