# Zalo Auto Reply

Tự động trả lời tin nhắn trong nhóm Zalo khi người được chỉ định nhắn tin. Mọi thứ được cấu hình qua web panel.

- Đăng nhập Zalo bằng **quét mã QR** ngay trên web. Phiên được lưu nên server khởi động lại không phải quét lại.
- Chọn nhiều nhóm để lắng nghe cùng lúc. Mỗi nhóm nghe **1 người (mặc định là trưởng nhóm), tối đa 2 người**.
- Tin trả lời mặc định là **"em"**, sửa được cho từng nhóm.
- Tuỳ chọn cho từng nhóm: trả lời dạng trích dẫn, chỉ trả lời tin dạng chữ, thời gian chờ chống spam, bật/tắt nhanh.
- Nhật ký realtime kèm độ trễ của từng lần trả lời.

> ⚠️ Dự án dùng [`zca-js`](https://github.com/RFS-ADRENO/zca-js), là API **không chính thức** của Zalo. Zalo có thể khoá tài khoản, nên hãy dùng tài khoản phụ.
> Không mở Zalo Web (chat.zalo.me) bằng cùng tài khoản ở nơi khác, vì bot sẽ bị ngắt kết nối.

## Chạy trên máy (local)

Yêu cầu: Node.js 20 trở lên.

```bash
cp .env.example .env      # rồi sửa ADMIN_PASSWORD và SESSION_SECRET
npm run setup             # cài thư viện
npm run build
npm start                 # mở http://localhost:3000
```

Chế độ phát triển (tự reload): `npm run dev`, mở http://localhost:5173.

Chạy test: `npm test`.

## Deploy lên VPS

**Nên chọn VPS ở Việt Nam hoặc Singapore** cho gần server Zalo. Đây là yếu tố ảnh hưởng tốc độ trả lời nhiều nhất.

### Cách 1: Docker

```bash
cp .env.example .env && nano .env
docker compose up -d --build
```

### Cách 2: pm2

```bash
npm run setup && npm run build
npm i -g pm2
pm2 start ecosystem.config.cjs && pm2 save && pm2 startup
```

### HTTPS (khuyến nghị)

Server chỉ lắng nghe ở `127.0.0.1:3000` khi chạy Docker. Đặt Caddy phía trước để có HTTPS tự động:

```
# /etc/caddy/Caddyfile
panel.tenmien.com {
    reverse_proxy 127.0.0.1:3000
}
```

Khi đã có HTTPS, đặt `SECURE_COOKIE=true` trong `.env`.

## Cách hoạt động

```
Zalo WebSocket ──► listener ──► tra Map trong RAM ──► sendMessage
                                  ▲
Web panel ──► API ──► SQLite ─────┘ (lưu cấu hình xong là cập nhật Map ngay)
```

Để trả lời nhanh nhất, đường xử lý tin nhắn ([server/src/zalo/autoReply.ts](server/src/zalo/autoReply.ts)) **không đọc DB, không gọi API phụ, không `await`** trước khi gửi. Nó chỉ tra `Map` trong RAM rồi gửi ngay. Nhật ký được ghi sau khi đã gửi xong.

Nhật ký hiển thị 2 con số:
- **gửi**: thời gian từ lúc nhận tin tới lúc Zalo xác nhận đã gửi, phụ thuộc vào ping tới server Zalo.
- **tổng**: từ lúc người kia bấm gửi tới lúc bot trả lời xong, tính theo timestamp của Zalo.

## Cấu trúc

```
server/src/
  index.ts           khởi động HTTP server
  config.ts          biến môi trường
  db.ts              SQLite (cấu hình nhóm + phiên Zalo)
  rules.ts           cấu hình nhóm, cache RAM cho đường xử lý nóng
  events.ts          event bus + nhật ký
  zalo/service.ts    đăng nhập QR, khôi phục phiên, lấy nhóm/thành viên
  zalo/autoReply.ts  xử lý tin nhắn và trả lời
  http/              auth, REST API, WebSocket
web/src/             React + Tailwind
data/                app.db (sinh ra khi chạy, chứa phiên Zalo, đừng chia sẻ)
```
