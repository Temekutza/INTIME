import test from "node:test";
import assert from "node:assert/strict";
import { EventStore } from "../lib/store.js";

const event = (status = "planned") => ({
  id: 1, type: "task", title: "Test", date: null, time: null, duration_min: null, is_deadline: false,
  status, source: "user", source_ref: null, created_at: "2026-10-30T09:00:00", updated_at: "2026-10-30T10:00:00", deleted_at: null,
});
const deferred = () => { let resolve; const promise = new Promise(r => { resolve = r; }); return { promise, resolve }; };

test("a stale GET cannot overwrite a confirmed PATCH", async t => {
  const old = deferred(); let reads = 0;
  t.mock.method(globalThis, "fetch", async (url, options) => {
    if (options?.method === "PATCH") return Response.json(event("done"));
    reads++;
    if (reads === 1) return old.promise;
    return Response.json({ events: [event("done")] });
  });
  const store = new EventStore();
  const load = store.load();
  await store.patch(1, { status: "done" });
  old.resolve(Response.json({ events: [event()] }));
  await load;
  assert.equal(store.events[0].status, "done");
  assert.equal(reads, 2);
  assert.equal(store.saving.size, 0);
});

test("failed PATCH retains previous data and exposes error; duplicate writes rejected", async t => {
  const pending = deferred();
  t.mock.method(globalThis, "fetch", async () => pending.promise);
  const store = new EventStore(); store.events = [event()];
  const patch = store.patch(1, { status: "done" });
  await assert.rejects(store.patch(1, { status: "done" }), /Дождитесь/);
  pending.resolve(new Response("failed", { status: 500 }));
  await assert.rejects(patch, /500/);
  assert.equal(store.events[0].status, "planned");
  assert.match(store.error, /500/);
  assert.equal(store.saving.size, 0);
});

test("failed reload preserves last confirmed collection", async t => {
  t.mock.method(globalThis, "fetch", async () => { throw new TypeError("offline"); });
  const store = new EventStore(); store.events = [event()]; store.loaded = true;
  await store.load();
  assert.equal(store.events.length, 1);
  assert.equal(store.loaded, true);
  assert.equal(store.loading, false);
  assert.match(store.error, /Проверьте соединение/);
});
