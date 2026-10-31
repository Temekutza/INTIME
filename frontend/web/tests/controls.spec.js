import { test, expect } from "@playwright/test";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

const artifacts = process.env.AIVRITM_TEST_ARTIFACTS || path.join(os.tmpdir(), "aivritm-controls-qa");
let baseline;
test.beforeAll(async ({ request }) => { baseline = (await (await request.get("/api/events")).json()).events; });
test.beforeEach(async ({ page }) => {
  await page.clock.install({ time: new Date("2026-10-30T10:10:00+03:00") });
  await page.clock.pauseAt(new Date("2026-10-30T10:10:00+03:00"));
  await page.addInitScript(() => { localStorage.setItem("ritm.speech", "off"); if (!localStorage.getItem("ritm.session_id")) localStorage.setItem("ritm.session_id", crypto.randomUUID()); });
});
test.afterEach(async ({ request }) => {
  for (const event of (await (await request.get("/api/events")).json()).events) {
    if (!baseline.some(item => item.id === event.id)) await request.delete(`/api/events/${event.id}`);
  }
});
async function loaded(page) {
  await page.goto("/"); await expect(page.locator("#records")).toHaveAttribute("aria-busy", "false");
}
async function shot(page, name) {
  await fs.mkdir(artifacts, { recursive: true }); await page.screenshot({ path: path.join(artifacts, name + ".png") });
}
async function insideViewport(locator) {
  const box = await locator.evaluate(node => {
    const r = node.getBoundingClientRect();
    return { left: r.left, right: r.right, top: r.top, bottom: r.bottom, width: innerWidth, height: innerHeight, overflow: node.scrollWidth > node.clientWidth + 1 };
  });
  expect(box.left).toBeGreaterThanOrEqual(0); expect(box.top).toBeGreaterThanOrEqual(0);
  expect(box.right).toBeLessThanOrEqual(box.width); expect(box.bottom).toBeLessThanOrEqual(box.height); expect(box.overflow).toBe(false);
}

test("custom select supports keyboard, choices, Escape and outside dismissal", async ({ page }) => {
  await loaded(page); await page.locator("#add-button").click();
  const select = page.getByRole("combobox", { name: "Тип записи", exact: true });
  await select.focus(); await page.keyboard.press("ArrowDown");
  await expect(page.getByRole("listbox", { name: "Тип записи" })).toBeVisible();
  await page.keyboard.press("ArrowDown"); await page.keyboard.press("Enter");
  await expect(page.locator("#create-type")).toHaveValue("meeting");
  await expect(select).toContainText("Встреча");
  await expect(page.locator("#create-duration")).toBeVisible();
  await select.click(); await page.keyboard.press("Escape");
  await expect(select).toBeFocused(); await expect(page.locator("#create-dialog")).toBeVisible();
  await select.click(); await page.locator("#create-title").click();
  await expect(page.getByRole("listbox", { name: "Тип записи" })).toBeHidden();
});

test("calendar chooses a real date, navigates month/year and supports keyboard and clearing", async ({ page }) => {
  await loaded(page); await page.locator("#add-button").click();
  const trigger = page.getByRole("button", { name: "Открыть календарь: Дата", exact: true });
  await trigger.click(); const calendar = page.getByRole("dialog", { name: "Выбор даты", exact: true });
  await expect(calendar.locator(".date-picker__day")).toHaveCount(42);
  await expect(calendar.locator(".is-today")).toHaveAttribute("data-date", "2026-10-30");
  await page.keyboard.press("ArrowRight"); await page.keyboard.press("Enter");
  await expect(page.locator("#create-date")).toHaveValue("2026-10-31");
  await trigger.click(); await calendar.getByRole("button", { name: "Выбрать месяц и год" }).click();
  await calendar.getByRole("button", { name: "Выбрать месяц и год" }).click();
  await calendar.getByRole("button", { name: "2027", exact: true }).click();
  await calendar.locator(".date-picker__months button").first().click();
  await calendar.locator('[data-date="2027-01-15"]').click();
  await expect(page.locator("#create-date")).toHaveValue("2027-01-15");
  await trigger.click(); await calendar.getByRole("button", { name: "Сегодня", exact: true }).click();
  await expect(page.locator("#create-date")).toHaveValue("2026-10-30");
  await trigger.click(); await calendar.getByRole("button", { name: "Удалить", exact: true }).click();
  await expect(page.locator("#create-date")).toHaveValue("");
});

test("custom time applies chosen hour/minute, preserves exact minutes and clears", async ({ page }) => {
  await loaded(page); await page.locator("#add-button").click();
  const trigger = page.getByRole("button", { name: "Выбрать время: Время", exact: true });
  await trigger.click(); const time = page.getByRole("dialog", { name: "Выбор времени" });
  await time.getByRole("group", { name: "Часы" }).getByRole("button", { name: "18", exact: true }).click();
  await time.getByRole("group", { name: "Минуты" }).getByRole("button", { name: "35", exact: true }).click();
  await time.getByRole("button", { name: "Готово", exact: true }).click();
  await expect(page.locator("#create-time")).toHaveValue("18:35");
  await page.locator("#create-time").fill("14:17"); await trigger.click();
  await expect(time.getByRole("group", { name: "Минуты" }).getByRole("button", { name: "17", exact: true })).toHaveAttribute("aria-pressed", "true");
  await page.keyboard.press("Escape"); await expect(trigger).toBeFocused();
  await trigger.click(); await time.getByRole("button", { name: "Очистить", exact: true }).click();
  await expect(page.locator("#create-time")).toHaveValue("");
});

test("discard dialogs preserve drafts on Escape and close only after explicit choice", async ({ page }) => {
  await loaded(page); await page.locator("#add-button").click();
  await page.locator("#create-name").fill("Несохранённая задача");
  const close = page.getByRole("button", { name: "Закрыть форму создания", exact: true });
  await close.click(); await expect(page.getByRole("dialog", { name: "Несохранённые изменения" })).toBeVisible();
  await page.keyboard.press("Escape"); await expect(close).toBeFocused();
  await expect(page.locator("#create-name")).toHaveValue("Несохранённая задача");
  await close.click(); await page.getByRole("button", { name: "Закрыть форму", exact: true }).click();
  await expect(page.locator("#create-dialog")).toBeHidden();
});

test("chat preview survives reload, rejects without writing, and creates only after explicit confirmation", async ({ page, request }) => {
  await loaded(page); const count = (await (await request.get("/api/events")).json()).events.length;
  await page.locator("#message-input").fill("Поставь задачу проверить новую карточку подтверждения"); await page.locator("#message-input").press("Enter");
  const pending = page.locator('.confirmation-card[data-state="pending"]');
  await expect(pending).toContainText("Проверить новую карточку", { ignoreCase: true });
  await expect(pending).toContainText("Запись ещё не создана");
  expect((await (await request.get("/api/events")).json()).events.length).toBe(count);
  await page.reload(); await expect(pending).toBeVisible();
  const actions = await pending.locator(".confirmation-card__actions").boundingBox();
  const history = await page.locator("#dialogue-scroll").boundingBox();
  expect(actions.y + actions.height).toBeLessThanOrEqual(history.y + history.height);
  await shot(page, "chat-awaiting-confirmation");
  await pending.getByRole("button", { name: "Отказаться", exact: true }).click();
  await expect(page.locator('.confirmation-card[data-state="declined"]')).toContainText("Отклонено");
  expect((await (await request.get("/api/events")).json()).events.length).toBe(count);
  await page.locator("#message-input").fill("Поставь задачу проверить подтвержденную карточку"); await page.locator("#message-input").press("Enter");
  await pending.getByRole("button", { name: "Подтвердить", exact: true }).click();
  await expect(page.locator('.confirmation-card[data-state="confirmed"]')).toContainText("Подтверждено");
  await expect(page.locator("#dialogue .event-card").last()).toContainText("Проверить подтвержденную карточку", { ignoreCase: true });
  expect((await (await request.get("/api/events")).json()).events.length).toBe(count + 1);
  await shot(page, "chat-confirmed-and-declined");
});

test("lost confirmation response retries one creation with the same request ID", async ({ page, request }) => {
  await loaded(page); const before = (await (await request.get("/api/events")).json()).events.length;
  await page.locator("#message-input").fill("Поставь задачу проверить потерю ответа подтверждения"); await page.locator("#message-input").press("Enter");
  let lost = false; const ids = [];
  await page.route("**/api/message", async route => {
    const body = route.request().postDataJSON();
    if (body.text === "Да") {
      ids.push(body.request_id);
      if (!lost) { lost = true; await route.fetch(); await route.abort("failed"); return; }
    }
    await route.continue();
  });
  await page.getByRole("button", { name: "Подтвердить", exact: true }).click();
  await expect(page.locator(".message-error")).toContainText("Не удалось отправить");
  await expect(page.locator('.confirmation-card[data-state="pending"]')).toBeVisible();
  await page.locator(".message-error").getByRole("button", { name: "Повторить", exact: true }).click();
  await expect(page.locator('.confirmation-card[data-state="confirmed"]')).toBeVisible();
  expect(ids).toHaveLength(2); expect(ids[0]).toBe(ids[1]);
  expect((await (await request.get("/api/events")).json()).events.length).toBe(before + 1);
});

test("pending creation color survives reload during time clarification", async ({ page, request }) => {
  await loaded(page); await page.getByRole("button", { name: "Настройки цветов", exact: true }).click();
  await page.getByRole("button", { name: "Стандартный цвет: Встречи", exact: true }).click();
  const picker = page.locator(".color-popover:popover-open");
  await picker.getByRole("textbox", { name: "HEX-цвет" }).fill("#2255aa");
  await picker.getByRole("button", { name: "Применить цвет", exact: true }).click();
  await page.getByRole("button", { name: "Закрыть настройки цветов" }).click();
  await page.locator("#message-input").fill("Добавь встречу с командой восстановления цвета завтра"); await page.locator("#message-input").press("Enter");
  await expect(page.locator(".message-assistant").last()).toContainText("На какое время");
  await page.reload();
  await expect(page.locator("#creation-colors")).toHaveCount(0);
  await page.locator("#message-input").fill("в 18:30"); await page.locator("#message-input").press("Enter");
  await page.getByRole("button", { name: "Подтвердить", exact: true }).click();
  await expect(page.locator("#dialogue .event-card").last()).toContainText("командой восстановления цвета");
  const event = (await (await request.get("/api/events")).json()).events.find(item => /командой восстановления цвета/i.test(item.title));
  expect((await (await request.get("/api/colors")).json()).defaults.meeting).toBe("#2255aa");
  expect((await (await request.get("/api/colors")).json()).overrides[String(event.id)]).toBeUndefined();
  await request.patch("/api/colors/defaults/meeting", { data: { color: null } });
});

for (const [width, height] of [[1280, 800], [1366, 768], [1440, 900], [1536, 864], [1536, 960], [1920, 1080]]) {
  test(`context panels stay within viewport ${width}x${height}`, async ({ page }) => {
    const errors = []; page.on("pageerror", error => errors.push(error.message));
    await page.setViewportSize({ width, height }); await loaded(page); await page.locator("#add-button").click();
    await page.getByRole("combobox", { name: "Тип записи", exact: true }).click();
    await insideViewport(page.getByRole("listbox", { name: "Тип записи" })); await shot(page, `custom-select-${width}x${height}`);
    await page.keyboard.press("Escape");
    await page.getByRole("button", { name: "Открыть календарь: Дата", exact: true }).click();
    await insideViewport(page.getByRole("dialog", { name: "Выбор даты", exact: true })); await shot(page, `custom-calendar-${width}x${height}`);
    await page.keyboard.press("Escape");
    await page.getByRole("button", { name: "Выбрать время: Время", exact: true }).click();
    await insideViewport(page.getByRole("dialog", { name: "Выбор времени" })); await shot(page, `custom-time-${width}x${height}`);
    await page.keyboard.press("Escape"); await page.getByRole("button", { name: "Закрыть форму создания" }).click();
    const before = await page.locator("#dialogue-scroll").boundingBox();
    await page.locator(".quick-section summary").click();
    const after = await page.locator("#dialogue-scroll").boundingBox(); expect(after.height).toBeGreaterThan(before.height);
    await insideViewport(page.locator("#composer"));
    expect(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth + 1)).toBe(false);
    expect(errors).toEqual([]);
  });
}
