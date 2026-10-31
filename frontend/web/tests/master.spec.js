import { test, expect } from "@playwright/test";
import os from "node:os";
import path from "node:path";
import fs from "node:fs/promises";
const artifacts = process.env.AIVRITM_TEST_ARTIFACTS || path.join(os.tmpdir(), "intime-master-qa");
test.beforeEach(async ({ page }) => {
  await page.clock.setFixedTime(new Date("2026-10-30T10:10:00+03:00"));
  await page.addInitScript(() => { localStorage.setItem("ritm.speech", "off"); if (!localStorage.getItem("ritm.session_id")) localStorage.setItem("ritm.session_id", crypto.randomUUID()); });
});
async function load(page) { await page.goto("/"); await expect(page.locator("#records")).toHaveAttribute("aria-busy", "false"); }
async function shot(page, name) { await fs.mkdir(artifacts, { recursive: true }); await page.screenshot({ path: path.join(artifacts, name + ".png") }); }

for (const kind of ["task", "meeting", "reminder"]) test(`delete ${kind} requires confirmation and soft-deletes real record`, async ({ page, request }) => {
  const name = `Удаление ${kind} проверка`;
  const data = { session_id: crypto.randomUUID(), request_id: crypto.randomUUID(), type: kind, title: name, date: "2026-10-31", time: "18:00" };
  const created = (await (await request.post("/api/events", { data })).json()).events[0];
  await load(page); await page.locator("#search-input").fill(name); await page.locator("#search-form").press("Enter");
  await page.locator("#search-list button").filter({ hasText: name }).first().click();
  await page.getByRole("button", { name: "Удалить запись", exact: true }).click();
  await expect(page.getByRole("dialog", { name: "Удалить запись?" })).toContainText(name);
  await page.getByRole("button", { name: "Отмена", exact: true }).click();
  expect((await (await request.get("/api/events")).json()).events.some(row => row.id === created.id)).toBe(true);
  await page.getByRole("button", { name: "Удалить запись", exact: true }).click();
  await page.getByRole("button", { name: "Удалить", exact: true }).click();
  await expect(page.locator("#event-editor")).toBeHidden();
  expect((await (await request.get("/api/events")).json()).events.some(row => row.id === created.id)).toBe(false);
});

test("completed reminders remain visible and can be reopened", async ({ page, request }) => {
  const reply = await request.post("/api/events", { data: { session_id: crypto.randomUUID(), request_id: crypto.randomUUID(), type: "reminder", title: "Сохранить завершённое напоминание", date: "2026-10-31", time: "18:30" } });
  const event = (await reply.json()).events[0];
  await load(page); await page.locator('[data-tab="reminders"]').click();
  const card = page.locator(`.reminder-card[data-id="${event.id}"]`);
  await card.locator('input[type="checkbox"]').check(); await expect(card).toHaveClass(/is-done/);
  await page.reload(); await page.locator('[data-tab="reminders"]').click(); await expect(card).toContainText("Завершено");
  await card.locator('input[type="checkbox"]').uncheck(); await expect(card).not.toHaveClass(/is-done/);
  await request.delete(`/api/events/${event.id}`);
});

test("calendar modes, navigation, real positions and list sorting", async ({ page }) => {
  await load(page); await page.locator('[data-tab="calendar"]').click();
  await expect(page.locator(".time-calendar__column")).toHaveCount(7);
  await expect(page.locator(".time-calendar__column .calendar-event")).not.toHaveCount(0);
  await shot(page, "calendar-week");
  await page.locator(".time-calendar .calendar-event").filter({ hasText: "Планирование с командой" }).click();
  await expect(page.locator("#calendar-details")).toContainText("Планирование с командой");
  await expect(page.locator("#event-editor")).toBeHidden();
  await expect(page.locator('[data-tab="calendar"]')).toHaveAttribute("aria-current", "page");
  await expect(page.locator("#calendar-details")).toBeInViewport();
  await shot(page, "calendar-inspector");
  await page.getByRole("button", { name: "Снять выбор события", exact: true }).click();
  await page.locator("#calendar-next").click(); await expect(page.locator("#calendar-date")).toHaveValue("2026-11-06");
  await page.locator("#calendar-today").click();
  for (const mode of ["day", "month", "year", "list"]) {
    await page.locator(`[data-calendar-layout="${mode}"]`).click(); await shot(page, "calendar-" + mode);
    if (mode === "month") await expect(page.locator(".month-grid__day")).toHaveCount(42);
    if (mode === "year") await expect(page.locator(".year-month")).toHaveCount(12);
  }
  const first = await page.locator(".calendar-row").first().innerText();
  await page.locator("#sort-order").selectOption("desc");
  expect(await page.locator(".calendar-row").first().innerText()).not.toBe(first);
});

test("speech on starts synthesis, off cancels and preference persists", async ({ page }) => {
  await page.addInitScript(() => {
    window.__speech = { spoken: [], cancelled: 0 };
    Object.defineProperty(window, "speechSynthesis", { configurable: true, value: {
      getVoices: () => [], addEventListener() {}, resume() {},
      speak: utterance => window.__speech.spoken.push(utterance.text), cancel: () => window.__speech.cancelled++,
    } });
  });
  await load(page); await page.locator("#menu-button").click(); await page.locator("#speech-toggle").click();
  await expect(page.locator("#speech-toggle")).toHaveAttribute("aria-pressed", "true");
  expect(await page.evaluate(() => window.__speech.spoken.length)).toBe(1);
  await page.locator("#speech-toggle").click(); await expect(page.locator("#speech-toggle")).toHaveAttribute("aria-pressed", "false");
  expect(await page.evaluate(() => window.__speech.cancelled)).toBeGreaterThan(0);
  expect(await page.evaluate(() => localStorage.getItem("ritm.speech"))).toBe("off");
});

for (const [kind, word] of [["task", "задачу"], ["meeting", "встречу"], ["reminder", "напоминание"]]) test(`chat rename ${kind} previews and changes only after confirmation`, async ({ page, request }) => {
  const name = `Документ ${kind}`;
  const created = (await (await request.post("/api/events", { data: { session_id: crypto.randomUUID(), request_id: crypto.randomUUID(), type: kind, title: name, date: "2026-10-31", time: "20:00" } })).json()).events[0];
  await load(page);
  await page.locator("#message-input").fill(`Переименуй ${word} «${name}» в «Новый документ ${kind}»`);
  await page.locator("#message-input").press("Enter");
  await expect(page.locator('.confirmation-card[data-state="pending"]')).toContainText(`Новый документ ${kind}`);
  expect((await (await request.get("/api/events")).json()).events.find(row => row.id === created.id).title).toBe(name);
  await page.getByRole("button", { name: "Подтвердить", exact: true }).click();
  await expect(page.locator("#dialogue .event-card").last()).toContainText(`Новый документ ${kind}`);
  expect((await (await request.get("/api/events")).json()).events.find(row => row.id === created.id).title).toBe(`Новый документ ${kind}`);
  await page.locator("#dialogue .event-card").last().getByRole("button", { name: "Редактировать", exact: true }).click();
  await expect(page.locator("#edit-title")).toHaveValue(`Новый документ ${kind}`);
  await request.delete(`/api/events/${created.id}`);
});

for (const [width, height] of [[1280, 800], [1366, 768], [1440, 900], [1536, 864], [1536, 985], [1920, 1080]]) test(`master desktop ${width}x${height}`, async ({ page }) => {
  const errors = []; page.on("pageerror", error => errors.push(error.message));
  await page.setViewportSize({ width, height }); await load(page);
  for (const tab of ["tasks", "reminders", "calendar"]) {
    await page.locator(`[data-tab="${tab}"]`).click();
    const geometry = await page.evaluate(() => {
      const root = document.documentElement, composer = document.getElementById("composer").getBoundingClientRect();
      return { overflow: root.scrollWidth > innerWidth + 1 || root.scrollHeight > innerHeight + 1, composer: composer.bottom <= innerHeight };
    });
    expect(geometry).toEqual({ overflow: false, composer: true }); await shot(page, `${tab}-${width}x${height}`);
  }
  await page.locator("#day-open").click(); await page.locator("#assistant-open").click();
  const left = await page.locator("#day-open").boundingBox(), right = await page.locator("#assistant-open").boundingBox();
  expect(left.x).toBeLessThan(right.x);
  await page.locator("#day-open").click(); await page.locator("#assistant-open").click();
  expect(errors).toEqual([]);
});
