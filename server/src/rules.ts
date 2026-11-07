import { db } from "./db.js";
import { DEFAULT_REPLY, MAX_LISTEN_USERS } from "./config.js";

export type ListenUser = { id: string; name: string };

export type GroupRule = {
  groupId: string;
  groupName: string;
  enabled: boolean;
  listenUsers: ListenUser[];
  reply: string;
  quote: boolean;
  cooldownSec: number;
  textOnly: boolean;
  updatedAt: number;
};

/** Dạng tối giản dùng trên đường xử lý tin nhắn: chỉ có Set + chuỗi, không cần tính toán thêm. */
export type HotRule = {
  users: Set<string>;
  reply: string;
  quote: boolean;
  cooldownMs: number;
  textOnly: boolean;
  groupName: string;
};

type Row = {
  group_id: string;
  group_name: string;
  enabled: number;
  listen_users: string;
  reply: string;
  quote: number;
  cooldown_sec: number;
  text_only: number;
  updated_at: number;
};

const fromRow = (r: Row): GroupRule => ({
  groupId: r.group_id,
  groupName: r.group_name,
  enabled: !!r.enabled,
  listenUsers: JSON.parse(r.listen_users),
  reply: r.reply,
  quote: !!r.quote,
  cooldownSec: r.cooldown_sec,
  textOnly: !!r.text_only,
  updatedAt: r.updated_at,
});

const upsertStmt = db.prepare(`
  INSERT INTO group_rules (group_id, group_name, enabled, listen_users, reply, quote, cooldown_sec, text_only, updated_at)
  VALUES (@group_id, @group_name, @enabled, @listen_users, @reply, @quote, @cooldown_sec, @text_only, @updated_at)
  ON CONFLICT(group_id) DO UPDATE SET
    group_name = excluded.group_name, enabled = excluded.enabled, listen_users = excluded.listen_users,
    reply = excluded.reply, quote = excluded.quote, cooldown_sec = excluded.cooldown_sec,
    text_only = excluded.text_only, updated_at = excluded.updated_at
`);
const deleteStmt = db.prepare("DELETE FROM group_rules WHERE group_id = ?");
const allStmt = db.prepare<[], Row>("SELECT * FROM group_rules");

class RuleStore {
  private rules = new Map<string, GroupRule>();
  /** Chỉ chứa các nhóm đang bật và có ít nhất 1 người được nghe. */
  readonly hot = new Map<string, HotRule>();

  constructor() {
    for (const row of allStmt.all()) {
      const rule = fromRow(row);
      this.rules.set(rule.groupId, rule);
      this.syncHot(rule);
    }
  }

  list(): GroupRule[] {
    return [...this.rules.values()];
  }

  get(groupId: string): GroupRule | undefined {
    return this.rules.get(groupId);
  }

  upsert(input: Omit<GroupRule, "updatedAt">): GroupRule {
    const listenUsers = [...new Map(input.listenUsers.map((u) => [u.id, u])).values()];
    if (listenUsers.length > MAX_LISTEN_USERS) {
      throw new Error(`Chỉ được lắng nghe tối đa ${MAX_LISTEN_USERS} người mỗi nhóm`);
    }
    const reply = input.reply.trim() || DEFAULT_REPLY;
    const rule: GroupRule = {
      ...input,
      listenUsers,
      reply,
      cooldownSec: Math.max(0, Math.min(3600, Math.floor(input.cooldownSec))),
      updatedAt: Date.now(),
    };
    upsertStmt.run({
      group_id: rule.groupId,
      group_name: rule.groupName,
      enabled: rule.enabled ? 1 : 0,
      listen_users: JSON.stringify(rule.listenUsers),
      reply: rule.reply,
      quote: rule.quote ? 1 : 0,
      cooldown_sec: rule.cooldownSec,
      text_only: rule.textOnly ? 1 : 0,
      updated_at: rule.updatedAt,
    });
    this.rules.set(rule.groupId, rule);
    this.syncHot(rule);
    return rule;
  }

  remove(groupId: string) {
    deleteStmt.run(groupId);
    this.rules.delete(groupId);
    this.hot.delete(groupId);
  }

  private syncHot(rule: GroupRule) {
    if (!rule.enabled || rule.listenUsers.length === 0) {
      this.hot.delete(rule.groupId);
      return;
    }
    this.hot.set(rule.groupId, {
      users: new Set(rule.listenUsers.map((u) => u.id)),
      reply: rule.reply,
      quote: rule.quote,
      cooldownMs: rule.cooldownSec * 1000,
      textOnly: rule.textOnly,
      groupName: rule.groupName,
    });
  }
}

export const rules = new RuleStore();
