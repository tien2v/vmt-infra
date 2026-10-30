'use strict';
// Bang gia Ship to China — doi tac Tai Loc (Cong ty TNHH XNK Tong Hop Tai Loc), hieu luc 01/05/2026,
// tuyen Ha Noi -> Trung Quoc. Nguon: file "BANG BAO GIA 1.5.2026 xuat CHINA.xlsx" anh gui 30/10/2026.
// GIONG HET o app/lib/price.js va khach/lib/price.js (2 container build rieng) — sua 1 cho thi sua ca 2.
//
// Gia thu khach = gia doi tac x (1 + MARKUP), lam tron len 1.000d.
// Gia doi tac chua gom VAT 10% (dieu 1 bang gia). Can tinh phi = max(can thuc, DxRxC/6000), lam tron len 0,5kg (dieu 2).

const MARKUP = 0.10;            // anh dan: thu khach them 10%
const HARD_SURCHARGE = 0.10;    // dieu 4: hang kho thu them 10% phi thong quan
const INSURANCE_RATE = 0.06;    // dieu 9: bao hiem 6% gia tri khai bao
const RECEIVER_PAYS = 0.08;     // dieu 6: nguoi nhan tra cuoc / thu ho +8% tong tien
const HCM_SURCHARGE = 0.05;     // anh dan 30/10: hang gui tu kho HCM, Tai Loc thu them 5% cuoc
const VAT = 0.10;               // khach chon lay hoa don VAT: cong 10% tren gia thu khach (bang gia doi tac chua gom VAT)

// Hang thuong (cot B): 0,5-1,5kg dong gia; 2-45kg theo kg; 50kg tro len theo kg
const THUONG = { flatMax: 1.5, flat: 178500, perKgTo50: 102637, perKg50: 98175 };
// Hang kho NHANH (cot C): 0,5kg = 206.550; 1-10kg = 252.000d/kg; chi nhan duoi 10kg
const KHO_NHANH = { half: 206550, perKg: 252000, maxKg: 10 };
// Hang kho THUONG (cot D) / CHAM (cot E): bang theo 0,5kg den 10kg, tren 10kg tinh theo kg theo bac
const STEP = {
  standard: [189247.5, 253246.5, 371088, 504000, 630000, 621065.25, 732200.625, 815490, 926625.375, 1009914.75, 1077932.8125, 1158018.75, 1264879.6875, 1344965.625, 1451826.5625, 1531912.5, 1638773.4375, 1718859.375, 1825720.3125, 1905806.25],
  eco: [158535, 219960, 319995, 387270, 479115, 546390, 646425, 713700, 813735, 881010, 943312.5, 1008000, 1104187.5, 1168875, 1265062.5, 1329750, 1425937.5, 1490625, 1586812.5, 1651500],
};
// bac theo kg tren 10kg: [tu kg, don gia/kg]
const TIERS = {
  standard: [[10, 179010], [21, 175950], [45, 172890], [101, 134666.775], [501, 130960.35]],
  eco: [[10, 153900], [21, 150300], [45, 146700], [101, 113373], [501, 110466]],
};
// Yen sao (cot F): theo kg
const YEN = [[0, 1000000], [5, 950000], [10, 900000], [20, 850000]];
// Thu, chung tu (cot C dong "Thu"): 0,5kg = 180.000; 1kg = 207.000; nang hon tinh nhu hang kho nhanh
const THU = { half: 180000, one: 207000 };

const CLASSES = {
  thuong: 'Hàng thường',
  kho: 'Hàng khó (thuốc, chất bột, chất lỏng, pin, linh kiện điện tử, hàng giá trị cao)',
  yen: 'Yến sào',
  thu: 'Thư, chứng từ',
  rieng: 'Hàng báo giá riêng (tóc, nail, mi, sách vở, linh kiện/điện thoại, máy tính, trầm hương)',
};
const SPEED = { express_shipping: 'express', standard_shipping: 'standard', eco_shipping: 'eco' };

const roundHalf = (x) => Math.ceil(x * 2 - 1e-9) / 2;
const tierRate = (tiers, kg) => { let r = tiers[0][1]; for (const [from, v] of tiers) if (kg > from || (from > 10 && kg >= from)) r = v; return r; };

// Tra ve { ok, cw, partner, customer, lines[], note } hoac { ok:false, reason }
function quote({ cls, method, weight, dims, value, insurance, receiverPays, origin, vat }) {
  const w = Number(weight) || 0;
  const [L, W, H] = (dims || []).map(Number);
  const vol = L > 0 && W > 0 && H > 0 ? (L * W * H) / 6000 : 0;
  if (!(w > 0) && !(vol > 0)) return { ok: false, reason: 'Chưa có cân nặng' };
  const cw = roundHalf(Math.max(w, vol, 0.5));
  const speed = SPEED[method] || 'standard';
  const lines = []; let base;
  if (cls === 'rieng') return { ok: false, cw, reason: 'Loại hàng này cần nhân viên báo giá riêng' };
  if (cls === 'thuong') {
    base = cw <= THUONG.flatMax ? THUONG.flat : cw * (cw >= 50 ? THUONG.perKg50 : THUONG.perKgTo50);
    lines.push(['Cước hàng thường', base]);
  } else if (cls === 'yen') {
    base = cw * tierRate(YEN.map(([f, v]) => [f, v]), cw);
    lines.push(['Cước yến sào', base]);
  } else if (cls === 'thu' && cw <= 1) {
    base = cw <= 0.5 ? THU.half : THU.one;
    lines.push(['Cước thư, chứng từ', base]);
  } else { // hang kho (thu > 1kg tinh nhu hang kho nhanh)
    const sp = cls === 'thu' ? 'express' : speed;
    if (sp === 'express') {
      if (cw >= KHO_NHANH.maxKg) return { ok: false, cw, reason: 'Hàng khó đi nhanh chỉ nhận dưới 10kg, chọn Tiêu chuẩn hoặc Tiết kiệm' };
      base = cw <= 0.5 ? KHO_NHANH.half : cw * KHO_NHANH.perKg;
    } else if (cw <= 10) base = STEP[sp][Math.round(cw * 2) - 1];
    else base = cw * tierRate(TIERS[sp], cw);
    lines.push(['Cước hàng khó (' + { express: 'nhanh', standard: 'thường', eco: 'chậm' }[sp] + ')', base]);
    if (cls === 'kho') lines.push(['Phí thông quan hàng khó 10%', base * HARD_SURCHARGE]);
  }
  if (origin === 'HCM') {
    const freight = lines.reduce((a, l) => a + l[1], 0);
    lines.push(['Phụ phí gửi từ kho HCM 5%', freight * HCM_SURCHARGE]);
  }
  if (insurance) {
    const v = Number(value) || 0;
    lines.push(['Bảo hiểm 6% giá trị khai', v * INSURANCE_RATE]);
  }
  let partner = lines.reduce((a, l) => a + l[1], 0);
  if (receiverPays) { const x = partner * RECEIVER_PAYS; lines.push(['Người nhận trả cước / thu hộ 8%', x]); partner += x; }
  const out = lines.map(([n, v]) => [n, Math.round(v * (1 + MARKUP))]);
  let customer = Math.ceil((partner * (1 + MARKUP)) / 1000) * 1000;
  if (vat) { const v = Math.round(customer * VAT); out.push(['VAT 10%', v]); customer = Math.ceil((customer + v) / 1000) * 1000; }
  return { ok: true, cw, vol: vol ? Math.round(vol * 100) / 100 : null, partner: Math.round(partner), customer, vat: !!vat, lines: out };
}

module.exports = { quote, CLASSES, MARKUP };
