import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");

function required(name: string): string {
  const value = process.env[name];
  if (!value) {
    console.error(`[config] Thiếu biến môi trường ${name}. Xem file .env.example`);
    process.exit(1);
  }
  return value;
}

export const config = {
  port: Number(process.env.PORT ?? 3000),
  host: process.env.HOST ?? "0.0.0.0",
  adminPassword: required("ADMIN_PASSWORD"),
  sessionSecret: required("SESSION_SECRET"),
  dataDir: path.resolve(root, process.env.DATA_DIR ?? "data"),
  webDist: path.resolve(root, "web/dist"),
  secureCookie: process.env.SECURE_COOKIE === "true",
  isDev: process.env.NODE_ENV !== "production",
};

/** Tối đa số người được lắng nghe trong 1 nhóm. */
export const MAX_LISTEN_USERS = 2;
export const DEFAULT_REPLY = "em";
