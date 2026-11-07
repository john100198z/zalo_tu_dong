import { Agent } from "undici";

/**
 * fetch mặc định của Node đóng kết nối rảnh sau 4 giây, nên tin đầu tiên sau một lúc im lặng
 * phải bắt tay lại. Agent này giữ kết nối lâu hơn. (Đo thực tế từ VN: lợi ~3-5ms,
 * nên không chủ động gửi request "hâm nóng" để tránh tạo lưu lượng thừa tới Zalo.)
 */
const agent = new Agent({
  keepAliveTimeout: 10 * 60_000,
  keepAliveMaxTimeout: 10 * 60_000,
  connections: 16,
  pipelining: 1,
});

export const keepAliveFetch: typeof fetch = (input, init) =>
  fetch(input, { ...init, dispatcher: agent } as RequestInit);
