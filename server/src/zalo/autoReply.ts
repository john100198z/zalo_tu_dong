import { ThreadType, type API, type GroupMessage, type Message } from "zca-js";
import { rules, type HotRule } from "../rules.js";
import { finalizeLog, pushLog } from "../events.js";
import { replyMode } from "../replyMode.js";
import { observe, verifyRace } from "./race.js";
import { rememberGroupMessage } from "./warmup.js";
import { archive } from "./archive.js";

const lastReplyAt = new Map<string, number>();

// Chống trả lời 2 lần cho cùng 1 tin (khi Zalo gửi lặp lúc kết nối lại).
const SEEN_LIMIT = 1000;
const seen = new Set<string>();

function markSeen(msgId: string): boolean {
  if (seen.has(msgId)) return false;
  seen.add(msgId);
  if (seen.size > SEEN_LIMIT) seen.delete(seen.values().next().value!);
  return true;
}

/** Trả về rule nếu tin này cần được trả lời. Chỉ đọc Map trong RAM. */
function match(msg: Message): HotRule | undefined {
  if (msg.type !== ThreadType.Group || msg.isSelf || !replyMode.isActive()) return;
  const rule = rules.hot.get(msg.threadId);
  if (!rule) return;
  const data = msg.data;
  if (!rule.users.has(data.uidFrom)) return;
  if (rule.textOnly && typeof data.content !== "string") return;
  if (!markSeen(data.msgId)) return;
  if (rule.cooldownMs > 0) {
    const key = `${msg.threadId}:${data.uidFrom}`;
    const now = Date.now();
    const last = lastReplyAt.get(key);
    if (last !== undefined && now - last < rule.cooldownMs) return;
    lastReplyAt.set(key, now);
  }
  return rule;
}

/**
 * Đường xử lý nóng: tra Map trong RAM rồi gọi sendMessage ngay.
 * Không có await, DB hay gọi API phụ nào trước khi gửi.
 * Mọi việc khác (ghi nhận tin, nhật ký, kiểm tra vị trí) chạy SAU khi đã gọi gửi.
 */
export function createAutoReplyHandler(api: API) {
  return (msg: Message) => {
    const rule = match(msg);
    if (rule) reply(api, msg as GroupMessage, rule);
    observe(msg);
    archive(msg);
    if (msg.type === ThreadType.Group && !msg.isSelf) rememberGroupMessage(msg as GroupMessage);
  };
}

function reply(api: API, msg: GroupMessage, rule: HotRule) {
  const data = msg.data;
  const started = performance.now();
  const payload = rule.quote ? { msg: rule.reply, quote: data } : rule.reply;
  const send = () => api.sendMessage(payload, msg.threadId, ThreadType.Group);

  // Lỗi mạng thoáng qua: gửi lại 1 lần ngay.
  const sending = send().catch(send);
  const pausedAfter = replyMode.claim(rule.groupName, data.dName);
  sending.then(
    (res) => {
      const log = pushLog({ ...base(), ok: true, pending: true, pausedAfter });
      const ourMsgId = res.message?.msgId != null ? String(res.message.msgId) : null;
      verifyRace(api, msg.threadId, msg, ourMsgId, rule.reply)
        .then((race) => finalizeLog(log, { race }))
        .catch(() => finalizeLog(log, { race: null }));
    },
    (err: unknown) => {
      // Gửi lỗi tức là chưa trả lời được ai, nên mở lại lắng nghe.
      if (pausedAfter) replyMode.update({ paused: false });
      pushLog({ ...base(), ok: false, error: err instanceof Error ? err.message : String(err) });
    },
  );

  function base() {
    const now = Date.now();
    return {
      at: now,
      groupId: msg.threadId,
      groupName: rule.groupName,
      senderId: data.uidFrom,
      senderName: data.dName,
      text: typeof data.content === "string" ? data.content : `[${data.msgType}]`,
      reply: rule.reply,
      processMs: Math.round(performance.now() - started),
      totalMs: Math.max(0, now - Number(data.ts)),
    };
  }
}
