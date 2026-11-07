import https from "node:https";
import { Agent } from "undici";

// User-Agent Chrome hiện tại, giống trình duyệt thật trên Windows.
export const CHROME_UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36";

// Thứ tự cipher giống Chrome để TLS fingerprint gần giống trình duyệt thật.
const CHROME_CIPHERS = [
  "ECDHE-ECDSA-AES128-GCM-SHA256",
  "ECDHE-RSA-AES128-GCM-SHA256",
  "ECDHE-ECDSA-AES256-GCM-SHA384",
  "ECDHE-RSA-AES256-GCM-SHA384",
  "ECDHE-ECDSA-CHACHA20-POLY1305",
  "ECDHE-RSA-CHACHA20-POLY1305",
  "ECDHE-RSA-AES128-SHA",
  "ECDHE-RSA-AES256-SHA",
  "AES128-GCM-SHA256",
  "AES256-GCM-SHA384",
  "AES128-SHA",
  "AES256-SHA",
].join(":");

const SEC_CH_UA = '"Google Chrome";v="131", "Chromium";v="131", "Not_A Brand";v="24"';

// undici Agent: keep-alive lâu + HTTP/2 + TLS cipher giống Chrome.
const agent = new Agent({
  keepAliveTimeout: 10 * 60_000,
  keepAliveMaxTimeout: 10 * 60_000,
  connections: 16,
  pipelining: 1,
  allowH2: true,
  connect: { ciphers: CHROME_CIPHERS },
});

// https.Agent cho WebSocket (thư viện ws dùng agent này khi bắt tay TLS).
export const wsAgent = new https.Agent({
  keepAlive: true,
  ciphers: CHROME_CIPHERS,
});

/**
 * Thêm các header Sec-* mà trình duyệt luôn gửi nhưng Node.js không tự thêm.
 * Chỉ thêm khi request đã có User-Agent (= đã qua getDefaultHeaders của zca-js, không phải raw request).
 */
function injectBrowserHeaders(init?: RequestInit): RequestInit | undefined {
  if (!init?.headers) return init;

  const headers = new Headers(init.headers as HeadersInit);
  if (!headers.has("User-Agent") && !headers.has("user-agent")) return init;

  const ua = headers.get("User-Agent") || headers.get("user-agent") || "";
  const isChrome = ua.includes("Chrome/");

  // Sec-Fetch-*: cả Chrome lẫn Firefox đều gửi khi gọi API từ trang web.
  if (!headers.has("Sec-Fetch-Dest")) headers.set("Sec-Fetch-Dest", "empty");
  if (!headers.has("Sec-Fetch-Mode")) headers.set("Sec-Fetch-Mode", "cors");
  if (!headers.has("Sec-Fetch-Site")) headers.set("Sec-Fetch-Site", "same-site");

  // Sec-Ch-Ua-*: chỉ Chrome / Chromium gửi.
  if (isChrome) {
    if (!headers.has("Sec-Ch-Ua")) headers.set("Sec-Ch-Ua", SEC_CH_UA);
    if (!headers.has("Sec-Ch-Ua-Mobile")) headers.set("Sec-Ch-Ua-Mobile", "?0");
    if (!headers.has("Sec-Ch-Ua-Platform")) headers.set("Sec-Ch-Ua-Platform", '"Windows"');
  }

  return { ...init, headers };
}

export const keepAliveFetch: typeof fetch = (input, init) =>
  fetch(input, { ...injectBrowserHeaders(init), dispatcher: agent } as RequestInit);

/**
 * Giả lập bước đầu tiên mà trình duyệt thật luôn làm: tải trang chat.zalo.me.
 * Điều này thiết lập cookie ban đầu và tạo TLS session cache, khiến các request API
 * tiếp theo trông giống như đến từ trình duyệt đang mở trang Zalo Web.
 */
export async function preloadChatPage(ua: string) {
  try {
    await fetch("https://chat.zalo.me/", {
      headers: {
        Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8",
        "Accept-Encoding": "gzip, deflate, br, zstd",
        "Accept-Language": "en-US,en;q=0.9,vi;q=0.8",
        "Cache-Control": "max-age=0",
        "Sec-Fetch-Dest": "document",
        "Sec-Fetch-Mode": "navigate",
        "Sec-Fetch-Site": "none",
        "Sec-Fetch-User": "?1",
        "Upgrade-Insecure-Requests": "1",
        "User-Agent": ua,
        ...(ua.includes("Chrome/")
          ? {
              "Sec-Ch-Ua": SEC_CH_UA,
              "Sec-Ch-Ua-Mobile": "?0",
              "Sec-Ch-Ua-Platform": '"Windows"',
            }
          : {}),
      },
      dispatcher: agent,
      redirect: "follow",
    } as RequestInit);
  } catch {
    // Không quan trọng nếu lỗi — mục đích chỉ là thiết lập TLS session cache.
  }
}
