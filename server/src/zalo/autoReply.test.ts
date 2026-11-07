import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { ThreadType, type API, type Message } from "zca-js";

process.env.ADMIN_PASSWORD ??= "test";
process.env.SESSION_SECRET ??= "test-secret-test-secret-test-secret";
process.env.DATA_DIR ??= (await import("node:fs")).mkdtempSync(`${(await import("node:os")).tmpdir()}/zalo-test-`);

const { rules } = await import("../rules.js");
const { createAutoReplyHandler } = await import("./autoReply.js");

type Sent = { payload: unknown; threadId: string };
let sent: Sent[] = [];
const fakeApi = {
  getOwnId: () => "me",
  sendMessage: async (payload: unknown, threadId: string) => {
    sent.push({ payload, threadId });
    return { message: { msgId: 1 }, attachment: [] };
  },
} as unknown as API;
const handle = createAutoReplyHandler(fakeApi);

let seq = 0;
function groupMsg(threadId: string, uidFrom: string, content: unknown = "hello", isSelf = false) {
  return {
    type: ThreadType.Group,
    threadId,
    isSelf,
    data: { msgId: String(++seq), uidFrom, dName: uidFrom, content, msgType: "webchat", ts: String(Date.now()) },
  } as unknown as Message;
}

const base = { groupName: "G", enabled: true, reply: "em", quote: false, cooldownSec: 0, textOnly: false };

beforeEach(() => {
  sent = [];
  for (const r of rules.list()) rules.remove(r.groupId);
});

test("trả lời người được nghe, bỏ qua người khác và nhóm khác", () => {
  rules.upsert({ ...base, groupId: "g1", listenUsers: [{ id: "u1", name: "A" }] });
  handle(groupMsg("g1", "u1"));
  handle(groupMsg("g1", "u2"));
  handle(groupMsg("g2", "u1"));
  handle(groupMsg("g1", "u1", "x", true));
  assert.equal(sent.length, 1);
  assert.deepEqual(sent[0], { payload: "em", threadId: "g1" });
});

test("nghe 2 người trong cùng nhóm và nhiều nhóm cùng lúc", () => {
  rules.upsert({ ...base, groupId: "g1", listenUsers: [{ id: "u1", name: "A" }, { id: "u2", name: "B" }] });
  rules.upsert({ ...base, groupId: "g2", listenUsers: [{ id: "u3", name: "C" }], reply: "dạ" });
  handle(groupMsg("g1", "u1"));
  handle(groupMsg("g1", "u2"));
  handle(groupMsg("g2", "u3"));
  assert.deepEqual(sent.map((s) => [s.threadId, s.payload]), [["g1", "em"], ["g1", "em"], ["g2", "dạ"]]);
});

test("không cho quá 2 người", () => {
  assert.throws(() =>
    rules.upsert({ ...base, groupId: "g1", listenUsers: ["a", "b", "c"].map((id) => ({ id, name: id })) }),
  );
});

test("nhóm tắt thì không trả lời", () => {
  rules.upsert({ ...base, groupId: "g1", enabled: false, listenUsers: [{ id: "u1", name: "A" }] });
  handle(groupMsg("g1", "u1"));
  assert.equal(sent.length, 0);
});

test("chỉ tin chữ, trích dẫn, cooldown và chống trùng", () => {
  rules.upsert({ ...base, groupId: "g1", textOnly: true, quote: true, cooldownSec: 60, listenUsers: [{ id: "u1", name: "A" }] });
  handle(groupMsg("g1", "u1", { title: "sticker" }));
  const m = groupMsg("g1", "u1");
  handle(m);
  handle(m);
  handle(groupMsg("g1", "u1"));
  assert.equal(sent.length, 1);
  assert.equal((sent[0].payload as { msg: string; quote: unknown }).msg, "em");
  assert.ok((sent[0].payload as { quote: unknown }).quote);
});

test("gửi lỗi thì tự gửi lại 1 lần", async () => {
  rules.upsert({ ...base, groupId: "g1", listenUsers: [{ id: "u1", name: "A" }] });
  let attempts = 0;
  const flaky = {
    sendMessage: async () => {
      if (++attempts === 1) throw new Error("network");
      return { message: { msgId: 1 }, attachment: [] };
    },
  } as unknown as API;
  createAutoReplyHandler(flaky)(groupMsg("g1", "u1"));
  await new Promise((r) => setTimeout(r, 10));
  assert.equal(attempts, 2);
});

test("đường xử lý gọi sendMessage đồng bộ, không chờ gì trước", () => {
  rules.upsert({ ...base, groupId: "g1", listenUsers: [{ id: "u1", name: "A" }] });
  handle(groupMsg("g1", "u1"));
  assert.equal(sent.length, 1, "sendMessage phải được gọi ngay trong cùng tick");
});
