'use strict';
// AI (Gemini) cho trang khach: doc tin Zalo / anh -> dien san form Ship to China; dich ten hang sang tieng Trung.
// Khoa + model do admin nhap o saas.7zone.net/ket-noi (kv 'gemini_key', 'gemini_model' trong vmt.db, trang khach chi doc).
// AI chi DIEN SAN cho khach xem lai, khong bao gio tu tao don.
const { CLASSES } = require('./price');

let adminKv = () => null;
function init(kvReader) { adminKv = kvReader; }
function cfg() {
  let key = ''; try { key = (JSON.parse(adminKv('gemini_key') || 'null') || {}).key || ''; } catch {}
  return { key, model: adminKv('gemini_model') || 'gemini-flash-latest' };
}
const ready = () => !!cfg().key;

// Goi Gemini, tra ve object JSON. images: [{mime, data(base64)}]
async function askJson(prompt, images, timeoutMs) {
  const c = cfg();
  if (!c.key) return { error: 'Chưa cài AI' };
  const parts = [{ text: prompt }].concat((images || []).map((i) => ({ inline_data: { mime_type: i.mime || 'image/jpeg', data: i.data } })));
  try {
    const r = await fetch('https://generativelanguage.googleapis.com/v1beta/models/' + encodeURIComponent(c.model) + ':generateContent', {
      method: 'POST', headers: { 'Content-Type': 'application/json', 'x-goog-api-key': c.key },
      body: JSON.stringify({ contents: [{ role: 'user', parts }], generationConfig: { responseMimeType: 'application/json', temperature: 0.1 } }),
      signal: AbortSignal.timeout(timeoutMs || 60000),
    });
    const j = await r.json().catch(() => ({}));
    if (!r.ok) return { error: (j.error && j.error.message) || ('AI lỗi HTTP ' + r.status) };
    const text = ((((j.candidates || [])[0] || {}).content || {}).parts || []).map((p) => p.text || '').join('');
    const m = text.match(/\{[\s\S]*\}/);
    if (!m) return { error: 'AI không trả kết quả' };
    return { data: JSON.parse(m[0]) };
  } catch (e) { return { error: /timeout|abort/i.test(String(e && e.name) + e) ? 'AI phản hồi chậm, thử lại' : 'Không đọc được kết quả AI' }; }
}

const s = (v, max) => String(v == null ? '' : v).replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, max);
const CATS = Object.keys(CLASSES);

const CN_PROMPT = `Bạn là nhân viên nhận đơn gửi hàng từ Việt Nam sang Trung Quốc (dịch vụ "Ship to China").
Đọc tin nhắn / ảnh khách gửi (có thể lộn xộn, tiếng Việt, tiếng Trung, viết tắt) và trích thông tin để điền form.
Trả về DUY NHẤT 1 object JSON đúng mẫu:
{"lot": "", "cat": "", "rname": "", "rphone": "", "raddr": "", "items": [{"name": "", "nameZh": "", "qty": 1, "price": null}], "note": "", "warnings": []}
Quy tắc:
- KHÔNG bịa. Thiếu thông tin nào thì để "" (hoặc null với price). Không tự nghĩ ra người nhận, SĐT, địa chỉ.
- lot: tên lô ngắn gọn tiếng Việt (tối đa 60 ký tự) tóm tắt hàng, vd "Quần áo mẫu gửi xưởng".
- cat: chọn 1 trong ${CATS.map((k) => '"' + k + '" = ' + CLASSES[k]).join('; ')}. Không chắc thì "thuong".
- rname: tên người nhận ở Trung Quốc, giữ nguyên chữ Hán nếu có.
- rphone: SĐT người nhận, chỉ giữ chữ số (bỏ +86 / 0086 ở đầu).
- raddr: địa chỉ người nhận ở Trung Quốc. Có chữ Hán thì giữ nguyên chữ Hán đầy đủ (tỉnh 省, thành phố 市, quận 区/县, đường, số nhà). Chỉ có phiên âm / tiếng Việt thì viết lại bằng chữ Hán nếu chắc chắn, không chắc thì giữ nguyên.
- items: mỗi loại hàng 1 dòng. name = tên tiếng Việt (khách ghi tiếng Trung thì dịch sang tiếng Việt). nameZh = tên tiếng Trung giản thể ngắn gọn dùng để khai báo hải quan / gửi nội địa TQ. qty = số lượng (số nguyên, không có thì 1). price = giá trị khai MỖI cái bằng VND (số nguyên) nếu khách có ghi; khách ghi bằng tệ / USD thì để null và thêm cảnh báo.
- note: yêu cầu khác của khách (giao gấp, gọi trước, dễ vỡ...) nếu có, tiếng Việt.
- warnings: danh sách cảnh báo ngắn tiếng Việt, chỉ khi có: hàng cấm / hạn chế gửi đi Trung Quốc (pin rời, chất lỏng dễ cháy, thuốc, chất bột, vũ khí, tiền...) · SĐT Trung Quốc không đủ 11 số hoặc không bắt đầu bằng 1 · địa chỉ thiếu tỉnh / thành phố / số nhà · giá ghi bằng tệ.`;

function cleanCn(d) {
  d = d && typeof d === 'object' ? d : {};
  const items = (Array.isArray(d.items) ? d.items : []).slice(0, 50).map((i) => {
    i = i || {};
    const qty = Math.floor(Number(i.qty)); const price = i.price == null || i.price === '' ? null : Math.floor(Number(i.price));
    return { name: s(i.name, 120), nameZh: s(i.nameZh, 120), qty: qty >= 1 && qty <= 1e6 ? qty : 1, price: price != null && price >= 0 && price <= 1e11 ? price : null };
  }).filter((i) => i.name || i.nameZh);
  for (const i of items) if (!i.name) i.name = i.nameZh;
  return {
    lot: s(d.lot, 80), cat: CATS.includes(d.cat) ? d.cat : '', rname: s(d.rname, 60),
    rphone: s(d.rphone, 20).replace(/[^0-9]/g, '').replace(/^(0086|86)(?=1\d{10}$)/, ''),
    raddr: s(d.raddr, 300), items, note: s(d.note, 500),
    warnings: (Array.isArray(d.warnings) ? d.warnings : []).map((w) => s(w, 200)).filter(Boolean).slice(0, 8),
  };
}

// Doc tin nhan + anh -> du lieu dien form Ship to China
async function cnFill(text, images) {
  const t = s(text, 8000);
  const r = await askJson(CN_PROMPT + (t ? '\n\nTIN NHẮN KHÁCH:\n"""\n' + t + '\n"""' : '\n\n(Không có tin nhắn, chỉ đọc ảnh.)'), images, 60000);
  if (r.error) return r;
  const out = cleanCn(r.data);
  if (out.rphone && !/^1\d{10}$/.test(out.rphone) && !out.warnings.some((w) => /SĐT|số điện thoại/i.test(w))) out.warnings.push('SĐT Trung Quốc thường có 11 số, bắt đầu bằng 1 — kiểm tra lại');
  return { ok: true, data: out };
}

// Dich ten hang sang tieng Trung (dung cho don khach tu go tay). names: [string] -> [string]
async function toZh(names) {
  const list = names.map((n) => s(n, 120)).slice(0, 50);
  if (!list.length) return { ok: true, zh: [] };
  const r = await askJson('Dịch tên các mặt hàng sau sang tiếng Trung giản thể, ngắn gọn, dùng để khai báo hải quan và gửi hàng nội địa Trung Quốc. Giữ nguyên thứ tự, giữ nguyên tên thương hiệu. Trả về DUY NHẤT JSON {"zh": ["...", ...]} cùng số phần tử.\n' + JSON.stringify(list), null, 45000);
  if (r.error) return r;
  const zh = Array.isArray(r.data.zh) ? r.data.zh.map((x) => s(x, 120)) : [];
  if (zh.length !== list.length) return { error: 'AI trả sai số dòng' };
  return { ok: true, zh };
}

// ---- Ky gui ve VN: doc tin shop / anh don Taobao, 1688 -> ma van don + hang ----
const KS_PROMPT = `Bạn là nhân viên nhận đơn ký gửi hàng từ Trung Quốc về Việt Nam. Khách tự mua hàng ở Taobao / 1688 / shop TQ, shop gửi về kho của mình ở Trung Quốc.
Đọc tin nhắn / ảnh khách gửi (tin shop báo mã vận đơn, ảnh chụp đơn hàng Taobao / 1688, danh sách hàng...) và trích thông tin.
Trả về DUY NHẤT 1 object JSON đúng mẫu:
{"wbs": [""], "shop": "", "lot": "", "items": [{"name": "", "nameZh": "", "qty": 1, "price": null}], "warnings": []}
Quy tắc:
- KHÔNG bịa. Thiếu thì để "" / [] / null.
- wbs: TẤT CẢ mã vận đơn chuyển phát nội địa Trung Quốc tìm thấy (运单号 / 快递单号, thường 10–20 ký tự chữ + số, vd SF1234567890123, YT..., JT..., 7xxxxxxxxxxx, ZTO...). KHÔNG lấy mã đơn hàng Taobao / 1688 (订单号 / 订单编号, thường 18–19 chữ số), số điện thoại, mã sản phẩm.
- shop: tên shop / người bán nếu có.
- lot: tên gợi nhớ ngắn tiếng Việt (tối đa 60 ký tự) tóm tắt hàng.
- items: mỗi loại hàng 1 dòng. name = tên tiếng Việt ngắn gọn (dịch nếu gốc tiếng Trung). nameZh = tên tiếng Trung giản thể ngắn gọn. qty = số lượng. price = đơn giá MỖI cái bằng TỆ (¥, số, có thể lẻ) nếu thấy; không thấy thì null.
- warnings: cảnh báo ngắn tiếng Việt nếu có: hàng cấm / hạn chế (pin rời, chất lỏng dễ cháy, thuốc, chất bột, vũ khí...), mã vận đơn mờ / không chắc.`;
function cleanKs(d) {
  d = d && typeof d === 'object' ? d : {};
  const wbs = [...new Set((Array.isArray(d.wbs) ? d.wbs : []).map((w) => s(w, 60).toUpperCase().replace(/\s/g, '')).filter((w) => /^[A-Z0-9-]{4,40}$/.test(w) && !/^\d{17,}$/.test(w)))].slice(0, 50);
  const items = (Array.isArray(d.items) ? d.items : []).slice(0, 50).map((i) => {
    i = i || {}; const qty = Math.floor(Number(i.qty)); const price = i.price == null || i.price === '' ? null : Math.round(Number(i.price) * 100) / 100;
    return { name: s(i.name, 120), nameZh: s(i.nameZh, 120), qty: qty >= 1 && qty <= 1e6 ? qty : 1, price: price != null && price >= 0 && price <= 1e9 ? price : null };
  }).filter((i) => i.name || i.nameZh);
  for (const i of items) if (!i.name) i.name = i.nameZh;
  return { wbs, shop: s(d.shop, 120), lot: s(d.lot, 80), items, warnings: (Array.isArray(d.warnings) ? d.warnings : []).map((w) => s(w, 200)).filter(Boolean).slice(0, 8) };
}
async function ksFill(text, images) {
  const t = s(text, 8000);
  const r = await askJson(KS_PROMPT + (t ? '\n\nTIN NHẮN KHÁCH:\n"""\n' + t + '\n"""' : '\n\n(Không có tin nhắn, chỉ đọc ảnh.)'), images, 60000);
  if (r.error) return r;
  return { ok: true, data: cleanKs(r.data) };
}

module.exports = { init, ready, cnFill, ksFill, toZh, _cleanCn: cleanCn, _cleanKs: cleanKs };
