import { test, expect, chromium } from "@playwright/test";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { USE_DB_MOCKS } from "./db-mocks.js";

const artifacts = process.env.INTIME_TEST_ARTIFACTS || path.join(os.tmpdir(), "intime-frontend-qa");
const sizes = [[1280, 800], [1343, 868], [1366, 768], [1440, 900], [1536, 985], [1920, 1080]];
let baseline = [];

test.beforeAll(async ({ request }) => { baseline = (await (await request.get("/api/events")).json()).events; });
test.afterEach(async ({ request }) => {
  // Restore only our isolated fixture database so scenarios do not depend on order.
  const events = (await (await request.get("/api/events")).json()).events;
  for (const event of events) {
    const original = baseline.find(item => item.id === event.id);
    if (!original) { await request.delete(`/api/events/${event.id}`); continue; }
    const fields = ["title", "date", "time", "status"];
    if (fields.some(key => event[key] !== original[key])) {
      await request.patch(`/api/events/${event.id}`, { data: Object.fromEntries(fields.map(key => [key, original[key]])) });
    }
  }
});

test.beforeEach(async ({ page }) => {
  await page.clock.install({ time: new Date("2026-10-30T10:10:00+03:00") });
  await page.clock.pauseAt(new Date("2026-10-30T10:10:00+03:00"));
  await page.addInitScript(() => {
    localStorage.setItem("ritm.speech", "off");
    localStorage.setItem("ritm.session_id", crypto.randomUUID());
  });
});

async function loaded(page) {
  await page.goto("/");
  await expect(page.locator("#records")).toHaveAttribute("aria-busy", "false");
  await expect(page.locator("#sync-status")).toHaveText("Данные на сервере · обновить");
}

async function screenshot(page, name) {
  await fs.mkdir(artifacts, { recursive: true });
  await page.screenshot({ path: path.join(artifacts, name + ".png"), animations: "disabled" });
}

async function geometry(page) {
  const findings = await page.evaluate(() => {
    const rect = id => document.getElementById(id).getBoundingClientRect();
    const main = rect("workspace-main");
    const day = rect("day-panel");
    const ai = document.getElementById("assistant-panel");
    const editor = document.getElementById("event-editor");
    const composer = rect("composer");
    const errors = [];
    if (document.documentElement.scrollWidth > innerWidth + 1) errors.push("page horizontal overflow");
    if (day.right > main.left + 1) errors.push("left/main overlap");
    if (!ai.hidden && (main.right > rect("assistant-panel").left + 1 || rect("assistant-panel").right > innerWidth + 1)) errors.push("main/assistant overlap");
    if (!ai.hidden && (composer.bottom > innerHeight || composer.top < rect("assistant-panel").top)) errors.push("composer outside panel");
    if (!editor.hidden && (rect("event-editor").left < rect("records").right - 1 || rect("event-editor").right > main.right)) errors.push("editor overlap");
    for (const id of ["records", "event-editor", "day-panel", "assistant-panel", "header"]) {
      const node = document.getElementById(id);
      if (!node.hidden && node.scrollWidth > node.clientWidth + 1) errors.push(id + " content overflow");
    }
    return errors;
  });
  expect(findings).toEqual([]);
}

test("dashboard uses real data; workspaces switch and notifications stay unavailable", async ({ page }) => {
  const errors = []; page.on("pageerror", error => errors.push(error.message));
  await loaded(page);
  await expect(page.locator("h1")).toHaveText("Мои задачи");
  await expect(page.locator("#day-time")).toHaveText("10:10");
  await expect(page.locator("#workspace-select")).toBeEnabled();
  expect(await page.locator("#workspace-select option").count()).toBeGreaterThan(0);
  await expect(page.getByRole("button", { name: "Создать пространство" })).toBeEnabled();
  await expect(page.getByRole("button", { name: "Уведомления недоступны" })).toBeDisabled();
  await expect(page.locator("#day-meetings")).toContainText("Планирование с командой");
  await expect(page.locator("#records")).toContainText("Согласовать макет");
  await geometry(page);
  expect(errors).toEqual([]);
});

test("tabs, calendar date, completed group and filters", async ({ page }) => {
  await loaded(page);
  await page.locator('[data-tab="calendar"]').click();
  await expect(page.locator("#records")).toContainText("Обсуждение проекта");
  await page.locator("#calendar-date").fill("2026-10-31");
  await page.locator("#calendar-date").dispatchEvent("change");
  await expect(page.locator("#records")).toContainText("ничего не запланировано");
  await page.locator("#calendar-today").click();
  await expect(page.locator("#records")).toContainText("Планирование с командой");
  await page.locator('[data-tab="tasks"]').click();
  await page.locator("#status-filter").selectOption("done");
  const group = page.getByRole("button", { name: /Завершённые/ });
  if (await group.getAttribute("aria-expanded") === "false") await group.click();
  await expect(page.locator("#records .task-row").first().locator("input")).toBeChecked();
  await expect(page.locator("#records .task-row").first()).toHaveClass(/is-done/);
  await screenshot(page, "completed-tasks");
});

test("search finds a real entity and opens editor; empty and error states", async ({ page }) => {
  await loaded(page);
  await page.locator("#search-input").fill("Согласовать макет");
  await page.locator("#search-form").press("Enter");
  await expect(page.locator("#search-list")).toContainText("Согласовать макет");
  await page.locator("#search-list button").first().click();
  await expect(page.locator("#edit-title")).toHaveValue("Согласовать макет");
  await page.locator("#search-input").fill("несуществующийзапросцфщ");
  await page.locator("#search-form").press("Enter");
  await expect(page.locator("#search-status")).toContainText("Ничего не найдено");
  await page.route("**/api/search?*", route => route.fulfill({ status: 500, body: "failed" }));
  await page.locator("#search-input").fill("сбой");
  await page.locator("#search-form").press("Enter");
  await expect(page.locator("#search-status")).toContainText("500");
});

test("create, edit and complete task update list, sidebar, calendar and dialogue", async ({ page }) => {
  await loaded(page);
  await page.locator("#add-button").click();
  await expect(page.locator("#create-dialog")).toBeVisible();
  await page.locator("#create-name").fill("Проверить спецификацию");
  await page.locator("#create-date").fill("2026-10-30");
  await page.locator("#create-time").fill("18:00");
  await page.locator("#create-dialog").getByRole("button", { name: "Создать задачу", exact: true }).click();
  await expect(page.locator("#create-dialog")).not.toBeVisible();
  await page.locator("#message-input").fill("Какие задачи у меня сегодня?");
  await page.locator("#message-input").press("Enter");
  await expect(page.locator("#dialogue")).toContainText("Проверить спецификацию");
  await expect(page.locator("#records")).toContainText("Проверить спецификацию", { ignoreCase: true });
  await page.locator("#records .task-row__content").filter({ hasText: /проверить спецификацию/i }).click();
  await page.locator("#edit-title").fill("Проверить спецификацию E2E");
  await page.locator("#edit-time").fill("18:30");
  await page.getByRole("button", { name: "Сохранить изменения" }).click();
  await expect(page.locator(".editor-save-status")).toHaveText("Изменения сохранены на сервере");
  await expect(page.locator("#day-tasks")).toContainText("Проверить спецификацию E2E");
  await expect(page.locator("#dialogue .event-card__title").last()).toHaveText("Проверить спецификацию E2E");
  await page.getByRole("button", { name: "Завершить запись", exact: true }).click();
  await expect(page.locator(".editor-save-status")).toHaveText("Изменения сохранены на сервере");
  await expect(page.locator("#day-tasks .day-task").filter({ hasText: "Проверить спецификацию E2E" }).locator("input")).toBeChecked();
  await expect(page.locator("#dialogue .event-card").last()).toHaveClass(/is-done/);
  await page.locator('[data-tab="calendar"]').click();
  await expect(page.locator("#records")).toContainText("Проверить спецификацию E2E");
});

test("AI panel collapses, frees space and preserves draft and history", async ({ page }) => {
  await loaded(page);
  await page.locator("#message-input").fill("Какие планы на сегодня?");
  await page.locator("#message-input").press("Enter");
  await expect(page.locator(".message-assistant").first()).toBeVisible();
  await expect(page.locator("#message-input")).toBeEnabled();
  await page.locator("#message-input").fill("Черновик\nс новой строкой");
  const history = await page.locator("#dialogue").innerText();
  const before = await page.locator("#workspace-main").boundingBox();
  await page.locator("#assistant-close").click();
  await expect(page.locator("#assistant-panel")).toBeHidden();
  const after = await page.locator("#workspace-main").boundingBox();
  expect(after.width).toBeGreaterThan(before.width + 200);
  await screenshot(page, "assistant-closed");
  await page.locator("#assistant-open").click();
  await expect(page.locator("#message-input")).toHaveValue("Черновик\nс новой строкой");
  expect(await page.locator("#dialogue").innerText()).toBe(history);
  await page.locator("#message-input").press("Shift+Enter");
  await expect(page.locator("#message-input")).toHaveValue("Черновик\nс новой строкой\n");
});

test("sidebar completion updates the open editor and can be reversed", async ({ page }) => {
  await loaded(page);
  await page.getByRole("button", { name: "Открыть: Подготовить материалы к встрече", exact: true }).click();
  await page.locator("#day-tasks .day-task").filter({ hasText: "Подготовить материалы к встрече" }).locator("input").check();
  await expect(page.locator("#edit-status")).toHaveValue("done");
  await expect(page.locator("#records .task-row").filter({ hasText: "Подготовить материалы к встрече" })).toHaveClass(/is-done/);
  await page.getByRole("button", { name: "Вернуть в открытые", exact: true }).click();
  await expect(page.locator(".editor-save-status")).toHaveText("Изменения сохранены на сервере");
  await expect(page.locator("#edit-status")).toHaveValue("planned");
  await expect(page.locator("#day-tasks .day-task").filter({ hasText: "Подготовить материалы к встрече" }).locator("input")).not.toBeChecked();
});

test("create a reminder through the existing dialogue", async ({ page }) => {
  await loaded(page);
  await page.locator('[data-tab="reminders"]').click();
  await page.locator('.quick-commands [data-prompt="Напомни мне "]').click();
  await expect(page.locator("#message-input")).toHaveValue("Напомни мне ");
  await page.locator("#message-input").fill("Напомни мне завтра в 10:00 проверить браузерные тесты");
  await page.locator("#message-input").press("Enter");
  await page.getByRole("button", { name: "Подтвердить", exact: true }).click();
  await expect(page.locator("#records")).toContainText("Проверить браузерные тесты", { ignoreCase: true });
  await expect(page.locator("#records")).toContainText("31 октября 2026");
});

test("a late history response cannot restore a previous conversation", async ({ page }) => {
  test.skip(!USE_DB_MOCKS, "Мок истории из БД выключен");
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  let started;
  const ready = new Promise(resolve => { started = resolve; });
  await page.route("**/api/history?*", async route => {
    started();
    await gate;
    await route.fulfill({ json: { messages: [{ id: 1, role: "assistant", text: "Старый диалог", kind: "info", created_at: "2026-10-30T09:00:00" }] } });
  });
  await page.goto("/");
  await ready;
  await page.locator("#menu-button").click();
  await page.locator("#new-chat").click();
  const response = page.waitForResponse(response => response.url().includes("/api/history?"));
  release();
  await response;
  await expect(page.locator("#dialogue")).toBeEmpty();
  await expect(page.locator("#hero")).toBeVisible();
});

test("a refresh preserves unsaved editor fields; canceling discard keeps the current view", async ({ page }) => {
  await loaded(page);
  await page.getByRole("button", { name: "Открыть: Проверить документы", exact: true }).click();
  await page.locator("#edit-title").fill("Несохранённый черновик");
  await page.locator("#sync-status").click();
  await expect(page.locator("#sync-status")).toHaveText("Данные на сервере · обновить");
  await expect(page.locator("#edit-title")).toHaveValue("Несохранённый черновик");
  await page.locator('[data-tab="calendar"]').click();
  await page.getByRole("button", { name: "Продолжить редактирование", exact: true }).click();
  await expect(page.locator("#view-title")).toHaveText("Мои задачи");
  await expect(page.locator("#edit-title")).toHaveValue("Несохранённый черновик");
  await page.getByRole("button", { name: "Закрыть редактор", exact: true }).click();
  await page.getByRole("button", { name: "Не сохранять", exact: true }).click();
  await expect(page.locator("#event-editor")).toBeHidden();
});

test("reminders sort and edit real timestamps; notifications are not simulated", async ({ page }) => {
  await loaded(page);
  await page.locator('[data-tab="reminders"]').click();
  await expect(page.locator(".reminder-card").first()).toContainText("Позвонить в типографию");
  await expect(page.locator(".reminder-card").first()).toContainText("Через 25 мин");
  await page.locator("#sort-order").selectOption("desc");
  await expect(page.locator(".reminder-card").first()).toContainText("Подготовиться к обсуждению");
  await page.locator(".reminder-card").first().getByRole("button").click();
  await expect(page.locator("#event-editor")).toContainText("доставка уведомлений пока недоступны");
  await page.locator("#edit-time").fill("14:10");
  await page.getByRole("button", { name: "Сохранить изменения" }).click();
  await expect(page.locator(".editor-save-status")).toHaveText("Изменения сохранены на сервере");
  await expect(page.locator(".reminder-card").first()).toContainText("14:10");
});

test("network errors keep data and draft; retry recovers without duplicate creation", async ({ page }) => {
  await loaded(page);
  await page.route("**/api/events", route => route.fulfill({ status: 503, body: "unavailable" }));
  await page.locator("#sync-status").click();
  await expect(page.locator("#data-status")).toContainText("503");
  await expect(page.locator("#records")).toContainText("Согласовать макет");
  await screenshot(page, "load-error");
  await page.unroute("**/api/events");
  await page.locator("#data-status").getByRole("button", { name: "Повторить" }).click();
  await expect(page.locator("#data-status")).toBeHidden();
  // Backend accepts the message, then the browser loses its response.
  let first = true; const requests = [];
  await page.route("**/api/message", async route => {
    requests.push(route.request().postDataJSON());
    if (first) { first = false; await route.fetch(); await route.abort("failed"); }
    else await route.continue();
  });
  await page.locator("#message-input").fill("Поставь задачу уникальная повторная отправка E2E");
  await page.locator("#message-input").press("Enter");
  await expect(page.locator(".message-error")).toContainText("Не удалось отправить");
  await page.locator(".message-error").getByRole("button", { name: "Повторить" }).click();
  await page.getByRole("button", { name: "Подтвердить", exact: true }).click();
  await expect(page.locator("#dialogue .event-card__title").last()).toContainText("Уникальная повторная отправка", { ignoreCase: true });
  expect(requests[0].request_id).toBe(requests[1].request_id);
  const response = await page.request.get("/api/events");
  const events = (await response.json()).events;
  expect(events.filter(e => /уникальная повторная отправка/i.test(e.title))).toHaveLength(1);
});

test("initial error, empty records and permission error states", async ({ page }) => {
  await page.route("**/api/events", route => route.fulfill({ status: 403, body: "denied" }));
  await page.goto("/");
  await expect(page.locator("#data-status")).toContainText("Нет доступа");
  await page.unroute("**/api/events");
  if (!USE_DB_MOCKS) return;
  await page.route("**/api/events", route => route.fulfill({ json: { events: [] } }));
  await page.locator("#sync-status").click();
  await expect(page.locator("#records")).toContainText("Добавьте первую задачу");
  await screenshot(page, "empty-state");
});

test("failed save preserves editor draft, and prevents false success", async ({ page }) => {
  await loaded(page);
  await page.getByRole("button", { name: "Открыть: Согласовать макет", exact: true }).click();
  await page.locator("#edit-title").fill("Черновик после ошибки");
  await page.route("**/api/events/*", route => route.fulfill({ status: 500, body: "failed" }));
  await page.getByRole("button", { name: "Сохранить изменения" }).click();
  await expect(page.locator(".editor-save-status")).toContainText("500");
  await expect(page.locator("#edit-title")).toHaveValue("Черновик после ошибки");
  await expect(page.locator("#records")).toContainText("Согласовать макет");
  await expect(page.locator("#sync-status")).toContainText("Ошибка");
});

test("delete requires explicit confirmation and refreshes all views", async ({ page }) => {
  await loaded(page);
  await page.locator("#message-input").fill("Поставь задачу временная запись для удаления E2E сегодня в 19:00");
  await page.locator("#message-input").press("Enter");
  await page.getByRole("button", { name: "Подтвердить", exact: true }).click();
  await expect(page.locator("#dialogue .event-card__title").last()).toContainText("Временная запись", { ignoreCase: true });
  const card = page.locator("#dialogue .event-card").last();
  await card.getByRole("button", { name: /Удалить/ }).click();
  await expect(page.locator("#confirm-dialog")).toBeVisible();
  await expect(page.locator("#records")).toContainText("Временная запись", { ignoreCase: true });
  await page.locator("#confirm-keep").click();
  await expect(card).toBeVisible();
  await card.getByRole("button", { name: /Удалить/ }).click();
  await page.locator("#confirm-delete").click();
  await expect(page.locator("#confirm-dialog")).toBeHidden();
  await expect(page.locator("#records")).not.toContainText("Временная запись", { ignoreCase: true });
  await expect(page.locator("#day-tasks")).not.toContainText("Временная запись", { ignoreCase: true });
});

test("AI meeting conflict is not confirmed automatically", async ({ page }) => {
  await loaded(page);
  const before = (await (await page.request.get("/api/events")).json()).events.length;
  await page.locator("#message-input").fill("Добавь встречу с тестовой командой сегодня в 11:30");
  await page.locator("#message-input").press("Enter");
  await expect(page.locator("#suggestions")).toBeVisible();
  await expect(page.locator(".message-assistant").last()).toContainText(/пересекается|занято|конфликт/i);
  expect((await (await page.request.get("/api/events")).json()).events.length).toBe(before);
  await screenshot(page, "ai-confirmation");
  await page.getByRole("button", { name: "Подтвердить", exact: true }).click();
  await expect(page.locator("#dialogue .event-card__title").last()).toContainText("тестовой командой", { ignoreCase: true });
  expect((await (await page.request.get("/api/events")).json()).events.length).toBe(before + 1);
});

for (const [width, height] of sizes) {
  test(`desktop geometry ${width}x${height}, editor and panel states`, async ({ page }) => {
    const errors = []; page.on("pageerror", error => errors.push(error.message));
    await page.setViewportSize({ width, height });
    await loaded(page);
    await page.locator("#message-input").fill("Какие задачи у меня сегодня?");
    await page.locator("#message-input").press("Enter");
    await expect(page.locator(".message-assistant").first()).toBeVisible();
    await page.getByRole("button", { name: "Открыть: Согласовать макет", exact: true }).click();
    await geometry(page);
    await screenshot(page, `tasks-editor-${width}x${height}`);
    await page.locator("#assistant-close").click();
    await geometry(page);
    await page.locator("#assistant-open").click();
    await page.locator('[data-tab="reminders"]').click();
    await geometry(page);
    await screenshot(page, `reminders-${width}x${height}`);
    expect(errors).toEqual([]);
  });
}

test("long content, many records and history scroll independently; panel widths", async ({ page }) => {
  test.skip(!USE_DB_MOCKS, "Мок набора записей из БД выключен");
  const base = (await (await page.request.get("/api/events")).json()).events.find(e => e.type === "task" && e.status === "planned");
  const longTitle = "ОченьДлинноеНазваниеБезПробелов".repeat(10);
  const events = Array.from({ length: 200 }, (_, i) => ({ ...base, id: 2000 + i, title: i === 0 ? longTitle : `Тестовая задача ${i}` }));
  await page.route("**/api/events", route => route.fulfill({ json: { events } }));
  await page.route("**/api/history?*", route => route.fulfill({ json: { messages: Array.from({ length: 80 }, (_, i) => ({ id: i + 1, role: i % 2 ? "assistant" : "user", text: longTitle, kind: "info", request_id: `long-${i}` })) } }));
  await loaded(page);
  await page.locator("#records .task-row__content").first().click();
  await geometry(page);
  await expect(page.locator("#edit-title")).toHaveValue(longTitle);
  expect(await page.locator("#records").evaluate(node => node.scrollHeight > node.clientHeight)).toBe(true);
  expect(await page.locator("#dialogue-scroll").evaluate(node => node.scrollHeight > node.clientHeight)).toBe(true);
  await screenshot(page, "long-content");
  await page.setViewportSize({ width: 1920, height: 1080 });
  await page.evaluate(() => {
    document.documentElement.style.setProperty("--assistant-width", "420px");
    document.documentElement.style.setProperty("--sidebar-width", "240px");
  });
  await geometry(page);
  await screenshot(page, "wider-panels");
});

test("actual browser tab zoom 125 percent keeps desktop composition", async ({ baseURL }) => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "intime-zoom-"));
  const extension = path.join(directory, "extension");
  await fs.mkdir(extension);
  await fs.writeFile(path.join(extension, "manifest.json"), JSON.stringify({
    manifest_version: 3, name: "intime isolated zoom test", version: "1.0", permissions: ["tabs"],
    background: { service_worker: "worker.js" },
  }));
  await fs.writeFile(path.join(extension, "worker.js"), "chrome.tabs.onUpdated.addListener((id, info, tab) => { if (tab.url?.startsWith('http://127.0.0.1:')) chrome.tabs.setZoom(id, 1.25); });");
  const context = await chromium.launchPersistentContext(path.join(directory, "profile"), {
    headless: true, channel: "chromium", executablePath: process.env.INTIME_BROWSER_PATH,
    viewport: null, timezoneId: "Europe/Moscow", locale: "ru-RU",
    args: [`--disable-extensions-except=${extension}`, `--load-extension=${extension}`, "--window-size=1920,1080"],
  });
  try {
    const page = context.pages()[0];
    await page.clock.install({ time: new Date("2026-10-30T10:10:00+03:00") });
    await page.addInitScript(() => localStorage.setItem("ritm.speech", "off"));
    await page.goto(baseURL);
    await expect(page.locator("#sync-status")).toHaveText("Данные на сервере · обновить");
    const worker = context.serviceWorkers()[0] || await context.waitForEvent("serviceworker");
    const factor = await worker.evaluate(async () => {
      const tabs = await chrome.tabs.query({});
      const tab = tabs.find(item => item.url?.startsWith("http://127.0.0.1:"));
      await chrome.tabs.setZoom(tab.id, 1.25);
      return chrome.tabs.getZoom(tab.id);
    });
    expect(factor).toBe(1.25);
    await page.getByRole("button", { name: "Открыть: Согласовать макет", exact: true }).click();
    await geometry(page);
    await fs.writeFile(path.join(artifacts, "zoom-geometry.json"), JSON.stringify(await page.evaluate(() => ({
      innerWidth, innerHeight, devicePixelRatio,
      screenWidth: screen.width, screenHeight: screen.height,
      viewport: { width: visualViewport.width, height: visualViewport.height, scale: visualViewport.scale },
      app: document.getElementById("app").getBoundingClientRect().toJSON(),
      assistant: document.getElementById("assistant-panel").getBoundingClientRect().toJSON(),
      composer: document.getElementById("composer").getBoundingClientRect().toJSON(),
    })), null, 2));
    // Capture Chromium's physical surface: Playwright's CSS-sized clipping rectangle
    // loses the right/bottom of a tab when browser zoom changes devicePixelRatio.
    const cdp = await context.newCDPSession(page);
    const capture = await cdp.send("Page.captureScreenshot", { format: "png", fromSurface: true, captureBeyondViewport: false });
    await fs.writeFile(path.join(artifacts, "desktop-zoom-125.png"), Buffer.from(capture.data, "base64"));
    await fs.writeFile(path.join(artifacts, "browser-version.txt"), `${context.browser().version()}\nTab zoom: ${factor}\n`);
  } finally { await context.close(); }
});
