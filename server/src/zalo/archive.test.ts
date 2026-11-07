import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import { ThreadType, type Message } from "zca-js";

process.env.ADMIN_PASSWORD ??= "test";
process.env.SESSION_SECRET ??= "test-secret-test-secret-test-secret";
process.env.DATA_DIR ??= fs.mkdtempSync(`${os.tmpdir()}/zalo-test-`);

const { archive, flushArchive, listThreads, getMessages } = await import("./archive.js");
const { bus } = await import("../events.js");

let seq = 0;
const msg = (type: ThreadType, threadId: string, uid: string, dName: string, content: unknown, isSelf = false, msgType = "webchat") =>
  ({ type, threadId, isSelf, data: { msgId: String(++seq), uidFrom: uid, dName, content, msgType, ts: String(1_000 + seq) } }) as unknown as Message;

test("lưu tin nhóm + tin riêng, đặt tên cuộc trò chuyện riêng theo người kia, phát sự kiện realtime", () => {
  const emitted: unknown[] = [];
  bus.on("chat", (c) => emitted.push(...c));
  archive(msg(ThreadType.Group, "g1", "u1", "Quang", "alo"));
  archive(msg(ThreadType.User, "u2", "me", "Tôi", "chào", true));
  archive(msg(ThreadType.User, "u2", "u2", "Lan", { title: "", href: "https://x/a.jpg", thumb: "https://x/t.jpg" }, false, "chat.photo"));
  flushArchive();
  assert.equal(emitted.length, 3);

  const threads = listThreads();
  const dm = threads.find((t) => t.threadId === "u2")!;
  assert.equal(dm.name, "Lan");
  assert.equal(dm.isGroup, false);
  assert.equal(dm.lastText, "[Ảnh]");
  assert.equal(threads.find((t) => t.threadId === "g1")!.isGroup, true);

  const msgs = getMessages("u2");
  assert.deepEqual(msgs.map((m) => m.isSelf), [true, false]);
  assert.equal(msgs[1].attach?.thumb, "https://x/t.jpg");
});

test("không lưu trùng, chỉ giữ 300 tin mỗi cuộc trò chuyện, phân trang tin cũ", () => {
  const dup = msg(ThreadType.Group, "g2", "u1", "A", "x");
  archive(dup);
  archive(dup);
  for (let i = 0; i < 320; i++) archive(msg(ThreadType.Group, "g2", "u1", "A", `tin ${i}`));
  flushArchive();
  const latest = getMessages("g2", undefined, 200);
  assert.equal(latest.length, 200);
  assert.equal(latest.at(-1)!.text, "tin 319");
  const older = getMessages("g2", latest[0].ts, 200);
  assert.equal(older.length, 100);
  assert.equal(older[0].text, "tin 20");
});
