import { ThreadType, type API, type GroupMessage } from "zca-js";
import { connOpenCount } from "./http.js";
import { replyMode } from "../replyMode.js";
import { rules } from "../rules.js";
import { warmGroup } from "../warm.js";
import { bus } from "../events.js";

/**
 * Giữ ấm kết nối tới host gửi tin nhóm (zpwServiceMap.group[0]): Zalo đóng kết nối rảnh, lần gửi sau
 * phải bắt tay TLS lại (+~60ms qua proxy). "Ping" bằng request hợp lệ trả 200 + keep-alive để giữ
 * kết nối (HEAD rỗng bị trả lỗi + Connection: close, không giữ nổi). Xoay vòng 2 loại request cho
 * giống thao tác người thật, khoảng cách random, đi chung dispatcher với sendMessage.
 */

// Khoảng cách giữa các lần ping: random trong [MIN, MAX] cho đỡ lộ pattern cố định.
const WARM_MIN_MS = Math.max(2_000, Number(process.env.ZALO_WARM_MIN_MS) || 10_000);
const WARM_MAX_MS = Math.max(WARM_MIN_MS, Number(process.env.ZALO_WARM_MAX_MS) || 14_000);
const nextDelay = () => WARM_MIN_MS + Math.floor(Math.random() * (WARM_MAX_MS - WARM_MIN_MS + 1));
// Nhiều sự kiện dồn cùng lúc (bấm tiếp tục, đổi trạng thái) chỉ bắn 1 lần.
const MIN_GAP_MS = 2_000;

let timer: NodeJS.Timeout | null = null;
let currentApi: API | null = null;
let host = "";
let inFlight = false;
let lastAt = 0;
let rot = 0;
let lastMethod = "ping";
// Tin nhóm gần nhất bot thấy, dùng cho lượt "đánh dấu đã xem".
let lastGroupMsg: Parameters<API["sendSeenEvent"]>[0] | null = null;
let ping: () => Promise<unknown> = defaultPing;

/**
 * Đang lắng nghe = có nhóm đang bật, đang trong ca, và KHÔNG bị dừng sau khi "trả lời 1 lần".
 * Dính cờ oneShot rồi dừng (paused) thì không trả lời ai nữa nên không cần giữ ấm.
 */
export const isListening = () => rules.hot.size > 0 && replyMode.isActive();

/** Ghi nhớ tin nhóm gần nhất (không phải tin của mình) để dùng cho lượt ping "đã xem". */
export function rememberGroupMessage(msg: GroupMessage) {
  lastGroupMsg = msg.data as unknown as Parameters<API["sendSeenEvent"]>[0];
}

/** Nhóm dùng để xem thông tin: nhóm người dùng đã chọn, nếu không có thì lấy 1 nhóm đang nghe. */
function pingGroupId(): string | undefined {
  return warmGroup.get()?.groupId || rules.hot.keys().next().value;
}

function defaultPing(): Promise<unknown> {
  if (!currentApi) return Promise.resolve();
  const gid = pingGroupId();
  // Xoay vòng cho giống thao tác người thật: xem thông tin nhóm → đánh dấu đã xem → "đang soạn tin".
  const step = rot++ % 3;
  if (step === 1 && lastGroupMsg) {
    lastMethod = "seen";
    return currentApi.sendSeenEvent(lastGroupMsg, ThreadType.Group);
  }
  if (step === 2 && gid) {
    lastMethod = "typing";
    return currentApi.sendTypingEvent(gid, ThreadType.Group);
  }
  if (!gid) return Promise.resolve();
  lastMethod = "groupInfo";
  return currentApi.getGroupInfo(gid);
}

export async function warmTick() {
  if (!currentApi || inFlight || !isListening() || Date.now() - lastAt < MIN_GAP_MS) return;
  inFlight = true;
  lastAt = Date.now();
  const before = connOpenCount(host);
  const t0 = performance.now();
  try {
    await ping();
    const ms = Math.round(performance.now() - t0);
    // Tín hiệu thật: nếu lần này undici phải mở kết nối mới tới host thì tức là CHƯA giữ ấm được.
    const opened = connOpenCount(host) - before;
    console.log(`[warm] ${host} ${lastMethod} ${ms}ms ${opened > 0 ? "✗ phải mở kết nối mới (chưa giữ ấm được)" : "✓ tái dùng kết nối"}`);
  } catch {
    // Ping lỗi (nhóm không còn / tin quá cũ / rate limit): không ảnh hưởng việc trả lời.
  } finally {
    inFlight = false;
  }
}

function schedule() {
  timer = setTimeout(() => {
    void warmTick().finally(() => {
      if (currentApi) schedule();
    });
  }, nextDelay());
  timer.unref();
}

export function startWarmup(api: API, pingImpl?: () => Promise<unknown>) {
  stopWarmup();
  const base = api.zpwServiceMap?.group?.[0];
  if (!base) {
    console.warn("[warm] Không có host nhóm (zpwServiceMap.group) để giữ ấm");
    return;
  }
  currentApi = api;
  host = new URL(base).hostname;
  ping = pingImpl ?? defaultPing;
  schedule();
  void warmTick();
}

export function stopWarmup() {
  if (timer) clearTimeout(timer);
  timer = null;
  currentApi = null;
  host = "";
  lastAt = 0;
  ping = defaultPing;
}

// Vừa bấm "Tiếp tục lắng nghe" / vào ca: giữ ấm ngay, không chờ tới chu kỳ sau.
bus.on("reply_mode", (m) => {
  if (m.working && !m.paused) void warmTick();
});
