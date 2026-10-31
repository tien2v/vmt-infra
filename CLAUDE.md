# Quy tắc làm việc trên repo này (anh Tiến chốt 31/10/2026)

Anh không đọc code. Mọi thay đổi push lên `main` sẽ tự chạy trên máy chủ thật sau ~3–4 phút (xem `infra/server-cloudfly.md` trong Project).

## Sửa một chỗ = rà mọi chỗ liên quan
Trước khi sửa, tự trả lời và xử lý luôn (không chắc thì hỏi anh):
- Dữ liệu cũ đã lưu có cần chuyển đổi / tương thích không?
- Admin (`app/`) và trang khách (`khach/`) có cùng chỗ cần sửa theo không?
- Tiền, ví, sổ cái, trạng thái đơn, thông báo, log lịch sử đơn có bị ảnh hưởng không?
- Phân quyền (kho không thấy tiền), sao lưu, test có cần cập nhật không?
- Các file `lib/` đang có 2 bản ở `app/lib` và `khach/lib` (ledger, tth, price, cnshared, vietqr, mail, ks, ai, chat, webpush): sửa một bản thì phải sửa bản kia y hệt.

## Bàn Kho TQ (`app/kho*.html`, `app/lib/kho.js`)
- Sửa / thêm tính năng bàn kho thì **sửa luôn tài liệu hướng dẫn** `app/kho-help.html` (song ngữ Trung–Việt) cho khớp; tính năng chưa chạy để ở mục "即将上线 · Sắp có", không mô tả như đã có.
- Mạng TQ → VN chậm: giữ trang nhẹ, không gọi mạng khi quét; thao tác đi qua hàng đợi `/kho/api/sync`. Đổi file giao diện bàn kho thì tăng tên cache trong `app/kho-sw.js`.
- Tài khoản nhân viên khai sẵn (tên + email) nằm trong `app/staff.json.enc` (mã hoá bằng .uikey, email không để công khai); thêm người: giải mã, sửa, mã hoá lại. Nhân viên tự đặt mật khẩu qua email (`/api/pw/forgot`).

## Gọn gàng, không rác, không nặng máy chủ
Sau mỗi lần làm, rà và xoá:
- Code tạm, tài khoản tạm, đoạn gỡ lỗi, file / chức năng không còn dùng.
- Dữ liệu tự sinh không có hạn xoá (log, ảnh bỏ ngang, bản sao lưu, bảng tạm): luôn đặt giới hạn số ngày / số dòng.
- Việc nặng lặp lại mỗi request (đọc cả cục dữ liệu, nén lại, parse JSON lớn): phải có bộ nhớ đệm.
- Không nạp tài nguyên ngoài (Google Fonts, CDN…): nhân viên kho ở Trung Quốc sẽ bị chặn / treo trang.

## Trước khi push
- `node --check` các file đã sửa; chạy test (`node --test app/test/*.test.js`).
- Chạy thử server tại máy (DATA_DIR tạm) cho phần vừa sửa.
- Commit ghi bằng tiếng Việt, nói rõ đã sửa gì và đã đồng bộ những chỗ nào.

## Giao diện mã hoá (`app/ui.tar.gz.enc`, `khach/ui.tar.gz.enc`) — nhiều phiên cùng sửa
File mã hoá không ghép được bằng git: đóng gói từ bản cũ sẽ **đè mất** phần phiên khác vừa làm.
Trước khi mã hoá lại để push:
1. `git fetch origin main`; nếu file `.enc` trên `origin/main` khác bản mình bắt đầu sửa → giải mã bản đó ra thư mục riêng.
2. Ghép 3 chiều từng file (`git merge-file mine base theirs`), sửa xung đột nếu có, chạy thử lại.
3. Mã hoá bản đã ghép rồi mới push. Commit ghi rõ đã ghép với commit nào.

## Chat theo đơn (`lib/chat.js` 2 bản, `khach/lib/chatk.js`, `app/lib/chats.js`, `khach/chat.js`, `app/chat.html`, `app/ext/chat-admin.js`)
- Dữ liệu ở khach.db (chat_threads, chat_msgs, chat_ev, chat_log, chat_tpl); 2 tiến trình cùng ghi, báo nhau qua bảng `chat_ev` (giữ 2 ngày).
- Giao diện chat trang khách là file riêng `khach/chat.js` (không mã hoá), máy chủ tự chèn vào cuối index.html → sửa chat không cần mã hoá lại giao diện.
- Video chat lưu ở `<thư mục khach.db>/chatfiles/` (khách ≤ 100MB, NV ≤ 75MB, tổng ≤ 40GB, tự dọn: bỏ ngang 1 ngày; cuộc yên 30 ngày + cũ hơn 90 ngày). Thông báo điện thoại cho NV: khoá VAPID riêng trong vmt.db, service worker `app/chat-sw.js`.
- Ghi chú nội bộ (`f = 'note'`) không bao giờ được gửi ra phía khách (API, SSE, thông báo đẩy): sửa chỗ nào đọc chat_msgs cho khách thì giữ điều kiện này.
