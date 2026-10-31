// @ts-check
import { eventStore } from "./lib/store.js";
import { EventEditor } from "./lib/editor.js";
import { button, el, element, empty, icon, input, select } from "./lib/ui.js";
import { clock, eventMeta, isoDay } from "./lib/model.js";
import { renderCalendar, renderCalendarGridStub, renderDay, renderReminders, renderTasks } from "./lib/views.js";
import { searchEvents } from "./lib/api.js";
import { workspaceStore } from "./lib/workspace.js";
import { colorStore } from "./lib/colors.js";
import { setupColorSettings } from "./lib/color-settings.js";
import { CreateEventDialog } from "./lib/create-event.js";
import { setupDayPanel } from "./lib/layout.js";
import { enhanceFields } from "./lib/fields.js";
import { confirmDiscard } from "./lib/confirm-dialog.js";

const store = eventStore;
const records = element("records");
const grid = element("content-grid");
const layout = element("layout");
const panel = element("assistant-panel");
const message = element("message-input");
const status = element("data-status");
const sync = element("sync-status");
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
let calendarLayout = "list";
try {
  const saved = localStorage.getItem("ritm.calendar-layout");
  if (saved === "list" || saved === "month") calendarLayout = saved;
} catch { /* optional preference */ }
let stopped = false;
/** @type {ReturnType<typeof setTimeout> | undefined} */
let timer;
/** @type {AbortController | null} */
let searchController = null;
let searchGeneration = 0;

const editor = new EventEditor(element("event-editor"), store, () => {
  grid.classList.remove("has-editor");
  render();
  records.querySelector("button")?.focus();
});

/** @param {import('./lib/types').RitmEvent} event */
async function openEvent(event) {
  if (!store.events.some(item => item.id === event.id)) store.upsert(event);
  const nextView = event.type === "task" ? "tasks" : event.type === "reminder" ? "reminders" : "calendar";
  if (!await editor.open(store.events.find(item => item.id === event.id) || event)) return;
  view = nextView;
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
  panel.hidden = closed;
  layout.classList.toggle("assistant-hidden", closed);
  element("assistant-open").hidden = !closed;
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
  sync.textContent = offline ? "Нет соединения · повторить" : store.saving.size || chatRequests ? "Сохранение…" : store.loading ? "Обновление…" : chatError ? "Ошибка отправки · см. диалог" : store.error ? "Ошибка запроса · повторить" : store.loaded ? "Данные на сервере · обновить" : "Загрузка данных…";
}

function render() {
  editor.synchronize();
  grid.classList.toggle("has-editor", editor.id !== null);
  const tasks = store.events.filter(event => event.type === "task");
  const reminders = store.events.filter(event => event.type === "reminder" && event.status === "planned");
  element("tasks-count").textContent = String(tasks.length);
  element("reminders-count").textContent = String(reminders.length);
  const titles = { tasks: "Мои задачи", reminders: "Напоминания", calendar: "Календарь" };
  element("view-title").textContent = titles[view];
  const done = tasks.filter(event => event.status === "done").length;
  element("view-description").textContent = view === "tasks" ? `${tasks.length - done} открытых · ${done} завершённых` : view === "reminders" ? "Отдельные записи с датой и временем · без доставки уведомлений" : "Задачи, встречи и напоминания в одном календаре";
  element("add-label").textContent = view === "tasks" ? "Добавить задачу" : view === "reminders" ? "Добавить напоминание" : "Добавить встречу";
  element("task-filters").hidden = view !== "tasks";
  element("calendar-controls").hidden = view !== "calendar";
  element("sort-order").parentElement?.toggleAttribute("hidden", view === "calendar");
  document.querySelectorAll("[data-tab]").forEach(tab => {
    if (!(tab instanceof HTMLElement)) return;
    tab.classList.toggle("is-active", tab.dataset.tab === view);
    if (tab.dataset.tab === view) tab.setAttribute("aria-current", "page"); else tab.removeAttribute("aria-current");
  });
  records.setAttribute("aria-busy", String(store.loading));
  status.hidden = !store.error;
  status.replaceChildren();
  if (store.error) status.append(el("span", "", store.error + (store.loaded ? " Показаны последние загруженные данные." : "")), button("Повторить", "inline-link", () => { void store.load(); }));
  const counts = renderDay(element("day-meetings"), element("day-tasks"), store.events, actions);
  element("meeting-count").textContent = String(counts.meetings);
  element("day-task-count").textContent = `${counts.done} из ${counts.tasks}`;
  if (!store.loaded) {
    records.replaceChildren(empty(store.loading ? "Загружаем ваши планы…" : "Не удалось загрузить записи. Повторите попытку."));
  }   else if (view === "tasks") renderTasks(records, store.events, select("status-filter").value, select("sort-order").value, editor.id, collapsed, actions);
  else if (view === "reminders") renderReminders(records, store.events, select("sort-order").value, actions);
  else if (calendarLayout === "month") renderCalendarGridStub(records);
  else renderCalendar(records, store.events, input("calendar-date").value, actions);
  for (const btn of element("calendar-layout").querySelectorAll("[data-calendar-layout]")) {
    if (!(btn instanceof HTMLButtonElement)) continue;
    const on = btn.dataset.calendarLayout === calendarLayout;
    btn.classList.toggle("is-active", on);
    btn.setAttribute("aria-checked", String(on));
    btn.tabIndex = on ? 0 : -1;
  }
  renderSync();
  enhanceFields();
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
    searchStatus.textContent = hits.length ? `${hits.length} найдено · не более 20 результатов` : "Ничего не найдено. Попробуйте другой запрос.";
    for (const event of hits) {
      const result = button("", "search-result", () => {
        openEvent(event); closeSearch();
      });
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
}

function tick() {
  if (stopped) return;
  const now = clock.now();
  const text = now.toLocaleTimeString("ru-RU", { hour: "2-digit", minute: "2-digit" });
  element("day-time").textContent = text;
  element("day-date").textContent = now.toLocaleDateString("ru-RU", { weekday: "long", day: "numeric", month: "long", year: "numeric" });
  const zone = Intl.DateTimeFormat().resolvedOptions().timeZone;
  element("day-zone").textContent = zone.replaceAll("_", " ");
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
element("assistant-close").addEventListener("click", () => toggleAssistant(true));
element("assistant-open").addEventListener("click", () => toggleAssistant(false));
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
  if (next !== "list" && next !== "month") return;
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
  setCalendarLayout(calendarLayout === "list" ? "month" : "list");
  const active = element("calendar-layout").querySelector(".is-active");
  if (active instanceof HTMLButtonElement) active.focus();
});
sync.addEventListener("click", () => { void store.load(); });
element("search-form").addEventListener("submit", event => { event.preventDefault(); void search(); });
searchInput.addEventListener("input", () => { closeSearch(); searchStatus.textContent = ""; });
element("search-close").addEventListener("click", () => { closeSearch(); searchInput.focus(); });
document.addEventListener("keydown", event => { if (event.key === "Escape" && !searchPanel.hidden) { closeSearch(); searchInput.focus(); } });
document.addEventListener("click", event => { if (event.target instanceof Node && !element("search-form").contains(event.target) && !searchPanel.contains(event.target)) closeSearch(); });
store.addEventListener("change", render);
window.addEventListener("ritm:data-changed", () => { store.revision += 1; void store.load(); void colorStore.load(true); });
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
  node.title = workspaceStore.error || "Пространство";
  enhanceFields();
}

function openWorkspaceCreate() {
  const dialog = el("dialog", "create-dialog");
  dialog.setAttribute("aria-labelledby", "workspace-create-title");
  const heading = el("div", "section-heading");
  const title = el("h2", "", "Новое пространство"); title.id = "workspace-create-title";
  const close = button("×", "icon-btn", () => dialog.close());
  close.setAttribute("aria-label", "Закрыть создание пространства");
  heading.append(title, close);
  const form = el("form", "create-form");
  const name = el("input"); name.id = "workspace-name"; name.required = true; name.maxLength = 80;
  name.autocomplete = "off"; name.placeholder = "Например, Работа";
  const field = el("label", "form-field", "Название"); field.htmlFor = name.id; field.append(name);
  const status = el("p", "create-status"); status.setAttribute("role", "status");
  const submit = el("button", "btn btn-primary", "Создать"); submit.type = "submit";
  form.append(field, status, submit);
  form.addEventListener("submit", async event => {
    event.preventDefault();
    const text = name.value.trim();
    if (!text) { status.textContent = "Введите название пространства."; return; }
    submit.disabled = true; name.disabled = true; close.disabled = true;
    status.textContent = "Сохранение…"; status.classList.remove("is-danger");
    try {
      const created = await workspaceStore.create(text);
      store.workspaceId = created.id;
      store.revision += 1;
      fillWorkspaceSelect();
      dialog.close();
      await store.load();
      element("live-status").textContent = "Создано пространство: " + created.name;
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

/** @param {number} id */
async function applyWorkspace(id) {
  if (id === workspaceStore.currentId) return;
  if (editor.id !== null && !await editor.close()) {
    fillWorkspaceSelect();
    return;
  }
  workspaceStore.select(id);
  store.workspaceId = id;
  store.revision += 1;
  await store.load();
}

select("workspace-select").addEventListener("change", () => {
  const id = Number(select("workspace-select").value);
  if (!Number.isSafeInteger(id)) return;
  void applyWorkspace(id);
});
element("workspace-add").addEventListener("click", () => openWorkspaceCreate());

async function boot() {
  await workspaceStore.load();
  store.workspaceId = workspaceStore.currentId;
  fillWorkspaceSelect();
  await store.load();
}

try { toggleAssistant(localStorage.getItem("ritm.assistant-hidden") === "true", false); } catch { /* storage optional */ }
tick();
setupColorSettings();
setupDayPanel();
void boot();
void colorStore.load();
