import { Agent } from "undici";
const agent = new Agent({ keepAliveTimeout: 600000, keepAliveMaxTimeout: 600000, connections: 16, pipelining: 1, allowH2: true });
const URL_ = "https://tt-group-wpa.chat.zalo.me/";
const EVERY = 10_000, TOTAL = 300_000;
const t0 = Date.now();
let n = 0, cold = 0;
const ping = async () => {
  const t = performance.now();
  const r = await fetch(URL_, { method: "HEAD", dispatcher: agent });
  await r.arrayBuffer().catch(() => {});
  const ms = performance.now() - t;
  n++;
  const isCold = ms > 80;
  if (isCold) cold++;
  console.log(`${String(Math.round((Date.now() - t0) / 1000)).padStart(3)}s  ${ms.toFixed(0).padStart(4)}ms ${isCold ? "<-- BẮT TAY LẠI" : ""}`);
};
await ping();
const iv = setInterval(ping, EVERY);
setTimeout(async () => { clearInterval(iv); await agent.close(); console.log(`Tổng ${n} request, ${cold} lần bắt tay (gồm lần đầu)`); process.exit(0); }, TOTAL);
