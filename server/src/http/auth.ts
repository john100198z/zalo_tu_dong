import crypto from "node:crypto";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { config } from "../config.js";

const COOKIE = "sid";
const SESSION_TTL_MS = 30 * 24 * 3600_000;
const sessions = new Map<string, number>(); // token -> hết hạn lúc

// Giới hạn đăng nhập sai: 5 lần / 15 phút / IP.
const attempts = new Map<string, { count: number; resetAt: number }>();

function safeEqual(a: string, b: string) {
  const ha = crypto.createHash("sha256").update(a).digest();
  const hb = crypto.createHash("sha256").update(b).digest();
  return crypto.timingSafeEqual(ha, hb);
}

export function isAuthed(req: FastifyRequest): boolean {
  const raw = req.cookies[COOKIE];
  if (!raw) return false;
  const unsigned = req.unsignCookie(raw);
  if (!unsigned.valid || !unsigned.value) return false;
  const exp = sessions.get(unsigned.value);
  if (!exp || exp < Date.now()) {
    sessions.delete(unsigned.value);
    return false;
  }
  return true;
}

export async function requireAuth(req: FastifyRequest, reply: FastifyReply) {
  if (!isAuthed(req)) return reply.code(401).send({ error: "Chưa đăng nhập" });
}

export function registerAuthRoutes(app: FastifyInstance) {
  app.post<{ Body: { password?: string } }>("/api/auth/login", async (req, reply) => {
    const now = Date.now();
    const a = attempts.get(req.ip);
    if (a && a.resetAt > now && a.count >= 5) {
      return reply.code(429).send({ error: "Sai quá nhiều lần, thử lại sau 15 phút" });
    }
    if (!safeEqual(req.body?.password ?? "", config.adminPassword)) {
      const next = a && a.resetAt > now ? a : { count: 0, resetAt: now + 15 * 60_000 };
      next.count++;
      attempts.set(req.ip, next);
      return reply.code(401).send({ error: "Sai mật khẩu" });
    }
    attempts.delete(req.ip);
    const token = crypto.randomBytes(32).toString("hex");
    sessions.set(token, now + SESSION_TTL_MS);
    reply.setCookie(COOKIE, token, {
      path: "/",
      httpOnly: true,
      sameSite: "strict",
      secure: config.secureCookie,
      signed: true,
      maxAge: SESSION_TTL_MS / 1000,
    });
    return { ok: true };
  });

  app.post("/api/auth/logout", async (req, reply) => {
    const raw = req.cookies[COOKIE];
    if (raw) {
      const u = req.unsignCookie(raw);
      if (u.valid && u.value) sessions.delete(u.value);
    }
    reply.clearCookie(COOKIE, { path: "/" });
    return { ok: true };
  });

  app.get("/api/auth/me", async (req) => ({ authed: isAuthed(req) }));
}
