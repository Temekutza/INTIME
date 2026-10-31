import { test, expect } from "@playwright/test";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

const artifacts = process.env.AIVRITM_TEST_ARTIFACTS || path.join(os.tmpdir(), "aivritm-frontend-qa");
const popup = page => page.locator(".color-popover:popover-open");
let baseline;

async function reset(request) {
  for (const type of ["task", "meeting", "reminder"]) await request.patch(`/api/colors/defaults/${type}`, { data: { color: null } });
  const colors = await (await request.get("/api/colors")).json();
  for (const id of Object.keys(colors.overrides)) await request.patch(`/api/events/${id}/color`, { data: { color: null } });
}

test.beforeAll(async ({ request }) => { baseline = (await (await request.get("/api/events")).json()).events; });
test.beforeEach(async ({ page, request }) => {
  await reset(request);
  await page.clock.install({ time: new Date("2026-10-30T10:10:00+03:00") });
  await page.clock.pauseAt(new Date("2026-10-30T10:10:00+03:00"));
  await page.addInitScript(() => { localStorage.setItem("ritm.speech", "off"); localStorage.setItem("ritm.session_id", crypto.randomUUID()); });
});
test.afterEach(async ({ request }) => {
  await reset(request);
  const events = (await (await request.get("/api/events")).json()).events;
  for (const event of events) if (!baseline.some(item => item.id === event.id)) await request.delete(`/api/events/${event.id}`);
});

async function loaded(page) {
  await page.goto("/");
  await expect(page.locator("#records")).toHaveAttribute("aria-busy", "false");
  await page.waitForFunction(async () => (await import("/static/lib/colors.js")).colorStore.loaded);
}
async function screenshot(page, name) {
  await fs.mkdir(artifacts, { recursive: true });
  await page.screenshot({ path: path.join(artifacts, name + ".png"), animations: "disabled" });
}
async function choose(page, trigger, color) {
  await trigger.click();
  await popup(page).getByRole("textbox", { name: "HEX-цвет" }).fill(color);
  await popup(page).getByRole("button", { name: "Применить цвет", exact: true }).click();
  await expect(popup(page)).toHaveCount(0);
}
async function defaultColor(page, type, color) {
  await page.getByRole("button", { name: "Настройки цветов", exact: true }).click();
  await choose(page, page.getByRole("button", { name: "Стандартный цвет: " + type, exact: true }), color);
  await page.getByRole("button", { name: "Закрыть настройки цветов", exact: true }).click();
}
async function accent(locator, color) {
  await expect.poll(() => locator.evaluate(node => node.style.getPropertyValue("--object-color"))).toBe(color);
}

test("color inheritance, override, default change, reset and reload across all task views", async ({ page, request }) => {
  const errors = []; page.on("pageerror", error => errors.push(error.message));
  await loaded(page);
  const originalPriority = await page.evaluate(() => getComputedStyle(document.documentElement).getPropertyValue("--priority-urgent"));
  await defaultColor(page, "Задачи", "#123456");
  await accent(page.locator('#records [data-id="1"]'), "#123456");
  await accent(page.locator('#day-tasks [data-id="1"]'), "#123456");
  await page.getByRole("button", { name: "Открыть: Подготовить материалы к встрече", exact: true }).click();
  await choose(page, page.getByRole("button", { name: "Цвет записи", exact: true }), "#F28C28");
  await accent(page.locator("#event-editor"), "#f28c28");
  await defaultColor(page, "Задачи", "#4F72D8");
  await accent(page.locator('#records [data-id="1"]'), "#f28c28");
  await accent(page.locator('#records [data-id="2"]'), "#4f72d8");
  await page.locator("#message-input").fill("Какие задачи у меня сегодня?"); await page.locator("#message-input").press("Enter");
  await accent(page.locator('#dialogue [data-event-id="1"]').last(), "#f28c28");
  await page.locator('[data-tab="calendar"]').click(); await page.locator('[data-calendar-layout="list"]').click();
  await accent(page.locator('#records [data-id="1"]'), "#f28c28");
  await screenshot(page, "colors-calendar-and-chat");
  await page.reload();
  await page.getByRole("button", { name: "Открыть: Подготовить материалы к встрече", exact: true }).click();
  await accent(page.locator("#event-editor"), "#f28c28");
  const trigger = page.getByRole("button", { name: "Цвет записи", exact: true });
  await trigger.click();
  await popup(page).getByRole("button", { name: "Использовать цвет по умолчанию" }).click();
  await popup(page).getByRole("button", { name: "Применить цвет", exact: true }).click();
  await expect(popup(page)).toHaveCount(0);
  await accent(page.locator('#records [data-id="1"]'), "#4f72d8");
  expect((await (await request.get("/api/colors")).json()).overrides["1"]).toBeUndefined();
  expect(await page.evaluate(() => getComputedStyle(document.documentElement).getPropertyValue("--priority-urgent"))).toBe(originalPriority);
  expect(errors).toEqual([]);
});

test("creation inherits without writing an override, and allows a specific creation color", async ({ page, request }) => {
  await loaded(page); await defaultColor(page, "Задачи", "#112233");
  await page.locator("#message-input").fill("Поставь задачу проверить наследование цветов"); await page.locator("#message-input").press("Enter");
  await page.getByRole("button", { name: "Подтвердить", exact: true }).click();
  await expect(page.locator("#dialogue .event-card__title").last()).toContainText("наследование цветов");
  let events = (await (await request.get("/api/events")).json()).events;
  const inherited = events.find(item => /наследование цветов/i.test(item.title));
  expect((await (await request.get("/api/colors")).json()).overrides[String(inherited.id)]).toBeUndefined();
  await accent(page.locator(`#records [data-id="${inherited.id}"]`), "#112233");
  await page.locator("#add-button").click();
  await page.locator("#create-name").fill("Проверить индивидуальный цвет");
  await choose(page, page.getByRole("button", { name: "Цвет создаваемой записи", exact: true }), "#aabbcc");
  await page.locator("#create-dialog").getByRole("button", { name: "Создать задачу", exact: true }).click();
  await expect(page.locator("#create-dialog")).toBeHidden();
  events = (await (await request.get("/api/events")).json()).events;
  const custom = events.find(item => /индивидуальный цвет/i.test(item.title));
  await accent(page.locator(`#records [data-id="${custom.id}"]`), "#aabbcc");
  await defaultColor(page, "Задачи", "#884422");
  await accent(page.locator(`#records [data-id="${inherited.id}"]`), "#884422");
  await accent(page.locator(`#records [data-id="${custom.id}"]`), "#aabbcc");
});

test("creation color survives a clarification and is stored on the resulting meeting", async ({ page, request }) => {
  await loaded(page);
  await defaultColor(page, "Встречи", "#2255aa");
  await page.locator("#message-input").fill("Добавь встречу с цветной командой завтра");
  await page.locator("#message-input").press("Enter");
  await expect(page.locator(".message-assistant").last()).toContainText("На какое время");
  await page.locator("#message-input").fill("в 18:30"); await page.locator("#message-input").press("Enter");
  await page.getByRole("button", { name: "Подтвердить", exact: true }).click();
  await expect(page.locator("#dialogue .event-card__title").last()).toContainText("цветной командой");
  const events = (await (await request.get("/api/events")).json()).events;
  const created = events.find(item => /цветной командой/i.test(item.title));
  expect(created.type).toBe("meeting");
  expect((await (await request.get("/api/colors")).json()).overrides[String(created.id)]).toBeUndefined();
  await accent(page.locator(`#dialogue [data-event-id="${created.id}"]`).last(), "#2255aa");
});

test("meeting and reminder colors are consistent with day panel and calendar", async ({ page }) => {
  await loaded(page); await defaultColor(page, "Встречи", "#765432");
  await accent(page.locator('#day-meetings [data-id="12"]'), "#765432");
  await page.locator('#day-meetings [data-id="12"]').click();
  await choose(page, page.getByRole("button", { name: "Цвет записи", exact: true }), "#ff8800");
  await accent(page.locator('#records [data-id="12"]'), "#ff8800");
  await accent(page.locator('#day-meetings [data-id="12"]'), "#ff8800");
  await page.getByRole("button", { name: "Закрыть редактор", exact: true }).click();
  await defaultColor(page, "Напоминания", "#008877");
  await page.locator('[data-tab="reminders"]').click();
  await accent(page.locator('#records [data-id="9"]'), "#008877");
  await page.locator('#records [data-id="9"] button').click();
  await choose(page, page.getByRole("button", { name: "Цвет записи", exact: true }), "#770088");
  await accent(page.locator('#records [data-id="9"]'), "#770088");
  await screenshot(page, "colors-reminder-editor");
});

test("HEX validation, native palette and keyboard do not submit the parent form", async ({ page }) => {
  await loaded(page);
  await page.getByRole("button", { name: "Открыть: Согласовать макет", exact: true }).click();
  const trigger = page.getByRole("button", { name: "Цвет записи", exact: true });
  await trigger.focus(); await page.keyboard.press("Enter");
  await expect(popup(page)).toBeVisible();
  await expect(popup(page).getByRole("button", { name: "#847CCE", exact: true })).toBeFocused();
  for (let i = 0; i < 18; i++) {
    if (await popup(page).getByRole("textbox", { name: "HEX-цвет" }).evaluate(node => node === document.activeElement)) break;
    await page.keyboard.press("Tab");
  }
  const hex = popup(page).getByRole("textbox", { name: "HEX-цвет" }); await expect(hex).toBeFocused();
  await hex.fill("invalid");
  await expect(hex).toHaveAttribute("aria-invalid", "true");
  await expect(popup(page).getByRole("button", { name: "Применить цвет", exact: true })).toBeDisabled();
  await hex.fill("#12345678");
  await expect(hex).toHaveAttribute("aria-invalid", "true");
  await popup(page).getByLabel("Произвольный цвет", { exact: true }).fill("#00aaff");
  await expect(hex).toHaveValue("#00AAFF");
  await hex.fill("#abc"); await hex.press("Enter");
  await expect(popup(page)).toHaveCount(0);
  await accent(page.locator('#records [data-id="2"]'), "#aabbcc");
  await expect(page.locator(".editor-save-status")).toHaveText("Изменений нет");
  await expect(page.locator("#dialogue")).toBeEmpty();
  await trigger.click(); await page.keyboard.press("Escape");
  await expect(popup(page)).toHaveCount(0); await expect(trigger).toBeFocused();
});

test("backend color save and load failures preserve confirmed state and allow retry", async ({ page }) => {
  await page.route("**/api/colors", route => route.fulfill({ status: 503, body: "failed" }));
  await page.goto("/"); await page.getByRole("button", { name: "Настройки цветов", exact: true }).click();
  await expect(page.locator(".color-settings__status")).toContainText("503");
  await expect(page.getByRole("button", { name: "Стандартный цвет: Задачи", exact: true })).toBeDisabled();
  await page.unroute("**/api/colors");
  await page.getByRole("button", { name: "Повторить загрузку цветов" }).click();
  await expect(page.getByRole("button", { name: "Стандартный цвет: Задачи", exact: true })).toBeEnabled();
  await page.getByRole("button", { name: "Закрыть настройки цветов" }).click();
  await page.getByRole("button", { name: "Открыть: Согласовать макет", exact: true }).click();
  await page.route("**/api/events/*/color", route => route.fulfill({ status: 500, body: "failed" }));
  await page.getByRole("button", { name: "Цвет записи", exact: true }).click();
  await popup(page).getByRole("textbox", { name: "HEX-цвет" }).fill("#123456");
  await popup(page).getByRole("button", { name: "Применить цвет", exact: true }).click();
  await expect(popup(page).locator(".color-error")).toContainText("500");
  await accent(page.locator('#records [data-id="2"]'), "#847cce");
  await screenshot(page, "colors-save-error");
  await page.unroute("**/api/events/*/color");
  await popup(page).getByRole("button", { name: "Применить цвет", exact: true }).click();
  await expect(popup(page)).toHaveCount(0);
  await accent(page.locator('#records [data-id="2"]'), "#123456");
});

for (const [width, height] of [[1280, 800], [1343, 868], [1366, 768], [1440, 900], [1536, 985], [1920, 1080]]) {
  test(`color picker desktop geometry ${width}x${height}`, async ({ page }) => {
    await page.setViewportSize({ width, height }); await loaded(page);
    const assertPopup = async () => {
      const dimensions = await popup(page).evaluate(node => {
        const rect = node.getBoundingClientRect();
        return { left: rect.left, right: rect.right, top: rect.top, bottom: rect.bottom, vw: innerWidth, vh: innerHeight, overflow: node.scrollWidth > node.clientWidth + 1, pageOverflow: document.documentElement.scrollWidth > innerWidth + 1 };
      });
      expect(dimensions.left).toBeGreaterThanOrEqual(0); expect(dimensions.top).toBeGreaterThanOrEqual(0);
      expect(dimensions.right).toBeLessThanOrEqual(dimensions.vw); expect(dimensions.bottom).toBeLessThanOrEqual(dimensions.vh);
      expect(dimensions.overflow).toBe(false); expect(dimensions.pageOverflow).toBe(false);
    };
    await page.getByRole("button", { name: "Настройки цветов", exact: true }).click();
    await page.getByRole("button", { name: "Стандартный цвет: Напоминания", exact: true }).click();
    await assertPopup(); await screenshot(page, `color-settings-${width}x${height}`);
    await page.keyboard.press("Escape"); await page.getByRole("button", { name: "Закрыть настройки цветов" }).click();
    await page.getByRole("button", { name: "Открыть: Согласовать макет", exact: true }).click();
    await page.getByRole("button", { name: "Цвет записи", exact: true }).click(); await assertPopup();
    await page.keyboard.press("Escape");
    await page.locator("#add-button").click();
    await page.getByRole("button", { name: "Цвет создаваемой записи", exact: true }).click();
    await assertPopup(); await screenshot(page, `color-creation-${width}x${height}`);
  });
}
