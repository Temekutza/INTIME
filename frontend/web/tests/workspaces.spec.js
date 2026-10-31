import { test, expect } from "@playwright/test";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
const artifacts = process.env.AIVRITM_TEST_ARTIFACTS || path.join(os.tmpdir(), "intime-workspaces-qa");
const switcher = page => page.getByRole("button", { name: "Выбрать пространство", exact: true });
test.beforeEach(async ({ page }) => {
  await page.clock.setFixedTime(new Date("2026-10-30T10:10:00+03:00"));
  await page.addInitScript(() => {
    localStorage.setItem("ritm.speech", "off");
    if (!sessionStorage.getItem("workspace-test-started")) { localStorage.removeItem("ritm.workspace-id"); sessionStorage.setItem("workspace-test-started", "1"); }
  });
});
async function load(page) { await page.goto("/"); await expect(page.locator("#records")).toHaveAttribute("aria-busy", "false"); }
async function choose(page, name) { await switcher(page).click(); await page.getByRole("menuitemradio", { name, exact: true }).click(); await expect(switcher(page)).toContainText(name); }
async function makeSpace(page, name) {
  await switcher(page).click(); await page.getByRole("menuitem", { name: "Создать пространство", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "Новое пространство", exact: true });
  await dialog.locator("#workspace-name").fill(name); await dialog.getByRole("button", { name: "Создать", exact: true }).click();
  await expect(dialog).not.toBeVisible(); await expect(switcher(page)).toContainText(name); await expect(page.locator("#records")).toHaveAttribute("aria-busy", "false");
  return Number(await page.evaluate(() => localStorage.getItem("ritm.workspace-id")));
}
async function shot(page, name) { await fs.mkdir(artifacts, { recursive: true }); await page.screenshot({ path: path.join(artifacts, name + ".png") }); }

test("header panel icons retain fixed positions in all four states and desktop widths", async ({ page }) => {
  for (const [width, height] of [[1280, 800], [1366, 768], [1440, 900], [1920, 1080]]) {
    await page.setViewportSize({ width, height }); await load(page);
    if (await page.locator("#day-open").getAttribute("aria-expanded") === "false") await page.locator("#day-open").click();
    if (await page.locator("#assistant-open").getAttribute("aria-expanded") === "false") await page.locator("#assistant-open").click();
    const positions = [], widths = [];
    for (const [state, toggle] of [["both-open", null], ["left-closed", "day-open"], ["both-closed", "assistant-open"], ["right-closed", "day-open"], ["restored", "assistant-open"]]) {
      if (toggle) await page.locator("#" + toggle).click();
      positions.push(await page.evaluate(() => ["day-open", "assistant-open", "header"].map(id => { const r = document.getElementById(id).getBoundingClientRect(); return [r.x, r.y, r.width, r.height]; })));
      widths.push((await page.locator("#workspace-main").boundingBox()).width);
      expect(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth)).toBe(false);
      if (width === 1440) await shot(page, "panels-" + state);
    }
    for (const position of positions) expect(position).toEqual(positions[0]);
    expect(widths[1]).toBeGreaterThan(widths[0]); expect(widths[2]).toBeGreaterThan(widths[1]); expect(widths[4]).toBe(widths[0]);
    await expect(page.locator("#day-panel")).toBeVisible(); await expect(page.locator("#assistant-panel")).toBeVisible();
  }
});

test("create, rename and restore workspaces; forms and search use the selected space", async ({ page, request }) => {
  await load(page); const work = "Работа " + Date.now(), home = "Дом " + Date.now();
  const workId = await makeSpace(page, work);
  await page.locator("#add-button").click(); await page.locator("#create-name").fill("Подготовить презентацию пространства");
  await page.getByRole("dialog", { name: "Новая задача" }).getByRole("button", { name: "Создать задачу", exact: true }).click();
  await expect(page.locator("#edit-title")).toHaveValue("Подготовить презентацию пространства");
  const homeId = await makeSpace(page, home);
  await expect(page.locator("#records")).not.toContainText("Подготовить презентацию пространства"); await expect(page.locator("#event-editor")).toBeHidden();
  await page.locator('[data-tab="reminders"]').click(); await page.locator("#add-button").click();
  await page.locator("#create-name").fill("Купить продукты пространства"); await page.locator("#create-date").fill("2026-10-31"); await page.locator("#create-time").fill("18:00");
  await page.getByRole("button", { name: "Создать напоминание", exact: true }).click();
  await expect(page.locator("#edit-title")).toHaveValue("Купить продукты пространства");
  await choose(page, work); await page.locator('[data-tab="calendar"]').click(); await page.locator("#add-button").click();
  await page.locator("#create-name").fill("Обсуждение рабочего пространства"); await page.locator("#create-date").fill("2026-10-31"); await page.locator("#create-time").fill("15:00");
  await page.getByRole("dialog", { name: "Новая встреча", exact: true }).getByRole("button", { name: "Создать встречу", exact: true }).click(); await expect(page.locator("#calendar-editor-dialog")).toBeVisible();
  await page.getByRole("button", { name: "Закрыть редактор", exact: true }).click();
  const workRows = (await (await request.get(`/api/events?workspace_id=${workId}`)).json()).events;
  expect(workRows.map(row => row.type).sort()).toEqual(["meeting", "task"]);
  expect((await (await request.get(`/api/events?workspace_id=${homeId}`)).json()).events.map(row => row.type)).toEqual(["reminder"]);
  await choose(page, home); await page.locator("#search-input").fill("Подготовить презентацию пространства"); await page.locator("#search-form").press("Enter");
  await expect(page.locator("#search-status")).toContainText("Ничего");
  await page.locator("#search-close").click(); await choose(page, work);
  await switcher(page).click(); await page.getByRole("menuitem", { name: "Управление пространствами", exact: true }).click();
  await page.locator(".workspace-management-row").filter({ hasText: work }).getByRole("button", { name: "Переименовать" }).click();
  const renamed = "Проекты " + Date.now(); await page.locator("#workspace-name").fill(renamed); await page.getByRole("dialog", { name: "Переименовать пространство" }).getByRole("button", { name: "Сохранить", exact: true }).click();
  await expect(switcher(page)).toContainText(renamed); await page.reload(); await expect(switcher(page)).toContainText(renamed);
  await expect(page.locator("#tasks-count")).toHaveText("1"); await expect(page.locator("#reminders-count")).toHaveText("0");
  await switcher(page).click(); await shot(page, "workspace-menu"); await page.keyboard.press("Escape"); await expect(switcher(page)).toBeFocused();
});

test("AI confirmation remains in its own space, active requests block a context switch", async ({ page, request }) => {
  await load(page); const work = "AI работа " + Date.now(), home = "AI дом " + Date.now();
  const workId = await makeSpace(page, work), homeId = await makeSpace(page, home); await choose(page, work);
  let release; const gate = new Promise(resolve => { release = resolve; });
  let started; const sending = new Promise(resolve => { started = resolve; });
  await page.route("**/api/message", async route => { started(); await gate; await route.continue(); });
  try {
    await page.locator("#message-input").fill("Поставь задачу подготовить отчёт по пространству"); await page.locator("#message-input").press("Enter"); await sending;
    await switcher(page).click(); await page.getByRole("menuitemradio", { name: home, exact: true }).click();
    await expect(switcher(page)).toContainText(work); await expect(page.locator(".workspace-menu__error")).toBeVisible();
    release(); await expect(page.locator('.confirmation-card[data-state="pending"]')).toBeVisible();
    await page.unroute("**/api/message"); await page.keyboard.press("Escape");
    await choose(page, home); await expect(page.locator("#dialogue")).not.toContainText("подготовить отчёт по пространству");
    await choose(page, work); await expect(page.locator('.confirmation-card[data-state="pending"]')).toBeVisible();
    await page.getByRole("button", { name: "Подтвердить", exact: true }).click(); await expect(page.locator("#dialogue .event-card")).toContainText("отчёт");
    expect((await (await request.get(`/api/events?workspace_id=${homeId}`)).json()).events).toEqual([]);
    expect((await (await request.get(`/api/events?workspace_id=${workId}`)).json()).events).toHaveLength(1);
  } finally { release(); }
});

test("a late events response cannot show previous-space data after fast switching", async ({ page, request }) => {
  const work = (await (await request.post("/api/workspaces", { data: { name: "Быстрая работа " + Date.now() } })).json());
  const home = (await (await request.post("/api/workspaces", { data: { name: "Быстрый дом " + Date.now() } })).json());
  for (const row of [work, home]) await request.post("/api/events", { data: { workspace_id: row.id, session_id: crypto.randomUUID(), request_id: crypto.randomUUID(), type: "task", title: row.name } });
  await load(page); let release; const gate = new Promise(resolve => { release = resolve; });
  await page.route(`**/api/events?workspace_id=${work.id}`, async route => { await gate; await route.continue(); });
  try {
    await choose(page, work.name); await choose(page, home.name); await expect(page.locator("#records")).not.toContainText(work.name);
    release(); await expect(page.locator("#records")).toContainText(home.name); await expect(page.locator("#records")).not.toContainText(work.name);
  } finally { release(); }
});

test("creation waits for the restored workspace instead of falling back to default", async ({ page, request }) => {
  const space = (await (await request.post("/api/workspaces", { data: { name: "Загрузка контекста " + Date.now() } })).json());
  await load(page); await page.evaluate(id => localStorage.setItem("ritm.workspace-id", String(id)), space.id);
  let release; const gate = new Promise(resolve => { release = resolve; });
  await page.route("**/api/workspaces", async route => { await gate; await route.continue(); });
  try {
    await page.reload({ waitUntil: "domcontentloaded" });
    await expect(page.locator("#create-button")).toBeDisabled(); await expect(page.locator("#add-button")).toBeDisabled();
    await page.locator("#message-input").fill("Черновик до загрузки пространства"); await page.locator("#message-input").press("Enter");
    await expect(page.locator("#dialogue .message-user")).toHaveCount(0);
    release(); await expect(switcher(page)).toContainText(space.name); await expect(page.locator("#add-button")).toBeEnabled();
    await expect(page.locator("#message-input")).toHaveValue("Черновик до загрузки пространства");
    expect((await (await request.get(`/api/events?workspace_id=${space.id}`)).json()).events).toEqual([]);
  } finally { release(); }
});
