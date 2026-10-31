'use strict';
// Khach duyet anh kiem hang / de xuat dong goi do kho TQ gui (ban kho /kho/ -> su kien 'ask').
// Du lieu nam trong DB admin (vmt.db: kho_approval, kho_photo) — o day CHI DOC. Cau tra loi cua khach gui ve may chu admin
// (http://app:3000/kho/internal/reply, khoa noi bo kho_internal_key) de 1 noi duy nhat ghi: lich su, trang thai kien, tao loi cho CSKH.
const fs = require('node:fs');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');

const ADMIN_DB = process.env.ADMIN_DB || '/admin/vmt.db';
const PHOTO_DIR = path.join(path.dirname(ADMIN_DB), 'kho_photos');
const INTERNAL = process.env.KHO_INTERNAL_URL || 'http://app:3000';
let db = null, adminKv = () => null;

function init(kvReader) { adminKv = kvReader; }
function open() {
  if (db) return db;
  if (!fs.existsSync(ADMIN_DB)) return null;
  try { db = new DatabaseSync(ADMIN_DB, { readOnly: true }); } catch (e) { db = new DatabaseSync(ADMIN_DB); }
  db.exec('PRAGMA busy_timeout = 5000');
  return db;
}
const has = (d) => !!d.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'kho_approval'").get();
const J = (s, d) => { try { return JSON.parse(s); } catch { return d; } };

// Viec dang cho khach xac nhan (hien o "Can lam" + chuong)
function pending(owner) {
  const d = open(); if (!d || !has(d)) return [];
  return d.prepare("SELECT id, code, kind, ts FROM kho_approval WHERE owner = ? AND status = 'pending' ORDER BY id DESC LIMIT 20").all(String(owner || '').toLowerCase());
}
function get(id, owner) {
  const d = open(); if (!d || !has(d)) return null;
  const r = d.prepare('SELECT * FROM kho_approval WHERE id = ?').get(Number(id));
  if (!r || r.owner !== String(owner || '').toLowerCase()) return null;
  const lines = J(r.lines, []), photos = J(r.photos, []);
  return {
    id: r.id, code: r.code, kind: r.kind, note: r.note || '', ts: r.ts, status: r.status, reply_note: r.reply_note || '', reply_at: r.reply_at || '',
    photos, lines: lines.map((l) => ({ n: l.n, img: l.img, attr: l.attr, want: l.want, got: l.got, st: l.st, pids: l.pids || [] })),
  };
}
// Anh chi xem duoc khi thuoc 1 yeu cau duyet cua chinh khach do
function photoFile(pid, aid, owner) {
  const a = get(aid, owner); if (!a) return null;
  const all = new Set(a.photos.concat(...a.lines.map((l) => l.pids)));
  if (!all.has(pid)) return null;
  const r = open().prepare('SELECT file FROM kho_photo WHERE id = ?').get(String(pid));
  return r ? path.join(PHOTO_DIR, r.file) : null;
}
async function reply(id, owner, ok, note, by) {
  const key = adminKv('kho_internal_key');
  if (!key) return { error: 'Hệ thống chưa sẵn sàng, thử lại sau ít phút' };
  try {
    const r = await fetch(INTERNAL + '/kho/internal/reply', { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Kho-Key': key }, body: JSON.stringify({ id, owner: String(owner || '').toLowerCase(), ok: !!ok, note: String(note || '').slice(0, 500), by }), signal: AbortSignal.timeout(15000) });
    const j = await r.json().catch(() => ({}));
    return r.ok ? { ok: true } : { error: j.error || 'Không gửi được, thử lại' };
  } catch (e) { return { error: 'Mất kết nối tới hệ thống, thử lại sau ít phút' }; }
}

module.exports = { init, pending, get, photoFile, reply };
