import test from "node:test";
import assert from "node:assert/strict";
import { ColorStore, SYSTEM_COLORS, PRIORITY_COLORS, normalizeHex, softTint, swatchInk, isColorSnapshot } from "../lib/colors.js";

const snapshot = () => ({ defaults: { task: null, meeting: null, reminder: null }, overrides: {} });

test("strict HEX normalization rejects CSS injection and accepts shorthand", () => {
  assert.equal(normalizeHex(" #AbC "), "#aabbcc");
  assert.equal(normalizeHex("#AA11Ff"), "#aa11ff");
  for (const value of ["red", "#fff000; color:red", "url(x)", "#12345678", "transparent", ""]) assert.equal(normalizeHex(value), null);
  assert.equal(isColorSnapshot(snapshot()), true);
  assert.equal(isColorSnapshot({ ...snapshot(), overrides: { 1: "red" } }), false);
  assert.equal(isColorSnapshot({ ...snapshot(), defaults: { task: "#000000" } }), false);
});

test("object overrides outrank preferences, then system defaults; priorities independent", async t => {
  const store = new ColorStore(); const task = { id: 1, type: "task" };
  const priorities = JSON.stringify(PRIORITY_COLORS);
  assert.equal(store.resolve(task), SYSTEM_COLORS.task);
  t.mock.method(globalThis, "fetch", async (url, options) => {
    const color = JSON.parse(options.body).color;
    return Response.json(url.includes("/defaults/") ? { type: "task", color } : { event_id: 1, color });
  });
  await store.save("task", "#123456");
  assert.equal(store.resolve(task), "#123456");
  await store.save(1, "#fedcba");
  await store.save("task", "#112233");
  assert.equal(store.resolve(task), "#fedcba");
  await store.save(1, null);
  assert.equal(store.resolve(task), "#112233");
  assert.equal(Object.hasOwn(store.overrides, "1"), false);
  await store.save("task", null);
  assert.equal(store.resolve(task), SYSTEM_COLORS.task);
  assert.equal(JSON.stringify(PRIORITY_COLORS), priorities);
});

test("tints keep dark text separate; black/white swatch labels choose contrast", () => {
  assert.equal(swatchInk("#ffffff"), "#000000");
  assert.equal(swatchInk("#000000"), "#ffffff");
  assert.equal(softTint("#000000"), "#ebebeb");
  assert.equal(softTint("#ffffff"), "#ffffff");
  assert.throws(() => softTint("url(x)"));
});

test("failed saves preserve confirmed values and recover on retry", async t => {
  const store = new ColorStore(); store.defaults.task = "#123456";
  t.mock.method(globalThis, "fetch", async () => new Response("failed", { status: 500 }));
  await assert.rejects(store.save("task", "#abcdef"), /500/);
  assert.equal(store.defaultColor("task"), "#123456");
  assert.equal(store.busy, false);
  assert.match(store.error, /500/);
  globalThis.fetch = async () => Response.json({ type: "task", color: "#abcdef" });
  await store.save("task", "#abcdef");
  assert.equal(store.defaultColor("task"), "#abcdef");
  assert.equal(store.error, "");
});

test("late preferences snapshot cannot overwrite a confirmed color", async t => {
  let release;
  const pending = new Promise(resolve => { release = resolve; });
  t.mock.method(globalThis, "fetch", async (url, options) => options.method === "PATCH" ? Response.json({ type: "task", color: "#abcdef" }) : pending);
  const store = new ColorStore(); const loading = store.load();
  await store.save("task", "#abcdef");
  release(Response.json(snapshot())); await loading;
  assert.equal(store.defaultColor("task"), "#abcdef");
});
