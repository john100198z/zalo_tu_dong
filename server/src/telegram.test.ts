import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";

process.env.ADMIN_PASSWORD ??= "test";
process.env.SESSION_SECRET ??= "test-secret-test-secret-test-secret";
process.env.DATA_DIR ??= fs.mkdtempSync(`${os.tmpdir()}/zalo-test-`);

const calls: { url: string; body: any }[] = [];
globalThis.fetch = (async (url: string, init: RequestInit) => {
  calls.push({ url, body: JSON.parse(String(init.body)) });
  return new Response(JSON.stringify({ ok: true, result: {} }));
}) as typeof fetch;

const { telegram } = await import("./telegram.js");
const { pushLog } = await import("./events.js");

const log = {
  at: Date.now(),
  groupId: "g1",
  groupName: "Nhóm ABC",
  senderId: "u1",
  senderName: "Người A",
  text: "có ai <không>",
  reply: "em",
  ok: true,
  processMs: 90,
  totalMs: 140,
};

test("không gửi khi chưa bật", async () => {
  telegram.save({ token: "123:abc", chatId: "-100", enabled: false });
  pushLog(log);
  await new Promise((r) => setTimeout(r, 20));
  assert.equal(calls.length, 0);
});

test("gửi thông báo đúng nội dung về đúng nhóm, không lộ token cho web", async () => {
  telegram.save({ enabled: true });
  pushLog(log);
  await new Promise((r) => setTimeout(r, 20));
  assert.equal(calls.length, 1);
  assert.match(calls[0].url, /bot123:abc\/sendMessage$/);
  assert.equal(calls[0].body.chat_id, "-100");
  const text: string = calls[0].body.text;
  assert.match(text, /Đã trả lời người Người A/);
  assert.match(text, /Nhóm: <b>Nhóm ABC<\/b>/);
  assert.match(text, /Tin nhắn trả lời: "em"/);
  assert.match(text, /Hãy kiểm tra tin nhắn ở app Zalo/);
  assert.match(text, /có ai &lt;không&gt;/, "phải escape HTML");
  assert.equal("token" in telegram.getPublic(), false);
});

test("gộp nhiều thông báo khi dồn dập để không vượt giới hạn Telegram", async () => {
  await new Promise((r) => setTimeout(r, 3200)); // chờ hết khoảng giãn cách của test trước
  calls.length = 0;
  pushLog(log);
  pushLog({ ...log, senderName: "Người B" });
  pushLog({ ...log, senderName: "Người C" });
  await new Promise((r) => setTimeout(r, 3500));
  assert.equal(calls.length, 2, "tin đầu gửi ngay, 2 tin sau gộp làm 1");
  assert.match(calls[1].body.text, /Người B[\s\S]*Người C/);
});
