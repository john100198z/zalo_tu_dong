import { settings } from "./db.js";
import { bus, type ReplyLog, type ZaloStatus } from "./events.js";

const SETTINGS_KEY = "telegram";
// Telegram giới hạn ~20 tin/phút cho mỗi nhóm, nên giãn cách 3,1 giây và gộp tin khi dồn.
const MIN_GAP_MS = 3_100;
const MAX_BATCH = 8; // giữ dưới giới hạn 4096 ký tự/tin của Telegram
// Mất kết nối quá 30 giây mới báo, tránh báo nhiễu khi rớt mạng thoáng qua.
const DISCONNECT_ALERT_DELAY_MS = 30_000;

export type TelegramSettings = {
  enabled: boolean;
  token: string;
  chatId: string;
  notifyReplies: boolean;
  notifyErrors: boolean;
  notifyStatus: boolean;
};

const defaults: TelegramSettings = {
  enabled: false,
  token: "",
  chatId: "",
  notifyReplies: true,
  notifyErrors: true,
  notifyStatus: true,
};

const escapeHtml = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
const clip = (s: string, n = 300) => (s.length > n ? `${s.slice(0, n)}…` : s);
const time = (ts: number) =>
  new Date(ts).toLocaleTimeString("vi-VN", { hour: "2-digit", minute: "2-digit", second: "2-digit", timeZone: "Asia/Ho_Chi_Minh" });

async function callTelegram<T>(token: string, method: string, body?: unknown): Promise<T> {
  const res = await fetch(`https://api.telegram.org/bot${token}/${method}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body ?? {}),
    signal: AbortSignal.timeout(15_000),
  });
  const data = (await res.json().catch(() => ({}))) as { ok?: boolean; result?: T; description?: string; parameters?: { retry_after?: number } };
  if (!data.ok) {
    const err = new Error(data.description || `Telegram lỗi ${res.status}`) as Error & { retryAfter?: number };
    err.retryAfter = data.parameters?.retry_after;
    throw err;
  }
  return data.result as T;
}

function formatReply(l: ReplyLog) {
  if (!l.ok) {
    return [
      `❌ <b>Trả lời thất bại</b>`,
      `👥 Nhóm: <b>${escapeHtml(l.groupName)}</b>`,
      `👤 Người nhắn: <b>${escapeHtml(l.senderName)}</b>`,
      `💬 Tin của họ: ${escapeHtml(clip(l.text))}`,
      `⚠️ Lỗi: ${escapeHtml(l.error ?? "")}`,
      `🕒 ${time(l.at)}`,
      ``,
      `👉 Hãy kiểm tra và trả lời thủ công trên app Zalo.`,
    ].join("\n");
  }
  return [
    `✅ <b>Đã trả lời người ${escapeHtml(l.senderName)}</b>`,
    `👥 Nhóm: <b>${escapeHtml(l.groupName)}</b>`,
    `💬 Tin của họ: ${escapeHtml(clip(l.text))}`,
    `↩️ Tin nhắn trả lời: "${escapeHtml(l.reply)}"`,
    ...formatRace(l),
    `🕒 ${time(l.at)}`,
    ``,
    `👉 Hãy kiểm tra tin nhắn ở app Zalo.`,
  ].join("\n");
}

const secs = (ms: number) => `${(ms / 1000).toFixed(2)}s`;

function formatRace(l: ReplyLog): string[] {
  const r = l.race;
  if (!r) return [`❔ Vị trí: chưa xác minh được (không nhận được xác nhận từ server Zalo)`];
  const speed = r.ourDeltaMs != null ? ` · ⚡ mình gửi sau ${secs(r.ourDeltaMs)}` : "";
  if (r.rank === 1) return [`🥇 Vị trí: <b>#1, trả lời đầu tiên</b>${speed}`];
  return [
    `⚠️ Vị trí: <b>#${r.rank}</b>, có <b>${r.ahead.length} người</b> nhắn trước mình${speed}`,
    ...r.ahead.slice(0, 5).map((a) => `   • ${escapeHtml(a.name)} (+${secs(a.deltaMs)}): ${escapeHtml(clip(a.text, 60))}`),
    ...(r.ahead.length > 5 ? [`   • … và ${r.ahead.length - 5} người khác`] : []),
  ];
}

class TelegramNotifier {
  private queue: string[] = [];
  private sending = false;
  private lastSentAt = 0;
  private disconnectTimer: NodeJS.Timeout | null = null;
  private alertedDisconnect = false;
  private wasConnected = false;
  private lastStatus: ZaloStatus | null = null;

  constructor() {
    bus.on("log_final", (l) => this.onLog(l));
    bus.on("status", (s) => this.onStatus(s));
  }

  get(): TelegramSettings {
    return { ...defaults, ...settings.get<Partial<TelegramSettings>>(SETTINGS_KEY) };
  }

  /** Dạng trả về cho web: không lộ token đầy đủ. */
  getPublic() {
    const { token, ...rest } = this.get();
    return { ...rest, hasToken: !!token, tokenPreview: token ? `${token.slice(0, 6)}…${token.slice(-4)}` : "" };
  }

  save(patch: Partial<TelegramSettings>) {
    const next = { ...this.get(), ...patch };
    next.token = next.token.trim();
    next.chatId = next.chatId.trim();
    settings.set(SETTINGS_KEY, next);
    return this.getPublic();
  }

  async verifyToken(token: string) {
    return callTelegram<{ username: string; first_name: string }>(token, "getMe");
  }

  /** Liệt kê các nhóm/chat gần đây đã nhắn cho bot, để người dùng chọn chat ID. */
  async findChats() {
    const { token } = this.get();
    if (!token) throw new Error("Chưa nhập token bot");
    const updates = await callTelegram<Array<Record<string, any>>>(token, "getUpdates", { limit: 100, timeout: 0 });
    const chats = new Map<string, { id: string; title: string; type: string }>();
    for (const u of updates) {
      const chat = (u.message ?? u.channel_post ?? u.my_chat_member ?? u.edited_message)?.chat;
      if (!chat) continue;
      chats.set(String(chat.id), {
        id: String(chat.id),
        title: chat.title || [chat.first_name, chat.last_name].filter(Boolean).join(" ") || chat.username || String(chat.id),
        type: chat.type,
      });
    }
    return [...chats.values()];
  }

  async sendTest() {
    const { token, chatId } = this.get();
    if (!token || !chatId) throw new Error("Cần nhập token và chat ID trước");
    await callTelegram(token, "sendMessage", {
      chat_id: chatId,
      parse_mode: "HTML",
      text: "🔔 <b>Zalo Auto Reply</b>\nKết nối Telegram thành công! Thông báo đã được BẬT: bot sẽ gửi tin về đây mỗi khi tự động trả lời.",
    });
    // Gửi thử được nghĩa là cấu hình đúng: bật luôn để người dùng không quên bật công tắc.
    return this.save({ enabled: true });
  }

  private onLog(l: ReplyLog) {
    const s = this.get();
    if (!s.enabled || !s.token || !s.chatId) return;
    if (l.ok ? !s.notifyReplies : !s.notifyErrors) return;
    this.enqueue(formatReply(l));
  }

  private onStatus(status: ZaloStatus) {
    this.lastStatus = status;
    if (status.state === "connected") {
      if (this.disconnectTimer) clearTimeout(this.disconnectTimer);
      this.disconnectTimer = null;
      if (this.alertedDisconnect) this.notifyStatus(`✅ <b>Bot Zalo đã kết nối lại</b> (${escapeHtml(status.name)})`);
      this.alertedDisconnect = false;
      this.wasConnected = true;
      return;
    }
    if (!this.wasConnected || this.disconnectTimer || this.alertedDisconnect) return;
    this.disconnectTimer = setTimeout(() => {
      this.disconnectTimer = null;
      const current = this.lastStatus;
      if (current?.state === "connected") return;
      this.alertedDisconnect = true;
      const reason = current && "reason" in current && current.reason ? `\nLý do: ${escapeHtml(current.reason)}` : "";
      this.notifyStatus(`⚠️ <b>Bot Zalo mất kết nối</b>, đang tự thử lại.${reason}\nNếu kéo dài, hãy vào web panel kiểm tra.`);
    }, DISCONNECT_ALERT_DELAY_MS);
  }

  private notifyStatus(text: string) {
    const s = this.get();
    if (s.enabled && s.notifyStatus && s.token && s.chatId) this.enqueue(text);
  }

  private enqueue(text: string) {
    this.queue.push(text);
    if (this.queue.length > 200) this.queue.shift();
    void this.flush();
  }

  private async flush() {
    if (this.sending) return;
    this.sending = true;
    try {
      while (this.queue.length) {
        const wait = this.lastSentAt + MIN_GAP_MS - Date.now();
        if (wait > 0) await new Promise((r) => setTimeout(r, wait));
        const batch = this.queue.splice(0, MAX_BATCH);
        const { token, chatId } = this.get();
        if (!token || !chatId) {
          this.queue = [];
          break;
        }
        try {
          await callTelegram(token, "sendMessage", {
            chat_id: chatId,
            parse_mode: "HTML",
            disable_web_page_preview: true,
            text: batch.join("\n\n━━━━━━━━━━\n\n"),
          });
        } catch (err) {
          const retryAfter = (err as { retryAfter?: number }).retryAfter;
          console.warn("[telegram] Gửi thông báo lỗi:", (err as Error).message);
          if (retryAfter) {
            this.queue.unshift(...batch);
            await new Promise((r) => setTimeout(r, retryAfter * 1000));
          }
        }
        this.lastSentAt = Date.now();
      }
    } finally {
      this.sending = false;
    }
  }
}

export const telegram = new TelegramNotifier();
