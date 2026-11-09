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

const calls: { url: string; method?: string; hasCookie: boolean }[] = [];
const fakeFetch = (async (url: string, init: RequestInit) => {
  calls.push({ url, method: init.method, hasCookie: !!(init.headers && JSON.stringify(init.headers).toLowerCase().includes("cookie")) });
  return new Response(null, { status: 404 });
}) as unknown as typeof fetch;
const api = { zpwServiceMap: { group: ["https://tt-group-wpa.chat.zalo.me"] } } as unknown as API;
const tick = () => new Promise((r) => setTimeout(r, 10));

test("chỉ bắn HEAD khi đang lắng nghe; dừng sau khi trả lời 1 lần thì im; tiếp tục thì bắn ngay", async () => {
  for (const r of rules.list()) rules.remove(r.groupId);
  replyMode.update({ oneShot: true, paused: false });

  startWarmup(api, fakeFetch);
  await tick();
  assert.equal(calls.length, 0, "chưa bật nhóm nào thì không bắn");

  rules.upsert({ groupId: "g1", groupName: "G", enabled: true, listenUsers: [{ id: "u1", name: "A" }], reply: "em", quote: false, cooldownSec: 0, textOnly: false });
  await warmTick();
  await warmTick();
  assert.equal(calls.length, 1, "bắn dồn trong 2 giây chỉ tính 1 lần");
  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0], { url: "https://tt-group-wpa.chat.zalo.me/", method: "HEAD", hasCookie: false });

  replyMode.claim("G", "A");
  await warmTick();
  assert.equal(calls.length, 1, "đang dừng (trả lời 1 lần rồi dừng) thì không bắn");

  await new Promise((r) => setTimeout(r, 2_100));
  replyMode.update({ paused: false });
  await tick();
  assert.equal(calls.length, 2, "bấm Tiếp tục lắng nghe thì bắn ngay, đúng 1 lần");
  await new Promise((r) => setTimeout(r, 2_100));

  await new Promise((r) => setTimeout(r, 2_100));
  replyMode.update({ working: false });
  await warmTick();
  assert.equal(calls.length, 2, "nghỉ làm thì không bắn");
  replyMode.update({ working: true });
  await tick();
  assert.equal(calls.length, 3, "vào làm thì bắn ngay");
  await new Promise((r) => setTimeout(r, 2_100));

  rules.upsert({ ...rules.get("g1")!, enabled: false });
  await warmTick();
  assert.equal(calls.length, 3, "tắt hết nhóm thì không bắn");

  stopWarmup();
  rules.upsert({ ...rules.get("g1")!, enabled: true });
  await warmTick();
  assert.equal(calls.length, 3, "mất kết nối Zalo (đã stop) thì không bắn");
  rules.remove("g1");
  replyMode.update({ oneShot: false, paused: false });
});
