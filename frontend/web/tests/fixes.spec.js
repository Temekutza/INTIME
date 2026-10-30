import { test, expect } from "@playwright/test";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

const artifacts = process.env.INTIME_TEST_ARTIFACTS || path.join(os.tmpdir(), "intime-frontend-qa");
const sizes = [[1280, 800], [1343, 868], [1366, 768], [1440, 900], [1536, 985], [1920, 1080]];
let baseline;
test.beforeAll(async ({ request }) => { baseline = (await (await request.get("/api/events")).json()).events; });
test.beforeEach(async ({ page }) => {
  await page.clock.install({ time: new Date("2026-10-30T10:10:00+03:00") });
  await page.clock.pauseAt(new Date("2026-10-30T10:10:00+03:00"));
  await page.addInitScript(() => { localStorage.setItem("ritm.speech", "off"); localStorage.setItem("ritm.session_id", crypto.randomUUID()); });
});
test.afterEach(async ({ request }) => {
  const events = (await (await request.get("/api/events")).json()).events;
  for (const event of events) if (!baseline.some(item => item.id === event.id)) await request.delete(`/api/events/${event.id}`);
  for (const type of ["task", "meeting", "reminder"]) await request.patch(`/api/colors/defaults/${type}`, { data: { color: null } });
});

async function loaded(page) {
  await page.goto("/");
  await expect(page.locator("#records")).toHaveAttribute("aria-busy", "false");
  await expect(page.getByRole("button", { name: "Цвет новой записи", exact: true })).toBeEnabled();
}
async function shot(page, name) {
  await fs.mkdir(artifacts, { recursive: true });
  await page.screenshot({ path: path.join(artifacts, name + ".png"), animations: "disabled" });
}
async function geometry(page) {
  const result = await page.evaluate(() => {
    const rect = id => document.getElementById(id).getBoundingClientRect();
    const main = rect("workspace-main"), header = rect("header");
    const errors = [];
    if (document.documentElement.scrollWidth > innerWidth + 1) errors.push("horizontal page overflow");
    if (document.documentElement.scrollHeight > innerHeight + 1) errors.push("vertical page overflow");
    if (main.top < header.bottom - 1) errors.push("header overlap");
    if (main.right > innerWidth + 1) errors.push("main outside window");
    for (const id of ["day-panel", "assistant-panel", "event-editor", "records", "header"]) {
      const node = document.getElementById(id);
      if (!node.hidden && node.scrollWidth > node.clientWidth + 1) errors.push(id + " overflow");
    }
    const day = document.getElementById("day-panel"), ai = document.getElementById("assistant-panel");
    if (!day.hidden && rect("day-panel").right > main.left + 1) errors.push("left panel overlap");
    if (day.hidden && main.left > 1) errors.push("empty left column");
    if (!ai.hidden && main.right > rect("assistant-panel").left + 1) errors.push("right panel overlap");
    if (ai.hidden && main.right < innerWidth - 1) errors.push("empty right column");
    return errors;
  });
  expect(result).toEqual([]);
}

test("add task opens a real form, saves date/color and reveals a new task", async ({ page, request }) => {
  await loaded(page);
  const before = (await (await request.get("/api/events")).json()).events.length;
  await page.locator("#add-button").click();
  await expect(page.getByRole("dialog", { name: "Новая задача", exact: true })).toBeVisible();
  await page.locator("#create-name").fill("Новая задача из формы");
  await page.locator("#create-date").fill("2026-10-30"); await page.locator("#create-time").fill("18:00");
  await page.getByRole("button", { name: "Цвет создаваемой записи", exact: true }).click();
  await page.locator(".color-popover:popover-open").getByRole("textbox", { name: "HEX-цвет" }).fill("#007788");
  await page.locator(".color-popover:popover-open").getByRole("button", { name: "Применить цвет", exact: true }).click();
  await shot(page, "create-task-form");
  await page.locator("#create-dialog").getByRole("button", { name: "Создать задачу", exact: true }).click();
  await expect(page.locator("#create-dialog")).toBeHidden();
  await expect(page.locator("#edit-title")).toHaveValue("Новая задача из формы");
  await expect(page.locator("#records .task-row.is-selected")).toBeInViewport();
  await expect(page.locator("#day-tasks")).toContainText("Новая задача из формы");
  const events = (await (await request.get("/api/events")).json()).events;
  expect(events.length).toBe(before + 1);
  const created = events.find(event => event.title === "Новая задача из формы");
  expect((await (await request.get("/api/colors")).json()).overrides[String(created.id)]).toBe("#007788");
  await shot(page, "created-task-selected");
});

test("lost form response retries the same request without duplicate creation", async ({ page, request }) => {
  await loaded(page); await page.locator("#add-button").click();
  await page.locator("#create-name").fill("Повтор формы после потери ответа");
  let first = true; const requests = [];
  await page.route("**/api/events", async route => {
    if (route.request().method() !== "POST") { await route.continue(); return; }
    requests.push(route.request().postDataJSON());
    if (first) { first = false; await route.fetch(); await route.abort("failed"); } else await route.continue();
  });
  const submit = page.locator("#create-dialog").getByRole("button", { name: "Создать задачу", exact: true });
  await submit.click(); await expect(page.locator("#create-status")).toContainText("Проверьте соединение");
  await expect(page.locator("#create-name")).toHaveValue("Повтор формы после потери ответа");
  await shot(page, "creation-network-error");
  await submit.click(); await expect(page.locator("#create-dialog")).toBeHidden();
  expect(requests).toHaveLength(2); expect(requests[0].request_id).toBe(requests[1].request_id);
  const events = (await (await request.get("/api/events")).json()).events;
  expect(events.filter(event => event.title === "Повтор формы после потери ответа")).toHaveLength(1);
});

test("meeting form asks before creating a conflict", async ({ page, request }) => {
  await loaded(page); await page.locator("#create-button").click();
  await page.locator("#create-type").selectOption("meeting");
  await page.locator("#create-name").fill("Конфликт из формы");
  await page.locator("#create-date").fill("2026-10-30"); await page.locator("#create-time").fill("11:30");
  await page.locator("#create-dialog").getByRole("button", { name: "Создать встречу", exact: true }).click();
  await expect(page.getByRole("button", { name: "Подтвердить создание", exact: true })).toBeVisible();
  let events = (await (await request.get("/api/events")).json()).events;
  expect(events.some(event => event.title === "Конфликт из формы")).toBe(false);
  await page.getByRole("button", { name: "Подтвердить создание", exact: true }).click();
  await expect(page.locator("#create-dialog")).toBeHidden();
  events = (await (await request.get("/api/events")).json()).events;
  expect(events.filter(event => event.title === "Конфликт из формы")).toHaveLength(1);
});

test("color changes visibly affect task background and persist after reload", async ({ page }) => {
  await loaded(page);
  const row = page.locator('#records [data-id="1"]');
  const before = await row.evaluate(node => getComputedStyle(node).backgroundColor);
  await page.getByRole("button", { name: "Настройки цветов", exact: true }).click();
  await page.getByRole("button", { name: "Стандартный цвет: Задачи", exact: true }).click();
  const popup = page.locator(".color-popover:popover-open");
  await popup.getByRole("textbox", { name: "HEX-цвет" }).fill("#007788");
  await popup.getByRole("button", { name: "Применить цвет", exact: true }).click();
  await page.getByRole("button", { name: "Закрыть настройки цветов", exact: true }).click();
  await expect.poll(() => row.evaluate(node => getComputedStyle(node).backgroundColor)).not.toBe(before);
  const after = await row.evaluate(node => getComputedStyle(node).backgroundColor);
  await page.reload(); await expect(page.locator("#records")).toHaveAttribute("aria-busy", "false");
  await expect.poll(() => row.evaluate(node => getComputedStyle(node).backgroundColor)).toBe(after);
  await shot(page, "visible-task-colors");
});

test("a newly created task is revealed after a thousand archived records", async ({ page }) => {
  const template = baseline.find(event => event.type === "task" && event.status === "planned");
  const archive = Array.from({ length: 1000 }, (_, index) => ({ ...template, id: 3000 + index, title: `Архивная задача ${index}`, date: "2024-01-07", time: "14:45" }));
  await page.route("**/api/events", route => route.request().method() === "GET" ? route.fulfill({ json: { events: archive } }) : route.continue());
  await loaded(page); await geometry(page);
  await page.locator("#add-button").click(); await page.locator("#create-name").fill("Новая задача после большого архива");
  await page.locator("#create-dialog").getByRole("button", { name: "Создать задачу", exact: true }).click();
  await expect(page.locator("#edit-title")).toHaveValue("Новая задача после большого архива");
  await expect(page.locator("#records .task-row.is-selected")).toBeInViewport();
  await geometry(page); await page.locator("#day-close").click(); await geometry(page);
  await shot(page, "thousand-records-new-task");
});

for (const [width, height] of sizes) {
  test(`panels, creation form and typography ${width}x${height}`, async ({ page }) => {
    await page.setViewportSize({ width, height }); await loaded(page);
    await page.getByRole("button", { name: "Открыть: Согласовать макет", exact: true }).click();
    await geometry(page);
    const fonts = await page.evaluate(() => {
      const size = selector => parseFloat(getComputedStyle(document.querySelector(selector)).fontSize);
      return { body: size("body"), title: size(".page-heading h1"), task: size(".task-row__title"), meta: size(".task-row__meta"), radius: parseFloat(getComputedStyle(document.querySelector(".task-row")).borderRadius) };
    });
    expect(fonts.body).toBeGreaterThanOrEqual(14); expect(fonts.title).toBeGreaterThanOrEqual(24);
    expect(fonts.task).toBeGreaterThanOrEqual(14); expect(fonts.meta).toBeGreaterThanOrEqual(12);
    expect(fonts.radius).toBeGreaterThanOrEqual(10); expect(fonts.radius).toBeLessThanOrEqual(14);
    const openWidth = (await page.locator("#workspace-main").boundingBox()).width;
    await page.locator("#day-close").click(); await expect(page.locator("#day-panel")).toBeHidden(); await geometry(page);
    expect((await page.locator("#workspace-main").boundingBox()).width).toBeGreaterThan(openWidth + 200);
    await page.locator("#assistant-close").click(); await geometry(page); await shot(page, `both-panels-hidden-${width}x${height}`);
    await page.locator("#day-open").click(); await geometry(page);
    await page.locator("#assistant-open").click(); await geometry(page);
    await page.locator("#day-close").click(); await page.reload(); await expect(page.locator("#day-panel")).toBeHidden();
    await page.locator("#day-open").click(); await page.locator("#add-button").click();
    await expect(page.locator("#create-dialog")).toBeVisible();
    await page.locator("#create-dialog").getByRole("button", { name: "Создать задачу", exact: true }).scrollIntoViewIfNeeded();
    await expect(page.locator("#create-dialog").getByRole("button", { name: "Создать задачу", exact: true })).toBeInViewport();
    await shot(page, `form-${width}x${height}`);
    await page.getByRole("button", { name: "Закрыть форму создания", exact: true }).click();
  });
}
