'use strict';
// Khoa Gemini API (Google) — dung de doc tin Zalo / anh / file tao nhieu don.
// Anh nhap o /ket-noi (chi admin), luu trong kv, KHONG len GitHub. Tai khoan Google cua VMT (khong dung chung Fudo).
let store;
function init(st) { store = st; }
function key() { try { return (JSON.parse(store.kvGet('gemini_key') || 'null') || {}).key || ''; } catch { return ''; } }

function setKey(k, by) {
  // Bo moi khoang trang / xuong dong / dau ngoac khi dan; khoa moi cua Google co the co dau cham (vd AQ.…)
  k = String(k || '').replace(/[\s"'`]/g, '');
  if (!/^[\w.\-]{20,200}$/.test(k)) return { error: 'Khoá Gemini không hợp lệ: chỉ gồm chữ, số, dấu - _ . (dài ' + k.length + ' ký tự)' };
  store.kvSet('gemini_key', JSON.stringify({ key: k, by, at: new Date().toISOString() }));
  return { ok: true };
}
function view() {
  let c = null; try { c = JSON.parse(store.kvGet('gemini_key') || 'null'); } catch {}
  if (!c) return { configured: false };
  return { configured: true, key: c.key.slice(0, 6) + '…' + c.key.slice(-4), by: c.by, at: c.at, lastTest: JSON.parse(store.kvGet('gemini_last_test') || 'null'), model: model() };
}

// Chon model Flash ban on dinh moi nhat ma khoa dung duoc (vd gemini-3.6-flash), bo ban preview / lite / tts / image / live.
function pickModel(names) {
  let best = null, bv = -1;
  for (const n of names) {
    const m = /^models\/gemini-(\d+(?:\.\d+)?)-flash$/.exec(n);
    if (m && Number(m[1]) > bv) { bv = Number(m[1]); best = n.replace('models/', ''); }
  }
  return best;
}
function model() { return store.kvGet('gemini_model') || 'gemini-flash-latest'; }

// Thu ket noi: lay danh sach model (chi doc, khong ton tien).
async function test() {
  const k = key();
  let out;
  if (!k) out = { ok: false, msg: 'Chưa nhập khoá' };
  else {
    try {
      const r = await fetch('https://generativelanguage.googleapis.com/v1beta/models?pageSize=50', { headers: { 'x-goog-api-key': k }, signal: AbortSignal.timeout(15000) });
      const j = await r.json().catch(() => ({}));
      const best = pickModel((j.models || []).map((m) => m.name));
      if (r.ok && best) store.kvSet('gemini_model', best);
      out = r.ok ? { ok: true, model: best, msg: 'Dùng được ' + (j.models || []).length + ' model · đang dùng ' + (best || 'gemini-flash-latest') } : { ok: false, msg: (j.error && j.error.message) || ('HTTP ' + r.status) };
    } catch (e) { out = { ok: false, msg: String(e.message || e) }; }
  }
  out.at = new Date().toISOString();
  store.kvSet('gemini_last_test', JSON.stringify(out));
  return out;
}

module.exports = { init, setKey, view, test, key, model, pickModel };
