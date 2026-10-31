// @ts-check
import { el, icon, button, empty } from "./ui.js";
import { paintObject } from "./colors.js";
import { clock, eventMeta, formatDate, groupTasks, isoDay, relativeTime, sortedEvents, eventStart } from "./model.js";
/** @typedef {import('./types').RitmEvent} RitmEvent */
/** @typedef {{ open: (event: RitmEvent) => void, complete: (event: RitmEvent, done: boolean) => void, saving: Set<number> }} Actions */
/** Client-side pages bound DOM size; the API returns the complete collection for counts/calendar.
 * @type {WeakMap<HTMLElement, {pages: Record<string, number>, selected: number | null, status: string, filter: string, order: string}>} */
const taskPages = new WeakMap();
const TASK_PAGE_SIZE = 40;

/** @param {RitmEvent} event @param {Actions} actions */
function checkbox(event, actions) {
  const box = el("input");
  box.type = "checkbox";
  box.checked = event.status === "done";
  box.disabled = actions.saving.has(event.id);
  box.setAttribute("aria-label", `${box.checked ? "Вернуть в открытые" : "Завершить"}: ${event.title}`);
  box.addEventListener("change", () => actions.complete(event, box.checked));
  return box;
}

/** @param {RitmEvent} event @param {number | null} selected @param {Actions} actions */
export function taskCard(event, selected, actions) {
  const card = el("article", `task-row${event.status === "done" ? " is-done" : ""}${selected === event.id ? " is-selected" : ""}`);
  card.dataset.id = String(event.id);
  paintObject(card, event);
  const content = button("", "task-row__content", () => actions.open(event));
  content.setAttribute("aria-label", `Открыть: ${event.title}`);
  content.setAttribute("aria-pressed", String(selected === event.id));
  content.title = event.title;
  content.append(el("strong", "task-row__title", event.title), el("span", "task-row__meta", eventMeta(event)));
  if (event.status === "done" && event.updated_at.length >= 16) content.append(el("span", "task-row__done mobile-only", `Выполнено в ${event.updated_at.slice(11, 16)}`));
  const status = el("span", "task-row__status", event.status === "done" ? "Завершена" : "Открыта");
  card.append(checkbox(event, actions), content, status);
  return card;
}

/** The tasks list scrolls inside #records on phones and inside the grid on desktop. */
function taskScroller(host) {
  const overflow = getComputedStyle(host).overflowY;
  if (overflow === "auto" || overflow === "scroll" || overflow === "overlay") return host;
  return host.parentElement;
}

/** @param {HTMLElement} host @param {RitmEvent[]} events @param {string} filter @param {string} order @param {number | null} selected @param {Set<string>} collapsed @param {Actions} actions */
export function renderTasks(host, events, filter, order, selected, collapsed, actions) {
  const scroller = taskScroller(host);
  const scroll = host.querySelector(".task-group") ? scroller?.scrollTop || 0 : 0;
  host.replaceChildren();
  const grouped = groupTasks(sortedEvents(events, order));
  const state = taskPages.get(host) || { pages: { planned: 0, done: 0 }, selected: null, status: "", filter, order };
  const status = events.find(event => event.id === selected)?.status || "";
  if (state.filter !== filter || state.order !== order) state.pages = { planned: 0, done: 0 };
  if (selected !== null && (state.selected !== selected || state.status !== status || state.filter !== filter || state.order !== order)) {
    for (const key of ["planned", "done"]) {
      const index = grouped[/** @type {'planned' | 'done'} */ (key)].findIndex(event => event.id === selected);
      if (index >= 0) state.pages[key] = Math.floor(index / TASK_PAGE_SIZE);
    }
  }
  state.selected = selected; state.status = status; state.filter = filter; state.order = order; taskPages.set(host, state);
  for (const key of /** @type {const} */ (["planned", "done"])) {
    if (filter !== "all" && filter !== key) continue;
    const section = el("section", `task-group task-group--${key}`);
    section.dataset.taskGroup = key;
    const header = button("", "group-heading", () => {
      if (collapsed.has(key)) collapsed.delete(key); else collapsed.add(key);
      renderTasks(host, events, filter, order, selected, collapsed, actions);
      const target = host.querySelector(`[data-task-group="${key}"] .group-heading`); if (target instanceof HTMLElement) target.focus({ preventScroll: true });
    });
    const label = key === "planned" ? "Созданные" : "Завершённые";
    const chevron = icon("chevron"); chevron.classList.add("group-chevron"); chevron.classList.toggle("is-collapsed", collapsed.has(key));
    header.append(el("strong", "", label), el("span", "muted", String(grouped[key].length)), chevron);
    header.setAttribute("aria-expanded", String(!collapsed.has(key)));
    const bar = el("div", "group-bar");
    const plus = button("", "icon-btn group-add", () => window.dispatchEvent(new CustomEvent("ritm:create", { detail: { type: "task" } })));
    plus.append(icon("plus"));
    plus.setAttribute("aria-label", "Добавить задачу");
    bar.append(header, plus);
    section.append(bar);
    if (!collapsed.has(key)) {
      if (!grouped[key].length) section.append(empty(key === "planned" ? "Свободный день. Добавьте первую задачу." : "Здесь появятся завершённые задачи."));
      const pages = Math.ceil(grouped[key].length / TASK_PAGE_SIZE);
      state.pages[key] = Math.max(0, Math.min(state.pages[key], pages - 1));
      const start = state.pages[key] * TASK_PAGE_SIZE;
      for (const event of grouped[key].slice(start, start + TASK_PAGE_SIZE)) section.append(taskCard(event, selected, actions));
      if (pages > 1) {
        const pager = el("nav", "task-pagination"); pager.setAttribute("aria-label", `Страницы: ${label}`);
        const turn = (/** @type {number} */ direction) => {
          state.pages[key] += direction;
          renderTasks(host, events, filter, order, selected, collapsed, actions);
          const group = host.querySelector(`[data-task-group="${key}"]`);
          group?.scrollIntoView({ block: "start" });
          const focus = group?.querySelector(".group-heading"); if (focus instanceof HTMLElement) focus.focus({ preventScroll: true });
        };
        const previous = button("Назад", "btn btn-quiet", () => turn(-1)); previous.disabled = state.pages[key] === 0;
        const next = button("Далее", "btn btn-quiet", () => turn(1)); next.disabled = state.pages[key] >= pages - 1;
        pager.append(previous, el("span", "muted", `${start + 1}–${Math.min(start + TASK_PAGE_SIZE, grouped[key].length)} из ${grouped[key].length}`), next);
        section.append(pager);
      }
    }
    host.append(section);
  }
  if (scroller) scroller.scrollTop = scroll;
}

/** @param {HTMLElement} host @param {RitmEvent[]} events @param {string} order @param {Actions} actions */
export function renderReminders(host, events, order, actions) {
  const top = host.querySelector(".reminder-card, .date-heading") ? host.scrollTop : 0;
  host.replaceChildren();
  const now = clock.now();
  const category = (/** @type {RitmEvent} */ event) => event.status === "done" ? 2 : (eventStart(event)?.getTime() ?? Infinity) < now.getTime() ? 1 : 0;
  const reminders = sortedEvents(events.filter(event => event.type === "reminder"), order).sort((a, b) => category(a) - category(b));
  if (!reminders.length) host.append(empty("Напоминаний пока нет. Добавьте запись с датой и временем."));
  let group = "";
  let lastCategory = -1;
  for (const event of reminders) {
    if (category(event) !== lastCategory) {
      lastCategory = category(event); group = "";
      host.append(el("h2", "date-heading", ["Предстоящие", "Прошедшие", "Завершённые"][lastCategory]));
    }
    if (event.date !== group) {
      group = event.date || "";
      host.append(el("h2", "date-heading", formatDate(event.date)));
    }
    const card = el("article", `reminder-card${event.status === "done" ? " is-done" : ""}`);
    paintObject(card, event);
    card.dataset.id = String(event.id);
    const body = el("div", "reminder-card__body");
    const top = el("div", "reminder-card__top");
    top.append(el("h3", event.status === "done" ? "is-struck" : "", event.title), el("span", "reminder-state", event.status === "done" ? "Завершено" : "Включено"));
    body.append(top, el("p", "muted", event.status === "done" ? "Завершено и остаётся в списке" : "Отдельное напоминание"));
    body.append(checkbox(event, actions));
    const meta = el("p", "record-meta");
    meta.append(icon("calendar"), el("span", "", eventMeta(event)));
    body.append(meta);
    if (event.time) body.append(el("p", "reminder-card__alarm", event.status === "done" ? "Напоминание завершено" : `Напомню в ${event.time.slice(0, 5)}`));
    body.append(el("p", "muted", "Уведомления не отправляются"));
    const timing = el("div", "reminder-card__timing");
    timing.append(el("span", "eyebrow", event.is_deadline ? "ДО ДЕДЛАЙНА" : "ДО ВРЕМЕНИ ЗАПИСИ"), el("strong", "relative-time", relativeTime(event, clock.now())));
    const edit = button("", "inline-link", () => actions.open(event));
    edit.append(el("span", "desktop-only", "Изменить запись →"), el("span", "mobile-only", "Настроить напоминание"));
    timing.append(edit);
    card.append(body, timing);
    host.append(card);
  }
  host.scrollTop = top;
}

/** @param {HTMLElement} host @param {RitmEvent[]} events @param {string} date @param {Actions} actions */
export function renderCalendar(host, events, date, actions, order = "asc") {
  host.replaceChildren(el("h2", "date-heading", formatDate(date)));
  const day = sortedEvents(events.filter(event => event.date === date), order);
  if (!day.length) host.append(empty("На этот день ничего не запланировано."));
  for (const event of day) {
    const row = el("article", "calendar-row");
    row.dataset.id = String(event.id);
    paintObject(row, event);
    const info = button("", "calendar-row__content", () => actions.open(event));
    info.append(el("strong", event.status === "done" ? "is-struck" : "", event.title), el("span", "muted", `${typeLabel(event.type)}${event.duration_min ? "  " + event.duration_min + " мин" : ""}`));
    row.append(el("time", "calendar-row__time", event.time?.slice(0, 5) || "Весь день"), icon(event.type === "reminder" ? "bell" : event.type === "task" ? "check" : "calendar"), info);
    host.append(row);
  }
}

/** @param {string} type */
export function typeLabel(type) {
  return type === "task" ? "Задача" : type === "meeting" ? "Встреча" : "Напоминание";
}

/** @param {HTMLElement} meetingHost @param {HTMLElement} taskHost @param {RitmEvent[]} events @param {Actions} actions */
export function renderDay(meetingHost, taskHost, events, actions) {
  const today = isoDay(clock.now());
  const meetings = sortedEvents(events.filter(event => event.type === "meeting" && event.status === "planned" && event.date === today));
  meetingHost.replaceChildren();
  for (const event of meetings) {
    const node = button("", "day-meeting", () => actions.open(event));
    node.dataset.id = String(event.id);
    paintObject(node, event);
    const start = eventStart(event);
    const end = start && event.duration_min ? new Date(start.getTime() + event.duration_min * 60000) : null;
    const time = event.time?.slice(0, 5) || "Без времени";
    node.append(el("span", "day-meeting__time", time + (end ? " — " + end.toLocaleTimeString("ru-RU", { hour: "2-digit", minute: "2-digit" }) : "")), el("strong", "", event.title), el("span", "muted", relativeTime(event, clock.now())));
    meetingHost.append(node);
  }
  if (!meetings.length) meetingHost.append(el("p", "day-empty", "Сегодня без встреч"));
  const tasks = sortedEvents(events.filter(event => event.type === "task" && event.date === today));
  taskHost.replaceChildren();
  for (const event of tasks) {
    const node = el("div", `day-task${event.status === "done" ? " is-done" : ""}`);
    node.dataset.id = String(event.id);
    paintObject(node, event);
    const open = button("", "day-task__content", () => actions.open(event));
    open.append(el("span", "day-task__title", event.title), el("span", "muted", event.status === "done" ? "Завершена  обновлена " + event.updated_at.slice(11, 16) : event.time ? "Сегодня, " + event.time.slice(0, 5) : "Сегодня"));
    node.append(checkbox(event, actions), open);
    taskHost.append(node);
  }
  if (!tasks.length) taskHost.append(el("p", "day-empty", "Задач на сегодня нет"));
  return { meetings: meetings.length, tasks: tasks.length, done: tasks.filter(event => event.status === "done").length };
}
