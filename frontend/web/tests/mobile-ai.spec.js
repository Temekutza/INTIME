import { test, expect } from "@playwright/test";
import path from "node:path";
import { fileURLToPath } from "node:url";

const shots = path.join(path.dirname(fileURLToPath(import.meta.url)), "../artifacts/mobile-qa/after");

async function ready(page) {
  await page.goto("/");
  await expect(page.locator("#view-title")).toHaveText("Мои задачи");
  await expect(page.locator(".task-row").first()).toBeVisible();
  await expect(page.locator("#mobile-ai-open")).toBeVisible();
}

async function pageBox(page) {
  return page.evaluate(() => {
    const doc = document.documentElement;
    const offenders = [...document.body.querySelectorAll("*")].filter(node => {
      const style = getComputedStyle(node);
      if (style.display === "none" || style.visibility === "hidden" || node.closest("[hidden]")) return false;
      const box = node.getBoundingClientRect();
      return box.width > 0 && box.height > 0 && box.right > doc.clientWidth + 1;
    }).slice(0, 8).map(node => node.id || node.className?.toString?.() || node.tagName);
    return { scrollWidth: doc.scrollWidth, clientWidth: doc.clientWidth, offenders };
  });
}

test("AI-MOB-01 closed mobile screen has no persistent assistant sheet", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await ready(page);
  await expect(page.locator("#assistant-panel")).toBeHidden();
  await expect(page.locator("#message-input")).toBeHidden();
  await expect(page.locator("#sheet-handle")).toBeHidden();
  await expect(page.locator(".sheet-grab")).toBeHidden();
  const gap = await page.evaluate(() => {
    const records = document.getElementById("records").getBoundingClientRect();
    const tab = document.getElementById("mobile-tabbar").getBoundingClientRect();
    return tab.top - records.bottom;
  });
  expect(gap).toBeGreaterThan(-2);
  expect(gap).toBeLessThan(28);
});

test("AI-MOB-02 header shows a compact InTime AI button", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await ready(page);
  const button = page.getByRole("button", { name: "Открыть InTime AI" });
  await expect(button).toBeVisible();
  await expect(button).toHaveAttribute("aria-expanded", "false");
  const boxes = await page.evaluate(() => {
    const rect = id => document.getElementById(id).getBoundingClientRect();
    const header = rect("header");
    const ids = ["mobile-search-open", "sync-status", "mobile-ai-open", "mobile-account"];
    return { header, controls: ids.map(id => ({ id, ...rect(id).toJSON() })), brand: document.querySelector(".brand").getBoundingClientRect().toJSON() };
  });
  expect(boxes.controls[2].x).toBeGreaterThan(boxes.header.width * 0.45);
  expect(boxes.controls[2].right).toBeLessThanOrEqual(boxes.header.right + 1);
  expect(boxes.controls[2].width).toBeGreaterThanOrEqual(40);
  expect(boxes.controls[2].height).toBeGreaterThanOrEqual(40);
  expect(boxes.brand.right).toBeLessThanOrEqual(boxes.controls[0].x + 1);
  for (let index = 1; index < boxes.controls.length; index += 1) {
    expect(boxes.controls[index].x).toBeGreaterThanOrEqual(boxes.controls[index - 1].right - 1);
  }
});

test("AI-MOB-03 and AI-MOB-04 open and close the full-screen assistant", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await ready(page);
  await page.locator("[data-mobile-tab='calendar']").click();
  await page.locator(".week-day:not(.is-selected)").first().click();
  const selected = await page.locator(".week-day.is-selected").getAttribute("aria-label");
  const description = await page.locator("#view-description").innerText();
  await page.getByRole("button", { name: "Открыть InTime AI" }).click();
  await expect(page.locator("#assistant-panel")).toBeVisible();
  await expect(page.locator("#assistant-title")).toBeVisible();
  await expect(page.locator("#assistant-back")).toBeVisible();
  await expect(page.locator("#message-input")).toBeVisible();
  await expect(page.locator("#send-button")).toBeVisible();
  await expect(page.locator("#mic-button")).toBeVisible();
  await expect(page.locator("#mobile-tabbar")).toBeHidden();
  await expect(page.locator("html")).toHaveClass(/ai-open/);
  await page.locator("#assistant-back").click();
  await expect(page.locator("#assistant-panel")).toBeHidden();
  await expect(page.locator("#mobile-tabbar")).toBeVisible();
  await expect(page.locator("html")).not.toHaveClass(/ai-open/);
  await expect(page.locator(".week-day.is-selected")).toHaveAttribute("aria-label", selected || "");
  await expect(page.locator("#view-description")).toHaveText(description);
  await expect(page.locator("[data-mobile-tab='calendar']")).toHaveClass(/is-active/);
});

test("AI-MOB-05 browser back closes the assistant and stays in the app", async ({ page }) => {
  await page.setViewportSize({ width: 375, height: 812 });
  await ready(page);
  await page.getByRole("button", { name: "Открыть InTime AI" }).click();
  await expect(page.locator("#assistant-panel")).toBeVisible();
  await page.goBack();
  await expect(page.locator("#assistant-panel")).toBeHidden();
  await expect(page.locator("#view-title")).toBeVisible();
  await expect(page).toHaveURL("/");
  await expect(page.locator("#mobile-tabbar")).toBeVisible();
});

test("AI-MOB-06 and AI-MOB-07 keep history and unsent text", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  let historyRequests = 0;
  page.on("request", request => { if (request.url().includes("/api/history")) historyRequests += 1; });
  await ready(page);
  const afterLoad = historyRequests;
  await page.getByRole("button", { name: "Открыть InTime AI" }).click();
  await page.locator("#message-input").fill("Черновик без отправки");
  await page.locator("#assistant-back").click();
  await page.getByRole("button", { name: "Открыть InTime AI" }).click();
  await expect(page.locator("#message-input")).toHaveValue("Черновик без отправки");
  await page.locator("#message-input").fill("Запланируй встречу завтра");
  await page.locator("#send-button").click();
  await expect(page.locator(".message-user").last()).toContainText("Запланируй встречу завтра");
  await page.locator("#message-input").fill("Ещё не отправлено");
  await page.locator("#assistant-back").click();
  await page.getByRole("button", { name: "Открыть InTime AI" }).click();
  await expect(page.locator(".message-user").last()).toContainText("Запланируй встречу завтра");
  await expect(page.locator("#message-input")).toHaveValue("Ещё не отправлено");
  expect(historyRequests).toBe(afterLoad);
});

test("AI-MOB-08 and AI-MOB-09 composer stays available with the keyboard open", async ({ page }) => {
  await page.setViewportSize({ width: 375, height: 667 });
  await ready(page);
  await page.getByRole("button", { name: "Открыть InTime AI" }).click();
  await page.evaluate(() => {
    window.dispatchEvent(new CustomEvent("ritm:keyboard-metrics", { detail: { inset: 280, height: window.innerHeight - 280, top: 0 } }));
  });
  await expect(page.locator("html")).toHaveClass(/keyboard-open/);
  await page.locator("#message-input").fill("Текст с клавиатуры");
  await expect(page.locator("#message-input")).toHaveValue("Текст с клавиатуры");
  const geometry = await page.evaluate(() => {
    const panel = document.getElementById("assistant-panel").getBoundingClientRect();
    const composer = document.getElementById("composer").getBoundingClientRect();
    const send = document.getElementById("send-button").getBoundingClientRect();
    const input = document.getElementById("message-input").getBoundingClientRect();
    const visible = Number.parseFloat(getComputedStyle(document.documentElement).getPropertyValue("--vv-height"));
    return { panel, composer, send, input, visible };
  });
  expect(geometry.composer.bottom).toBeLessThanOrEqual(geometry.visible + 2);
  expect(geometry.send.bottom).toBeLessThanOrEqual(geometry.visible + 2);
  expect(geometry.input.bottom).toBeLessThanOrEqual(geometry.composer.bottom + 1);
  expect(geometry.send.top).toBeGreaterThanOrEqual(geometry.composer.top - 1);
  expect(geometry.panel.height).toBeLessThan(667);
  await page.evaluate(() => {
    window.dispatchEvent(new CustomEvent("ritm:keyboard-metrics", { detail: { inset: 0, height: window.innerHeight, top: 0 } }));
  });
  await expect(page.locator("html")).not.toHaveClass(/keyboard-open/);
  const restored = await page.locator("#assistant-panel").evaluate(node => node.getBoundingClientRect().height);
  expect(restored).toBeGreaterThan(600);
});

test("AI-MOB-10 confirmation card fits a 320px screen", async ({ page }) => {
  await page.setViewportSize({ width: 320, height: 568 });
  await ready(page);
  await page.getByRole("button", { name: "Открыть InTime AI" }).click();
  await page.locator("#message-input").fill("Запланируй встречу завтра");
  await page.locator("#send-button").click();
  const card = page.locator(".confirmation-card");
  await expect(card).toContainText("Ожидает подтверждения");
  await expect(card).toContainText("Встреча");
  await page.getByRole("button", { name: "Отказаться" }).scrollIntoViewIfNeeded();
  const fit = await page.evaluate(() => {
    const node = document.querySelector(".confirmation-card");
    const confirm = [...document.querySelectorAll("button")].find(button => button.textContent === "Подтвердить");
    const decline = [...document.querySelectorAll("button")].find(button => button.textContent === "Отказаться");
    const box = node.getBoundingClientRect();
    const confirmBox = confirm.getBoundingClientRect();
    const declineBox = decline.getBoundingClientRect();
    return {
      card: box.toJSON(),
      confirm: confirmBox.toJSON(),
      decline: declineBox.toJSON(),
      scrollWidth: node.scrollWidth,
      clientWidth: node.clientWidth,
      pageWidth: document.documentElement.clientWidth,
      pageScroll: document.documentElement.scrollWidth,
    };
  });
  expect(fit.card.x).toBeGreaterThanOrEqual(-1);
  expect(fit.card.right).toBeLessThanOrEqual(fit.pageWidth + 1);
  expect(fit.confirm.x).toBeGreaterThanOrEqual(-1);
  expect(fit.confirm.right).toBeLessThanOrEqual(fit.pageWidth + 1);
  expect(fit.decline.x).toBeGreaterThanOrEqual(-1);
  expect(fit.decline.right).toBeLessThanOrEqual(fit.pageWidth + 1);
  expect(fit.confirm.width).toBeGreaterThan(120);
  expect(fit.decline.width).toBeGreaterThan(120);
  expect(fit.scrollWidth).toBeLessThanOrEqual(fit.clientWidth + 1);
  expect(fit.pageScroll).toBeLessThanOrEqual(fit.pageWidth + 1);
});

test("AI-MOB-11 calendar uses the height freed by the assistant", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await ready(page);
  await page.locator("[data-mobile-tab='calendar']").click();
  await expect(page.locator(".week-strip")).toBeVisible();
  await expect(page.locator("#assistant-panel")).toBeHidden();
  const layout = await page.evaluate(() => {
    const records = document.getElementById("records").getBoundingClientRect();
    const tab = document.getElementById("mobile-tabbar").getBoundingClientRect();
    return { recordsHeight: records.height, gap: tab.top - records.bottom, viewport: window.innerHeight };
  });
  expect(layout.recordsHeight).toBeGreaterThan(layout.viewport * 0.35);
  expect(layout.gap).toBeGreaterThan(-2);
  expect(layout.gap).toBeLessThan(28);
});

test("AI-MOB-12 task list is not clipped by the old assistant sheet", async ({ page }) => {
  await page.setViewportSize({ width: 360, height: 640 });
  await ready(page);
  const layout = await page.evaluate(() => {
    const records = document.getElementById("records").getBoundingClientRect();
    const tab = document.getElementById("mobile-tabbar").getBoundingClientRect();
    const rows = [...document.querySelectorAll(".task-row")].map(node => node.getBoundingClientRect());
    const visible = rows.filter(row => row.top < tab.top && row.bottom > records.top);
    return { recordsHeight: records.height, gap: tab.top - records.bottom, visible: visible.length, viewport: window.innerHeight };
  });
  expect(layout.visible).toBeGreaterThanOrEqual(3);
  expect(layout.recordsHeight).toBeGreaterThan(layout.viewport * 0.28);
  expect(layout.gap).toBeGreaterThan(-2);
  expect(layout.gap).toBeLessThan(28);
});

test("AI-MOB-13 reminders stay clear of the bottom navigation", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await ready(page);
  await page.locator("[data-mobile-tab='reminders']").click();
  await expect(page.locator(".reminder-card").first()).toBeVisible();
  const layout = await page.evaluate(() => {
    const card = document.querySelector(".reminder-card").getBoundingClientRect();
    const records = document.getElementById("records").getBoundingClientRect();
    const tab = document.getElementById("mobile-tabbar").getBoundingClientRect();
    return { cardTop: card.top, cardRight: card.right, recordsRight: records.right, recordsLeft: records.left, cardLeft: card.left, gap: tab.top - records.bottom, tabTop: tab.top };
  });
  expect(layout.cardTop).toBeLessThan(layout.tabTop - 40);
  expect(layout.cardLeft).toBeGreaterThanOrEqual(layout.recordsLeft - 1);
  expect(layout.cardRight).toBeLessThanOrEqual(layout.recordsRight + 1);
  expect(layout.gap).toBeGreaterThan(-2);
  expect(layout.gap).toBeLessThan(28);
});

test("AI-MOB-14 header stays inside narrow screens", async ({ page }) => {
  for (const [width, height] of [[320, 568], [320, 700], [344, 720], [360, 640], [360, 800], [375, 667], [375, 812], [390, 844], [430, 932], [700, 320], [844, 390]]) {
    await page.setViewportSize({ width, height });
    await ready(page);
    const box = await pageBox(page);
    expect(box.scrollWidth, `${width}x${height} ${box.offenders.join(",")}`).toBeLessThanOrEqual(box.clientWidth + 1);
    const header = await page.evaluate(() => {
      const bar = document.getElementById("header").getBoundingClientRect();
      const name = getComputedStyle(document.querySelector(".brand-name")).fontSize;
      const ai = document.getElementById("mobile-ai-open").getBoundingClientRect();
      return { right: bar.right, width: bar.width, font: name, aiRight: ai.right, client: document.documentElement.clientWidth };
    });
    expect(header.right).toBeLessThanOrEqual(header.client + 1);
    expect(header.aiRight).toBeLessThanOrEqual(header.client + 1);
    expect(Number.parseFloat(header.font)).toBeGreaterThanOrEqual(16);
  }
});

test("AI-MOB-15 desktop assistant sidebar still works", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto("/");
  await expect(page.locator("#view-title")).toHaveText("Мои задачи");
  await expect(page.locator("#mobile-ai-open")).toBeHidden();
  await expect(page.locator("#mobile-tabbar")).toBeHidden();
  await expect(page.locator("#assistant-panel")).toBeVisible();
  await expect(page.locator("html")).not.toHaveClass(/ai-open/);
  const presentation = await page.evaluate(() => {
    const panel = document.getElementById("assistant-panel");
    const columns = getComputedStyle(document.getElementById("layout")).gridTemplateColumns;
    return { position: getComputedStyle(panel).position, columns: columns.split(" ").length, role: panel.getAttribute("role") };
  });
  expect(presentation.position).not.toBe("fixed");
  expect(presentation.columns).toBeGreaterThan(1);
  expect(presentation.role).toBeNull();
  await page.locator("#assistant-open").click();
  await expect(page.locator("#assistant-panel")).toBeHidden();
  await page.locator("#assistant-open").click();
  await expect(page.locator("#assistant-panel")).toBeVisible();
  await page.locator("#message-input").fill("Черновик рабочего стола");
  await page.locator("#assistant-open").click();
  await page.locator("#assistant-open").click();
  await expect(page.locator("#message-input")).toHaveValue("Черновик рабочего стола");
});

test("AI-MOB-16 viewport switches do not duplicate history requests or handlers", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  let historyRequests = 0;
  let messageRequests = 0;
  page.on("request", request => {
    if (request.url().includes("/api/history")) historyRequests += 1;
    if (request.url().includes("/api/message") && request.method() === "POST") messageRequests += 1;
  });
  await ready(page);
  const baseline = historyRequests;
  await page.getByRole("button", { name: "Открыть InTime AI" }).click();
  await expect(page.locator("#assistant-panel")).toBeVisible();
  expect(await page.evaluate(() => history.state && history.state.ritmAi)).toBe(1);
  await page.locator("#assistant-back").click();
  await page.setViewportSize({ width: 1440, height: 900 });
  await expect(page.locator("#assistant-panel")).toBeVisible();
  await page.setViewportSize({ width: 390, height: 844 });
  await expect(page.locator("#assistant-panel")).toBeHidden();
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.setViewportSize({ width: 375, height: 812 });
  expect(historyRequests).toBe(baseline);
  await expect(page.locator("html")).toHaveAttribute("data-mobile-shell", "ready");
  await page.getByRole("button", { name: "Открыть InTime AI" }).click();
  await expect(page.locator("#assistant-panel")).toBeVisible();
  expect(await page.evaluate(() => history.state && history.state.ritmAi)).toBe(1);
  await expect(page.locator("html")).toHaveAttribute("data-mobile-shell", "ready");
  await page.locator("#message-input").fill("Одно сообщение");
  await page.locator("#send-button").click();
  await expect(page.locator(".message-user").last()).toContainText("Одно сообщение");
  expect(messageRequests).toBe(1);
  expect(historyRequests).toBe(baseline);
});

test("visual QA of closed screens, assistant, keyboard and narrow header", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await ready(page);
  await page.screenshot({ path: path.join(shots, "tasks-closed-ai.png") });
  await page.locator("[data-mobile-tab='calendar']").click();
  await expect(page.locator(".week-strip")).toBeVisible();
  await page.screenshot({ path: path.join(shots, "calendar-closed-ai.png") });
  await page.locator("[data-mobile-tab='reminders']").click();
  await expect(page.locator(".reminder-card").first()).toBeVisible();
  await page.screenshot({ path: path.join(shots, "reminders-closed-ai.png") });

  await page.setViewportSize({ width: 320, height: 568 });
  await page.screenshot({ path: path.join(shots, "header-320.png") });
  await page.evaluate(() => {
    const span = document.querySelector(".workspace-switcher-trigger > span");
    if (span) span.textContent = "Очень длинное название рабочего пространства продуктовой команды";
  });
  const narrow = await pageBox(page);
  expect(narrow.scrollWidth, narrow.offenders.join(",")).toBeLessThanOrEqual(narrow.clientWidth + 1);
  await page.screenshot({ path: path.join(shots, "long-workspace.png") });

  await page.getByRole("button", { name: "Открыть InTime AI" }).click();
  await expect(page.locator("#assistant-panel")).toBeVisible();
  await page.screenshot({ path: path.join(shots, "ai-open.png") });
  await page.evaluate(() => {
    const dialogue = document.getElementById("dialogue");
    const make = (role, text) => {
      const item = document.createElement("li");
      item.className = role === "user" ? "message message-user" : "message message-assistant";
      const body = document.createElement("p");
      body.className = "message__text";
      body.textContent = text;
      item.append(body);
      dialogue.append(item);
    };
    for (let index = 0; index < 8; index += 1) {
      make("user", `Длинное сообщение пользователя ${index + 1} о переносе встречи и подготовке материалов к планированию.`);
      make("assistant", `Ответ InTime AI ${index + 1}. Проверьте дату, время и участников перед подтверждением действия.`);
    }
    document.body.classList.remove("is-empty");
    dialogue.parentElement.scrollTop = dialogue.parentElement.scrollHeight;
  });
  await page.screenshot({ path: path.join(shots, "ai-history.png") });
  await page.locator("#message-input").fill("Запланируй встречу завтра");
  await page.locator("#send-button").click();
  await expect(page.locator(".confirmation-card")).toBeVisible();
  await page.getByRole("button", { name: "Подтвердить" }).scrollIntoViewIfNeeded();
  await page.screenshot({ path: path.join(shots, "ai-confirmation.png") });
  await page.evaluate(() => {
    window.dispatchEvent(new CustomEvent("ritm:keyboard-metrics", { detail: { inset: 240, height: window.innerHeight - 240, top: 0 } }));
    const band = document.createElement("div");
    band.setAttribute("data-qa-keyboard", "");
    band.style.cssText = "position:fixed;left:0;right:0;bottom:0;height:240px;background:#d9d6e2;z-index:70;pointer-events:none;";
    document.body.append(band);
  });
  await page.screenshot({ path: path.join(shots, "ai-keyboard.png") });
});
