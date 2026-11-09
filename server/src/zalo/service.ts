import { Zalo, ZaloApiError, CloseReason, LoginQRCallbackEventType, type API, type Credentials } from "zca-js";
import { settings } from "../db.js";
import { bus, type ZaloStatus } from "../events.js";
import { createAutoReplyHandler } from "./autoReply.js";
import { startWarmup, stopWarmup } from "./warmup.js";
import { CHROME_UA, keepAliveFetch, preloadChatPage, wsAgent } from "./http.js";
import { knownSenders } from "./race.js";

const CREDENTIALS_KEY = "zalo_credentials";
const GROUPS_TTL_MS = 5 * 60_000;
const MEMBERS_TTL_MS = 5 * 60_000;
const CHUNK = 50;

// Watchdog: tự kết nối lại không giới hạn số lần, thời gian chờ tăng dần.
const RECONNECT_DELAYS_MS = [2_000, 5_000, 10_000, 30_000, 60_000, 120_000, 300_000];
// Khi bị đá do mở Zalo Web nơi khác: chờ lâu hơn để không giành kết nối liên tục.
const DUPLICATE_RECONNECT_MS = 60_000;
// Kiểm tra phiên còn sống định kỳ (phát hiện kết nối "chết lặng").
const HEALTH_INTERVAL_MS = 15 * 60_000;
const HEALTH_TIMEOUT_MS = 15_000;
const HEALTH_MAX_FAILS = 2;
// Gọi keepAlive định kỳ giống Zalo Web thật để duy trì phiên.
const KEEPALIVE_INTERVAL_MS = 3 * 60_000;

export type GroupSummary = {
  id: string;
  name: string;
  avatar: string;
  totalMember: number;
  creatorId: string;
  adminIds: string[];
};

export type MemberRole = "owner" | "admin" | "member";
export type GroupMember = {
  id: string;
  name: string;
  avatar: string;
  role: MemberRole;
  /** Lần cuối thấy người này nhắn trong nhóm (ms), nếu có. */
  lastMessageAt?: number;
};

/** memberIds/memVerList của Zalo đôi khi có dạng "uid_version". */
const normalizeUid = (id: string) => id.replace(/_\d+$/, "");

function chunk<T>(items: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  return Promise.race([
    promise,
    new Promise<never>((_, reject) => setTimeout(() => reject(new Error("timeout")), ms)),
  ]);
}

class ZaloService {
  private api: API | null = null;
  private status: ZaloStatus = { state: "disconnected" };
  private abortQR: (() => unknown) | null = null;
  private groupsCache: { at: number; groups: GroupSummary[] } | null = null;
  private membersCache = new Map<string, { at: number; members: GroupMember[] }>();

  private reconnectTimer: NodeJS.Timeout | null = null;
  private reconnectAttempt = 0;
  private healthTimer: NodeJS.Timeout | null = null;
  private healthFails = 0;
  private keepAliveTimer: NodeJS.Timeout | null = null;

  getStatus() {
    return this.status;
  }

  private setStatus(status: ZaloStatus) {
    this.status = status;
    bus.emit("status", status);
  }

  private createClient() {
    // selfListen: nhận cả tin của chính mình để biết thứ tự thật khi kiểm tra vị trí.
    // (autoReply luôn bỏ qua tin của mình nên không có chuyện tự trả lời chính mình.)
    // agent: truyền https.Agent có TLS cipher giống Chrome cho kết nối WebSocket.
    return new Zalo({
      selfListen: true,
      checkUpdate: false,
      logging: false,
      polyfill: keepAliveFetch,
      agent: wsAgent as any,
    });
  }

  hasSavedSession() {
    return settings.get(CREDENTIALS_KEY) !== null;
  }

  /** Đăng nhập bằng phiên đã lưu. Thất bại thì watchdog tự thử lại. */
  async restore() {
    this.cancelReconnect();
    const credentials = settings.get<Credentials>(CREDENTIALS_KEY);
    if (!credentials) {
      this.setStatus({ state: "disconnected", reason: "Chưa có phiên đăng nhập, hãy quét QR" });
      return;
    }
    this.teardown();
    this.setStatus({ state: "connecting", attempt: this.reconnectAttempt || undefined });
    try {
      // Giả lập trình duyệt: tải trang chat.zalo.me trước khi gọi API login.
      await preloadChatPage(credentials.userAgent);
      // Mỗi lần tạo client mới để bộ đếm retry nội bộ của zca-js được làm mới.
      await this.attach(await withTimeout(this.createClient().login(credentials), 30_000));
    } catch (err) {
      // Zalo trả lời "từ chối" (phiên hết hạn / đổi IP): thử lại vô ích và trông đáng ngờ, nên dừng hẳn.
      // Còn lỗi mạng/timeout thì tiếp tục thử lại.
      if (err instanceof ZaloApiError) {
        console.error("[zalo] Zalo từ chối phiên đã lưu, cần quét QR lại:", err.message);
        this.setStatus({ state: "disconnected", reason: "Phiên đăng nhập đã hết hạn hoặc bị Zalo từ chối. Hãy quét QR lại" });
        return;
      }
      console.error("[zalo] Đăng nhập bằng phiên đã lưu thất bại:", err);
      this.scheduleReconnect("Không đăng nhập được bằng phiên đã lưu");
    }
  }

  async startQRLogin() {
    this.abortQR?.();
    this.cancelReconnect();
    this.teardown();
    this.setStatus({ state: "connecting" });

    let credentials: Credentials | null = null;
    try {
      await preloadChatPage(CHROME_UA);
      const api = await this.createClient().loginQR({ userAgent: CHROME_UA }, (event) => {
        switch (event.type) {
          case LoginQRCallbackEventType.QRCodeGenerated:
            this.abortQR = event.actions.abort;
            this.setStatus({ state: "qr", image: `data:image/png;base64,${event.data.image}` });
            break;
          case LoginQRCallbackEventType.QRCodeScanned:
            this.setStatus({ state: "qr_scanned", name: event.data.display_name, avatar: event.data.avatar });
            break;
          case LoginQRCallbackEventType.QRCodeExpired:
            this.abortQR = null;
            event.actions.abort();
            this.setStatus({ state: "disconnected", reason: "Mã QR đã hết hạn, hãy tạo mã mới" });
            break;
          case LoginQRCallbackEventType.QRCodeDeclined:
            this.abortQR = null;
            event.actions.abort();
            this.setStatus({ state: "disconnected", reason: "Bạn đã từ chối đăng nhập trên điện thoại" });
            break;
          case LoginQRCallbackEventType.GotLoginInfo:
            credentials = { cookie: event.data.cookie, imei: event.data.imei, userAgent: event.data.userAgent };
            break;
        }
      });
      this.abortQR = null;
      if (!api) return;
      if (credentials) settings.set(CREDENTIALS_KEY, credentials);
      await this.attach(api);
    } catch (err) {
      this.abortQR = null;
      if (this.status.state === "disconnected") return; // đã báo lý do (hết hạn/từ chối)
      console.error("[zalo] Đăng nhập QR lỗi:", err);
      this.setStatus({ state: "disconnected", reason: "Đăng nhập thất bại, hãy thử lại" });
    }
  }

  private async attach(api: API) {
    this.api = api;
    this.groupsCache = null;
    this.membersCache.clear();

    const uid = api.getOwnId();
    let name = uid;
    let avatar = "";
    try {
      const { profile } = await api.fetchAccountInfo();
      name = profile.displayName || profile.zaloName || uid;
      avatar = profile.avatar;
    } catch {
      /* không quan trọng */
    }

    const listener = api.listener;
    listener.on("message", createAutoReplyHandler(api));
    listener.on("connected", () => {
      console.log(`[zalo] Đã kết nối: ${name} (${uid})`);
      this.reconnectAttempt = 0;
      this.healthFails = 0;
      this.setStatus({ state: "connected", uid, name, avatar, since: Date.now() });
    });
    listener.on("disconnected", (code, reason) => {
      if (this.api !== api) return;
      console.warn(`[zalo] Mất kết nối (${code}) ${reason}`);
      this.setStatus({ state: "connecting", reason: "Mất kết nối, đang thử lại..." });
    });
    // zca-js đã hết lượt tự thử lại: watchdog của mình tiếp quản.
    listener.on("closed", (code, reason) => {
      if (this.api !== api) return;
      console.warn(`[zalo] Kết nối đã đóng hẳn (${code}) ${reason}`);
      const duplicate = code === CloseReason.DuplicateConnection || code === CloseReason.KickConnection;
      this.scheduleReconnect(
        duplicate ? "Tài khoản đang mở Zalo Web ở nơi khác. Hãy đóng tab đó" : `Kết nối bị đóng (mã ${code})`,
        duplicate ? DUPLICATE_RECONNECT_MS : undefined,
      );
    });
    listener.on("error", (err) => console.error("[zalo] Listener lỗi:", err));
    listener.start({ retryOnClose: true });
    this.startHealthCheck(api);
    this.startKeepAlive(api);
    startWarmup(api);
  }

  private scheduleReconnect(reason: string, delayMs?: number) {
    this.teardown();
    if (!this.hasSavedSession()) {
      this.setStatus({ state: "disconnected", reason });
      return;
    }
    const delay = delayMs ?? RECONNECT_DELAYS_MS[Math.min(this.reconnectAttempt, RECONNECT_DELAYS_MS.length - 1)];
    this.reconnectAttempt++;
    console.warn(`[zalo] ${reason}. Thử kết nối lại lần ${this.reconnectAttempt} sau ${delay / 1000}s`);
    this.setStatus({ state: "connecting", attempt: this.reconnectAttempt, reason, retryAt: Date.now() + delay });
    this.cancelReconnect();
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      void this.restore();
    }, delay);
  }

  private cancelReconnect() {
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.reconnectTimer = null;
  }

  /** Gọi 1 API nhẹ định kỳ; lỗi liên tiếp nghĩa là kết nối/phiên có vấn đề thì kết nối lại. */
  private startHealthCheck(api: API) {
    if (this.healthTimer) clearInterval(this.healthTimer);
    this.healthTimer = setInterval(async () => {
      if (this.api !== api || this.status.state !== "connected") return;
      try {
        await withTimeout(api.fetchAccountInfo(), HEALTH_TIMEOUT_MS);
        this.healthFails = 0;
      } catch (err) {
        this.healthFails++;
        console.warn(`[zalo] Kiểm tra sức khoẻ lỗi (${this.healthFails}/${HEALTH_MAX_FAILS}):`, err);
        if (this.healthFails >= HEALTH_MAX_FAILS) {
          this.healthFails = 0;
          this.scheduleReconnect("Phiên không phản hồi");
        }
      }
    }, HEALTH_INTERVAL_MS);
  }

  /** Gọi keepAlive định kỳ giống Zalo Web thật, giữ phiên không bị đánh dấu "không hoạt động". */
  private startKeepAlive(api: API) {
    if (this.keepAliveTimer) clearInterval(this.keepAliveTimer);
    this.keepAliveTimer = setInterval(async () => {
      if (this.api !== api || this.status.state !== "connected") return;
      try {
        await api.keepAlive();
      } catch {
        // Lỗi keepAlive không nghiêm trọng; healthCheck sẽ xử lý nếu phiên thật sự chết.
      }
    }, KEEPALIVE_INTERVAL_MS);
  }

  /** Nút "Kết nối lại" trên web: thử ngay, không chờ. */
  async reconnect() {
    this.reconnectAttempt = 0;
    await this.restore();
  }

  private teardown() {
    const api = this.api;
    this.api = null;
    if (this.healthTimer) clearInterval(this.healthTimer);
    this.healthTimer = null;
    if (this.keepAliveTimer) clearInterval(this.keepAliveTimer);
    this.keepAliveTimer = null;
    stopWarmup();
    if (api) {
      api.listener.removeAllListeners();
      try {
        api.listener.stop();
      } catch {
        /* đã dừng */
      }
    }
  }

  logout() {
    this.abortQR?.();
    this.abortQR = null;
    this.cancelReconnect();
    this.reconnectAttempt = 0;
    this.teardown();
    settings.delete(CREDENTIALS_KEY);
    this.groupsCache = null;
    this.membersCache.clear();
    this.setStatus({ state: "disconnected", reason: "Đã đăng xuất" });
  }

  private requireApi(): API {
    if (!this.api) throw new Error("Chưa kết nối Zalo");
    return this.api;
  }

  async getGroups(refresh = false): Promise<GroupSummary[]> {
    const api = this.requireApi();
    if (!refresh && this.groupsCache && Date.now() - this.groupsCache.at < GROUPS_TTL_MS) {
      return this.groupsCache.groups;
    }
    const { gridVerMap } = await api.getAllGroups();
    const ids = Object.keys(gridVerMap);
    const groups: GroupSummary[] = [];
    for (const batch of chunk(ids, CHUNK)) {
      const { gridInfoMap } = await api.getGroupInfo(batch);
      for (const info of Object.values(gridInfoMap)) {
        groups.push({
          id: info.groupId,
          name: info.name,
          avatar: info.avt || info.fullAvt,
          totalMember: info.totalMember,
          creatorId: info.creatorId,
          adminIds: info.adminIds ?? [],
        });
      }
    }
    groups.sort((a, b) => a.name.localeCompare(b.name, "vi"));
    this.groupsCache = { at: Date.now(), groups };
    return groups;
  }

  /** Lấy tên hiển thị cho nhiều uid cùng lúc (dùng khi bật hàng loạt theo trưởng nhóm). */
  async getUserNames(ids: string[]): Promise<Map<string, string>> {
    const api = this.requireApi();
    const names = new Map<string, string>();
    for (const batch of chunk([...new Set(ids)], CHUNK)) {
      try {
        const { profiles } = await api.getGroupMembersInfo(batch);
        for (const [key, p] of Object.entries(profiles)) {
          names.set(normalizeUid(p.id || key), p.displayName || p.zaloName);
        }
      } catch (err) {
        console.warn("[zalo] Lấy tên người dùng lỗi:", err);
      }
    }
    return names;
  }

  /** Tìm người theo số điện thoại (cho trường hợp người cần nghe chưa từng nhắn trong nhóm). */
  async findByPhone(phone: string): Promise<GroupMember> {
    const api = this.requireApi();
    const u = await api.findUser(phone.replace(/[^\d+]/g, ""));
    if (!u?.uid) throw new Error("Không tìm thấy tài khoản Zalo với số này");
    return { id: u.uid, name: u.display_name || u.zalo_name || u.uid, avatar: u.avatar, role: "member" };
  }

  async getMembers(groupId: string, refresh = false): Promise<GroupMember[]> {
    const api = this.requireApi();
    const cached = this.membersCache.get(groupId);
    if (!refresh && cached && Date.now() - cached.at < MEMBERS_TTL_MS) return cached.members;

    const info = (await api.getGroupInfo(groupId)).gridInfoMap[groupId];
    if (!info) throw new Error("Không tìm thấy nhóm");

    const adminIds = new Set(info.adminIds ?? []);
    const roleOf = (id: string): MemberRole =>
      id === info.creatorId ? "owner" : adminIds.has(id) ? "admin" : "member";

    // Nhóm lớn/cộng đồng: Zalo chỉ trả về vài người (thường là trưởng/phó nhóm).
    // Bổ sung trưởng/phó nhóm + những người bot đã thấy nhắn trong nhóm.
    const selfId = api.getOwnId();
    const ids = new Set<string>([
      ...(info.memberIds ?? []).map(normalizeUid),
      ...(info.memVerList ?? []).map(normalizeUid),
      ...(info.creatorId ? [info.creatorId] : []),
      ...adminIds,
    ]);
    const recent = new Map(knownSenders(groupId).map((s) => [s.id, s]));
    for (const id of recent.keys()) ids.add(id);
    ids.delete(selfId);
    const known = new Map<string, GroupMember>();
    for (const m of info.currentMems ?? []) {
      known.set(m.id, { id: m.id, name: m.dName || m.zaloName, avatar: m.avatar, role: roleOf(m.id) });
      ids.add(m.id);
    }

    const missing = [...ids].filter((id) => !known.has(id));
    for (const batch of chunk(missing, CHUNK)) {
      try {
        const { profiles } = await api.getGroupMembersInfo(batch);
        for (const [key, p] of Object.entries(profiles)) {
          const id = normalizeUid(p.id || key);
          known.set(id, { id, name: p.displayName || p.zaloName || id, avatar: p.avatar, role: roleOf(id) });
        }
      } catch (err) {
        console.warn("[zalo] Lấy thông tin thành viên lỗi:", err);
      }
    }
    for (const id of ids) {
      if (!known.has(id)) known.set(id, { id, name: id, avatar: "", role: roleOf(id) });
    }

    for (const m of known.values()) {
      const r = recent.get(m.id);
      if (!r) continue;
      m.lastMessageAt = r.lastTs;
      if (m.name === m.id && r.name) m.name = r.name;
    }
    known.delete(selfId);

    // Trưởng nhóm, phó nhóm, rồi người nhắn gần nhất, rồi theo tên.
    const order: Record<MemberRole, number> = { owner: 0, admin: 1, member: 2 };
    const members = [...known.values()].sort(
      (a, b) =>
        order[a.role] - order[b.role] ||
        (b.lastMessageAt ?? 0) - (a.lastMessageAt ?? 0) ||
        a.name.localeCompare(b.name, "vi"),
    );
    this.membersCache.set(groupId, { at: Date.now(), members });
    return members;
  }
}

export const zalo = new ZaloService();
