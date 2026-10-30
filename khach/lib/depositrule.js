'use strict';
// Chon tai khoan nhan nap tien THEO SO TIEN + GIO, giong het luat dang chay ben Gobiz
// (n8n 4f0LDtiVhLIZrYq5 "Bat/tat tai khoan nap tien theo gio"):
// - Ban dem (21h-9h): moi so tien tu 10k -> Tuan Anh (B1).
// - Ban ngay (9h-21h): 10k den duoi 5tr -> Tuan Anh (B1); tu 5tr -> Cuong (MC) va/hoac Cao (L8).
//   + Cuong: ca ban ngay, tru khi vi MC du tren 200tr (co MC = 'tat').
//   + Cao: chi T2-T7 9h-17h30, tru khi vi L8 du tren 40tr (co L8 = 'tat', bat lai khi duoi 20tr).
//   + Ca 2 deu tat ban ngay -> van bat (Cao chi trong gio Cao lam) de khach nap tu 5tr co cho vao.
// Co MC/L8 lay tu bang n8n (luong cu tinh), n8n day sang moi 15 phut.
const MIN = 10000, BIG = 5000000;
function vnNow(ms) { const d = new Date((ms || Date.now()) + 7 * 3600e3); return { phut: d.getUTCHours() * 60 + d.getUTCMinutes(), thu: d.getUTCDay(), d }; }
// Moc gio ke tiep ma luat co the doi (de bao "QR dung den ...")
function nextChange(ms) {
  const t = vnNow(ms); const marks = [540, 1050, 1260]; // 9h, 17h30, 21h
  const m = marks.find((x) => x > t.phut); const base = Date.UTC(t.d.getUTCFullYear(), t.d.getUTCMonth(), t.d.getUTCDate()) - 7 * 3600e3;
  return new Date(base + (m !== undefined ? m : 1440 + 540) * 60e3).toISOString();
}
function pick(amount, code, flags, accounts, ms) {
  amount = Math.round(Number(amount));
  if (!(amount >= MIN)) return { error: 'Nạp tối thiểu 10.000đ' };
  const byId = (id) => accounts.find((a) => a.id === id && a.active);
  const t = vnNow(ms);
  const banNgay = t.phut >= 540 && t.phut < 1260;
  const caoLam = t.thu >= 1 && t.thu <= 6 && t.phut >= 540 && t.phut < 1050;
  const f = Object.assign({ MC: 'bat', L8: 'bat' }, flags || {});
  let ids;
  if (!banNgay || amount < BIG) ids = ['B1'];
  else {
    ids = []; if (f.MC === 'bat') ids.push('MC'); if (caoLam && f.L8 === 'bat') ids.push('L8');
    if (!ids.length) { ids.push('MC'); if (caoLam) ids.push('L8'); }
  }
  const cands = ids.map(byId).filter(Boolean);
  if (!cands.length) return { error: 'Hiện chưa có tài khoản nhận số tiền này, vui lòng liên hệ nhân viên' };
  // Nhieu tai khoan cung hop le: chia deu theo ma khach (moi khach on dinh 1 tai khoan)
  let h = 0; for (const c of String(code)) h = (h * 31 + c.charCodeAt(0)) >>> 0;
  return { account: cands[h % cands.length], validUntil: nextChange(ms) };
}
module.exports = { pick, nextChange, MIN, BIG };
