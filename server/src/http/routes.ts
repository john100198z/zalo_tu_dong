import type { FastifyInstance } from "fastify";
import { zalo } from "../zalo/service.js";
import { rules, type ListenUser } from "../rules.js";
import { recentLogs } from "../events.js";
import { replyMode } from "../replyMode.js";
import { getMessages, listThreads, setThreadName } from "../zalo/archive.js";
import { DEFAULT_REPLY, MAX_LISTEN_USERS } from "../config.js";
import { requireAuth } from "./auth.js";
import { telegram, type TelegramSettings } from "../telegram.js";

type RuleBody = {
  groupName?: string;
  enabled?: boolean;
  listenUsers?: ListenUser[];
  reply?: string;
  quote?: boolean;
  cooldownSec?: number;
  textOnly?: boolean;
};

const ruleSchema = {
  type: "object",
  properties: {
    groupName: { type: "string", maxLength: 200 },
    enabled: { type: "boolean" },
    listenUsers: {
      type: "array",
      maxItems: MAX_LISTEN_USERS,
      items: {
        type: "object",
        required: ["id", "name"],
        properties: { id: { type: "string", minLength: 1, maxLength: 40 }, name: { type: "string", maxLength: 200 } },
        additionalProperties: false,
      },
    },
    reply: { type: "string", maxLength: 2000 },
    quote: { type: "boolean" },
    cooldownSec: { type: "integer", minimum: 0, maximum: 3600 },
    textOnly: { type: "boolean" },
  },
  additionalProperties: false,
} as const;

type BulkBody = {
  action: "listen" | "enable" | "disable" | "reply" | "remove";
  groupIds: string[];
  reply?: string;
};

const bulkSchema = {
  type: "object",
  required: ["action", "groupIds"],
  properties: {
    action: { enum: ["listen", "enable", "disable", "reply", "remove"] },
    groupIds: { type: "array", minItems: 1, maxItems: 1000, items: { type: "string", maxLength: 40 } },
    reply: { type: "string", maxLength: 2000 },
  },
  additionalProperties: false,
} as const;

const telegramSchema = {
  type: "object",
  properties: {
    enabled: { type: "boolean" },
    token: { type: "string", maxLength: 100 },
    chatId: { type: "string", maxLength: 40 },
    notifyReplies: { type: "boolean" },
    notifyErrors: { type: "boolean" },
    notifyStatus: { type: "boolean" },
  },
  additionalProperties: false,
} as const;

// Tên người trong tin nhắn riêng chỉ hỏi Zalo 1 lần mỗi lần chạy, tránh gọi API lặp lại khi mở trang.
const triedNames = new Set<string>();

export function registerApiRoutes(app: FastifyInstance) {
  app.register(async (api) => {
    api.addHook("preHandler", requireAuth);

    api.get("/api/meta", async () => ({ maxListenUsers: MAX_LISTEN_USERS, defaultReply: DEFAULT_REPLY }));

    api.get("/api/zalo/status", async () => ({ ...zalo.getStatus(), hasSavedSession: zalo.hasSavedSession() }));

    api.post("/api/zalo/login-qr", async () => {
      void zalo.startQRLogin(); // QR được đẩy qua WebSocket
      return { ok: true };
    });

    api.post("/api/zalo/reconnect", async () => {
      void zalo.reconnect();
      return { ok: true };
    });

    api.post("/api/zalo/logout", async () => {
      zalo.logout();
      return { ok: true };
    });

    api.get<{ Querystring: { refresh?: string } }>("/api/groups", async (req, reply) => {
      try {
        const groups = await zalo.getGroups(req.query.refresh === "1");
        return groups.map((g) => ({ ...g, rule: rules.get(g.id) ?? null }));
      } catch (err) {
        return reply.code(503).send({ error: (err as Error).message });
      }
    });

    api.get<{ Params: { id: string }; Querystring: { refresh?: string } }>(
      "/api/groups/:id/members",
      async (req, reply) => {
        try {
          return await zalo.getMembers(req.params.id, req.query.refresh === "1");
        } catch (err) {
          return reply.code(503).send({ error: (err as Error).message });
        }
      },
    );

    api.get<{ Querystring: { phone?: string } }>("/api/users/by-phone", async (req, reply) => {
      try {
        return await zalo.findByPhone(req.query.phone ?? "");
      } catch (err) {
        return reply.code(404).send({ error: (err as Error).message });
      }
    });


    api.get("/api/rules", async () => rules.list());

    api.put<{ Params: { id: string }; Body: RuleBody }>(
      "/api/rules/:id",
      { schema: { body: ruleSchema } },
      async (req, reply) => {
        const prev = rules.get(req.params.id);
        const b = req.body;
        try {
          return rules.upsert({
            groupId: req.params.id,
            groupName: b.groupName ?? prev?.groupName ?? "",
            enabled: b.enabled ?? prev?.enabled ?? true,
            listenUsers: b.listenUsers ?? prev?.listenUsers ?? [],
            reply: b.reply ?? prev?.reply ?? DEFAULT_REPLY,
            quote: b.quote ?? prev?.quote ?? false,
            cooldownSec: b.cooldownSec ?? prev?.cooldownSec ?? 0,
            textOnly: b.textOnly ?? prev?.textOnly ?? false,
          });
        } catch (err) {
          return reply.code(400).send({ error: (err as Error).message });
        }
      },
    );

    api.post<{ Body: BulkBody }>("/api/rules/bulk", { schema: { body: bulkSchema } }, async (req, reply) => {
      const { action, groupIds } = req.body;
      const replyText = req.body.reply?.trim() || undefined;
      try {
        if (action === "listen") {
          // Nhóm chưa cấu hình: mặc định nghe trưởng nhóm. Nhóm đã có: chỉ bật lại (giữ người đã chọn).
          const groups = new Map((await zalo.getGroups()).map((g) => [g.id, g]));
          const fresh = groupIds.filter((id) => !rules.get(id) && groups.get(id)?.creatorId);
          const names = await zalo.getUserNames(fresh.map((id) => groups.get(id)!.creatorId));
          for (const id of groupIds) {
            const prev = rules.get(id);
            const g = groups.get(id);
            if (prev) {
              rules.upsert({ ...prev, enabled: true, reply: replyText ?? prev.reply });
            } else if (g?.creatorId) {
              rules.upsert({
                groupId: id,
                groupName: g.name,
                enabled: true,
                listenUsers: [{ id: g.creatorId, name: names.get(g.creatorId) || "Trưởng nhóm" }],
                reply: replyText ?? DEFAULT_REPLY,
                quote: false,
                cooldownSec: 0,
                textOnly: false,
              });
            }
          }
        } else {
          for (const id of groupIds) {
            const prev = rules.get(id);
            if (!prev) continue;
            if (action === "remove") rules.remove(id);
            else if (action === "enable" || action === "disable") rules.upsert({ ...prev, enabled: action === "enable" });
            else if (action === "reply" && replyText) rules.upsert({ ...prev, reply: replyText });
          }
        }
        return groupIds.map((id) => ({ groupId: id, rule: rules.get(id) ?? null }));
      } catch (err) {
        return reply.code(503).send({ error: (err as Error).message });
      }
    });

    api.delete<{ Params: { id: string } }>("/api/rules/:id", async (req) => {
      rules.remove(req.params.id);
      return { ok: true };
    });

    api.get("/api/logs", async () => recentLogs());

    api.get("/api/reply-mode", async () => replyMode.get());

    // Trang /message: CHỈ XEM. Không có route gửi tin, không gọi API "đã xem" của Zalo.
    api.get("/api/chats", async () => {
      const threads = listThreads();
      const groups = await zalo.getGroups().catch(() => []);
      const groupInfo = new Map(groups.map((g) => [g.id, g]));
      const unnamed = threads.filter((t) => !t.isGroup && !t.name && !triedNames.has(t.threadId)).map((t) => t.threadId);
      for (const id of unnamed) triedNames.add(id);
      const names = unnamed.length ? await zalo.getUserNames(unnamed).catch(() => new Map<string, string>()) : new Map<string, string>();
      return threads.map((t) => {
        const g = t.isGroup ? groupInfo.get(t.threadId) : undefined;
        let name = g?.name || t.name;
        if (!name && names.get(t.threadId)) {
          name = names.get(t.threadId)!;
          setThreadName(t.threadId, name);
        }
        return { ...t, name: name || t.threadId, avatar: g?.avatar ?? "" };
      });
    });

    api.get<{ Params: { id: string }; Querystring: { before?: string } }>("/api/chats/:id/messages", async (req) =>
      getMessages(req.params.id, req.query.before ? Number(req.query.before) : undefined),
    );

    api.put<{ Body: { working?: boolean; oneShot?: boolean; paused?: boolean } }>(
      "/api/reply-mode",
      {
        schema: {
          body: {
            type: "object",
            properties: { working: { type: "boolean" }, oneShot: { type: "boolean" }, paused: { type: "boolean" } },
            additionalProperties: false,
          },
        },
      },
      async (req) => replyMode.update(req.body),
    );

    api.get("/api/telegram", async () => telegram.getPublic());

    api.put<{ Body: Partial<TelegramSettings> }>(
      "/api/telegram",
      { schema: { body: telegramSchema } },
      async (req, reply) => {
        if (req.body.token) {
          try {
            await telegram.verifyToken(req.body.token.trim());
          } catch (err) {
            return reply.code(400).send({ error: `Token không hợp lệ: ${(err as Error).message}` });
          }
        }
        return telegram.save(req.body);
      },
    );

    api.get("/api/telegram/chats", async (_req, reply) => {
      try {
        return await telegram.findChats();
      } catch (err) {
        return reply.code(400).send({ error: (err as Error).message });
      }
    });

    api.post("/api/telegram/test", async (_req, reply) => {
      try {
        return await telegram.sendTest();
      } catch (err) {
        return reply.code(400).send({ error: (err as Error).message });
      }
    });
  });
}
