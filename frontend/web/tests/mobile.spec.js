import { test, expect } from "@playwright/test";
import path from "node:path";
import { fileURLToPath } from "node:url";

const shots = path.join(path.dirname(fileURLToPath(import.meta.url)), "../artifacts/mobile-qa");

async function ready(page) {
  await page.goto("/");
  await expect(page.locator("#view-title")).toHaveText("Мои задачи");
  await expect(page.locator(".task-row").first()).toBeVisible();
}

async function overflow(page) {
  return page.evaluate(() => {
    const doc = document.documentElement;
    const offenders = [...document.body.querySelectorAll("*")].filter(node => {
      const style = getComputedStyle(node);
      if (style.display === "none" || style.visibility === "hidden") return false;
      const box = node.getBoundingClientRect();
      return box.width > 0 && box.right > doc.clientWidth + 1;
    }).slice(0, 8).map(node => node.id || node.className);
    return { scrollWidth: doc.scrollWidth, clientWidth: doc.clientWidth, offenders };
  });
}

test("mobile shell, screens and main flows", async ({ page }) => {
  await page.setViewportSize({ width: 430, height: 932 });
  await ready(page);
  await page.screenshot({ path: path.join(shots, "tasks-430.png"), fullPage: false });

  await page.locator("[data-mobile-tab='calendar']").click();
  await expect(page.locator(".week-strip")).toBeVisible();
  await expect(page.locator(".agenda-card").first()).toBeVisible();
  await page.screenshot({ path: path.join(shots, "calendar-430.png"), fullPage: false });

  const before = await page.locator(".week-day.is-selected").getAttribute("aria-label");
  await page.locator(".week-day:not(.is-selected)").first().click();
  await expect(page.locator(".week-day.is-selected")).not.toHaveAttribute("aria-label", before || "");
  await page.getByRole("button", { name: "Следующий период" }).click();
  await expect(page.locator("#view-description")).toContainText("неделя");
  await page.getByRole("button", { name: "Сегодня" }).click();
  const cardTitle = await page.locator(".agenda-card").first().locator("strong").innerText();
  await page.locator(".agenda-card").first().click();
  await expect(page.locator("#calendar-details")).toContainText(cardTitle);
  await page.getByRole("button", { name: "Снять выбор события" }).click();

  await page.locator("[data-mobile-tab='tasks']").click();
  const created = page.getByRole("button", { name: /Созданные/ });
  await created.click();
  await expect(created).toHaveAttribute("aria-expanded", "false");
  await created.click();
  await page.locator(".task-row input[type=checkbox]").nth(2).click();
  await expect(page.locator(".task-group--done .task-row")).toHaveCount(3);

  await page.locator("#mobile-create").click();
  await page.locator("[data-create='task']").click();
  await page.locator("#create-name").fill("Мобильная задача");
  await page.locator("#create-dialog").getByRole("button", { name: "Создать задачу" }).click();
  await page.getByRole("button", { name: "Подтвердить создание" }).click();
  await expect(page.locator(".task-row", { hasText: "Мобильная задача" })).toBeVisible();
  await page.reload();
  await expect(page.locator(".task-row", { hasText: "Мобильная задача" })).toBeVisible();

  await page.locator("[data-mobile-tab='reminders']").click();
  await expect(page.locator(".reminder-card").first()).toBeVisible();
  await page.screenshot({ path: path.join(shots, "reminders-430.png"), fullPage: false });
  await page.locator("#sort-order").selectOption("desc");
  await expect(page.locator(".reminder-card").first()).toBeVisible();

  await page.getByRole("button", { name: "Открыть InTime AI" }).click();
  await expect(page.locator("#assistant-panel")).toBeVisible();
  await expect(page.locator("#mobile-tabbar")).toBeHidden();
  await page.locator("#message-input").fill("Запланируй встречу завтра");
  await page.locator("#send-button").click();
  await expect(page.getByRole("button", { name: "Подтвердить" })).toBeVisible();
  await page.screenshot({ path: path.join(shots, "calendar-ai-note.png"), fullPage: false });
  await page.getByRole("button", { name: "Отказаться" }).click();
  await expect(page.locator(".confirmation-card")).toContainText("Отклонено");
  await page.locator("#assistant-back").click();
  await expect(page.locator("#assistant-panel")).toBeHidden();
  await expect(page.locator("#mobile-tabbar")).toBeVisible();

  await page.locator("#mobile-search-open").click();
  await page.locator("#search-input").fill("Встреча");
  await page.locator("#search-form").evaluate(form => form.requestSubmit());
  await expect(page.locator(".search-result").first()).toBeVisible();
  await page.keyboard.press("Escape");

  await page.getByRole("button", { name: "Выбрать пространство" }).click();
  await page.getByRole("menuitemradio", { name: /Команда/ }).click();
  await expect(page.getByRole("button", { name: "Выбрать пространство" })).toContainText("Команда");

  const box = await overflow(page);
  expect(box.scrollWidth).toBeLessThanOrEqual(box.clientWidth + 1);
  expect(box.offenders).toEqual([]);
});

for (const [width, height] of [[320, 700], [360, 800], [375, 812], [393, 852], [414, 896], [480, 900], [768, 1024], [844, 390]]) {
  test(`no horizontal overflow ${width}x${height}`, async ({ page }) => {
    await page.setViewportSize({ width, height });
    await ready(page);
    for (const tab of ["calendar", "reminders", "tasks"]) {
      await page.locator(`[data-mobile-tab='${tab}']`).click();
      const box = await overflow(page);
      expect(box.scrollWidth, `${tab} ${box.offenders.join(",")}`).toBeLessThanOrEqual(box.clientWidth + 1);
    }
  });
}

test("desktop shell stays in columns", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto("/");
  await expect(page.locator("#view-title")).toHaveText("Мои задачи");
  await expect(page.locator("#mobile-tabbar")).toBeHidden();
  await expect(page.locator("#day-panel")).toBeVisible();
  await expect(page.locator("#assistant-panel")).toBeVisible();
  const columns = await page.evaluate(() => getComputedStyle(document.getElementById("layout")).gridTemplateColumns);
  expect(columns.split(" ").length).toBeGreaterThan(1);
  await page.screenshot({ path: path.join(shots, "desktop-1440.png"), fullPage: false });
});
