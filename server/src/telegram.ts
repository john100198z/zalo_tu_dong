import { Agent } from "undici";
import { settings } from "./db.js";
import { bus, type ReplyLog, type ZaloStatus } from "./events.js";
import { replyMode } from "./replyMode.js";
import { rules } from "./rules.js";

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

/**
 * Kết nối riêng cho Telegram. DNS trả cả IPv6 nhưng VPS không có IPv6, và Node mặc định chỉ chờ
 * 250ms cho mỗi lần nối IPv4 trước khi chuyển sang IPv6: đường tới Telegram mất ~250-330ms nên
 * ~1/3 lần nối báo ETIMEDOUT ("fetch failed"). Ép IPv4, cho chờ đủ lâu, và giữ kết nối để dùng lại.
 */
const tgAgent = new Agent({
  connect: { family: 4, timeout: 10_000 },
  keepAliveTimeout: 20_000,
  keepAliveMaxTimeout: 60_000,
});

/** Lỗi lúc đang nối: request chắc chắn chưa tới Telegram, gửi lại không bị trùng. */
const CONNECT_ERRORS = new Set(["ETIMEDOUT", "ECONNREFUSED", "ENETUNREACH", "EHOSTUNREACH", "EAI_AGAIN", "UND_ERR_CONNECT_TIMEOUT"]);
/** Lỗi đứt giữa chừng: Telegram có thể đã nhận, chỉ gửi lại với lệnh không tạo tin mới. */
const SOCKET_ERRORS = new Set(["ECONNRESET", "EPIPE", "UND_ERR_SOCKET", "UND_ERR_CLOSED"]);

const causeCode = (err: unknown) => {
  const c = (err as { cause?: { code?: string; name?: string } })?.cause;
  return c?.code ?? c?.name;
};

/** "fetch failed (ETIMEDOUT)": kèm mã lỗi thật để log có ích. */
export const describeError = (err: unknown) => {
  const code = causeCode(err);
  return `${(err as Error)?.message ?? String(err)}${code ? ` (${code})` : ""}`;
};

async function callTelegram<T>(
  token: string,
  method: string,
  body?: unknown,
  opts: { signal?: AbortSignal; timeoutMs?: number } = {},
): Promise<T> {
  const send = () => {
    const timeout = AbortSignal.timeout(opts.timeoutMs ?? 15_000);
    return fetch(`https://api.telegram.org/bot${token}/${method}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body ?? {}),
      signal: opts.signal ? AbortSignal.any([opts.signal, timeout]) : timeout,
      dispatcher: tgAgent,
    } as RequestInit);
  };
  let res: Response;
  try {
    res = await send();
  } catch (err) {
    const code = causeCode(err) ?? "";
    const retryable = CONNECT_ERRORS.has(code) || (method !== "sendMessage" && SOCKET_ERRORS.has(code));
    if (!retryable || opts.signal?.aborted) throw err;
    res = await send();
  }
  const data = (await res.json().catch(() => ({}))) as { ok?: boolean; result?: T; description?: string; parameters?: { retry_after?: number } };
  if (!data.ok) {
    const err = new Error(data.description || `Telegram lỗi ${res.status}`) as Error & { retryAfter?: number };
    err.retryAfter = data.parameters?.retry_after;
    throw err;
  }
  return data.result as T;
}

function formatReply(l: ReplyLog) {
  const head = [
    `${l.ok ? "✅" : "❌"} Người gửi: <b>${escapeHtml(l.senderName)}</b>`,
    `👥 ${escapeHtml(l.groupName)}`,
    `💬 ${escapeHtml(clip(l.text, 200))}`,
  ];
  if (!l.ok) return [...head, `⚠️ Lỗi: ${escapeHtml(l.error ?? "")}`, `🕒 ${time(l.at)}`].join("\n");
  return [...head, `↩️ "${escapeHtml(l.reply)}"`, ...formatRace(l), `🕒 ${time(l.at)}`].join("\n");
}

function formatRace(l: ReplyLog): string[] {
  const r = l.race;
  // Thời gian phản hồi theo đồng hồ server Zalo; chưa xác minh được thì dùng số đo phía mình.
  const speed = ` · ⚡ ${((r?.ourDeltaMs ?? l.totalMs) / 1000).toFixed(2)}s`;
  if (!r) return [`❔ Vị trí: chưa rõ${speed}`];
  if (r.rank === 1) return [`🥇 Vị trí: <b>#1</b>${speed}`];
  return [
    `⚠️ Vị trí: <b>#${r.rank}</b> (${r.ahead.length} người trước)${speed}`,
    ...r.ahead.slice(0, 3).map((a) => `   • ${escapeHtml(a.name)}: ${escapeHtml(clip(a.text, 40))}`),
  ];
}

function zaloLine(s: ZaloStatus | null) {
  switch (s?.state) {
    case "connected":
      return `🟢 Zalo: <b>đã kết nối</b> (${escapeHtml(s.name)})`;
    case "connecting":
      return `🟡 Zalo: <b>đang kết nối lại…</b>`;
    case "qr":
    case "qr_scanned":
      return `🟡 Zalo: <b>đang chờ quét QR</b>`;
    case "disconnected":
      return `🔴 Zalo: <b>chưa kết nối</b>${s.reason ? ` (${escapeHtml(clip(s.reason, 120))})` : ""}`;
    default:
      return `⚪ Zalo: <b>đang khởi động</b>`;
  }
}

const PANEL_SEPARATOR = "──────────";
// Tin đã bị xoá / quá cũ / không đổi: không phải lỗi cần ghi log.
const EDIT_IGNORABLE = /not modified|not found|can't be edited|message to edit/i;

function toChat(chat: Record<string, any>): TelegramChat {
  return {
    id: String(chat.id),
    title: chat.title || [chat.first_name, chat.last_name].filter(Boolean).join(" ") || chat.username || String(chat.id),
    type: chat.type,
  };
}

/** header: nội dung tin báo trả lời được gộp chung với bảng trạng thái (giữ nguyên khi tự cập nhật). */
function formatPanel(status: ZaloStatus | null, header?: string) {
  const mode = replyMode.get();
  const groups = rules.hot.size;
  const listening = !mode.working
    ? `🔴 <b>ĐANG DỪNG</b> (nghỉ làm, không trả lời nhóm nào)`
    : mode.paused
    ? `⏸ <b>ĐANG DỪNG lắng nghe tất cả nhóm</b>`
    : status?.state !== "connected"
      ? `🔴 <b>KHÔNG trả lời được</b> vì Zalo chưa kết nối`
      : groups === 0
          ? `⚪ Chưa bật nhóm nào để lắng nghe`
          : `▶️ <b>Đang lắng nghe ${groups} nhóm</b>`;
  return [
    ...(header ? [header, PANEL_SEPARATOR] : [`🤖 <b>Zalo Auto Reply</b>`, ``]),
    zaloLine(status),
    listening,
    ...(mode.working && mode.paused && mode.pausedBy
      ? [
          `↳ Đã trả lời 1 lần: <b>${escapeHtml(mode.pausedBy.senderName)}</b> trong nhóm <b>${escapeHtml(mode.pausedBy.groupName)}</b>` +
            (mode.pausedAt ? ` lúc ${time(mode.pausedAt)}` : ""),
        ]
      : []),
    `1️⃣ Trả lời 1 lần rồi dừng: <b>${mode.oneShot ? "đang mở" : "đã tắt"}</b>`,
  ].join("\n");
}

function panelKeyboard() {
  const mode = replyMode.get();
  const rows = [
    [
      mode.working
        ? { text: "🟢 ĐANG LÀM VIỆC (ấn nếu dừng hoạt động)", callback_data: "work_off" }
        : { text: "🔴 ĐANG DỪNG (ấn nếu muốn làm việc)", callback_data: "work_on" },
    ],
    [
      mode.oneShot
        ? { text: "🟢 1 lần rồi dừng: ON (bấm để tắt)", callback_data: "oneshot_off" }
        : { text: "⚪ 1 lần rồi dừng: OFF (bấm để mở)", callback_data: "oneshot_on" },
    ],
  ];
  if (mode.working && mode.paused) rows.push([{ text: "▶️ Tiếp tục lắng nghe", callback_data: "resume" }]);
  rows.push([{ text: "🔄 Làm mới", callback_data: "refresh" }]);
  return { inline_keyboard: rows };
}

type QueueItem = { text: string; withPanel?: boolean };
type Panel = { chatId: string; messageId: number; header?: string };
type TelegramChat = { id: string; title: string; type: string };

const PANEL_REFRESH_DELAY_MS = 800;

class TelegramNotifier {
  private queue: QueueItem[] = [];
  private sending = false;
  private lastSentAt = 0;
  private disconnectTimer: NodeJS.Timeout | null = null;
  private alertedDisconnect = false;
  private wasConnected = false;
  private lastStatus: ZaloStatus | null = null;

  private started = false;
  private pollToken = "";
  private pollAbort: AbortController | null = null;
  private botUsername = "";
  private seenChats = new Map<string, TelegramChat>();
  /** Tin duy nhất đang có nút và trạng thái realtime. */
  private panel: Panel | null = null;
  private panelTimer: NodeJS.Timeout | null = null;
  private cached: TelegramSettings | null = null;

  constructor() {
    bus.on("log_final", (l) => this.onLog(l));
    bus.on("status", (s) => {
      this.onStatus(s);
      this.schedulePanelRefresh();
    });
    bus.on("reply_mode", () => this.schedulePanelRefresh());
  }

  /** Bắt đầu nhận nút bấm và tin nhắc tên bot từ Telegram. */
  start() {
    this.started = true;
    this.syncPoller();
  }

  private syncPoller() {
    if (!this.started) return;
    const { token } = this.get();
    if (token === this.pollToken && this.pollAbort) return;
    this.pollAbort?.abort();
    this.pollAbort = null;
    this.pollToken = token;
    this.botUsername = "";
    this.seenChats.clear();
    this.panel = null;
    if (!token) return;
    const abort = new AbortController();
    this.pollAbort = abort;
    void this.poll(token, abort.signal);
  }

  private async poll(token: string, signal: AbortSignal) {
    let offset = 0;
    while (!signal.aborted) {
      try {
        if (!this.botUsername) {
          const me = await callTelegram<{ username: string }>(token, "getMe", undefined, { signal });
          this.botUsername = me.username;
          await callTelegram(token, "setMyCommands", {
            commands: [{ command: "trangthai", description: "Xem trạng thái và bật/tắt bot Zalo" }],
          }, { signal }).catch(() => {});
        }
        const updates = await callTelegram<Array<Record<string, any>>>(
          token,
          "getUpdates",
          { offset, timeout: 25, allowed_updates: ["message", "callback_query", "my_chat_member"] },
          { signal, timeoutMs: 40_000 },
        );
        for (const u of updates) {
          offset = u.update_id + 1;
          await this.handleUpdate(token, u).catch((err) => console.warn("[telegram] Xử lý cập nhật lỗi:", describeError(err)));
        }
      } catch (err) {
        if (signal.aborted) return;
        console.warn("[telegram] Nhận cập nhật lỗi:", describeError(err));
        await new Promise((r) => setTimeout(r, 5_000));
      }
    }
  }

  private async handleUpdate(token: string, u: Record<string, any>) {
    const msg = u.message;
    const chat = (msg ?? u.my_chat_member)?.chat;
    if (chat) this.seenChats.set(String(chat.id), toChat(chat));

    const { chatId } = this.get();
    if (msg && String(msg.chat.id) === chatId && this.isCallingMe(msg)) {
      await this.sendPanel(msg.message_id);
      return;
    }

    const cq = u.callback_query;
    if (!cq) return;
    const panel: Panel | null = cq.message ? this.panelFromMessage(cq.message) : null;
    // Chỉ nhóm Telegram đã cấu hình mới được điều khiển bot.
    if (!panel || panel.chatId !== chatId) {
      await callTelegram(token, "answerCallbackQuery", { callback_query_id: cq.id, text: "Không có quyền điều khiển" });
      return;
    }
    let toast = "Đã cập nhật";
    if (cq.data === "work_on") {
      replyMode.update({ working: true });
      toast = "🟢 Đã VÀO LÀM: bot bắt đầu trả lời";
    } else if (cq.data === "work_off") {
      replyMode.update({ working: false });
      toast = "🔴 Đã NGHỈ LÀM: bot dừng trả lời";
    } else if (cq.data === "oneshot_on") {
      replyMode.update({ oneShot: true });
      toast = "Đã BẬT: trả lời 1 lần rồi dừng";
    } else if (cq.data === "oneshot_off") {
      replyMode.update({ oneShot: false });
      toast = "Đã TẮT chế độ 1 lần, bot lắng nghe lại";
    } else if (cq.data === "resume") {
      replyMode.update({ paused: false });
      toast = "▶️ Đã tiếp tục lắng nghe";
    }
    await callTelegram(token, "answerCallbackQuery", { callback_query_id: cq.id, text: toast });
    this.trackPanel(panel);
    await this.editPanel(panel);
  }

  private isCallingMe(msg: Record<string, any>) {
    const text: string = msg.text ?? "";
    const me = this.botUsername.toLowerCase();
    const cmd = /^\/(trangthai|status|start|menu)(@\w+)?\b/i.exec(text);
    if (cmd) return !cmd[2] || cmd[2].slice(1).toLowerCase() === me;
    if (me && text.toLowerCase().includes(`@${me}`)) return true;
    // Trả lời vào tin của bot cũng tính là gọi bot.
    return !!me && msg.reply_to_message?.from?.username?.toLowerCase() === me;
  }

  /** Lấy lại panel đang theo dõi, hoặc dựng lại phần tin báo từ chính tin nhắn (sau khi server khởi động lại). */
  private panelFromMessage(m: Record<string, any>): Panel {
    const chatId = String(m.chat.id);
    const p = this.panel;
    if (p && p.chatId === chatId && p.messageId === m.message_id) return p;
    const text: string = m.text ?? "";
    const cut = text.indexOf(PANEL_SEPARATOR);
    return { chatId, messageId: m.message_id, header: cut > 0 ? escapeHtml(text.slice(0, cut).trimEnd()) : undefined };
  }

  private async sendPanel(replyTo?: number, header?: string) {
    const { token, chatId } = this.get();
    if (!token || !chatId) return;
    const sent = await callTelegram<{ message_id: number }>(token, "sendMessage", {
      chat_id: chatId,
      parse_mode: "HTML",
      text: formatPanel(this.lastStatus, header),
      reply_markup: panelKeyboard(),
      disable_web_page_preview: true,
      ...(replyTo ? { reply_parameters: { message_id: replyTo, allow_sending_without_reply: true } } : {}),
    });
    this.trackPanel({ chatId, messageId: sent.message_id, header });
  }

  /** Chỉ tin mới nhất có nút và trạng thái realtime; tin trước đó bị gỡ nút. */
  private trackPanel(p: Panel) {
    const old = this.panel;
    this.panel = p;
    if (old && !(old.chatId === p.chatId && old.messageId === p.messageId)) void this.retirePanel(old);
  }

  private async retirePanel(p: Panel) {
    const { token } = this.get();
    if (!token) return;
    try {
      if (p.header) {
        // Bỏ phần trạng thái (sẽ cũ) và nút, chỉ giữ tin báo trả lời.
        await callTelegram(token, "editMessageText", {
          chat_id: p.chatId,
          message_id: p.messageId,
          parse_mode: "HTML",
          text: p.header,
          disable_web_page_preview: true,
        });
      } else {
        await callTelegram(token, "editMessageReplyMarkup", {
          chat_id: p.chatId,
          message_id: p.messageId,
          reply_markup: { inline_keyboard: [] },
        });
      }
    } catch (err) {
      const m = (err as Error).message;
      if (!EDIT_IGNORABLE.test(m)) console.warn("[telegram] Gỡ nút tin cũ lỗi:", describeError(err));
    }
  }

  private async editPanel(p: Panel) {
    const { token } = this.get();
    if (!token) return;
    try {
      await callTelegram(token, "editMessageText", {
        chat_id: p.chatId,
        message_id: p.messageId,
        parse_mode: "HTML",
        text: formatPanel(this.lastStatus, p.header),
        reply_markup: panelKeyboard(),
        disable_web_page_preview: true,
      });
    } catch (err) {
      const m = (err as Error).message;
      if (m.includes("not modified")) return;
      if (!EDIT_IGNORABLE.test(m)) return console.warn("[telegram] Cập nhật bảng điều khiển lỗi:", describeError(err));
      // Tin đã bị xoá hoặc quá cũ: bỏ theo dõi.
      if (this.panel === p) this.panel = null;
    }
  }

  private schedulePanelRefresh() {
    if (!this.panel || this.panelTimer) return;
    this.panelTimer = setTimeout(() => {
      this.panelTimer = null;
      if (this.panel) void this.editPanel(this.panel);
    }, PANEL_REFRESH_DELAY_MS);
  }

  /** Cache trong RAM: được gọi ở mọi tin báo/nút bấm, chỉ đọc DB lần đầu. */
  get(): TelegramSettings {
    this.cached ??= { ...defaults, ...settings.get<Partial<TelegramSettings>>(SETTINGS_KEY) };
    return this.cached;
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
    this.cached = next;
    this.syncPoller();
    return this.getPublic();
  }

  async verifyToken(token: string) {
    return callTelegram<{ username: string; first_name: string }>(token, "getMe");
  }

  /**
   * Các chat đã nhắn cho bot (kể cả tin tồn từ trước khi server chạy, vì lần nhận đầu lấy cả tin tồn).
   * Không gọi getUpdates riêng: Telegram báo lỗi 409 khi đang nhận cập nhật liên tục.
   */
  findChats() {
    if (!this.get().token) throw new Error("Chưa nhập token bot");
    return [...this.seenChats.values()];
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
    // Bot vừa tự dừng: gộp tin báo với bảng trạng thái + nút "Tiếp tục lắng nghe" thành 1 tin.
    this.enqueue({ text: formatReply(l), withPanel: l.pausedAfter });
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
    if (s.enabled && s.notifyStatus && s.token && s.chatId) this.enqueue({ text });
  }

  private enqueue(item: QueueItem) {
    this.queue.push(item);
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
        const { token, chatId } = this.get();
        if (!token || !chatId) {
          this.queue = [];
          break;
        }
        // Tin kèm nút gửi riêng; các tin thường liền nhau thì gộp.
        let n = 1;
        if (!this.queue[0].withPanel) while (n < MAX_BATCH && n < this.queue.length && !this.queue[n].withPanel) n++;
        const batch = this.queue.splice(0, n);
        try {
          if (batch[0].withPanel) {
            await this.sendPanel(undefined, batch[0].text);
          } else {
            await callTelegram(token, "sendMessage", {
              chat_id: chatId,
              parse_mode: "HTML",
              disable_web_page_preview: true,
              text: batch.map((i) => i.text).join("\n\n━━━━━━━━━━\n\n"),
            });
          }
        } catch (err) {
          const retryAfter = (err as { retryAfter?: number }).retryAfter;
          console.warn("[telegram] Gửi thông báo lỗi:", describeError(err));
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
