import { settings } from "./db.js";

const KEY = "warm_group";

/** Nhóm được chọn để "ping" giữ ấm kết nối gửi tin. null = tự động chọn 1 nhóm đang nghe. */
export type WarmGroup = { groupId: string; groupName: string } | null;

let cached: WarmGroup | undefined;

export const warmGroup = {
  get(): WarmGroup {
    if (cached === undefined) cached = settings.get<WarmGroup>(KEY) ?? null;
    return cached;
  },
  set(g: WarmGroup): WarmGroup {
    cached = g;
    if (g) settings.set(KEY, g);
    else settings.delete(KEY);
    return g;
  },
};
