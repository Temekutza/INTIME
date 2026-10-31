import { test, expect } from "@playwright/test";

test.beforeEach(async ({ page }) => {
  await page.addInitScript(() => {
    localStorage.setItem("ritm.speech", "off");
    localStorage.removeItem("ritm.day-hidden"); localStorage.removeItem("ritm.assistant-hidden");
  });
});

test("local Inter font, original logo in white header and aligned quick commands", async ({ page }) => {
  const failures = []; const external = [];
  page.on("response", response => { if (/\/assets\//.test(response.url()) && !response.ok()) failures.push(response.url()); });
  page.on("request", request => { if (/^https?:/.test(request.url()) && new URL(request.url()).hostname !== "127.0.0.1") external.push(request.url()); });
  await page.goto("/"); await expect(page.locator("#records")).toHaveAttribute("aria-busy", "false");
  const fonts = await page.evaluate(async () => {
    const sans = await document.fonts.load('400 14px "Inter"', "Задача");
    const serif = await document.fonts.load('600 26px "Inter"', "Календарь");
    return { sans: sans.length, serif: serif.length, body: getComputedStyle(document.body).fontFamily, title: getComputedStyle(document.querySelector("h1")).fontFamily };
  });
  expect(fonts.sans).toBeGreaterThan(0); expect(fonts.serif).toBeGreaterThan(0);
  expect(fonts.body).toContain("Inter"); expect(fonts.title).toContain("Inter");
  const logo = page.locator('#header .brand img[alt="InTime"]');
  await expect(logo).toBeVisible(); expect(await logo.evaluate(node => node.naturalWidth)).toBe(2172);
  const brand = await logo.boundingBox(), header = await page.locator("#header").boundingBox(); expect(brand.y + brand.height).toBeLessThanOrEqual(header.y + header.height);
  await expect(page.locator("#day-panel .brand")).toHaveCount(0);
  const commands = await page.locator(".quick-commands button").evaluateAll(buttons => buttons.map(button => {
    const r = button.getBoundingClientRect(), icon = button.querySelector('[data-icon]').getBoundingClientRect(), label = button.querySelector('.quick-command__label').getBoundingClientRect();
    return { x: r.x, width: r.width, icon: icon.x, label: label.x };
  }));
  expect(commands).toHaveLength(4);
  for (const command of commands) expect(command).toEqual(commands[0]);
  await expect(page.locator("#send-button .icon svg")).toHaveCount(1);
  await expect(page.locator("#mic-button .icon svg")).toHaveCount(1);
  await expect(page.locator("#attach-button")).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Уведомления недоступны" })).toHaveCount(0);
  await expect(page.locator("#workspace-add")).toBeHidden();
  await page.locator("#color-settings-button").click();
  await expect(page.getByRole("dialog", { name: "Цвета объектов" })).toBeVisible();
  await page.getByRole("button", { name: "Закрыть настройки цветов" }).click();
  expect(failures).toEqual([]); expect(external).toEqual([]);
});

for (const [width, height] of [[1280, 800], [1440, 900], [1920, 1080]]) test(`shell does not change scale across tabs ${width}x${height}`, async ({ page }) => {
  await page.setViewportSize({ width, height }); await page.goto("/");
  await expect(page.locator("#records")).toHaveAttribute("aria-busy", "false"); await page.evaluate(() => document.fonts.ready);
  const frames = [];
  for (const tab of ["tasks", "calendar", "reminders", "tasks"]) {
    await page.locator(`[data-tab="${tab}"]`).click();
    frames.push(await page.evaluate(() => {
      const rect = id => { const r = document.querySelector(id).getBoundingClientRect(); return [r.x, r.y, r.width, r.height]; };
      return { header: rect("#header"), left: rect("#day-panel"), right: rect("#assistant-panel"), clock: rect(".clock"), main: rect("#workspace-main"), tabs: rect(".tabs"), titleSize: getComputedStyle(document.querySelector("h1")).fontSize };
    }));
    expect(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth + 1)).toBe(false);
  }
  for (const frame of frames) expect(frame).toEqual(frames[0]);
  await page.locator("#day-open").click(); await expect(page.locator("#day-open")).toBeVisible();
  await page.locator("#day-open").click(); await expect(page.locator("#header .brand")).toBeVisible();
});
