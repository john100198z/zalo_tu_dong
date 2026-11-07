import { EventEmitter } from "node:events";

export type ZaloStatus =
  | { state: "disconnected"; reason?: string }
  | { state: "connecting"; attempt?: number; reason?: string; retryAt?: number }
  | { state: "qr"; image: string }
  | { state: "qr_scanned"; name: string; avatar: string }
  | { state: "connected"; uid: string; name: string; avatar: string; since: number };

/** Một tin của người khác chen vào giữa tin của người được nghe và tin trả lời của mình. */
export type AheadMessage = { name: string; text: string; deltaMs: number };

export type RaceResult = {
  /** Vị trí của mình: 1 = trả lời đầu tiên. */
  rank: number;
  ahead: AheadMessage[];
  /** Thời gian từ tin của người kia tới tin của mình, theo đồng hồ server Zalo (ms). */
  ourDeltaMs: number | null;
};

export type ReplyLog = {
  id: number;
  at: number;
  groupId: string;
  groupName: string;
  senderId: string;
  senderName: string;
  text: string;
  reply: string;
  ok: boolean;
  error?: string;
  /** Thời gian từ lúc nhận sự kiện tới lúc Zalo xác nhận đã gửi (ms). */
  processMs: number;
  /** Thời gian từ lúc người kia gửi (theo timestamp Zalo) tới lúc mình gửi xong (ms). */
  totalMs: number;
  /** Đang chờ kiểm tra vị trí. */
  pending?: boolean;
  race?: RaceResult | null;
};

type BusEvents = {
  status: [ZaloStatus];
  /** Tin vừa trả lời (có thể chưa kiểm tra xong vị trí). */
  log: [ReplyLog];
  /** Cập nhật kết quả kiểm tra vị trí cho 1 dòng nhật ký. */
  log_update: [ReplyLog];
  /** Dòng nhật ký đã hoàn tất (đã có vị trí hoặc gửi lỗi), dùng cho thông báo. */
  log_final: [ReplyLog];
};

export const bus = new EventEmitter<BusEvents>();

const LOG_LIMIT = 300;
const logs: ReplyLog[] = [];
let logSeq = 0;

export function pushLog(entry: Omit<ReplyLog, "id">): ReplyLog {
  const log = { ...entry, id: ++logSeq };
  logs.push(log);
  if (logs.length > LOG_LIMIT) logs.shift();
  bus.emit("log", log);
  if (!log.pending) bus.emit("log_final", log);
  return log;
}

export function finalizeLog(log: ReplyLog, patch: Partial<ReplyLog>) {
  Object.assign(log, patch, { pending: false });
  bus.emit("log_update", log);
  bus.emit("log_final", log);
}

export const recentLogs = () => logs.slice().reverse();
