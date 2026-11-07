import https from "node:https";
import tls from "node:tls";
import { Agent, ProxyAgent, type Dispatcher } from "undici";
import { HttpsProxyAgent } from "https-proxy-agent";
import { SocksProxyAgent } from "socks-proxy-agent";
import { SocksClient } from "socks";

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

// ---------- Proxy ----------
const PROXY = process.env.ZALO_PROXY?.trim() || "";
const isSocks = PROXY.startsWith("socks");
const isHttp = PROXY.startsWith("http");

if (PROXY) {
  console.log(`[http] Proxy Zalo: ${PROXY.replace(/:\/\/[^@]*@/, "://***@")}`);
}

// ---------- undici dispatcher (cho fetch / HTTP requests) ----------
const BASE_OPTS = {
  keepAliveTimeout: 10 * 60_000,
  keepAliveMaxTimeout: 10 * 60_000,
  connections: 16,
  pipelining: 1,
};

function parseSocksProxy(url: string) {
  const u = new URL(url);
  return {
    host: u.hostname,
    port: Number(u.port) || 1080,
    type: (url.startsWith("socks4") ? 4 : 5) as 4 | 5,
    ...(u.username ? { userId: decodeURIComponent(u.username) } : {}),
    ...(u.password ? { password: decodeURIComponent(u.password) } : {}),
  };
}

function buildDispatcher(): Dispatcher {
  if (isHttp) {
    return new ProxyAgent({
      uri: PROXY,
      ...BASE_OPTS,
      allowH2: true,
      requestTls: { ciphers: CHROME_CIPHERS },
    });
  }

  if (isSocks) {
    const proxy = parseSocksProxy(PROXY);
    return new Agent({
      ...BASE_OPTS,
      connect: (opts: any, cb: any) => {
        SocksClient.createConnection({
          proxy,
          command: "connect",
          destination: { host: opts.hostname, port: Number(opts.port) },
        })
          .then(({ socket }) => {
            const tlsSocket = tls.connect({
              socket,
              servername: opts.servername || opts.hostname,
              ciphers: CHROME_CIPHERS,
            });
            tlsSocket.on("secureConnect", () => cb(null, tlsSocket));
            tlsSocket.on("error", (err: Error) => cb(err, null));
          })
          .catch((err: unknown) => cb(err, null));
      },
    });
  }

  return new Agent({
    ...BASE_OPTS,
    allowH2: true,
    connect: { ciphers: CHROME_CIPHERS },
  });
}

const dispatcher = buildDispatcher();

// ---------- WebSocket agent (cho thư viện ws bên trong zca-js) ----------
function buildWsAgent() {
  if (isHttp) return new HttpsProxyAgent(PROXY, { ciphers: CHROME_CIPHERS });
  if (isSocks) return new SocksProxyAgent(PROXY);
  return new https.Agent({ keepAlive: true, ciphers: CHROME_CIPHERS });
}

export const wsAgent = buildWsAgent();

// ---------- Inject browser headers ----------
function injectBrowserHeaders(init?: RequestInit): RequestInit | undefined {
  if (!init?.headers) return init;

  const headers = new Headers(init.headers as HeadersInit);
  if (!headers.has("User-Agent") && !headers.has("user-agent")) return init;

  const ua = headers.get("User-Agent") || headers.get("user-agent") || "";
  const isChrome = ua.includes("Chrome/");

  if (!headers.has("Sec-Fetch-Dest")) headers.set("Sec-Fetch-Dest", "empty");
  if (!headers.has("Sec-Fetch-Mode")) headers.set("Sec-Fetch-Mode", "cors");
  if (!headers.has("Sec-Fetch-Site")) headers.set("Sec-Fetch-Site", "same-site");

  if (isChrome) {
    if (!headers.has("Sec-Ch-Ua")) headers.set("Sec-Ch-Ua", SEC_CH_UA);
    if (!headers.has("Sec-Ch-Ua-Mobile")) headers.set("Sec-Ch-Ua-Mobile", "?0");
    if (!headers.has("Sec-Ch-Ua-Platform")) headers.set("Sec-Ch-Ua-Platform", '"Windows"');
  }

  return { ...init, headers };
}

export const keepAliveFetch: typeof fetch = (input, init) =>
  fetch(input, { ...injectBrowserHeaders(init), dispatcher } as RequestInit);

/**
 * Giả lập bước đầu tiên mà trình duyệt thật luôn làm: tải trang chat.zalo.me.
 * Thiết lập TLS session cache, khiến các request API tiếp theo trông tự nhiên hơn.
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
      dispatcher,
      redirect: "follow",
    } as RequestInit);
  } catch {
    // Không quan trọng nếu lỗi — mục đích chỉ là thiết lập TLS session cache.
  }
}
