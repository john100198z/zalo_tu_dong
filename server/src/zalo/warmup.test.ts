import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import type { API } from "zca-js";

process.env.ADMIN_PASSWORD ??= "test";
process.env.SESSION_SECRET ??= "test-secret-test-secret-test-secret";
process.env.DATA_DIR ??= fs.mkdtempSync(`${os.tmpdir()}/zalo-test-`);

const { startWarmup, stopWarmup, warmTick } = await import("./warmup.js");
const { rules } = await import("../rules.js");
const { replyMode } = await import("../replyMode.js");

let calls = 0;
const fakePing = async () => {
  calls++;
};
const api = { zpwServiceMap: { group: ["https://tt-group-wpa.chat.zalo.me"] } } as unknown as API;
const tick = () => new Promise((r) => setTimeout(r, 10));

test("chỉ ping khi đang lắng nghe; dừng sau khi trả lời 1 lần thì im; tiếp tục thì ping ngay", async () => {
  for (const r of rules.list()) rules.remove(r.groupId);
  replyMode.update({ oneShot: true, paused: false, working: true });

  startWarmup(api, fakePing);
  await tick();
  assert.equal(calls, 0, "chưa bật nhóm nào thì không ping");

  rules.upsert({ groupId: "g1", groupName: "G", enabled: true, listenUsers: [{ id: "u1", name: "A" }], reply: "em", quote: false, cooldownSec: 0, textOnly: false });
  await warmTick();
  await warmTick();
  assert.equal(calls, 1, "ping dồn trong 2 giây chỉ tính 1 lần");

  // Trả lời 1 lần xong → paused → KHÔNG giữ ấm nữa (không trả lời ai cho tới khi bấm tiếp tục).
  replyMode.claim("G", "A");
  await new Promise((r) => setTimeout(r, 2_100));
  await warmTick();
  assert.equal(calls, 1, "đang dừng (trả lời 1 lần rồi dừng) thì không ping");

  // Bấm "Tiếp tục lắng nghe" → đang lắng nghe trở lại → ping ngay.
  replyMode.update({ paused: false });
  await tick();
  assert.equal(calls, 2, "bấm Tiếp tục lắng nghe thì ping ngay, đúng 1 lần");

  // Nghỉ làm → im.
  await new Promise((r) => setTimeout(r, 2_100));
  replyMode.update({ working: false });
  await warmTick();
  assert.equal(calls, 2, "nghỉ làm thì không ping");

  // Vào làm lại → ping ngay.
  replyMode.update({ working: true });
  await tick();
  assert.equal(calls, 3, "vào làm thì ping ngay");

  // Tắt hết nhóm → im.
  await new Promise((r) => setTimeout(r, 2_100));
  rules.upsert({ ...rules.get("g1")!, enabled: false });
  await warmTick();
  assert.equal(calls, 3, "tắt hết nhóm thì không ping");

  stopWarmup();
  rules.remove("g1");
  replyMode.update({ oneShot: false, paused: false });
});
