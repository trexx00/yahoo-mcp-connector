import { test } from "node:test";
import assert from "node:assert/strict";
import { MemoryPendingStore, type PendingAction } from "../src/pending.js";

const action: PendingAction = { kind: "delete", folder: "INBOX", uid: 1, preview: {} };

test("a confirmation code works exactly once", async () => {
  const store = new MemoryPendingStore();
  const code = await store.put(action, 60_000);
  assert.deepEqual(await store.take(code), action);
  assert.equal(await store.take(code), undefined);
});

test("unknown and expired codes are refused", async () => {
  const store = new MemoryPendingStore();
  assert.equal(await store.take("made-up"), undefined);
  const code = await store.put(action, -1); // already expired
  assert.equal(await store.take(code), undefined);
});

test("codes are unique", async () => {
  const store = new MemoryPendingStore();
  const codes = new Set(await Promise.all(Array.from({ length: 200 }, () => store.put(action, 60_000))));
  assert.equal(codes.size, 200);
});

test("daily send counter counts sends", async () => {
  const store = new MemoryPendingStore();
  assert.equal(await store.sentToday(), 0);
  await store.recordSend();
  await store.recordSend();
  assert.equal(await store.sentToday(), 2);
});
