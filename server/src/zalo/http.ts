import http from "node:http";
import https from "node:https";
import { Agent, ProxyAgent, type Dispatcher } from "undici";
import { HttpsProxyAgent } from "https-proxy-agent";
import { SocksProxyAgent } from "socks-proxy-agent";

export const CHROME_UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36";

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

const PROXY = process.env.ZALO_PROXY?.trim() || "";
const isSocks = PROXY.startsWith("socks");
const isHttp = PROXY.startsWith("http");

if (PROXY) console.log(`[http] Proxy Zalo: ${PROXY.replace(/:\/\/[^@]*@/, "://***@")}`);

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

// ---------- SOCKS5: dùng https.request + SocksProxyAgent (ổn định hơn SocksClient) ----------
function buildSocksFetch(): typeof fetch {
  const agent = new SocksProxyAgent(PROXY);

  return ((input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    return new Promise((resolve, reject) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : (input as Request).url;
      const parsed = new URL(url);
      const isHttps = parsed.protocol === "https:";
      const method = init?.method ?? "GET";
      const headers: Record<string, string> = {};
      if (init?.headers) {
        const h = init.headers instanceof Headers ? init.headers : new Headers(init.headers as HeadersInit);
        h.forEach((v, k) => {
          headers[k] = v;
        });
      }

      const transport = isHttps ? https : http;
      const req = transport.request(
        {
          hostname: parsed.hostname,
          port: parsed.port || (isHttps ? 443 : 80),
          path: parsed.pathname + parsed.search,
          method,
          headers,
          agent: agent as any,
          ciphers: CHROME_CIPHERS,
        },
        (res) => {
          const chunks: Buffer[] = [];
          res.on("data", (c: Buffer) => chunks.push(c));
          res.on("end", () => {
            const body = Buffer.concat(chunks);
            const resHeaders = new Headers();
            for (const [k, v] of Object.entries(res.headers)) {
              if (!v) continue;
              if (Array.isArray(v)) for (const x of v) resHeaders.append(k, x);
              else resHeaders.set(k, v);
            }
            resolve(new Response(body, { status: res.statusCode ?? 200, statusText: res.statusMessage ?? "", headers: resHeaders }));
          });
          res.on("error", reject);
        },
      );
      req.on("error", reject);

      if (init?.body != null) {
        const b = init.body;
        if (typeof b === "string" || Buffer.isBuffer(b) || b instanceof Uint8Array) req.write(b);
        else if (b instanceof URLSearchParams) req.write(b.toString());
      }
      req.end();
    });
  }) as typeof fetch;
}

// ---------- HTTP proxy / direct: dùng undici ----------
const BASE_OPTS = {
  keepAliveTimeout: 10 * 60_000,
  keepAliveMaxTimeout: 10 * 60_000,
  connections: 16,
  pipelining: 1,
};

function buildDispatcher(): Dispatcher {
  if (isHttp) {
    return new ProxyAgent({
      uri: PROXY,
      ...BASE_OPTS,
      allowH2: true,
      requestTls: { ciphers: CHROME_CIPHERS },
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

// ---------- keepAliveFetch ----------
const socksFetch = isSocks ? buildSocksFetch() : null;

export const keepAliveFetch: typeof fetch = isSocks
  ? (input, init) => socksFetch!(input, injectBrowserHeaders(init))
  : (input, init) => fetch(input, { ...injectBrowserHeaders(init), dispatcher } as RequestInit);

export async function preloadChatPage(ua: string) {
  try {
    const headers: Record<string, string> = {
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
    };
    if (ua.includes("Chrome/")) {
      headers["Sec-Ch-Ua"] = SEC_CH_UA;
      headers["Sec-Ch-Ua-Mobile"] = "?0";
      headers["Sec-Ch-Ua-Platform"] = '"Windows"';
    }
    await keepAliveFetch("https://chat.zalo.me/", { headers, redirect: "follow" });
  } catch {
    // Không quan trọng nếu lỗi.
  }
}
