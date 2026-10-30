'use strict';
// Tao chuoi VietQR (chuan EMVCo / NAPAS) ngay tren may chu, khong goi dich vu ngoai.
// DUNG CHUNG: khach/lib/vietqr.js va app/lib/vietqr.js giong het nhau.
const BANKS = {
  TPB: ['970423', 'TPBank'], MB: ['970422', 'MB Bank'], VCB: ['970436', 'Vietcombank'], TCB: ['970407', 'Techcombank'],
  ACB: ['970416', 'ACB'], BIDV: ['970418', 'BIDV'], CTG: ['970415', 'VietinBank'], VPB: ['970432', 'VPBank'],
  STB: ['970403', 'Sacombank'], VIB: ['970441', 'VIB'], HDB: ['970437', 'HDBank'], OCB: ['970448', 'OCB'],
  MSB: ['970426', 'MSB'], SHB: ['970443', 'SHB'], AGR: ['970405', 'Agribank'], SCB: ['970429', 'SCB'],
  EIB: ['970431', 'Eximbank'], SEAB: ['970440', 'SeABank'], LPB: ['970449', 'LPBank'], NAB: ['970428', 'Nam A Bank'],
  BAB: ['970409', 'Bac A Bank'], KLB: ['970452', 'KienlongBank'], VAB: ['970427', 'VietABank'], PGB: ['970430', 'PGBank'],
  CAKE: ['546034', 'CAKE'], TIMO: ['963388', 'Timo'], UBANK: ['546035', 'Ubank'],
};
const tlv = (id, v) => id + String(v.length).padStart(2, '0') + v;
function crc16(s) { let c = 0xffff; for (const b of Buffer.from(s, 'utf8')) { c ^= b << 8; for (let i = 0; i < 8; i++) c = c & 0x8000 ? ((c << 1) ^ 0x1021) & 0xffff : (c << 1) & 0xffff; } return c.toString(16).toUpperCase().padStart(4, '0'); }
const ascii = (s) => String(s || '').normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/đ/g, 'd').replace(/Đ/g, 'D').replace(/[^A-Za-z0-9 ]/g, ' ').replace(/\s+/g, ' ').trim();
// bank: ma trong BANKS; amount: so nguyen dong (bo trong = khach tu nhap); info: noi dung chuyen khoan
function payload(bank, acct, amount, info) {
  const b = BANKS[bank]; if (!b) throw new Error('Ngân hàng không hỗ trợ');
  if (!/^[0-9A-Za-z]{4,19}$/.test(String(acct))) throw new Error('Số tài khoản không hợp lệ');
  const mai = tlv('00', 'A000000727') + tlv('01', tlv('00', b[0]) + tlv('01', String(acct))) + tlv('02', 'QRIBFTTA');
  let s = tlv('00', '01') + tlv('01', amount ? '12' : '11') + tlv('38', mai) + tlv('53', '704');
  if (amount) s += tlv('54', String(Math.round(amount)));
  s += tlv('58', 'VN');
  const add = ascii(info).slice(0, 50); if (add) s += tlv('62', tlv('08', add));
  s += '6304'; return s + crc16(s);
}
module.exports = { BANKS, payload, crc16 };
