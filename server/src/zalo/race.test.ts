import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import { ThreadType, type API, type GroupMessage, type Message } from "zca-js";

process.env.ADMIN_PASSWORD ??= "test";
process.env.SESSION_SECRET ??= "test-secret-test-secret-test-secret";
process.env.DATA_DIR ??= fs.mkdtempSync(`${os.tmpdir()}/zalo-test-`);

const { observe, verifyRace, knownSenders } = await import("./race.js");

const SELF = "me";
const api = { getOwnId: () => SELF } as unknown as API;
const T0 = Date.now();

function msg(group: string, msgId: number, uid: string, name: string, offsetMs: number, content = "em") {
  return {
    type: ThreadType.Group,
    threadId: group,
    isSelf: uid === SELF,
    data: { msgId: String(msgId), uidFrom: uid, dName: name, ts: String(T0 + offsetMs), content, msgType: "webchat" },
  } as unknown as Message;
}

test("đếm đúng số người nhắn chen giữa, theo thứ tự server (msgId)", async () => {
  const trigger = msg("g1", 1000, "boss", "Trưởng nhóm", 0, "cần 1 bạn");
  observe(trigger);
  observe(msg("g1", 1001, "b", "B", 300));
  observe(msg("g1", 1002, "boss", "Trưởng nhóm", 350, "nhanh lên")); // người được nghe nhắn tiếp: không tính
  // Tin của C được server xếp TRƯỚC mình (msgId nhỏ hơn) nhưng tới tay mình SAU tin của mình.
  setTimeout(() => {
    observe(msg("g1", 1004, SELF, "Tôi", 420));
    setTimeout(() => observe(msg("g1", 1003, "c", "C", 410)), 200);
    setTimeout(() => observe(msg("g1", 1005, "d", "D", 500)), 250); // sau mình: không tính
  }, 50);

  const r = await verifyRace(api, "g1", trigger as GroupMessage, "1004", "em");
  assert.ok(r);
  assert.equal(r.rank, 3);
  assert.deepEqual(r.ahead.map((a) => [a.name, a.deltaMs]), [["B", 300], ["C", 410]]);
  assert.equal(r.ourDeltaMs, 420);
});

test("trả lời đầu tiên thì vị trí #1", async () => {
  const trigger = msg("g2", 2000, "boss", "Trưởng nhóm", 0);
  observe(trigger);
  setTimeout(() => {
    observe(msg("g2", 2001, SELF, "Tôi", 90));
    observe(msg("g2", 2002, "b", "B", 400));
  }, 20);
  const r = await verifyRace(api, "g2", trigger as GroupMessage, "2001", "em");
  assert.equal(r?.rank, 1);
  assert.equal(r?.ahead.length, 0);
});

test("không nhận được tin của mình từ server thì báo chưa xác minh, không đoán", async () => {
  const trigger = msg("g3", 3000, "boss", "Trưởng nhóm", 0);
  observe(trigger);
  const r = await verifyRace(api, "g3", trigger as GroupMessage, "9999", "em");
  assert.equal(r, null);
});

test("ghi nhớ người đã nhắn để chọn trong nhóm lớn", () => {
  const names = knownSenders("g1").map((s) => s.name);
  assert.ok(names.includes("B") && names.includes("C") && !names.includes("Tôi"));
});
