# vmt-infra

Máy chủ VMT Console (Ubuntu 24.04, CloudFly): Docker, Caddy (HTTPS), app admin `app/` (Node 22, không dùng thư viện ngoài), Postgres (chỉ nội bộ, dự phòng), sao lưu DB hằng ngày.

Không chứa mật khẩu, khoá bí mật hay dữ liệu khách. Mật khẩu được tạo ngẫu nhiên trên máy chủ.

## Cài lần đầu (root)

    curl --location -o s github.com/tien2v/vmt-infra/raw/main/setup.sh
    bash s

## Cập nhật bản mới (root)

    curl --location -o u github.com/tien2v/vmt-infra/raw/main/update.sh
    bash u

Lần chạy đầu sau khi có app, màn hình in **tài khoản quản trị** (chỉ hiện 1 lần).

## App admin (`app/`)

- Đăng nhập + phân quyền theo bàn: `admin`, `sale`, `order`, `kho`, `tc`. Vai trò `kho` không nhận được số tiền (lọc ngay trên máy chủ).
- Dữ liệu Gobiz do n8n đẩy sang mỗi 15 phút qua `POST /api/ingest`, có chữ ký RSA-SHA256 trên chuỗi `<X-Ts>.<body>`; máy chủ kiểm bằng `app/ingest_pub.pem` (khoá công khai). Khoá riêng chỉ nằm trong n8n.
- Lưu ở `/opt/vmt/appdata/vmt.db` (SQLite có sẵn trong Node 22).

Máy chủ tự cập nhật mỗi 3 phút khi có commit mới trên main (nhật ký: /var/log/vmt-autoupdate.log).

Quản lý tài khoản nhân viên (chạy trong `/opt/vmt`):

    docker compose exec app node cli.js list
    docker compose exec app node cli.js add ten.dang.nhap kho "Tên hiển thị"
    docker compose exec app node cli.js reset ten.dang.nhap
    docker compose exec app node cli.js lock ten.dang.nhap
