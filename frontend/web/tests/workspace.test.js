import test from "node:test";
import assert from "node:assert/strict";
import { WorkspaceStore } from "../lib/workspace.js";

const space = (id, name, is_default = false) => ({ id, name, is_default });

function stubStorage(start = {}) {
  const memory = new Map(Object.entries(start));
  Object.defineProperty(globalThis, "localStorage", {
    configurable: true,
    value: {
      getItem: key => (memory.has(key) ? memory.get(key) : null),
      setItem: (key, value) => { memory.set(key, String(value)); },
      removeItem: key => { memory.delete(key); },
    },
  });
  return memory;
}

test("workspace store picks saved id, then default", async t => {
  const memory = stubStorage({ "ritm.workspace-id": "3" });
  t.mock.method(globalThis, "fetch", async () => Response.json({
    workspaces: [space(1, "Общее пространство", true), space(3, "Работа"), space(5, "Личное")],
  }));
  const store = new WorkspaceStore();
  await store.load();
  assert.equal(store.currentId, 3);
  store.select(5);
  assert.equal(store.currentId, 5);
  assert.equal(memory.get("ritm.workspace-id"), "5");
});

test("workspace store creates a space and selects it", async t => {
  stubStorage();
  t.mock.method(globalThis, "fetch", async (_url, options) => {
    if (options?.method === "POST") {
      return Response.json({ id: 8, name: "Семья", is_default: false }, { status: 201 });
    }
    return Response.json({ workspaces: [space(1, "Общее пространство", true)] });
  });
  const store = new WorkspaceStore();
  await store.load();
  assert.equal(store.currentId, 1);
  const created = await store.create("Семья");
  assert.equal(created.id, 8);
  assert.equal(store.currentId, 8);
  assert.equal(store.workspaces.some(row => row.id === 8), true);
});
