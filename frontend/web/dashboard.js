// @ts-check
import { eventStore } from "./lib/store.js";
import { EventEditor } from "./lib/editor.js";
import { button, el, element, empty, icon, input, select } from "./lib/ui.js";
import { clock, eventMeta, isoDay } from "./lib/model.js";
import { renderCalendar, renderDay, renderReminders, renderTasks } from "./lib/views.js";
import { searchEvents } from "./lib/api.js";
import { workspaceStore } from "./lib/workspace.js";
import { colorStore } from "./lib/colors.js";
import { setupColorSettings } from "./lib/color-settings.js";
import { CreateEventDialog } from "./lib/create-event.js";
import { setupDayPanel } from "./lib/layout.js";
import { enhanceFields } from "./lib/fields.js";
import { confirmDiscard } from "./lib/confirm-dialog.js";
import { renderCalendarView, movePeriod, calendarRange } from "./lib/calendar.js";
import { renderCalendarDetails } from "./lib/calendar-details.js";
import { WorkspaceSwitcher } from "./lib/workspace-switcher.js";
import { closeMobileAssistant, initials, isMobileViewport, openMobileAssistant, renderTypeLegend, setupMobileShell } from "./lib/mobile.js";
import { renderMobileAgenda, weekRangeLabel } from "./lib/mobile-calendar.js";

const store = eventStore;
const records = element("records");
const grid = element("content-grid");
const layout = element("layout");
const panel = element("assistant-panel");
const message = element("message-input");
const status = element("data-status");
const sync = element("sync-status");
const pageHeading = element("view-title").closest(".page-heading");
const viewToolbar = element("calendar-controls").parentElement;
const addButton = element("add-button");
const searchPanel = element("search-results");
const searchInput = input("search-input");
const searchStatus = element("search-status");
const searchList = element("search-list");
const collapsed = new Set();
/** @type {import('./lib/types').View} */
let view = "tasks";
let chatRequests = 0;
let chatError = false;
let currentDay = isoDay(clock.now());
/** @type {import('./lib/types').CalendarLayout} */
let calendarLayout = "week";
let lastCalendarKey = "";
/** @type {number | null} */
let calendarSelectedId = null;
const calendarDialog = (() => {
  const node = document.querySelector("#calendar-editor-dialog");
  if (!(node instanceof HTMLDialogElement)) throw new Error("Missing calendar editor dialog");
  return node;
})();
try {
  const saved = localStorage.getItem("ritm.calendar-layout");
  if (saved === "list" || saved === "day" || saved === "week" || saved === "month" || saved === "year") calendarLayout = saved;
} catch { /* optional preference */ }
let stopped = false;
/** @type {ReturnType<typeof setTimeout> | undefined} */
let timer;
/** @type {AbortController | null} */
let searchController = null;
let searchGeneration = 0;

const editor = new EventEditor(element("event-editor"), store, () => {
  calendarDialog.close();
  grid.append(element("event-editor"));
  grid.classList.remove("has-editor");
  render();
  const target = view === "calendar" ? element("calendar-details").querySelector('[data-action="edit"]') : records.querySelector("button");
  if (target instanceof HTMLElement) target.focus();
});
// A tall expanded editor shares the workspace scroll; pin its bottom once reached.
const stickyEditor = new ResizeObserver(() => {
  const host = element("event-editor");
  host.style.setProperty("--editor-sticky-top", `${Math.min(0, grid.clientHeight - host.offsetHeight)}px`);
});
stickyEditor.observe(grid); stickyEditor.observe(element("event-editor"));
calendarDialog.addEventListener("cancel", event => { event.preventDefault(); void editor.close(); });

/** Calendar selection never opens an editing form. @param {import('./lib/types').RitmEvent} event */
function selectCalendarEvent(event) {
  calendarSelectedId = event.id; render();
  records.querySelector(`[data-id="${event.id}"]`)?.scrollIntoView({ block: "nearest" });
}

/** @param {import('./lib/types').RitmEvent} event */
async function openEvent(event) {
  if (!store.events.some(item => item.id === event.id)) store.upsert(event);
  const nextView = event.type === "task" ? "tasks" : event.type === "reminder" ? "reminders" : "calendar";
  if (!await editor.open(store.events.find(item => item.id === event.id) || event)) return;
  view = view === "calendar" ? "calendar" : nextView;
  if (view === "calendar") {
    calendarSelectedId = event.id;
    calendarDialog.append(element("event-editor"));
    if (!calendarDialog.open) calendarDialog.showModal();
    element("edit-title").focus();
  }
  if (event.date) input("calendar-date").value = event.date;
  if (event.status === "done") collapsed.delete("done");
  if (select("status-filter").value !== "all" && select("status-filter").value !== event.status) select("status-filter").value = "all";
  grid.classList.add("has-editor");
  render();
}

/** @param {import('./lib/types').RitmEvent} event @param {boolean} done */
async function complete(event, done) {
  try { await store.patch(event.id, { status: done ? "done" : "planned" }); }
  catch { render(); }
}
const actions = { open: openEvent, complete, saving: store.saving };
const creation = new CreateEventDialog(async event => {
  store.revision += 1;
  await Promise.all([store.load(), colorStore.load(true)]);
  store.upsert(event); await openEvent(event);
  element("live-status").textContent = "Запись сохранена: " + event.title;
  records.querySelector(`[data-id="${event.id}"]`)?.scrollIntoView({ block: "nearest" });
});

/** @param {boolean} closed @param {boolean} [focus] */
function toggleAssistant(closed, focus = true) {
  if (isMobileViewport()) {
    if (closed) closeMobileAssistant({ focus });
    else openMobileAssistant({ focus });
    return;
  }
  panel.hidden = closed;
  layout.classList.toggle("assistant-hidden", closed);
  element("assistant-open").setAttribute("aria-expanded", String(!closed));
  element("assistant-open").setAttribute("aria-label", closed ? "Показать ассистента" : "Скрыть ассистента");
  element("assistant-open").title = closed ? "Показать ассистента" : "Скрыть ассистента";
  try { localStorage.setItem("ritm.assistant-hidden", String(closed)); } catch { /* optional preference */ }
  if (focus) {
    if (closed) element("assistant-open").focus();
    else message.focus();
  }
  if (closed) window.dispatchEvent(new Event("ritm:assistant-hidden"));
}

/** Uses the existing dialogue workflow; creation is not a second API implementation. @param {string} prompt */
async function compose(prompt) {
  colorStore.creationType = prompt.startsWith("Добавь встречу") ? "meeting" : prompt.startsWith("Напомни") ? "reminder" : "task";
  colorStore.changed();
  toggleAssistant(false, false);
  if (message instanceof HTMLTextAreaElement) {
    if (message.disabled) { message.focus(); return; }
    if (message.value.trim() && !await confirmDiscard("Заменить текущий черновик новой командой?", "Заменить черновик")) { message.focus(); return; }
    message.value = prompt;
    message.dispatchEvent(new Event("input", { bubbles: true }));
    message.focus(); message.setSelectionRange(message.value.length, message.value.length);
  }
}

function renderSync() {
  const offline = !navigator.onLine;
  sync.classList.toggle("is-danger", offline || Boolean(store.error) || chatError);
  sync.textContent = offline ? "Нет соединения  повторить" : store.saving.size || chatRequests ? "Сохранение…" : store.loading ? "Обновление…" : chatError ? "Ошибка отправки  см. диалог" : store.error ? "Ошибка запроса  повторить" : store.loaded ? "Данные на сервере  обновить" : "Загрузка данных…";
}

function render() {
  if (!input("calendar-date").value) input("calendar-date").value = isoDay(clock.now());
  const previousScroll = records.scrollTop;
  const previousWorkspaceScroll = grid.scrollTop;
  editor.synchronize();
  grid.classList.toggle("has-editor", editor.id !== null && view !== "calendar");
  element("app").classList.toggle("calendar-page", view === "calendar");
  element("app").classList.toggle("tasks-page", view === "tasks");
  element("app").classList.toggle("reminders-page", view === "reminders");
  element("app").classList.toggle("mobile-agenda", isMobileViewport() && view === "calendar" && (calendarLayout === "week" || calendarLayout === "day"));
  const tasks = store.events.filter(event => event.type === "task");
  const reminders = store.events.filter(event => event.type === "reminder");
  element("tasks-count").textContent = String(tasks.length);
  element("reminders-count").textContent = String(reminders.length);
  const openTasks = tasks.filter(event => event.status !== "done").length;
  const mobileTasks = document.getElementById("mobile-tasks-count");
  const mobileReminders = document.getElementById("mobile-reminders-count");
  if (mobileTasks) { mobileTasks.textContent = openTasks ? String(openTasks) : ""; mobileTasks.hidden = !openTasks; }
  if (mobileReminders) { mobileReminders.textContent = reminders.length ? String(reminders.length) : ""; mobileReminders.hidden = !reminders.length; }
  const viewCount = document.getElementById("view-count");
  if (viewCount) {
    viewCount.textContent = view === "reminders" ? String(reminders.length) : "";
    viewCount.hidden = view !== "reminders";
  }
  const legend = document.getElementById("type-legend");
  if (legend) {
    legend.hidden = !(isMobileViewport() && view === "tasks");
    if (!legend.hidden) renderTypeLegend(legend);
  }
  const titles = { tasks: "Мои задачи", reminders: "Напоминания", calendar: "Календарь" };
  const calendarDate = input("calendar-date").value ? new Date(input("calendar-date").value + "T12:00:00") : null;
  const calendarTitle = calendarDate
    ? calendarLayout === "year"
      ? String(calendarDate.getFullYear())
      : calendarDate.toLocaleDateString("ru-RU", { month: "long", year: "numeric" }).replace(/\s*г\.$/u, "")
    : titles.calendar;
  element("view-title").textContent = view === "calendar" ? calendarTitle : titles[view];
  grid.classList.toggle("calendar-inspector", view === "calendar");
  const done = tasks.filter(event => event.status === "done").length;
  element("view-description").textContent = view === "tasks" ? `${tasks.length - done} открытых  ${done} завершённых` : view === "reminders" ? "Отдельные записи с датой и временем  без доставки уведомлений" : "Задачи, встречи и напоминания в одном календаре";
  element("add-label").textContent = view === "tasks" ? "Добавить задачу" : view === "reminders" ? "Добавить напоминание" : "Добавить встречу";
  element("task-filters").hidden = view !== "tasks";
  element("calendar-controls").hidden = view !== "calendar";
  element("sort-order").closest(".sort-control")?.toggleAttribute("hidden", view === "calendar" && calendarLayout !== "list");
  if (view === "calendar") pageHeading?.append(element("calendar-controls"));
  else { viewToolbar?.prepend(element("calendar-controls")); pageHeading?.append(addButton); }
  document.querySelectorAll("[data-tab], [data-mobile-tab]").forEach(tab => {
    if (!(tab instanceof HTMLElement)) return;
    const name = tab.dataset.tab || tab.dataset.mobileTab;
    tab.classList.toggle("is-active", name === view);
    if (name === view) tab.setAttribute("aria-current", "page"); else tab.removeAttribute("aria-current");
  });
  records.setAttribute("aria-busy", String(store.loading));
  status.hidden = !store.error;
  status.replaceChildren();
  if (store.error) status.append(el("span", "", store.error + (store.loaded ? " Показаны последние загруженные данные." : "")), button("Повторить", "inline-link", () => { void store.load(); }));
  const counts = renderDay(element("day-meetings"), element("day-tasks"), store.events, actions);
  element("meeting-count").textContent = String(counts.meetings);
  element("day-task-count").textContent = `${counts.done} из ${counts.tasks}`;
  const mobileAgenda = isMobileViewport() && view === "calendar" && (calendarLayout === "week" || calendarLayout === "day");
  if (!store.loaded) {
    records.replaceChildren(empty(store.loading ? "Загружаем ваши планы…" : "Не удалось загрузить записи. Повторите попытку."));
  }   else if (view === "tasks") renderTasks(records, store.events, select("status-filter").value, select("sort-order").value, editor.id, collapsed, actions);
  else if (view === "reminders") renderReminders(records, store.events, select("sort-order").value, actions);
  else if (mobileAgenda) renderMobileAgenda(records, store.events, input("calendar-date").value, selectCalendarEvent, date => { input("calendar-date").value = date; render(); });
  else if (calendarLayout !== "list") renderCalendarView(records, store.events, input("calendar-date").value, calendarLayout, selectCalendarEvent, date => { input("calendar-date").value = date; calendarLayout = "day"; render(); });
  else renderCalendar(records, store.events, input("calendar-date").value, { ...actions, open: selectCalendarEvent }, select("sort-order").value);
  element("calendar-footer").hidden = view !== "calendar";
  if (view === "calendar") {
    const key = calendarLayout + input("calendar-date").value;
    records.scrollTop = key === lastCalendarKey ? previousScroll : mobileAgenda ? 0 : (calendarLayout === "day" || calendarLayout === "week" ? 9 * 52 : 0);
    lastCalendarKey = key;
    const range = calendarRange(input("calendar-date").value, calendarLayout);
    const inclusiveEnd = new Date(range.end.getTime() - 86400000);
    element("view-description").textContent = mobileAgenda ? weekRangeLabel(range.start, inclusiveEnd) : `${range.start.toLocaleDateString("ru-RU")} — ${inclusiveEnd.toLocaleDateString("ru-RU")}`;
    const chosen = store.events.find(event => event.id === calendarSelectedId) || null;
    if (!chosen) calendarSelectedId = null;
    renderCalendarDetails(element("calendar-details"), chosen, () => { if (chosen) void openEvent(chosen); }, () => { calendarSelectedId = null; render(); records.querySelector("button")?.focus(); });
    records.querySelectorAll("[data-id]").forEach(node => {
      const selected = node instanceof HTMLElement && node.dataset.id === String(calendarSelectedId);
      node.classList.toggle("is-selected", selected);
      if (node instanceof HTMLButtonElement) node.setAttribute("aria-pressed", String(selected));
    });
    const count = store.events.filter(event => event.date && event.date >= isoDay(range.start) && event.date < isoDay(range.end)).length;
    const legend = element("calendar-legend"); legend.replaceChildren();
    for (const [type, label] of [["task", "Задачи"], ["meeting", "Встречи"], ["reminder", "Напоминания"]]) {
      const item = el("span", "calendar-legend__type", label); item.style.setProperty("--legend-color", colorStore.defaultColor(/** @type {import('./lib/types').EventType} */ (type))); legend.append(item);
    }
    legend.append(el("span", "calendar-legend__count", `${count} записей за период`), addButton);
  } else lastCalendarKey = "";
  for (const btn of element("calendar-layout").querySelectorAll("[data-calendar-layout]")) {
    if (!(btn instanceof HTMLButtonElement)) continue;
    const on = btn.dataset.calendarLayout === calendarLayout;
    btn.classList.toggle("is-active", on);
    btn.setAttribute("aria-checked", String(on));
    btn.tabIndex = on ? 0 : -1;
  }
  const layoutBar = element("calendar-layout");
  if (isMobileViewport() && view === "calendar" && layoutBar.scrollWidth > layoutBar.clientWidth + 1) {
    const active = layoutBar.querySelector(".is-active");
    if (active instanceof HTMLElement) {
      const bar = layoutBar.getBoundingClientRect();
      const item = active.getBoundingClientRect();
      if (item.left < bar.left) layoutBar.scrollLeft -= bar.left - item.left;
      else if (item.right > bar.right) layoutBar.scrollLeft += item.right - bar.right;
    }
  }
  renderSync();
  enhanceFields();
  if (view === "tasks") grid.scrollTop = previousWorkspaceScroll;
}

async function search() {
  const query = searchInput.value.trim();
  searchController?.abort();
  const generation = ++searchGeneration;
  if (!query) { searchPanel.hidden = true; return; }
  searchPanel.hidden = false;
  searchStatus.textContent = "Поиск…";
  searchList.replaceChildren();
  searchController = new AbortController();
  try {
    const hits = await searchEvents(query, searchController.signal, store.workspaceId);
    if (generation !== searchGeneration) return;
    searchStatus.textContent = hits.length ? `${hits.length} найдено  не более 20 результатов` : "Ничего не найдено. Попробуйте другой запрос.";
    for (const event of hits) {
      const result = button("", "search-result", () => {
        openEvent(event); closeSearch();
      });
      result.dataset.id = String(event.id);
      result.append(el("strong", "", event.title), el("span", "muted", eventMeta(event)));
      searchList.append(result);
    }
  } catch (error) {
    if (generation !== searchGeneration || searchController?.signal.aborted) return;
    searchStatus.textContent = error instanceof Error ? error.message : "Ошибка поиска. Повторите запрос.";
  }
}

function closeSearch() {
  searchController?.abort();
  searchGeneration += 1;
  searchPanel.hidden = true;
  document.documentElement.classList.remove("is-search-open");
}

function tick() {
  if (stopped) return;
  const now = clock.now();
  const text = now.toLocaleTimeString("ru-RU", { hour: "2-digit", minute: "2-digit" });
  element("day-time").textContent = text;
  element("day-date").textContent = now.toLocaleDateString("ru-RU", { weekday: "long", day: "numeric", month: "long", year: "numeric" }).replace(/\s*г\.$/u, "");
  const zone = Intl.DateTimeFormat().resolvedOptions().timeZone;
  element("day-zone").textContent = zone.replaceAll("_", " ");
  const sheetClock = document.getElementById("sheet-clock");
  if (sheetClock) sheetClock.textContent = `Сегодня, ${text}`;
  element("day-zone").title = "Часовой пояс браузера. Время записей хранится без часового пояса и должно совпадать с локальным временем сервера.";
  element("clock-hour").style.transform = `rotate(${(now.getHours() % 12) * 30 + now.getMinutes() / 2}deg)`;
  element("clock-minute").style.transform = `rotate(${now.getMinutes() * 6}deg)`;
  const today = isoDay(now);
  if (currentDay !== today) { currentDay = today; void store.load(); }
  render();
  timer = setTimeout(tick, (60 - now.getSeconds()) * 1000 - now.getMilliseconds());
}

document.querySelectorAll("[data-icon]").forEach(node => {
  if (node instanceof HTMLElement) node.append(icon(node.dataset.icon || "calendar"));
});
document.querySelectorAll("[data-mobile-tab]").forEach(tab => {
  tab.addEventListener("click", () => {
    if (!(tab instanceof HTMLElement)) return;
    const desktop = document.querySelector(`.tabs [data-tab="${tab.dataset.mobileTab}"]`);
    if (desktop instanceof HTMLElement) desktop.click();
  });
});
document.querySelectorAll("[data-tab]").forEach(tab => {
  tab.addEventListener("click", async () => {
    if (!(tab instanceof HTMLElement)) return;
    const next = tab.dataset.tab;
    if (next !== "tasks" && next !== "reminders" && next !== "calendar") return;
    if (next !== view && editor.id !== null && !await editor.close()) return;
    view = next;
    render();
  });
});
element("assistant-open").addEventListener("click", () => toggleAssistant(!panel.hidden));
element("create-button").addEventListener("click", () => creation.open("task"));
element("add-button").addEventListener("click", () => creation.open(view === "tasks" ? "task" : view === "reminders" ? "reminder" : "meeting"));
document.querySelectorAll("[data-prompt]").forEach(node => node.addEventListener("click", () => {
  if (node instanceof HTMLElement) compose(node.dataset.prompt || "");
}));
for (const id of ["status-filter", "sort-order", "calendar-date"]) element(id).addEventListener("change", render);
input("calendar-date").value = currentDay;
element("calendar-today").addEventListener("click", () => { input("calendar-date").value = isoDay(clock.now()); render(); });
/** @param {string | undefined} next */
function setCalendarLayout(next) {
  if (next !== "list" && next !== "day" && next !== "week" && next !== "month" && next !== "year") return;
  calendarLayout = next;
  try { localStorage.setItem("ritm.calendar-layout", next); } catch { /* optional preference */ }
  render();
}
element("calendar-layout").addEventListener("click", event => {
  const btn = event.target instanceof Element ? event.target.closest("[data-calendar-layout]") : null;
  if (btn instanceof HTMLButtonElement) setCalendarLayout(btn.dataset.calendarLayout);
});
element("calendar-layout").addEventListener("keydown", event => {
  if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") return;
  event.preventDefault();
  const modes = ["day", "week", "month", "year", "list"];
  setCalendarLayout(modes[(modes.indexOf(calendarLayout) + (event.key === "ArrowRight" ? 1 : 4)) % 5]);
  const active = element("calendar-layout").querySelector(".is-active");
  if (active instanceof HTMLButtonElement) active.focus();
});
sync.addEventListener("click", () => { void store.load(); });
element("search-form").addEventListener("submit", event => { event.preventDefault(); void search(); });
searchInput.addEventListener("input", () => {
  searchController?.abort();
  searchGeneration += 1;
  searchPanel.hidden = true;
  searchStatus.textContent = "";
});
element("search-close").addEventListener("click", () => { closeSearch(); searchInput.focus(); });
document.addEventListener("keydown", event => { if (event.key === "Escape" && !searchPanel.hidden) { closeSearch(); searchInput.focus(); } });
document.addEventListener("click", event => {
  if (!(event.target instanceof Node)) return;
  if (event.target instanceof Element && event.target.closest("#mobile-search-open")) return;
  if (!element("search-form").contains(event.target) && !searchPanel.contains(event.target)) closeSearch();
});
store.addEventListener("change", render);
window.addEventListener("ritm:data-changed", () => { store.revision += 1; void store.load(); void colorStore.load(true); });
window.addEventListener("ritm:edit-event", event => {
  if (!(event instanceof CustomEvent)) return;
  const record = store.events.find(item => item.id === event.detail.id); if (record) void openEvent(record);
});
window.addEventListener("ritm:event-deleted", event => {
  if (!(event instanceof CustomEvent)) return;
  searchList.querySelector(`[data-id="${event.detail.id}"]`)?.remove();
});
colorStore.addEventListener("change", render);
window.addEventListener("ritm:request", event => {
  if (!(event instanceof CustomEvent)) return;
  if (event.detail.phase === "start") chatRequests += 1;
  else { chatRequests = Math.max(0, chatRequests - 1); chatError = !event.detail.ok; }
  renderSync();
});
window.addEventListener("offline", renderSync);
window.addEventListener("online", () => { void store.load(); });
window.addEventListener("focus", () => { if (!stopped) { void store.load(); void colorStore.load(); } });
window.addEventListener("pagehide", () => { stopped = true; clearTimeout(timer); searchController?.abort(); });
window.addEventListener("pageshow", event => { if (event.persisted) { stopped = false; tick(); void store.load(); } });
window.addEventListener("beforeunload", event => {
  if (editor.dirty || editor.busy || colorStore.busy || creation.busy || creation.dialog.open && creation.dirty) { event.preventDefault(); event.returnValue = true; }
});
function fillWorkspaceSelect() {
  const node = select("workspace-select");
  const current = workspaceStore.currentId;
  node.replaceChildren();
  for (const space of workspaceStore.workspaces) {
    node.append(new Option(space.name, String(space.id), false, space.id === current));
  }
  node.disabled = workspaceStore.workspaces.length === 0;
  if (node.disabled) node.append(new Option("Общее пространство", ""));
  node.title = workspaceStore.error || "Пространство";
  const avatar = document.getElementById("mobile-initials");
  const activeSpace = workspaceStore.workspaces.find(space => space.id === current);
  if (avatar) avatar.textContent = initials(activeSpace?.name || "Общее пространство");
  enhanceFields();
}

/** @param {number | null} [renameId] */
async function openWorkspaceCreate(renameId = null) {
  if (renameId === null && !await prepareWorkspaceChange()) return;
  const dialog = el("dialog", "create-dialog");
  dialog.setAttribute("aria-labelledby", "workspace-create-title");
  const heading = el("div", "section-heading");
  const title = el("h2", "", renameId === null ? "Новое пространство" : "Переименовать пространство"); title.id = "workspace-create-title";
  const close = button("", "icon-btn", () => dialog.close()); close.append(icon("close"));
  close.setAttribute("aria-label", "Закрыть создание пространства");
  heading.append(title, close);
  const form = el("form", "create-form");
  const name = el("input"); name.id = "workspace-name"; name.required = true; name.maxLength = 80;
  name.autocomplete = "off"; name.placeholder = "Например, Работа";
  name.value = renameId === null ? "" : workspaceStore.workspaces.find(row => row.id === renameId)?.name || "";
  const field = el("label", "form-field", "Название"); field.htmlFor = name.id; field.append(name);
  const status = el("p", "create-status"); status.setAttribute("role", "status");
  const submit = el("button", "btn btn-primary", renameId === null ? "Создать" : "Сохранить"); submit.type = "submit";
  form.append(field, status, submit);
  form.addEventListener("submit", async event => {
    event.preventDefault();
    const text = name.value.trim();
    if (!text) { status.textContent = "Введите название пространства."; return; }
    submit.disabled = true; name.disabled = true; close.disabled = true;
    status.textContent = "Сохранение…"; status.classList.remove("is-danger");
    try {
      const created = renameId === null ? await workspaceStore.create(text) : await workspaceStore.rename(renameId, text);
      fillWorkspaceSelect();
      dialog.close();
      if (renameId === null) await applyWorkspace(created.id);
      element("live-status").textContent = "Сохранено пространство: " + created.name;
    } catch (error) {
      status.textContent = error instanceof Error ? error.message : "Не удалось создать пространство.";
      status.classList.add("is-danger");
    } finally {
      submit.disabled = false; name.disabled = false; close.disabled = false;
    }
  });
  dialog.addEventListener("close", () => dialog.remove());
  dialog.append(heading, form);
  document.body.append(dialog);
  dialog.showModal();
  name.focus();
}

function manageWorkspaces() {
  const dialog = el("dialog", "create-dialog"); dialog.setAttribute("aria-label", "Управление пространствами");
  const close = button("Закрыть", "btn btn-quiet", () => dialog.close()); dialog.append(el("h2", "", "Ваши пространства"));
  for (const row of workspaceStore.workspaces) {
    const item = el("div", "workspace-management-row"); item.append(el("span", "", row.name), button("Переименовать", "inline-link", () => { dialog.close(); void openWorkspaceCreate(row.id); })); dialog.append(item);
  }
  dialog.append(close); document.body.append(dialog); dialog.addEventListener("close", () => dialog.remove()); dialog.showModal();
}

async function prepareWorkspaceChange() {
  const permit = new Event("ritm:workspace-before-change", { cancelable: true });
  window.dispatchEvent(permit);
  if (permit.defaultPrevented || chatRequests || store.saving.size || colorStore.busy || creation.busy) return false;
  if (editor.id !== null && !await editor.close()) return false;
  if (creation.dialog.open) { await creation.close(); if (creation.dialog.open) return false; }
  return true;
}

/** @param {number} id */
async function applyWorkspace(id) {
  if (id === workspaceStore.currentId && id === store.workspaceId) return true;
  if (!await prepareWorkspaceChange()) {
    fillWorkspaceSelect();
    return false;
  }
  const previous = store.workspaceId;
  workspaceStore.select(id);
  searchController?.abort(); searchGeneration += 1; closeSearch(); searchInput.value = "";
  calendarSelectedId = null; grid.scrollTop = 0;
  window.dispatchEvent(new CustomEvent("ritm:workspace-changed", { detail: { previous, id } }));
  await store.switchWorkspace(id);
  return true;
}

select("workspace-select").addEventListener("change", () => {
  const id = Number(select("workspace-select").value);
  if (!Number.isSafeInteger(id)) return;
  void applyWorkspace(id);
});
const workspaceSwitcher = new WorkspaceSwitcher(select("workspace-select"), workspaceStore, applyWorkspace, () => { void openWorkspaceCreate(); }, manageWorkspaces);

async function boot() {
  await workspaceStore.load();
  store.workspaceId = workspaceStore.currentId;
  window.dispatchEvent(new CustomEvent("ritm:workspace-changed", { detail: { previous: null, id: workspaceStore.currentId } }));
  fillWorkspaceSelect();
  workspaceSwitcher.render();
  await store.load();
  for (const id of ["create-button", "add-button"]) {
    const control = element(id);
    if (control instanceof HTMLButtonElement) { control.disabled = !workspaceStore.workspaces.length; control.title = control.disabled ? workspaceStore.error : ""; }
  }
}

if (!isMobileViewport()) {
  try { toggleAssistant(localStorage.getItem("ritm.assistant-hidden") === "true", false); } catch { /* storage optional */ }
}
setupMobileShell({ onCreate: type => creation.open(type) });
window.addEventListener("ritm:viewport-mode", render);
window.addEventListener("ritm:create", event => {
  if (!(event instanceof CustomEvent)) return;
  const type = event.detail?.type;
  if (type === "task" || type === "meeting" || type === "reminder") creation.open(type);
});
tick();
setupColorSettings();
setupDayPanel();
void boot();
void colorStore.load();
for (const [id, direction] of [["calendar-prev", -1], ["calendar-next", 1]]) {
  element(String(id)).addEventListener("click", () => { input("calendar-date").value = movePeriod(input("calendar-date").value, calendarLayout, Number(direction)); render(); });
}
