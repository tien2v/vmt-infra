# Quy tắc làm việc trên repo này (anh Tiến chốt 31/10/2026)

Anh không đọc code. Mọi thay đổi push lên `main` sẽ tự chạy trên máy chủ thật sau ~3–4 phút (xem `infra/server-cloudfly.md` trong Project).

## Sửa một chỗ = rà mọi chỗ liên quan
Trước khi sửa, tự trả lời và xử lý luôn (không chắc thì hỏi anh):
- Dữ liệu cũ đã lưu có cần chuyển đổi / tương thích không?
- Admin (`app/`) và trang khách (`khach/`) có cùng chỗ cần sửa theo không?
- Tiền, ví, sổ cái, trạng thái đơn, thông báo, log lịch sử đơn có bị ảnh hưởng không?
- Phân quyền (kho không thấy tiền), sao lưu, test có cần cập nhật không?
- Các file `lib/` đang có 2 bản ở `app/lib` và `khach/lib` (ledger, tth, price, cnshared, vietqr): sửa một bản thì phải sửa bản kia y hệt.

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
