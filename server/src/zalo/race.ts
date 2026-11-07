import type { API, GroupMessage, Message } from "zca-js";
import type { AheadMessage, RaceResult } from "../events.js";
import { db } from "../db.js";

/**
 * Kiểm tra THỰC TẾ xem giữa tin của người được nghe và tin trả lời của mình
 * có bao nhiêu người khác đã nhắn. Ưu tiên đối chiếu lịch sử chat lấy từ server Zalo
 * (thứ tự do server quyết định); nếu không được thì dùng các tin đã nhận qua WebSocket.
 */

type Seen = { msgId: string; uid: string; name: string; ts: number; text: string; isSelf: boolean };

const BUFFER_MS = 2 * 60_000;
const BUFFER_MAX = 300;
const buffers = new Map<string, Seen[]>();

/** Danh sách người đã nhắn trong nhóm mà bot thấy được (dùng cho ô chọn người ở nhóm lớn). */
const senders = new Map<string, Map<string, { name: string; lastTs: number }>>();
const SENDERS_MAX = 2000;

const upsertSender = db.prepare(`
  INSERT INTO group_senders (group_id, uid, name, last_ts) VALUES (?, ?, ?, ?)
  ON CONFLICT(group_id, uid) DO UPDATE SET name = excluded.name, last_ts = excluded.last_ts
`);
for (const r of db.prepare<[], { group_id: string; uid: string; name: string; last_ts: number }>(
  "SELECT * FROM group_senders ORDER BY last_ts",
).all()) {
  rememberSender(r.group_id, r.uid, r.name, r.last_ts, false);
}

// Gom ghi DB mỗi 5 giây, để không bao giờ chạm vào đường trả lời.
const dirty = new Map<string, [string, string, string, number]>();
setInterval(() => {
  if (!dirty.size) return;
  const rows = [...dirty.values()];
  dirty.clear();
  db.transaction(() => rows.forEach((r) => upsertSender.run(...r)))();
}, 5_000).unref();

const textOf = (content: unknown, msgType: string) =>
  typeof content === "string" ? content : `[${msgType}]`;

function toSeen(m: GroupMessage): Seen {
  return {
    msgId: String(m.data.msgId),
    uid: m.data.uidFrom,
    name: m.data.dName,
    ts: Number(m.data.ts),
    text: textOf(m.data.content, m.data.msgType),
    isSelf: m.isSelf,
  };
}

/** Thứ tự server: so msgId (số tăng dần do server cấp), trùng thì so ts. */
function compare(a: Seen, b: Seen): number {
  try {
    const d = BigInt(a.msgId) - BigInt(b.msgId);
    if (d !== 0n) return d < 0n ? -1 : 1;
  } catch {
    /* msgId không phải số */
  }
  return a.ts - b.ts;
}

/** Ghi nhận mọi tin nhóm (kể cả tin của chính mình) để đối chiếu sau. Rất nhẹ, chạy sau đường trả lời. */
export function observe(msg: Message) {
  if (msg.type !== 1 /* ThreadType.Group */) return;
  const seen = toSeen(msg as GroupMessage);
  const list = buffers.get(msg.threadId) ?? [];
  list.push(seen);
  const cutoff = Date.now() - BUFFER_MS;
  while (list.length && (list.length > BUFFER_MAX || list[0].ts < cutoff)) list.shift();
  buffers.set(msg.threadId, list);
  if (!seen.isSelf) rememberSender(msg.threadId, seen.uid, seen.name, seen.ts);
}

export function rememberSender(groupId: string, uid: string, name: string, ts: number, persist = true) {
  let map = senders.get(groupId);
  if (!map) senders.set(groupId, (map = new Map()));
  map.delete(uid); // đưa xuống cuối = mới nhất
  map.set(uid, { name, lastTs: ts });
  if (map.size > SENDERS_MAX) map.delete(map.keys().next().value!);
  if (persist) dirty.set(`${groupId}:${uid}`, [groupId, uid, name, ts]);
}

export function knownSenders(groupId: string) {
  return [...(senders.get(groupId) ?? new Map()).entries()].map(([id, v]) => ({ id, ...v }));
}

function analyze(list: Seen[], trigger: Seen, ourMsgId: string, selfId: string): RaceResult | null {
  const sorted = [...list].sort(compare);
  const ti = sorted.findIndex((m) => m.msgId === trigger.msgId);
  const oi = sorted.findIndex((m) => m.msgId === ourMsgId);
  if (ti < 0 || oi < 0) return null;
  const between = sorted.slice(ti + 1, oi);
  const ahead: AheadMessage[] = between
    .filter((m) => !m.isSelf && m.uid !== selfId && m.uid !== trigger.uid)
    .map((m) => ({ name: m.name, text: m.text, deltaMs: m.ts - trigger.ts }));
  return {
    rank: ahead.length + 1,
    ahead,
    ourDeltaMs: sorted[oi].ts - trigger.ts,
  };
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const ECHO_TIMEOUT_MS = 6_000;
/** Chờ thêm sau khi nhận được tin của mình, để các tin server xếp trước nhưng đến trễ kịp về. */
const GRACE_MS = 1_500;

/**
 * Gọi sau khi đã gửi trả lời xong. Dữ liệu dùng để đếm là dữ liệu thật từ server Zalo:
 * - tin của người được nghe và tin của người khác: nhận qua WebSocket, kèm msgId/ts do server cấp;
 * - tin trả lời của mình: server gửi ngược lại (selfListen), cũng kèm msgId/ts do server cấp.
 * Không nhận được tin của mình từ server thì trả về null ("chưa xác minh được"), không ước đoán.
 *
 * (API lịch sử chat nhóm của zca-js đã bị Zalo bỏ, trả về 404, nên không dùng được.)
 */
export async function verifyRace(
  api: API,
  groupId: string,
  triggerMsg: GroupMessage,
  ourMsgId: string | null,
  replyText: string,
): Promise<RaceResult | null> {
  const trigger = toSeen(triggerMsg);
  const selfId = api.getOwnId();

  const findOurs = () =>
    (buffers.get(groupId) ?? []).find(
      (m) =>
        m.isSelf &&
        // Khớp msgId trả về khi gửi; dự phòng: tin đầu tiên của mình có đúng nội dung trả lời, sau tin kích hoạt.
        (m.msgId === ourMsgId || (m.text === replyText && compare(m, trigger) > 0)),
    );

  const deadline = Date.now() + ECHO_TIMEOUT_MS;
  while (!findOurs() && Date.now() < deadline) await sleep(100);
  const ours = findOurs();
  if (!ours) return null;

  await sleep(GRACE_MS);
  const list = (buffers.get(groupId) ?? []).filter((m) => m.msgId !== trigger.msgId);
  return analyze([...list, trigger], trigger, ours.msgId, selfId);
}

