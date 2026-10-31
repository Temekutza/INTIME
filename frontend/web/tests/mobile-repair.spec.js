import { test, expect } from "@playwright/test";
import path from "node:path";
import { fileURLToPath } from "node:url";

const shots = path.join(path.dirname(fileURLToPath(import.meta.url)), "../artifacts/mobile-repair");

async function ready(page) {
  await page.goto("/");
  await expect(page.locator("#view-title")).toHaveText("Мои задачи");
  await expect(page.locator(".task-row").first()).toBeVisible();
}

async function touchSwipe(page, selector, distance = -320) {
  const box = await page.locator(selector).boundingBox();
  if (!box) throw new Error("missing " + selector);
  const x = Math.round(box.x + Math.min(80, box.width / 2));
  const startY = Math.round(box.y + Math.min(box.height - 40, Math.max(80, box.height * 0.72)));
  const session = await page.context().newCDPSession(page);
  await session.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [{ x, y: startY, id: 1 }] });
  for (let step = 1; step <= 8; step += 1) {
    await session.send("Input.dispatchTouchEvent", {
      type: "touchMove",
      touchPoints: [{ x, y: Math.round(startY + (distance * step) / 8), id: 1 }],
    });
  }
  await session.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
  await session.detach();
}

async function scrollMetrics(page) {
  return page.evaluate(() => {
    const records = document.getElementById("records");
    const style = getComputedStyle(records);
    return {
      overflowY: style.overflowY,
      touchAction: style.touchAction,
      scrollTop: records.scrollTop,
      scrollHeight: records.scrollHeight,
      clientHeight: records.clientHeight,
      canScroll: records.scrollHeight > records.clientHeight + 8,
    };
  });
}

test("SCR tasks and reminders scroll by touch and survive AI", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await ready(page);

  const tasksBefore = await scrollMetrics(page);
  expect(tasksBefore.overflowY).toBe("auto");
  expect(tasksBefore.canScroll).toBe(true);
  await page.screenshot({ path: path.join(shots, "tasks-before-scroll.png") });
  await touchSwipe(page, "#records");
  const tasksAfter = await scrollMetrics(page);
  expect(tasksAfter.scrollTop).toBeGreaterThan(40);
  await page.evaluate(() => { document.getElementById("records").scrollTop = document.getElementById("records").scrollHeight; });
  const atEnd = await scrollMetrics(page);
  expect(atEnd.scrollTop + atEnd.clientHeight).toBeGreaterThan(atEnd.scrollHeight - 4);
  const lastClear = await page.evaluate(() => {
    const row = document.querySelector("#records .task-row:last-child");
    const bar = document.getElementById("mobile-tabbar").getBoundingClientRect();
    const box = row.getBoundingClientRect();
    return box.bottom <= bar.top + 1;
  });
  expect(lastClear).toBe(true);
  await page.screenshot({ path: path.join(shots, "tasks-after-scroll.png") });
  await touchSwipe(page, "#records", 280);
  expect((await scrollMetrics(page)).scrollTop).toBeLessThan(atEnd.scrollTop - 20);

  await page.locator("[data-mobile-tab='reminders']").click();
  await expect(page.locator(".reminder-card").first()).toBeVisible();
  const remindersBefore = await scrollMetrics(page);
  expect(remindersBefore.overflowY).toBe("auto");
  expect(remindersBefore.canScroll).toBe(true);
  await page.screenshot({ path: path.join(shots, "reminders-before-scroll.png") });
  const remindersStart = (await scrollMetrics(page)).scrollTop;
  await touchSwipe(page, "#records");
  const remindersDown = await scrollMetrics(page);
  expect(remindersDown.scrollTop).toBeGreaterThan(remindersStart + 40);
  await page.screenshot({ path: path.join(shots, "reminders-after-scroll.png") });
  await touchSwipe(page, "#records", 280);
  expect((await scrollMetrics(page)).scrollTop).toBeLessThan(remindersDown.scrollTop - 20);

  await page.locator("#mobile-ai-open").click();
  await expect(page.locator("#assistant-panel")).toBeVisible();
  await expect(page.locator("#message-input")).toBeVisible();
  await page.screenshot({ path: path.join(shots, "ai-open.png") });
  await page.locator("#message-input").fill("Черновик календаря");
  await page.locator("#assistant-back").click();
  await expect(page.locator("#assistant-panel")).toBeHidden();
  const unlocked = await page.evaluate(() => ({
    ai: document.documentElement.classList.contains("ai-open"),
    inert: document.getElementById("workspace-main").hasAttribute("inert"),
    overflow: getComputedStyle(document.getElementById("records")).overflowY,
  }));
  expect(unlocked).toEqual({ ai: false, inert: false, overflow: "auto" });
  await touchSwipe(page, "#records");
  expect((await scrollMetrics(page)).scrollTop).toBeGreaterThan(40);
  await page.locator("#mobile-ai-open").click();
  await expect(page.locator("#message-input")).toHaveValue("Черновик календаря");
  await page.locator("#assistant-back").click();

  await page.locator("#mobile-create").click();
  await page.locator("[data-create='task']").click();
  await page.keyboard.press("Escape");
  await page.locator("[data-mobile-tab='tasks']").click();
  expect((await scrollMetrics(page)).overflowY).toBe("auto");
  await touchSwipe(page, "#records");
  expect((await scrollMetrics(page)).scrollTop).toBeGreaterThan(20);
});

test("CAL month, year and mode switch", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await ready(page);
  await page.screenshot({ path: path.join(shots, "ai-closed.png") });
  await page.locator("[data-mobile-tab='calendar']").click();
  await page.locator("[data-calendar-layout='month']").click();
  await expect(page.locator(".month-grid__day")).toHaveCount(42);
  const month = await page.evaluate(() => {
    const grid = document.querySelector(".month-grid");
    const columns = getComputedStyle(grid).gridTemplateColumns.split(" ").filter(Boolean);
    const cells = [...document.querySelectorAll(".month-grid__day")];
    const overflow = cells.some(cell => [...cell.querySelectorAll(".calendar-event, .month-grid__more")].some(node => {
      const inner = node.getBoundingClientRect();
      const outer = cell.getBoundingClientRect();
      return inner.right > outer.right + 1 || inner.left < outer.left - 1;
    }));
    const more = document.querySelector(".month-grid__more");
    return {
      columns: columns.length,
      overflow,
      more: more ? more.textContent : "",
      page: document.documentElement.scrollWidth <= document.documentElement.clientWidth + 1,
    };
  });
  expect(month.columns).toBe(7);
  expect(month.overflow).toBe(false);
  expect(month.more.startsWith("+")).toBe(true);
  expect(month.page).toBe(true);
  await page.screenshot({ path: path.join(shots, "month-calendar.png") });
  const beforeDay = await page.locator("#view-description").innerText();
  await page.locator(".month-grid__more").first().click();
  await expect(page.locator(".agenda-list, .agenda-card, .empty-state").first()).toBeVisible();
  expect(await page.locator("[data-calendar-layout='day']").getAttribute("aria-checked")).toBe("true");
  expect(await page.locator("#view-description").innerText()).not.toBe(beforeDay);

  await page.locator("[data-calendar-layout='month']").click();
  await page.getByRole("button", { name: "Следующий период" }).click();
  const nextMonth = await page.locator("#view-title").innerText();
  await page.getByRole("button", { name: "Сегодня" }).click();
  await expect(page.locator("#view-title")).not.toHaveText(nextMonth);

  await page.locator("[data-calendar-layout='year']").click();
  await expect(page.locator(".year-month")).toHaveCount(12);
  const year = await page.evaluate(() => {
    const grid = document.querySelector(".year-grid");
    const month = document.querySelector(".year-month__days");
    const title = document.getElementById("view-title").textContent || "";
    const range = document.getElementById("view-description").textContent || "";
    const yearText = title.match(/\d{4}/)?.[0];
    const days = [...document.querySelectorAll(".year-month")[0].querySelectorAll(".year-day")];
    let overlap = false;
    for (let index = 1; index < days.length; index += 1) {
      const previous = days[index - 1].getBoundingClientRect();
      const current = days[index].getBoundingClientRect();
      const sameRow = Math.abs(previous.top - current.top) < 4;
      if (sameRow && current.left < previous.right - 0.5) overlap = true;
    }
    return {
      months: getComputedStyle(grid).gridTemplateColumns.split(" ").filter(Boolean).length,
      days: getComputedStyle(month).gridTemplateColumns.split(" ").filter(Boolean).length,
      weekdays: document.querySelectorAll(".year-month__weekdays span").length,
      overlap,
      titleMatchesRange: Boolean(yearText) && range.includes(yearText) && !range.includes("01." + title),
      range,
      title,
      page: document.documentElement.scrollWidth <= document.documentElement.clientWidth + 1,
    };
  });
  expect(year.months).toBe(2);
  expect(year.days).toBe(7);
  expect(year.weekdays).toBe(7 * 12);
  expect(year.overlap).toBe(false);
  expect(year.range.startsWith("01.01.")).toBe(true);
  expect(year.title).toMatch(/^20\d{2}$/);
  expect(year.range).toContain(year.title);
  expect(year.page).toBe(true);
  await page.screenshot({ path: path.join(shots, "year-calendar.png") });
  const yearDay = page.locator(".year-month").nth(0).locator(".year-day").nth(10);
  await yearDay.click();
  await expect(page.locator("[data-calendar-layout='day']")).toHaveAttribute("aria-checked", "true");

  await page.locator("[data-calendar-layout='year']").click();
  const layout = page.locator("#calendar-layout");
  await layout.evaluate(node => { node.scrollLeft = node.scrollWidth; });
  const listBox = await page.evaluate(() => {
    const bar = document.getElementById("calendar-layout").getBoundingClientRect();
    const item = document.querySelector("[data-calendar-layout='list']").getBoundingClientRect();
    return item.left >= bar.left - 1 && item.right <= bar.right + 1 && item.width > 40;
  });
  expect(listBox).toBe(true);
  await page.locator("[data-calendar-layout='list']").click();
  await expect(page.locator(".calendar-row, .empty-state").first()).toBeVisible();
});

for (const [width, height] of [[320, 568], [360, 640], [375, 667], [375, 812], [414, 896], [430, 932]]) {
  test(`geometry ${width}x${height}`, async ({ page }) => {
    await page.setViewportSize({ width, height });
    await ready(page);
    await page.locator("[data-mobile-tab='calendar']").click();
    await page.locator("[data-calendar-layout='year']").click();
    const yearCols = await page.locator(".year-grid").evaluate(node => getComputedStyle(node).gridTemplateColumns.split(" ").filter(Boolean).length);
    expect(yearCols).toBe(width < 360 ? 1 : 2);
    if (width === 320) await page.screenshot({ path: path.join(shots, "year-narrow.png") });
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth + 1);
    expect(overflow).toBe(true);
    await page.locator("[data-calendar-layout='month']").click();
    const modes = await page.locator("#calendar-layout button").evaluateAll(nodes => nodes.map(node => ({
      text: node.textContent,
      clipped: node.scrollWidth > node.clientWidth + 1,
    })));
    expect(modes.map(mode => mode.text)).toEqual(["День", "Неделя", "Месяц", "Год", "Список"]);
    expect(modes.every(mode => !mode.clipped)).toBe(true);
    const monthCols = await page.locator(".month-grid").evaluate(node => getComputedStyle(node).gridTemplateColumns.split(" ").filter(Boolean).length);
    expect(monthCols).toBe(7);
    const monthOverflow = await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth + 1);
    expect(monthOverflow).toBe(true);
  });
}

test("CAL crowded month and desktop regression", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await ready(page);
  await page.locator("[data-mobile-tab='calendar']").click();
  await page.locator("[data-calendar-layout='month']").click();
  await page.screenshot({ path: path.join(shots, "month-crowded.png") });
  const chips = await page.locator(".month-grid__day").evaluateAll(cells => cells.map(cell => cell.querySelectorAll(".calendar-event").length));
  expect(Math.max(...chips)).toBeLessThanOrEqual(2);

  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto("/");
  await expect(page.locator("#mobile-tabbar")).toBeHidden();
  await expect(page.locator("#assistant-panel")).toBeVisible();
  const desktop = await page.evaluate(() => ({
    tasksOverflow: getComputedStyle(document.getElementById("records")).overflowY,
    columns: getComputedStyle(document.getElementById("layout")).gridTemplateColumns.split(" ").length,
  }));
  expect(desktop.tasksOverflow).toBe("visible");
  expect(desktop.columns).toBeGreaterThan(1);
  await page.locator("[data-tab='calendar']").click();
  await page.locator("[data-calendar-layout='year']").click();
  const yearCols = await page.locator(".year-grid").evaluate(node => getComputedStyle(node).gridTemplateColumns.split(" ").filter(Boolean).length);
  expect(yearCols).toBe(3);
  await page.screenshot({ path: path.join(shots, "desktop-year.png") });
});

test("AI open timing, history and keyboard shell", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  const historyCalls = [];
  page.on("request", request => { if (request.url().includes("/api/history")) historyCalls.push(request.url()); });
  await ready(page);
  const cold = await page.evaluate(() => {
    const button = document.getElementById("mobile-ai-open");
    const started = performance.now();
    button.click();
    const panel = getComputedStyle(document.getElementById("assistant-panel"));
    const input = document.getElementById("message-input");
    return {
      shell: performance.now() - started,
      visible: panel.display !== "none" && panel.visibility !== "hidden",
      input: input.getBoundingClientRect().height > 0 && !input.disabled,
    };
  });
  expect(cold.visible).toBe(true);
  expect(cold.input).toBe(true);
  expect(cold.shell).toBeLessThan(200);
  await page.locator("#assistant-back").click();
  const callsAfterClose = historyCalls.length;
  const repeat = await page.evaluate(() => {
    const started = performance.now();
    document.getElementById("mobile-ai-open").click();
    return performance.now() - started;
  });
  expect(repeat).toBeLessThan(200);
  expect(historyCalls.length).toBe(callsAfterClose);
  await page.locator("#assistant-back").click();

  await page.route("**/api/history**", route => route.fulfill({
    status: 200,
    contentType: "application/json",
    body: JSON.stringify({
      messages: Array.from({ length: 40 }, (_, index) => ({
        role: index % 2 ? "assistant" : "user",
        text: `Длинная история ${index}. ` + "планирование ".repeat(12),
        created_at: new Date(Date.now() + index * 1000).toISOString(),
        kind: "answer",
      })),
    }),
  }));
  await page.reload();
  await expect(page.locator("#view-title")).toHaveText("Мои задачи");
  await expect(page.locator("#dialogue .message")).toHaveCount(40);
  const longOpen = await page.evaluate(() => {
    const started = performance.now();
    document.getElementById("mobile-ai-open").click();
    const input = document.getElementById("message-input");
    return { shell: performance.now() - started, input: input.getBoundingClientRect().height > 0 };
  });
  expect(longOpen.input).toBe(true);
  expect(longOpen.shell).toBeLessThan(250);
  await page.screenshot({ path: path.join(shots, "ai-long-history.png") });
  const measures = await page.evaluate(() => performance.getEntriesByName("intime-ai-open").map(entry => Math.round(entry.duration)));
  expect(measures.length).toBeGreaterThan(0);
  console.log("AI open measures ms", { cold: Math.round(cold.shell), repeat: Math.round(repeat), long: Math.round(longOpen.shell), marks: measures });
  await page.evaluate(() => {
    window.dispatchEvent(new CustomEvent("ritm:keyboard-metrics", { detail: { inset: 320, height: 524, top: 0 } }));
  });
  await expect(page.locator("html")).toHaveClass(/keyboard-open/);
  await expect(page.locator("#message-input")).toBeVisible();
  await page.screenshot({ path: path.join(shots, "ai-keyboard.png") });
});
