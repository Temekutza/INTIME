import test from "node:test";
import assert from "node:assert/strict";
import { eventMeta, groupTasks, isoDay, relativeTime, sortedEvents, validatePatch } from "../lib/model.js";
import { isEvent, isWorkspace, listEvents, listWorkspaces, patchEvent, searchEvents } from "../lib/api.js";

export const event = (id = 1, extra = {}) => ({
  id, type: "task", title: "Материалы", date: "2026-10-30", time: "12:00", duration_min: null,
  is_deadline: true, status: "planned", source: "user", source_ref: null,
  created_at: "2026-10-30T09:00:00", updated_at: "2026-10-30T09:00:00", deleted_at: null, ...extra,
});

test("relative time distinguishes deadline, day-only records, past and done", () => {
  const now = new Date(2026, 9, 30, 10, 10);
  assert.equal(relativeTime(event(), now), "Через 1 ч 50 мин");
  assert.equal(relativeTime(event(1, { time: "10:35" }), now), "Через 25 мин");
  assert.equal(relativeTime(event(1, { time: "10:10" }), now), "Сейчас");
  assert.equal(relativeTime(event(1, { time: "10:00" }), now), "Время прошло");
  assert.equal(relativeTime(event(1, { time: "10:00", status: "done" }), now), "Завершено");
  assert.equal(relativeTime(event(1, { time: null }), now), "Время не указано");
  assert.equal(relativeTime(event(1, { date: null }), now), "Дата не указана");
});

test("local dates do not shift at midnight; calendar intervals respect actual instants", () => {
  assert.equal(isoDay(new Date(2026, 9, 30, 0, 1)), "2026-10-30");
  assert.equal(relativeTime(event(1, { date: "2026-10-31", time: "00:05" }), new Date(2026, 9, 30, 23, 55)), "Через 10 мин");
  assert.match(eventMeta(event()), /До .*30.*октября.*12:00/);
});

test("sort is stable, does not mutate input, and leaves undated entries last", () => {
  const values = [event(3), event(4, { date: null }), event(2), event(1, { time: "11:00" })];
  assert.deepEqual(sortedEvents(values).map(e => e.id), [1, 2, 3, 4]);
  assert.deepEqual(sortedEvents(values, "desc").map(e => e.id), [2, 3, 1, 4]);
  assert.deepEqual(values.map(e => e.id), [3, 4, 2, 1]);
});

test("groups use only real task statuses", () => {
  const groups = groupTasks([event(), event(2, { status: "done" }), event(3, { type: "meeting" })]);
  assert.deepEqual(groups.planned.map(e => e.id), [1]);
  assert.deepEqual(groups.done.map(e => e.id), [2]);
});

test("patch validation rejects impossible dates, empty names, orphan times and unsupported statuses", () => {
  assert.throws(() => validatePatch(event(), " ", "", "", "planned"));
  assert.throws(() => validatePatch(event(), "x", "2026-02-30", "", "planned"));
  assert.throws(() => validatePatch(event(), "x", "", "14:00", "planned"));
  assert.throws(() => validatePatch(event(), "x", "2026-10-30", "25:00", "planned"));
  assert.throws(() => validatePatch(event(), "x", "", "", "progress"));
  assert.throws(() => validatePatch(event(1, { type: "reminder" }), "x", "", "", "planned"));
  assert.deepEqual(validatePatch(event(), "  x  ", "", "", "done"), { title: "x", date: null, time: null, status: "done" });
});

test("API DTO validation rejects incomplete or unsupported event responses", () => {
  assert.equal(isEvent(event()), true);
  assert.equal(isEvent(event(1, { type: "project" })), false);
  assert.equal(isEvent(event(1, { status: "progress" })), false);
  assert.equal(isEvent({ id: 1, title: "invalid" }), false);
  assert.equal(isEvent(event(1, { date: "2026-02-30" })), false);
  assert.equal(isEvent(event(1, { time: "25:00" })), false);
});

test("API rejects HTTP and schema failures; search encodes query and uses server limit", async t => {
  t.mock.method(globalThis, "fetch", async () => new Response("{}", { status: 403 }));
  await assert.rejects(listEvents(), /Нет доступа/);
  globalThis.fetch = async () => Response.json({ events: [{ id: 1 }] });
  await assert.rejects(listEvents(), /формат/);
  let searchUrl = "";
  globalThis.fetch = async url => { searchUrl = String(url); return Response.json({ hits: [{ event: event() }] }); };
  assert.equal((await searchEvents("макет & материалы", new AbortController().signal, 9))[0].id, 1);
  assert.match(searchUrl, /q=/);
  assert.match(searchUrl, /limit=20/);
  assert.match(searchUrl, /workspace_id=9/);
  let request;
  globalThis.fetch = async (url, options) => { request = { url, options }; return Response.json(event()); };
  await patchEvent(1, { status: "done" });
  assert.equal(request.url, "/api/events/1");
  assert.deepEqual(JSON.parse(request.options.body), { status: "done" });
});

test("workspace API validates payload and listEvents sends workspace_id", async () => {
  assert.equal(isWorkspace({ id: 2, name: "Работа", is_default: false }), true);
  assert.equal(isWorkspace({ id: 2, name: "Работа" }), false);
  let listUrl = "";
  globalThis.fetch = async url => { listUrl = String(url); return Response.json({ events: [event()] }); };
  await listEvents(undefined, 4);
  assert.match(listUrl, /\/api\/events\?workspace_id=4/);
  globalThis.fetch = async () => Response.json({ workspaces: [{ id: 1, name: "Общее пространство", is_default: true }] });
  const spaces = await listWorkspaces();
  assert.equal(spaces[0].name, "Общее пространство");
});
