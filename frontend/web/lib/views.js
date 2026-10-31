// @ts-check
import { el, icon, button, empty } from "./ui.js";
import { paintObject } from "./colors.js";
import { clock, eventMeta, formatDate, groupTasks, isoDay, relativeTime, sortedEvents, eventStart } from "./model.js";
/** @typedef {import('./types').RitmEvent} RitmEvent */
/** @typedef {{ open: (event: RitmEvent) => void, complete: (event: RitmEvent, done: boolean) => void, saving: Set<number> }} Actions */

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
  content.append(el("strong", "task-row__title", event.title), el("span", "task-row__meta", eventMeta(event)));
  const status = el("span", "task-row__status", event.status === "done" ? "Завершена" : "Открыта");
  card.append(checkbox(event, actions), content, status);
  return card;
}

/** @param {HTMLElement} host @param {RitmEvent[]} events @param {string} filter @param {string} order @param {number | null} selected @param {Set<string>} collapsed @param {Actions} actions */
export function renderTasks(host, events, filter, order, selected, collapsed, actions) {
  host.replaceChildren();
  const grouped = groupTasks(sortedEvents(events, order));
  for (const key of /** @type {const} */ (["planned", "done"])) {
    if (filter !== "all" && filter !== key) continue;
    const section = el("section", `task-group task-group--${key}`);
    const header = button("", "group-heading", () => {
      if (collapsed.has(key)) collapsed.delete(key); else collapsed.add(key);
      renderTasks(host, events, filter, order, selected, collapsed, actions);
    });
    const label = key === "planned" ? "Созданные" : "Завершённые";
    header.append(el("span", "group-dot"), el("strong", "", label), el("span", "muted", String(grouped[key].length)), el("span", "group-chevron", collapsed.has(key) ? "+" : "−"));
    header.setAttribute("aria-expanded", String(!collapsed.has(key)));
    section.append(header);
    if (!collapsed.has(key)) {
      if (!grouped[key].length) section.append(empty(key === "planned" ? "Свободный день. Добавьте первую задачу." : "Здесь появятся завершённые задачи."));
      for (const event of grouped[key]) section.append(taskCard(event, selected, actions));
    }
    host.append(section);
  }
}

/** @param {HTMLElement} host @param {RitmEvent[]} events @param {string} order @param {Actions} actions */
export function renderReminders(host, events, order, actions) {
  host.replaceChildren();
  const reminders = sortedEvents(events.filter(event => event.type === "reminder" && event.status === "planned"), order);
  if (!reminders.length) host.append(empty("Напоминаний пока нет. Добавьте запись с датой и временем."));
  let group = "";
  for (const event of reminders) {
    if (event.date !== group) {
      group = event.date || "";
      host.append(el("h2", "date-heading", formatDate(event.date)));
    }
    const card = el("article", "reminder-card");
    paintObject(card, event);
    card.dataset.id = String(event.id);
    const body = el("div", "reminder-card__body");
    body.append(el("h3", "", event.title), el("p", "muted", "Отдельное напоминание"));
    const meta = el("p", "record-meta");
    meta.append(icon("calendar"), el("span", "", eventMeta(event)));
    body.append(meta, el("p", "muted", "Уведомления не отправляются"));
    const timing = el("div", "reminder-card__timing");
    timing.append(el("span", "eyebrow", "ДО ВРЕМЕНИ ЗАПИСИ"), el("strong", "relative-time", relativeTime(event, clock.now())));
    timing.append(button("Настроить напоминание →", "inline-link", () => actions.open(event)));
    card.append(body, timing);
    host.append(card);
  }
}

/** @param {HTMLElement} host @param {RitmEvent[]} events @param {string} date @param {Actions} actions */
export function renderCalendar(host, events, date, actions) {
  host.replaceChildren(el("h2", "date-heading", formatDate(date)));
  const day = sortedEvents(events.filter(event => event.date === date));
  if (!day.length) host.append(empty("На этот день ничего не запланировано."));
  for (const event of day) {
    const row = el("article", "calendar-row");
    row.dataset.id = String(event.id);
    paintObject(row, event);
    const info = button("", "calendar-row__content", () => actions.open(event));
    info.append(el("strong", event.status === "done" ? "is-struck" : "", event.title), el("span", "muted", `${typeLabel(event.type)}${event.duration_min ? " · " + event.duration_min + " мин" : ""}`));
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
    open.append(el("span", "day-task__title", event.title), el("span", "muted", event.status === "done" ? "Завершена · обновлена " + event.updated_at.slice(11, 16) : event.time ? "Сегодня, " + event.time.slice(0, 5) : "Сегодня"));
    node.append(checkbox(event, actions), open);
    taskHost.append(node);
  }
  if (!tasks.length) taskHost.append(el("p", "day-empty", "Задач на сегодня нет"));
  return { meetings: meetings.length, tasks: tasks.length, done: tasks.filter(event => event.status === "done").length };
}
