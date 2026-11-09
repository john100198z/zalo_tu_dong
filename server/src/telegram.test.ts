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
  assert.match(text, /Người gửi: <b>Người A<\/b>/);
  assert.match(text, /👥 Nhóm ABC/);
  assert.match(text, /↩️ "em"/);
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

test("nút Telegram: bật/tắt 1 lần rồi dừng, tiếp tục lắng nghe, chặn nhóm lạ", async () => {
  const { replyMode } = await import("./replyMode.js");
  telegram.save({ token: "123:abc", chatId: "-100", enabled: true });
  const t = telegram as any;
  t.botUsername = "zalo_bot";
  calls.length = 0;
  const press = (data: string, chatId = -100) =>
    t.handleUpdate("123:abc", { update_id: 1, callback_query: { id: "cb", data, message: { chat: { id: chatId }, message_id: 7 } } });

  await press("oneshot_on");
  assert.equal(replyMode.get().oneShot, true);
  assert.ok(calls.some((c) => c.url.endsWith("/answerCallbackQuery")));
  const edit = calls.find((c) => c.url.endsWith("/editMessageText"));
  assert.match(edit!.body.text, /Trả lời 1 lần rồi dừng: <b>đang mở<\/b>/);
  assert.equal(edit!.body.reply_markup.inline_keyboard.length, 3, "chưa dừng thì không có nút Tiếp tục (ca làm, 1 lần, làm mới)");

  replyMode.claim("Nhậu", "Quang");
  calls.length = 0;
  await press("refresh");
  const paused = calls.find((c) => c.url.endsWith("/editMessageText"))!.body;
  assert.match(paused.text, /Quang/);
  assert.ok(paused.reply_markup.inline_keyboard.flat().some((b: any) => b.callback_data === "resume"));

  await press("resume");
  assert.equal(replyMode.get().paused, false);

  await press("oneshot_off", -999);
  assert.equal(replyMode.get().oneShot, true, "nhóm khác không được điều khiển");
  await press("oneshot_off");
  assert.equal(replyMode.get().oneShot, false);
});

test("tag tên bot hoặc /trangthai thì gửi bảng trạng thái, tin thường thì không", async () => {
  const t = telegram as any;
  t.botUsername = "zalo_bot";
  calls.length = 0;
  const say = (text: string, chatId = -100) =>
    t.handleUpdate("123:abc", { update_id: 2, message: { message_id: 9, chat: { id: chatId, type: "group" }, text } });
  await say("ê @Zalo_Bot ơi");
  await say("/trangthai@zalo_bot");
  await say("/trangthai@bot_khac");
  await say("chào cả nhà");
  await say("@zalo_bot", -999);
  const panels = calls.filter((c) => c.url.endsWith("/sendMessage"));
  assert.equal(panels.length, 2);
  assert.match(panels[0].body.text, /Zalo Auto Reply/);
  assert.ok(panels[0].body.reply_markup.inline_keyboard);
});

test("tự dừng sau khi trả lời: chỉ 1 tin gồm cả tin báo, trạng thái và nút", async () => {
  const { replyMode } = await import("./replyMode.js");
  telegram.save({ token: "123:abc", chatId: "-100", enabled: true });
  replyMode.update({ oneShot: true, paused: false });
  replyMode.claim("Nhậu", "Quang");
  await new Promise((r) => setTimeout(r, 3200));
  calls.length = 0;
  pushLog({ ...log, groupName: "Nhậu", senderName: "Quang", pausedAfter: true });
  await new Promise((r) => setTimeout(r, 50));
  const sent = calls.filter((c) => c.url.endsWith("/sendMessage"));
  assert.equal(sent.length, 1);
  assert.match(sent[0].body.text, /Người gửi: <b>Quang<\/b>/);
  assert.match(sent[0].body.text, /ĐANG DỪNG lắng nghe/);
  assert.ok(sent[0].body.reply_markup.inline_keyboard.flat().some((b: any) => b.callback_data === "resume"));

  // Bấm "Tiếp tục" trên tin đó (sau khi server khởi động lại, chỉ còn nội dung chữ): giữ phần tin báo.
  const t = telegram as any;
  t.panel = null;
  calls.length = 0;
  const plain = "✅ Người gửi: Quang\n👥 Nhóm: Nhậu\n──────────\n⏸ ĐANG DỪNG";
  await t.handleUpdate("123:abc", { update_id: 3, callback_query: { id: "cb", data: "resume", message: { chat: { id: -100 }, message_id: 11, text: plain } } });
  const edit = calls.find((c) => c.url.endsWith("/editMessageText"))!.body;
  assert.match(edit.text, /Người gửi: Quang/);
  assert.match(edit.text, /Đang lắng nghe|KHÔNG trả lời được|Chưa bật nhóm/);
  assert.equal(edit.reply_markup.inline_keyboard.flat().some((b: any) => b.callback_data === "resume"), false);
  replyMode.update({ oneShot: false, paused: false });
});

test("tắt chế độ 1 lần khi đang dừng thì tự lắng nghe lại, nút ON/OFF chỉ 1 nút", async () => {
  const { replyMode } = await import("./replyMode.js");
  replyMode.update({ oneShot: true, paused: false });
  replyMode.claim("Nhậu", "Quang");
  const t = telegram as any;
  calls.length = 0;
  await t.handleUpdate("123:abc", { update_id: 4, callback_query: { id: "cb", data: "oneshot_off", message: { chat: { id: -100 }, message_id: 12 } } });
  assert.deepEqual([replyMode.get().oneShot, replyMode.get().paused], [false, false]);
  const kb = calls.find((c) => c.url.endsWith("/editMessageText") && c.body.message_id === 12)!.body.reply_markup.inline_keyboard;
  assert.equal(kb[1].length, 1);
  assert.equal(kb[1][0].callback_data, "oneshot_on");
  assert.equal(kb.flat().some((b: any) => b.callback_data === "resume"), false);
});

test("chỉ tin mới nhất có nút, tin cũ bị gỡ nút và bỏ phần trạng thái", async () => {
  const t = telegram as any;
  t.panel = null;
  calls.length = 0;
  t.trackPanel({ chatId: "-100", messageId: 20, header: "✅ Người gửi: <b>A</b>" });
  t.trackPanel({ chatId: "-100", messageId: 21 });
  t.trackPanel({ chatId: "-100", messageId: 22 });
  await new Promise((r) => setTimeout(r, 20));
  assert.equal(t.panel.messageId, 22);
  const first = calls.find((c) => c.body.message_id === 20)!;
  assert.match(first.url, /editMessageText$/);
  assert.equal(first.body.text, "✅ Người gửi: <b>A</b>");
  assert.equal(first.body.reply_markup, undefined);
  const second = calls.find((c) => c.body.message_id === 21)!;
  assert.match(second.url, /editMessageReplyMarkup$/);
  assert.deepEqual(second.body.reply_markup.inline_keyboard, []);
});

test("nút ca làm việc: ĐANG LÀM VIỆC / ĐANG DỪNG, bấm để đổi", async () => {
  const { replyMode } = await import("./replyMode.js");
  telegram.save({ token: "123:abc", chatId: "-100", enabled: true });
  replyMode.update({ working: true, oneShot: false, paused: false });
  const t = telegram as any;
  t.panel = null;
  const press = (data: string) =>
    t.handleUpdate("123:abc", { update_id: 9, callback_query: { id: "cb", data, message: { chat: { id: -100 }, message_id: 30 } } });
  const lastEdit = () => calls.filter((c) => c.url.endsWith("/editMessageText") && c.body.message_id === 30).at(-1)!.body;

  calls.length = 0;
  await press("work_off");
  assert.equal(replyMode.get().working, false);
  let body = lastEdit();
  assert.equal(body.reply_markup.inline_keyboard[0][0].text, "🔴 ĐANG DỪNG (ấn nếu muốn làm việc)");
  assert.equal(body.reply_markup.inline_keyboard[0][0].callback_data, "work_on");
  assert.match(body.text, /ĐANG DỪNG<\/b> \(nghỉ làm/);

  await press("work_on");
  assert.equal(replyMode.get().working, true);
  body = lastEdit();
  assert.equal(body.reply_markup.inline_keyboard[0][0].text, "🟢 ĐANG LÀM VIỆC (ấn nếu dừng hoạt động)");
  assert.equal(body.reply_markup.inline_keyboard[0][0].callback_data, "work_off");
});

test("lỗi mạng: lỗi lúc nối thì thử lại; sendMessage đứt giữa chừng thì KHÔNG gửi lại (tránh trùng tin)", async () => {
  const realFetch = globalThis.fetch;
  const netErr = (code: string) => Object.assign(new TypeError("fetch failed"), { cause: { code } });
  let attempts = 0;
  const failOnce = (code: string) => (async () => {
    attempts++;
    if (attempts === 1) throw netErr(code);
    return new Response(JSON.stringify({ ok: true, result: { username: "bot" } }));
  }) as unknown as typeof fetch;
  try {
    attempts = 0;
    globalThis.fetch = failOnce("ETIMEDOUT");
    assert.deepEqual(await telegram.verifyToken("1:a"), { username: "bot" });
    assert.equal(attempts, 2, "ETIMEDOUT lúc nối thì thử lại");

    telegram.save({ token: "1:a", chatId: "-100" });
    attempts = 0;
    globalThis.fetch = failOnce("ECONNRESET");
    await assert.rejects(telegram.sendTest(), /fetch failed/);
    assert.equal(attempts, 1, "sendMessage đứt giữa chừng thì không gửi lại");

    attempts = 0;
    globalThis.fetch = failOnce("ETIMEDOUT");
    await telegram.sendTest();
    assert.equal(attempts, 2, "sendMessage lỗi lúc nối (chưa tới Telegram) thì thử lại");
  } finally {
    globalThis.fetch = realFetch;
  }
  const { describeError } = await import("./telegram.js");
  assert.equal(describeError(netErr("ETIMEDOUT")), "fetch failed (ETIMEDOUT)");
});
