'use strict';
// Bao khach khi don Gobiz doi trang thai (so snapshot moi voi trang thai da bao, luu o bang gz_seen).
// Chi chay cho tai khoan dang dung web moi (khach xem thu + tai khoan test). Lan dau gap khach: chi ghi nho, khong bao.
// Thong bao ghi vao bang notif -> chuong tren web + day len dien thoai (webpush.pump).

const vnd = (v) => Math.round(Number(v) || 0).toLocaleString('vi-VN').replace(/,/g, '.') + 'đ';
const DEAD = /CANCEL/;
const pay = (x) => (Number(x.unpaid) > 0 ? ', cần thanh toán ' + vnd(x.unpaid) : '');

const TXT = {
  ship: {
    MERCHANT_DELIVERING: () => 'đang chờ hàng tới kho Trung Quốc',
    PUTAWAY: () => 'hàng đã tới kho Trung Quốc',
    TRANSPORTING: () => 'đang vận chuyển về Việt Nam',
    READY_FOR_DELIVERY: (x) => 'hàng đã về kho Việt Nam' + (Number(x.unpaid) > 0 ? ', cần thanh toán ' + vnd(x.unpaid) + ' để giao hàng' : ', sẵn sàng giao'),
    DELIVERING: () => 'đã xuất kho, đang giao tới anh/chị',
    DELIVERED: () => 'đã giao xong',
  },
  order: {
    DEPOSITED: () => 'đã đặt cọc, chờ VMT mua hàng',
    ACCEPTED: () => 'VMT đã tiếp nhận, sắp mua hàng',
    PROCESSING: () => 'VMT đang mua hàng',
    PURCHASING: () => 'VMT đang mua hàng',
    PURCHASED: () => 'đã mua hàng xong, chờ shop gửi tới kho Trung Quốc',
    MERCHANT_DELIVERING: () => 'shop đang gửi hàng tới kho Trung Quốc',
    PUTAWAY: () => 'hàng đã tới kho Trung Quốc',
    TRANSPORTING: () => 'đang vận chuyển về Việt Nam',
    READY_FOR_DELIVERY: (x) => 'hàng đã về kho Việt Nam' + (Number(x.unpaid) > 0 ? ', cần thanh toán ' + vnd(x.unpaid) + ' để giao hàng' : ', sẵn sàng giao'),
    DELIVERING: () => 'đang giao tới anh/chị',
    DELIVERED: () => 'đã giao xong',
    OUT_OF_STOCK: () => 'shop báo hết hàng',
  },
  peer: {
    REQUEST_FOR_PAY: (x) => (Number(x.unpaid) > 0 ? 'cần thanh toán ' + vnd(x.unpaid) : 'chờ thanh toán'),
    PAYMENT_PAID: () => 'đã nhận tiền, VMT đang chuyển cho người nhận',
    TRANSACTION_COMPLETED: () => 'đã chuyển tiền xong',
  },
};
const NAME = { ship: 'Ký gửi', order: 'Đơn đặt hàng', peer: 'Thanh toán hộ' };
const NEWNAME = { ship: 'đơn ký gửi', order: 'đơn đặt hàng', peer: 'đơn thanh toán hộ' };

// Ten don de khach nhan ra: ky gui uu tien ma van don (khach thuoc ma nay hon ma don)
function label(k, x, wbOf) {
  if (k !== 'ship') return x.code;
  const wb = wbOf(x.code);
  return wb && wb.length ? wb[0] + (wb.length > 1 ? ' +' + (wb.length - 1) : '') + ' (đơn ' + x.code + ')' : x.code;
}
function text(k, x, prev, wbOf) {
  const L = label(k, x, wbOf);
  if (prev === undefined) return 'Đã tạo ' + NEWNAME[k] + ' ' + L + (k === 'peer' ? pay(x) : '');
  if (DEAD.test(x.status)) return NAME[k] + ' ' + L + ': đơn đã huỷ';
  const f = (TXT[k] || {})[x.status];
  return f ? NAME[k] + ' ' + L + ': ' + f(x) : null; // trang thai la -> khong bao (tranh chu kho hieu)
}

// users: [{ username, gobiz }]; byUser: Map tu buildIndex; wbOf(code) -> [ma van don]
function run(store, byUser, users, wbOf) {
  let sent = 0;
  for (const u of users) {
    const s = byUser.get(String(u.gobiz || '').toLowerCase());
    if (!s) continue;
    const cur = [];
    for (const x of s.orders) cur.push(['order', x]);
    for (const x of s.shipments) cur.push(['ship', x]);
    for (const x of s.peer) cur.push(['peer', x]);
    const seen = store.seenOf(u.username);
    const first = seen.size === 0;
    const changed = []; const msgs = [];
    for (const [k, x] of cur) {
      const prev = seen.get(x.code);
      if (prev === x.status) continue;
      changed.push([x.code, x.status]);
      if (first) continue;
      const t = text(k, x, prev, wbOf);
      if (t) msgs.push([x.code, t]);
    }
    if (msgs.length > 30) { // vd sau khi dong bo bi gian doan: gom 1 tin, khong xa chuong
      store.notifAdd(u.username, null, msgs.length + ' đơn vừa cập nhật trạng thái. Anh/chị mở Danh sách đơn để xem chi tiết.');
      sent++;
    } else for (const [code, t] of msgs) { store.notifAdd(u.username, code, t); sent++; }
    if (changed.length) store.seenSave(u.username, changed);
  }
  return sent;
}

module.exports = { run, text };
