import { test, expect } from "@playwright/test";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";

const artifacts = process.env.AIVRITM_TEST_ARTIFACTS || path.join(os.tmpdir(), "intime-calendar-reconstruction-qa");
test.beforeEach(async ({ page }) => {
  await page.clock.setFixedTime(new Date("2026-10-30T10:10:00+03:00"));
  await page.addInitScript(() => { localStorage.setItem("ritm.speech", "off"); localStorage.setItem("ritm.calendar-layout", "week"); });
});
async function open(page) {
  await page.goto("/"); await expect(page.locator("#records")).toHaveAttribute("aria-busy", "false");
  await page.locator('[data-tab="calendar"]').click();
}
async function screenshot(page, name) {
  await fs.mkdir(artifacts, { recursive: true }); await page.screenshot({ path: path.join(artifacts, name + ".png") });
}

test("CAL-01–04 selection is read-only, changes by ID, clears and stays fresh", async ({ page, request }) => {
  await open(page);
  await expect(page.locator("#calendar-details")).toContainText("Выберите событие");
  const first = page.locator(".calendar-event").filter({ hasText: "Планирование с командой" });
  const id = await first.getAttribute("data-id");
  await first.click();
  await expect(page.locator("#calendar-details h2")).toHaveText("Планирование с командой");
  await expect(first).toHaveAttribute("aria-pressed", "true");
  await expect(page.locator("#calendar-details input, #calendar-details textarea, #calendar-details select")).toHaveCount(0);
  await expect(page.locator("#calendar-editor-dialog")).not.toBeVisible();
  await expect(page.getByRole("button", { name: "Поделиться", exact: true })).toHaveCount(0);
  await request.patch(`/api/events/${id}`, { data: { title: "Обновлённое планирование" } });
  await page.locator("#sync-status").click();
  await expect(page.locator("#calendar-details h2")).toHaveText("Обновлённое планирование");
  await request.patch(`/api/events/${id}`, { data: { title: "Планирование с командой" } });
  await page.locator(".calendar-event").filter({ hasText: "Обсуждение проекта" }).click();
  await expect(page.locator("#calendar-details h2")).toHaveText("Обсуждение проекта");
  await page.getByRole("button", { name: "Снять выбор события" }).click();
  await expect(page.locator("#calendar-details")).toContainText("Выберите событие");
  await expect(page.locator('.calendar-event[aria-pressed="true"]')).toHaveCount(0);
});

test("CAL-05–06 explicit editor preserves API saves, draft protection, completion and deletion", async ({ page, request }) => {
  const response = await request.post("/api/events", { data: { session_id: crypto.randomUUID(), request_id: crypto.randomUUID(), type: "meeting", title: "Календарь проверка редактора", date: "2026-10-31", time: "11:00", duration_min: 60 } });
  const event = (await response.json()).events[0];
  try {
    await open(page); await page.locator(`.calendar-event[data-id="${event.id}"]`).click();
    await page.locator('#calendar-details [data-action="edit"]').click();
    await expect(page.locator("#calendar-editor-dialog")).toBeVisible();
    await page.locator("#edit-title").fill("Календарь новое название");
    await page.getByRole("button", { name: "Закрыть редактор", exact: true }).click();
    await page.getByRole("button", { name: "Продолжить редактирование", exact: true }).click();
    await expect(page.locator("#edit-title")).toHaveValue("Календарь новое название");
    await page.getByRole("button", { name: "Сохранить изменения", exact: true }).click();
    await expect(page.locator(".editor-save-status")).toHaveText("Изменения сохранены на сервере");
    expect((await (await request.get("/api/events")).json()).events.find(row => row.id === event.id).title).toBe("Календарь новое название");
    await page.getByRole("button", { name: "Завершить запись", exact: true }).click();
    await expect(page.getByRole("button", { name: "Вернуть в открытые", exact: true })).toBeVisible();
    await page.getByRole("button", { name: "Закрыть редактор", exact: true }).click();
    await expect(page.locator("#calendar-details")).toContainText("Завершено");
    await page.locator('#calendar-details [data-action="edit"]').click();
    await page.getByRole("button", { name: "Удалить запись", exact: true }).click();
    await page.getByRole("button", { name: "Отмена", exact: true }).click();
    await expect(page.locator("#calendar-editor-dialog")).toBeVisible();
    await page.getByRole("button", { name: "Удалить запись", exact: true }).click();
    await page.getByRole("button", { name: "Удалить", exact: true }).click();
    await expect(page.locator("#calendar-editor-dialog")).not.toBeVisible();
    await expect(page.locator(`.calendar-event[data-id="${event.id}"]`)).toHaveCount(0);
    await expect(page.locator("#calendar-details")).toContainText("Выберите событие");
  } finally { await request.delete(`/api/events/${event.id}`); }
});

test("CAL-07–10 navigation, views, short overlaps, current time and stored colors", async ({ page, request }) => {
  const ids = [];
  try {
    for (const [title, time, duration_min] of [["Короткая встреча", "11:00", 5], ["Пересечение", "11:00", 60], ["Близкая встреча", "11:10", 5]]) {
      const session = crypto.randomUUID();
      let reply = await (await request.post("/api/events", { data: { session_id: session, request_id: crypto.randomUUID(), type: "meeting", title, date: "2026-10-31", time, duration_min } })).json();
      if (reply.kind === "confirm") reply = await (await request.post("/api/message", { data: { session_id: session, request_id: crypto.randomUUID(), text: "Да" } })).json();
      expect(reply.kind).toBe("created"); ids.push(reply.events[0].id);
    }
    await request.patch(`/api/events/${ids[0]}/color`, { data: { color: "#2575a8" } });
    await open(page);
    const short = page.locator(`.calendar-event[data-id="${ids[0]}"]`), overlap = page.locator(`.calendar-event[data-id="${ids[1]}"]`);
    await short.scrollIntoViewIfNeeded();
    const a = await short.boundingBox(), b = await overlap.boundingBox();
    expect(Math.abs(a.y - b.y)).toBeLessThan(1); expect(a.x + a.width <= b.x || b.x + b.width <= a.x).toBe(true);
    expect(a.height).toBeGreaterThanOrEqual(24);
    expect(await short.evaluate(node => node.style.getPropertyValue("--object-color"))).toBe("#2575a8");
    await short.click(); await expect(page.locator("#calendar-details")).toContainText("11:00 — 11:05");
    expect(await page.locator(".time-calendar__now").evaluate(node => parseFloat(node.style.top))).toBeCloseTo(610 * 52 / 60, 1);
    await page.locator("#calendar-next").click(); await expect(page.locator("#calendar-date")).toHaveValue("2026-11-06");
    await page.locator("#calendar-prev").click(); await expect(page.locator("#calendar-date")).toHaveValue("2026-10-30");
    for (const mode of ["day", "month", "year", "list", "week"]) {
      await page.locator(`[data-calendar-layout="${mode}"]`).click();
      await expect(page.locator("#calendar-details h2")).toHaveText("Короткая встреча");
      if (mode === "month") await expect(page.locator(".month-grid__day")).toHaveCount(42);
      if (mode === "year") await expect(page.locator(".year-month")).toHaveCount(12);
    }
    await page.locator("#calendar-date").fill("2026-11-12"); await page.locator("#calendar-date").dispatchEvent("change");
    await page.locator("#calendar-today").click(); await expect(page.locator("#calendar-date")).toHaveValue("2026-10-30");
    await page.locator("#calendar-date").fill(""); await page.locator("#calendar-date").dispatchEvent("change");
    await expect(page.locator("#calendar-date")).toHaveValue("2026-10-30");
  } finally { for (const id of ids) await request.delete(`/api/events/${id}`); }
});

for (const [width, height] of [[1280, 800], [1366, 768], [1440, 900], [1536, 864], [1920, 1080]]) test(`CAL-11–12 desktop ${width}x${height}`, async ({ page }) => {
  await page.setViewportSize({ width, height }); await open(page);
  await page.locator(".calendar-event").filter({ hasText: "Планирование с командой" }).click();
  await expect(page.locator("#calendar-details")).toBeInViewport();
  const geometry = await page.evaluate(() => {
    const main = document.querySelector("#workspace-main").getBoundingClientRect();
    const grid = document.querySelector("#records").getBoundingClientRect();
    const details = document.querySelector("#calendar-details").getBoundingClientRect();
    return { overflow: document.documentElement.scrollWidth > innerWidth, gridHeight: grid.height, detailsHeight: details.height, overlap: grid.bottom > details.top, inside: grid.left >= main.left && grid.right <= main.right, detailsScroll: document.querySelector("#calendar-details").scrollHeight > document.querySelector("#calendar-details").clientHeight };
  });
  expect(geometry.overflow).toBe(false); expect(geometry.overlap).toBe(false); expect(geometry.inside).toBe(true); expect(geometry.detailsScroll).toBe(false);
  expect(geometry.gridHeight).toBeGreaterThan(350); expect(geometry.detailsHeight).toBeLessThanOrEqual(170);
  await screenshot(page, `calendar-selected-${width}x${height}`);
  await page.locator("#day-open").click(); await page.locator("#assistant-open").click();
  await expect(page.locator(".time-calendar__column")).toHaveCount(7);
  await page.locator("#day-open").click(); await page.locator("#assistant-open").click();
  await expect(page.locator("#calendar-details h2")).toHaveText("Планирование с командой");
});

test("reference visual fixture at exact 1280x823, without changing backend data", async ({ page, request }) => {
  const baseline = (await (await request.get("/api/events")).json()).events;
  const fixture = [["Обсуждение плана", "2026-10-26", "09:30", 60], ["Планирование с командой", "2026-10-27", "11:00", 60], ["Работа над проектом", "2026-10-28", "10:00", 90], ["Обсуждение проекта", "2026-10-29", "11:00", 90], ["Проверка результата", "2026-10-30", "10:00", 60], ["Личные планы", "2026-10-31", "10:30", 90], ["Подготовка материалов", "2026-10-26", "12:30", 90], ["Обратная связь", "2026-10-27", "14:00", 60], ["Созвон по макету", "2026-10-28", "13:00", 90], ["Итоги недели", "2026-10-30", "15:00", 60]]
    .map(([title, date, time, duration_min], index) => ({ ...baseline[0], id: 9000 + index, type: "meeting", title, date, time, duration_min, status: "planned", is_deadline: false }));
  await page.route("**/api/events", route => route.request().method() === "GET" ? route.fulfill({ json: { events: fixture } }) : route.continue());
  await page.route("**/api/colors", route => route.fulfill({ json: { defaults: { task: null, meeting: null, reminder: null }, overrides: Object.fromEntries(fixture.map((event, index) => [event.id, ["#847cce", "#77a08d", "#779fbf", "#bc9771"][index % 4]])) } }));
  await page.clock.setFixedTime(new Date("2026-10-27T10:10:00+03:00"));
  await page.setViewportSize({ width: 1280, height: 823 }); await open(page);
  await page.locator('.calendar-event[data-id="9001"]').click();
  await screenshot(page, "reference-after-1280x823");
  await page.locator("#records").screenshot({ path: path.join(artifacts, "reference-after-grid.png") });
  await page.locator(".page-heading").screenshot({ path: path.join(artifacts, "reference-after-header.png") });
  await page.locator("#calendar-details").screenshot({ path: path.join(artifacts, "reference-after-details.png") });
  await page.locator('.calendar-event[data-id="9001"]').screenshot({ path: path.join(artifacts, "reference-after-event.png") });
  expect((await (await request.get("/api/events")).json()).events).toEqual(baseline);
});
