import { settings } from "./db.js";
import { bus } from "./events.js";

const KEY = "reply_mode";

export type ReplyMode = {
  /** Trả lời 1 lần rồi tự dừng lắng nghe tất cả nhóm. */
  oneShot: boolean;
  /** Đang dừng: không trả lời nhóm nào cho tới khi bấm tiếp tục. */
  paused: boolean;
  pausedAt?: number;
  pausedBy?: { groupName: string; senderName: string };
};

// Đọc trên đường xử lý nóng nên giữ trong RAM, chỉ ghi DB khi đổi.
const state: ReplyMode = { oneShot: false, paused: false, ...settings.get<ReplyMode>(KEY) };

function commit() {
  settings.set(KEY, state);
  bus.emit("reply_mode", { ...state });
}

export const replyMode = {
  get: (): ReplyMode => ({ ...state }),
  isPaused: () => state.paused,

  /**
   * Gọi ngay sau khi bắt đầu gửi: khoá trong RAM tức thì để tin ở nhóm khác đến sát sau bị chặn.
   * Ghi DB và phát sự kiện để sau, không chen vào lúc request gửi tin đang đi ra mạng.
   */
  claim(groupName: string, senderName: string): boolean {
    if (!state.oneShot) return false;
    state.paused = true;
    state.pausedAt = Date.now();
    state.pausedBy = { groupName, senderName };
    setImmediate(commit);
    return true;
  },

  update(patch: { oneShot?: boolean; paused?: boolean }) {
    if (patch.oneShot !== undefined) state.oneShot = patch.oneShot;
    if (patch.paused !== undefined) state.paused = patch.paused;
    // Tắt chế độ 1 lần thì tự lắng nghe lại, không bắt bấm thêm "Tiếp tục".
    if (patch.oneShot === false) state.paused = false;
    if (!state.paused) {
      delete state.pausedAt;
      delete state.pausedBy;
    }
    commit();
    return this.get();
  },
};
