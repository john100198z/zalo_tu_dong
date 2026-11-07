import { ThreadType, type Message } from "zca-js";
import { db } from "../db.js";
import { bus } from "../events.js";

/**
 * Lưu tin nhắn nhận qua WebSocket để xem trên trang /message (chỉ xem).
 * Zalo không có API lấy lịch sử, nên chỉ có tin từ lúc bot chạy.
 * Đường trả lời chỉ đẩy tin vào mảng trong RAM; ghi DB gom mỗi giây, không gọi API Zalo nào.
 */

export type ChatAttach = { title?: string; href?: string; thumb?: string };
export type ChatMessage = {
  threadId: string;
  msgId: string;
  isGroup: boolean;
  uid: string;
  name: string;
  ts: number;
  isSelf: boolean;
  kind: string;
  text: string;
  attach?: ChatAttach;
  quote?: { name: string; text: string };
};
export type ChatThread = {
  threadId: string;
  isGroup: boolean;
  name: string;
  lastTs: number;
  lastText: string;
  lastName: string;
  lastSelf: boolean;
};

const KEEP_PER_THREAD = 300;
const FLUSH_MS = 1_000;
const PENDING_MAX = 5_000;

db.exec(`
  CREATE TABLE IF NOT EXISTS chat_messages (
    thread_id TEXT NOT NULL,
    msg_id    TEXT NOT NULL,
    ts        INTEGER NOT NULL,
    data      TEXT NOT NULL,
    PRIMARY KEY (thread_id, msg_id)
  );
  CREATE INDEX IF NOT EXISTS chat_messages_ts ON chat_messages (thread_id, ts);

  CREATE TABLE IF NOT EXISTS chat_threads (
    thread_id TEXT PRIMARY KEY,
    is_group  INTEGER NOT NULL,
    name      TEXT NOT NULL DEFAULT '',
    last_ts   INTEGER NOT NULL,
    last_text TEXT NOT NULL,
    last_name TEXT NOT NULL,
    last_self INTEGER NOT NULL
  );
`);

const insertMsg = db.prepare("INSERT OR IGNORE INTO chat_messages (thread_id, msg_id, ts, data) VALUES (?, ?, ?, ?)");
const upsertThread = db.prepare(`
  INSERT INTO chat_threads (thread_id, is_group, name, last_ts, last_text, last_name, last_self)
  VALUES (@threadId, @isGroup, @name, @ts, @text, @lastName, @isSelf)
  ON CONFLICT(thread_id) DO UPDATE SET
    name = CASE WHEN excluded.name != '' THEN excluded.name ELSE chat_threads.name END,
    last_ts = excluded.last_ts, last_text = excluded.last_text,
    last_name = excluded.last_name, last_self = excluded.last_self
  WHERE excluded.last_ts >= chat_threads.last_ts
`);
const pruneThread = db.prepare(`
  DELETE FROM chat_messages WHERE thread_id = @id AND ts < (
    SELECT ts FROM chat_messages WHERE thread_id = @id ORDER BY ts DESC LIMIT 1 OFFSET ${KEEP_PER_THREAD - 1}
  )
`);
const setNameStmt = db.prepare("UPDATE chat_threads SET name = ? WHERE thread_id = ?");
const threadsStmt = db.prepare<[], Record<string, any>>("SELECT * FROM chat_threads ORDER BY last_ts DESC LIMIT 1000");
const pageStmt = db.prepare<[string, number, number], { data: string }>(
  "SELECT data FROM chat_messages WHERE thread_id = ? AND ts < ? ORDER BY ts DESC LIMIT ?",
);

const LABELS: Record<string, string> = {
  "chat.photo": "[Ảnh]",
  "chat.sticker": "[Sticker]",
  "chat.video.msg": "[Video]",
  "chat.voice": "[Tin nhắn thoại]",
  "chat.gif": "[GIF]",
  "share.file": "[File]",
  "chat.recommended": "[Liên kết]",
  "chat.link": "[Liên kết]",
  "chat.location.new": "[Vị trí]",
  "chat.doodle": "[Hình vẽ]",
  "chat.todo": "[Việc cần làm]",
  "group.poll": "[Bình chọn]",
};

const str = (v: unknown) => (typeof v === "string" && v ? v : undefined);

function toChat(m: Message): ChatMessage {
  const d = m.data;
  const isGroup = m.type === ThreadType.Group;
  const base = {
    threadId: m.threadId,
    msgId: String(d.msgId),
    isGroup,
    uid: d.uidFrom,
    name: d.dName ?? "",
    ts: Number(d.ts),
    isSelf: m.isSelf,
    quote: d.quote ? { name: d.quote.fromD ?? "", text: d.quote.msg || "[Đính kèm]" } : undefined,
  };
  if (typeof d.content === "string") return { ...base, kind: "text", text: d.content };
  const c = (d.content ?? {}) as Record<string, unknown>;
  const label = LABELS[d.msgType] ?? `[${d.msgType}]`;
  const attach: ChatAttach = { title: str(c.title), href: str(c.href), thumb: str(c.thumb) };
  return {
    ...base,
    kind: d.msgType,
    text: str(c.title) ?? str(c.description) ?? label,
    attach: attach.href || attach.thumb ? attach : undefined,
  };
}

let pending: Message[] = [];

/** Gọi trên đường xử lý tin: chỉ đẩy vào mảng, không làm gì khác. */
export function archive(msg: Message) {
  if (pending.length < PENDING_MAX) pending.push(msg);
}

const writeBatch = db.transaction((chats: ChatMessage[]) => {
  const touched = new Set<string>();
  for (const c of chats) {
    if (!insertMsg.run(c.threadId, c.msgId, c.ts, JSON.stringify(c)).changes) continue;
    upsertThread.run({
      threadId: c.threadId,
      isGroup: c.isGroup ? 1 : 0,
      // Tên cuộc trò chuyện riêng = tên người kia; nhóm lấy từ danh sách nhóm khi xem.
      name: !c.isGroup && !c.isSelf ? c.name : "",
      ts: c.ts,
      text: c.text,
      lastName: c.isSelf ? "Bạn" : c.name,
      isSelf: c.isSelf ? 1 : 0,
    });
    touched.add(c.threadId);
  }
  for (const id of touched) pruneThread.run({ id });
});

export function flushArchive() {
  if (!pending.length) return;
  const batch = pending;
  pending = [];
  const chats = batch.map(toChat);
  try {
    writeBatch(chats);
  } catch (err) {
    console.error("[archive] Lưu tin nhắn lỗi:", err);
  }
  bus.emit("chat", chats);
}

setInterval(flushArchive, FLUSH_MS).unref();

export function listThreads(): ChatThread[] {
  return threadsStmt.all().map((r) => ({
    threadId: r.thread_id,
    isGroup: !!r.is_group,
    name: r.name,
    lastTs: r.last_ts,
    lastText: r.last_text,
    lastName: r.last_name,
    lastSelf: !!r.last_self,
  }));
}

export function setThreadName(threadId: string, name: string) {
  setNameStmt.run(name, threadId);
}

/** Tin cũ hơn `before`, trả về theo thứ tự thời gian tăng dần. */
export function getMessages(threadId: string, before = Number.MAX_SAFE_INTEGER, limit = 50): ChatMessage[] {
  return pageStmt
    .all(threadId, before, Math.min(limit, 200))
    .map((r) => JSON.parse(r.data) as ChatMessage)
    .reverse();
}
