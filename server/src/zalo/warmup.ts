import type { API } from "zca-js";
import { keepAliveFetch } from "./http.js";
import { replyMode } from "../replyMode.js";
import { rules } from "../rules.js";
import { bus } from "../events.js";

/**
 * Giữ ấm kết nối tới host gửi tin nhóm: Zalo đóng kết nối rảnh sau ~30s, lần gửi sau phải
 * bắt tay TLS lại (+~90ms). Gửi HEAD / không kèm cookie/tài khoản, đi chung dispatcher với
 * sendMessage để giữ đúng đường ống đó. Chỉ chạy khi đang thật sự lắng nghe.
 */

const INTERVAL_MS = 10_000;
const TIMEOUT_MS = 5_000;
// Nhiều sự kiện dồn cùng lúc (bấm tiếp tục, đổi trạng thái) chỉ bắn 1 lần.
const MIN_GAP_MS = 2_000;

let timer: NodeJS.Timeout | null = null;
let target = "";
let inFlight = false;
let lastAt = 0;
let doFetch: typeof fetch = keepAliveFetch;
// Thời gian HEAD nhanh nhất từng thấy ~ kết nối đang ấm; chậm hơn nhiều nghĩa là vừa bắt tay lại.
let bestMs = Infinity;

/** Đang lắng nghe = có nhóm đang bật, đang trong ca, và không bị dừng sau khi "trả lời 1 lần". */
export const isListening = () => rules.hot.size > 0 && replyMode.isActive();

export async function warmTick() {
  if (!target || inFlight || !isListening() || Date.now() - lastAt < MIN_GAP_MS) return;
  inFlight = true;
  lastAt = Date.now();
  const t0 = performance.now();
  try {
    const res = await doFetch(target, { method: "HEAD", signal: AbortSignal.timeout(TIMEOUT_MS) });
    await res.arrayBuffer().catch(() => {});
    const ms = Math.round(performance.now() - t0);
    const first = bestMs === Infinity;
    bestMs = Math.min(bestMs, ms);
    const warm = !first && ms <= Math.max(bestMs * 1.6, bestMs + 25);
    const host = new URL(target).host;
    console.log(`[warm] HEAD ${host} ${ms}ms ${first ? "(mốc đầu)" : warm ? "ấm ✓" : "nguội — vừa bắt tay lại"}`);
  } catch {
    // Lỗi mạng thoáng qua: lần sau thử lại, không ảnh hưởng gì tới việc trả lời.
  } finally {
    inFlight = false;
  }
}

export function startWarmup(api: API, fetchImpl: typeof fetch = keepAliveFetch) {
  stopWarmup();
  const base = api.zpwServiceMap?.group?.[0];
  if (!base) return;
  target = new URL("/", base).toString();
  doFetch = fetchImpl;
  timer = setInterval(warmTick, INTERVAL_MS);
  timer.unref();
  void warmTick();
}

export function stopWarmup() {
  if (timer) clearInterval(timer);
  timer = null;
  target = "";
  lastAt = 0;
  bestMs = Infinity;
}

// Vừa bấm "Tiếp tục lắng nghe": giữ ấm ngay, không chờ tới chu kỳ sau.
bus.on("reply_mode", (m) => {
  if (m.working && !m.paused) void warmTick();
});
