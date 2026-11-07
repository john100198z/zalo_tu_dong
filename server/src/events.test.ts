import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";

process.env.ADMIN_PASSWORD ??= "test";
process.env.SESSION_SECRET ??= "test-secret-test-secret-test-secret";
process.env.DATA_DIR ??= fs.mkdtempSync(`${os.tmpdir()}/zalo-test-`);

const { pushLog, finalizeLog, recentLogs } = await import("./events.js");
const { db } = await import("./db.js");

const entry = { at: 1, groupId: "g", groupName: "G", senderId: "u", senderName: "A", text: "x", reply: "em", ok: true, processMs: 1, totalMs: 1 };

test("nhật ký lưu DB, chỉ giữ 200 dòng mới nhất, cập nhật kết quả vị trí", () => {
  for (let i = 0; i < 250; i++) pushLog({ ...entry, text: `tin ${i}` });
  const last = pushLog({ ...entry, text: "cuối", pending: true });
  finalizeLog(last, { race: { rank: 1, ahead: [], ourDeltaMs: 120 } });

  const rows = db.prepare<[], { data: string }>("SELECT data FROM reply_logs ORDER BY id").all();
  assert.equal(rows.length, 200);
  const saved = JSON.parse(rows.at(-1)!.data);
  assert.equal(saved.text, "cuối");
  assert.equal(saved.pending, false);
  assert.equal(saved.race.rank, 1);
  assert.equal(recentLogs().length, 200);
  assert.equal(recentLogs()[0].text, "cuối");
});
