import fs from "node:fs";
import path from "node:path";
import Database from "better-sqlite3";
import { config } from "./config.js";

fs.mkdirSync(config.dataDir, { recursive: true });

export const db = new Database(path.join(config.dataDir, "app.db"));
db.pragma("journal_mode = WAL");

db.exec(`
  CREATE TABLE IF NOT EXISTS settings (
    key   TEXT PRIMARY KEY,
    value TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS group_rules (
    group_id        TEXT PRIMARY KEY,
    group_name      TEXT NOT NULL DEFAULT '',
    enabled         INTEGER NOT NULL DEFAULT 1,
    listen_users    TEXT NOT NULL DEFAULT '[]',
    reply           TEXT NOT NULL,
    quote           INTEGER NOT NULL DEFAULT 0,
    cooldown_sec    INTEGER NOT NULL DEFAULT 0,
    text_only       INTEGER NOT NULL DEFAULT 0,
    updated_at      INTEGER NOT NULL
  );

  -- Người bot đã thấy nhắn trong từng nhóm (Zalo không trả danh sách đầy đủ với nhóm lớn).
  CREATE TABLE IF NOT EXISTS group_senders (
    group_id TEXT NOT NULL,
    uid      TEXT NOT NULL,
    name     TEXT NOT NULL,
    last_ts  INTEGER NOT NULL,
    PRIMARY KEY (group_id, uid)
  );
`);

const getStmt = db.prepare<[string], { value: string }>("SELECT value FROM settings WHERE key = ?");
const setStmt = db.prepare("INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value");
const delStmt = db.prepare("DELETE FROM settings WHERE key = ?");

export const settings = {
  get<T>(key: string): T | null {
    const row = getStmt.get(key);
    return row ? (JSON.parse(row.value) as T) : null;
  },
  set(key: string, value: unknown) {
    setStmt.run(key, JSON.stringify(value));
  },
  delete(key: string) {
    delStmt.run(key);
  },
};
