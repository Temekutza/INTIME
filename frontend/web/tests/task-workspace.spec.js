import { test, expect } from "@playwright/test";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
const artifacts = process.env.AIVRITM_TEST_ARTIFACTS || path.join(os.tmpdir(), "intime-task-workspace-qa");
test.beforeEach(async ({ page }) => {
  await page.clock.setFixedTime(new Date("2026-10-30T10:10:00+03:00"));
  await page.addInitScript(() => localStorage.setItem("ritm.speech", "off"));
});
async function load(page) { await page.goto("/"); await expect(page.locator("#records")).toHaveAttribute("aria-busy", "false"); }
async function shot(page, name) { await fs.mkdir(artifacts, { recursive: true }); await page.screenshot({ path: path.join(artifacts, name + ".png") }); }

test("TASK-01–09,13 editor saves real fields, color, status and confirms deletion", async ({ page, request }) => {
  const created = await (await request.post("/api/events", { data: { session_id: crypto.randomUUID(), request_id: crypto.randomUUID(), type: "task", title: "Рабочая область проверка", date: "2026-10-31", time: "14:00" } })).json();
  expect(created.kind).toBe("created"); const id = created.events[0].id;
  try {
    await load(page); await page.locator(`.task-row[data-id="${id}"] .task-row__content`).click();
    await expect(page.locator("#edit-title")).toHaveValue("Рабочая область проверка");
    await page.locator("#edit-title").fill("Новое название рабочей задачи");
    await page.locator("#edit-date").fill("");
    await page.getByRole("button", { name: "Сохранить изменения", exact: true }).click();
    await expect(page.locator(".editor-save-status")).toHaveClass(/is-danger/);
    await page.locator("#edit-date").fill("2026-11-02"); await page.locator("#edit-time").fill("16:25");
    await page.getByRole("button", { name: "Сохранить изменения", exact: true }).click();
    await expect(page.locator(".editor-save-status")).toHaveText("Изменения сохранены на сервере");
    const record = (await (await request.get("/api/events")).json()).events.find(event => event.id === id);
    expect([record.title, record.date, record.time.slice(0, 5)]).toEqual(["Новое название рабочей задачи", "2026-11-02", "16:25"]);
    await page.getByRole("button", { name: "Цвет записи", exact: true }).click();
    const colors = page.locator(".color-popover:popover-open");
    await colors.getByRole("textbox", { name: "HEX-цвет" }).fill("#367f91");
    await colors.getByRole("button", { name: "Применить цвет", exact: true }).click();
    await expect.poll(async () => (await (await request.get("/api/colors")).json()).overrides[String(id)]).toBe("#367f91");
    await page.getByRole("button", { name: "Завершить запись", exact: true }).click();
    await expect(page.getByRole("button", { name: "Вернуть в открытые", exact: true })).toBeVisible();
    await page.reload(); await expect(page.locator("#records")).toHaveAttribute("aria-busy", "false");
    await page.locator(`.task-row[data-id="${id}"] .task-row__content`).click();
    await expect(page.locator("#edit-title")).toHaveValue("Новое название рабочей задачи");
    await expect(page.locator("#edit-status")).toHaveValue("done");
    await page.getByRole("button", { name: "Удалить запись", exact: true }).click();
    await page.getByRole("button", { name: "Отмена", exact: true }).click();
    await expect(page.locator("#event-editor")).toBeVisible();
    await page.getByRole("button", { name: "Удалить запись", exact: true }).click();
    await page.getByRole("button", { name: "Удалить", exact: true }).click();
    await expect(page.locator("#event-editor")).toBeHidden();
    expect((await (await request.get("/api/events")).json()).events.some(event => event.id === id)).toBe(false);
  } finally { await request.delete(`/api/events/${id}`); }
});

test("TASK-10–12 bounded pages preserve scroll, selection, counts and keyboard focus", async ({ page, request }) => {
  const template = (await (await request.get("/api/events")).json()).events.find(event => event.type === "task" && event.status === "planned");
  const archive = Array.from({ length: 500 }, (_, index) => ({ ...template, id: 7000 + index, title: `Архивная задача ${String(index).padStart(3, "0")}`, date: "2024-01-01" }));
  await page.route("**/api/events", route => route.fulfill({ json: { events: archive } }));
  await load(page); await expect(page.locator("#tasks-count")).toHaveText("500");
  await expect(page.locator(".task-row")).toHaveCount(40);
  await page.locator("#content-grid").evaluate(node => node.scrollTop = 900);
  const before = await page.locator("#content-grid").evaluate(node => node.scrollTop);
  await page.locator('.task-row[data-id="7014"] .task-row__content').click();
  await expect(page.locator("#edit-title")).toHaveValue("Архивная задача 014");
  expect(Math.abs(await page.locator("#content-grid").evaluate(node => node.scrollTop) - before)).toBeLessThan(8);
  await page.locator("#sync-status").click(); await expect(page.locator("#records")).toHaveAttribute("aria-busy", "false");
  expect(await page.locator("#content-grid").evaluate(node => node.scrollTop)).toBeGreaterThan(800);
  await page.getByRole("navigation", { name: "Страницы: Созданные" }).getByRole("button", { name: "Далее", exact: true }).click();
  await expect(page.locator(".task-row__title").first()).toHaveText("Архивная задача 040");
  await expect(page.locator("#edit-title")).toHaveValue("Архивная задача 014");
  await page.locator("#sync-status").click(); await expect(page.locator(".task-row__title").first()).toHaveText("Архивная задача 040");
  await page.locator(".task-row__content").first().focus(); await page.keyboard.press("Enter");
  await expect(page.locator("#edit-title")).toBeFocused();
  await expect(page.locator("#edit-title")).toHaveValue("Архивная задача 040");
  expect(await page.locator("#event-editor").evaluate(node => getComputedStyle(node).overflowY)).toBe("visible");
  await page.locator(".editor-notes summary").click(); await page.locator(".editor-actions").scrollIntoViewIfNeeded();
  await expect(page.getByRole("button", { name: "Удалить запись", exact: true })).toBeInViewport();
  await shot(page, "long-list-common-scroll");
});

test("TASK-14 desktop geometry, shared scrolling and larger rounded calendar editor", async ({ page }) => {
  for (const [width, height] of [[1280, 800], [1366, 768], [1440, 900], [1536, 864], [1920, 1080]]) {
    await page.setViewportSize({ width, height }); await load(page);
    if (await page.locator("#day-open").getAttribute("aria-expanded") === "false") await page.locator("#day-open").click();
    if (await page.locator("#assistant-open").getAttribute("aria-expanded") === "false") await page.locator("#assistant-open").click();
    await page.locator(".task-row__content").first().click();
    const state = await page.evaluate(() => {
      const editor = document.querySelector("#event-editor"), records = document.querySelector("#records");
      const inputs = [...editor.querySelectorAll(".editor-datetime input")].map(input => {
        const r = input.getBoundingClientRect(), icon = input.closest(".field-date").querySelector("button").getBoundingClientRect();
        return { height: r.height, delta: Math.abs(r.y + r.height / 2 - icon.y - icon.height / 2) };
      });
      return { ownScroll: editor.scrollHeight > editor.clientHeight + 1, listOverflow: getComputedStyle(records).overflowY, inputs, overflow: document.documentElement.scrollWidth > innerWidth };
    });
    expect(state.ownScroll).toBe(false); expect(state.listOverflow).toBe("visible"); expect(state.overflow).toBe(false);
    expect(state.inputs.map(input => input.height)).toEqual([42, 42]); expect(state.inputs.every(input => input.delta < 1)).toBe(true);
    await shot(page, `workspace-${width}x${height}`);
    await page.locator(".editor-actions").scrollIntoViewIfNeeded(); await expect(page.locator(".editor-actions")).toBeInViewport();
    await page.getByRole("button", { name: "Открыть календарь: Дата дедлайна" }).click();
    await expect(page.getByRole("dialog", { name: "Выбор даты", exact: true })).toBeInViewport(); await page.keyboard.press("Escape");
    await page.getByRole("button", { name: "Выбрать время: Время", exact: true }).click();
    await expect(page.getByRole("dialog", { name: "Выбор времени", exact: true })).toBeInViewport(); await page.keyboard.press("Escape");
    await page.locator("#day-open").click(); await page.locator("#assistant-open").click();
    await expect(page.locator("#event-editor")).toBeVisible();
  }
  await page.reload(); await page.locator('[data-tab="calendar"]').click();
  await page.locator(".calendar-event").filter({ hasText: "Планирование с командой" }).click();
  await page.locator('#calendar-details [data-action="edit"]').click();
  await expect(page.locator("#calendar-editor-dialog")).toBeVisible();
  expect(await page.locator("#calendar-editor-dialog").evaluate(node => getComputedStyle(node).borderRadius)).toBe("24px");
  expect(await page.locator("#edit-title").evaluate(node => getComputedStyle(node).fontSize)).toBe("20px");
  expect(await page.locator(".editor-actions .btn-danger").evaluate(node => getComputedStyle(node).backgroundColor)).toBe("rgb(181, 55, 72)");
  await shot(page, "rounded-modal");
});
