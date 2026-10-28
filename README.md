# vmt-infra

Script cài đặt máy chủ VMT Console (Ubuntu 24.04): Docker, Caddy (web), Postgres (chỉ nội bộ), sao lưu DB hằng ngày.

Không chứa mật khẩu hay dữ liệu khách. Mật khẩu database được tạo ngẫu nhiên trên máy chủ (`/opt/vmt/.env`).

Chạy trên máy chủ (root):

    curl --location -o s github.com/tien2v/vmt-infra/raw/main/setup.sh
    bash s
