// @ts-check
import { button, el } from "./ui.js";
import { clock, dayDate, isoDay, eventStart, formatDate, sortedEvents } from "./model.js";
import { paintObject } from "./colors.js";
/** @typedef {import('./types').RitmEvent} RitmEvent */
/** @typedef {'day'|'week'|'month'|'year'|'list'} CalendarMode */
const HOUR_HEIGHT = 52;
// A title line and a separate time row must fit even in a five-minute event.
const MIN_CARD_HEIGHT = 52;
/** @param {Date} date @param {number} amount */
export function addDays(date, amount) { const next = new Date(date); next.setDate(next.getDate() + amount); return next; }
/** @param {string} selected @param {CalendarMode} mode */
export function calendarRange(selected, mode) {
  const date = dayDate(selected);
  if (mode === "week") { const start = addDays(date, -(date.getDay() + 6) % 7); return { start, end: addDays(start, 7) }; }
  if (mode === "month") return { start: new Date(date.getFullYear(), date.getMonth(), 1), end: new Date(date.getFullYear(), date.getMonth() + 1, 1) };
  if (mode === "year") return { start: new Date(date.getFullYear(), 0, 1), end: new Date(date.getFullYear() + 1, 0, 1) };
  return { start: date, end: addDays(date, 1) };
}
/** Подпись колонки: число, месяц в родительном падеже и в дневном виде год. @param {Date} day @param {boolean} full */
export function calendarDayCaption(day, full) {
  const weekday = ["Вс", "Пн", "Вт", "Ср", "Чт", "Пт", "Сб"][day.getDay()];
  const number = String(day.getDate());
  const month = day
    .toLocaleDateString("ru-RU", full ? { day: "numeric", month: "long", year: "numeric" } : { day: "numeric", month: "short" })
    .replace(/^\d+\s+/u, "")
    .replace(/\s*г\.$/u, "")
    .replace(/\.$/u, "");
  return { weekday, number, month };
}

/** @param {string} selected @param {CalendarMode} mode @param {number} direction */
export function movePeriod(selected, mode, direction) {
  const date = dayDate(selected);
  if (mode === "day" || mode === "list" || mode === "week") return isoDay(addDays(date, direction * (mode === "week" ? 7 : 1)));
  const year = date.getFullYear() + (mode === "year" ? direction : 0), month = date.getMonth() + (mode === "month" ? direction : 0);
  return isoDay(new Date(year, month, Math.min(date.getDate(), new Date(year, month + 1, 0).getDate())));
}
/** Visible day segments. visualMinutes reserves readable hit areas without changing real end times.
 * @param {RitmEvent[]} events @param {Date} day @param {number} [visualMinutes] */
export function daySegments(events, day, visualMinutes = 0) {
  const low = day.getTime(), high = addDays(day, 1).getTime();
  const segments = events.flatMap(event => {
    const start = eventStart(event); if (!start) return [];
    const end = start.getTime() + (event.duration_min || 1) * 60000;
    if (start.getTime() >= high || end <= low) return [];
    return [{ event, start: Math.max(start.getTime(), low), end: Math.min(end, high), lane: 0, lanes: 1 }];
  }).sort((a, b) => a.start - b.start || b.end - a.end || a.event.id - b.event.id);
  /** @type {typeof segments} */ let group = [];
  /** @type {number[]} */ let ends = [];
  let groupEnd = 0;
  const finish = () => { for (const item of group) item.lanes = ends.length; group = []; ends = []; };
  for (const item of segments) {
    if (group.length && item.start >= groupEnd) finish();
    let lane = ends.findIndex(end => end <= item.start); if (lane < 0) lane = ends.length;
    const visualEnd = Math.max(item.end, item.start + visualMinutes * 60000);
    ends[lane] = visualEnd; item.lane = lane; group.push(item); groupEnd = Math.max(groupEnd, visualEnd);
  }
  finish(); return segments;
}
/** @param {RitmEvent} event @param {(event: RitmEvent) => void} open */
function eventButton(event, open) {
  const node = button("", "calendar-event", () => open(event)); node.dataset.id = String(event.id);
  const start = eventStart(event);
  const time = el("span", "calendar-event__time");
  time.append(el("span", "calendar-event__start", event.time?.slice(0, 5) || "Без времени"));
  if (event.duration_min && start) time.append(el("span", "calendar-event__end", ` — ${new Date(start.getTime() + event.duration_min * 60000).toLocaleTimeString("ru-RU", { hour: "2-digit", minute: "2-digit" })}`));
  node.title = `${event.title}\n${formatDate(event.date)} ${time.textContent}`;
  node.setAttribute("aria-label", node.title);
  node.append(el("strong", "calendar-event__title", event.title), time);
  paintObject(node, event); node.classList.toggle("is-done", event.status === "done"); return node;
}
/** @param {HTMLElement} host @param {RitmEvent[]} events @param {string} selected @param {CalendarMode} mode @param {(event: RitmEvent) => void} open @param {(date: string) => void} choose */
export function renderCalendarView(host, events, selected, mode, open, choose) {
  host.replaceChildren(); const range = calendarRange(selected, mode);
  if (mode === "year") {
    const year = el("div", "year-grid");
    const today = isoDay(clock.now());
    const weekNames = ["Пн", "Вт", "Ср", "Чт", "Пт", "Сб", "Вс"];
    for (let month = 0; month < 12; month++) {
      const date = new Date(range.start.getFullYear(), month, 1), cell = el("section", "year-month");
      cell.append(button(date.toLocaleDateString("ru-RU", { month: "long" }), "year-month__title", () => choose(isoDay(date))));
      const weekdays = el("div", "year-month__weekdays");
      for (const name of weekNames) weekdays.append(el("span", "", name));
      const days = el("div", "year-month__days");
      for (let pad = 0; pad < (date.getDay() + 6) % 7; pad++) days.append(el("span", "year-day-pad"));
      for (let n = 1; n <= new Date(date.getFullYear(), month + 1, 0).getDate(); n++) {
        const iso = isoDay(new Date(date.getFullYear(), month, n)), count = events.filter(event => event.date === iso).length;
        const item = button(String(n), "year-day", () => choose(iso));
        item.title = `${formatDate(iso)}: ${count} записей`;
        item.classList.toggle("has-events", count > 0);
        item.classList.toggle("is-today", iso === today);
        item.classList.toggle("is-selected", iso === selected);
        days.append(item);
      }
      cell.append(weekdays, days); year.append(cell);
    }
    host.append(year); return;
  }
  if (mode === "month") {
    const grid = el("div", "month-grid");
    const compact = window.matchMedia("(max-width: 1024px)").matches;
    const today = isoDay(clock.now());
    for (const name of ["Пн", "Вт", "Ср", "Чт", "Пт", "Сб", "Вс"]) grid.append(el("strong", "month-grid__weekday", name));
    const start = addDays(range.start, -(range.start.getDay() + 6) % 7);
    for (let i = 0; i < 42; i++) {
      const date = addDays(start, i), iso = isoDay(date), cell = el("section", "month-grid__day");
      cell.classList.toggle("is-muted", date.getMonth() !== range.start.getMonth());
      cell.classList.toggle("is-today", iso === today);
      cell.classList.toggle("is-selected", iso === selected);
      cell.append(button(String(date.getDate()), "month-day-number", () => choose(iso)));
      const rows = sortedEvents(events.filter(event => event.date === iso || daySegments([event], date).length));
      const visible = compact ? rows.slice(0, 2) : rows;
      for (const event of visible) cell.append(eventButton(event, open));
      const hidden = rows.length - visible.length;
      if (hidden > 0) {
        const more = button("+" + hidden, "month-grid__more", () => choose(iso));
        more.setAttribute("aria-label", `Ещё ${hidden}, ${formatDate(iso)}`);
        cell.append(more);
      }
      grid.append(cell);
    }
    host.append(grid); return;
  }
  const days = mode === "week" ? 7 : 1, shell = el("div", "time-calendar");
  shell.classList.toggle("is-single-day", days === 1);
  shell.style.setProperty("--days", String(days));
  const headings = el("div", "time-calendar__headings");
  const offset = -clock.now().getTimezoneOffset() / 60;
  headings.append(el("span", "time-calendar__zone", `GMT${offset >= 0 ? "+" : ""}${offset}`));
  const allDay = el("div", "time-calendar__all-day"); allDay.append(el("span", "", "Без времени"));
  const body = el("div", "time-calendar__body"), axis = el("div", "time-calendar__axis");
  for (let hour = 0; hour < 24; hour++) { const label = el("span", "", `${String(hour).padStart(2, "0")}:00`); label.style.top = hour * 52 + "px"; axis.append(label); }
  body.append(axis);
  for (let index = 0; index < days; index++) {
    const day = addDays(range.start, index), iso = isoDay(day), today = iso === isoDay(clock.now());
    const heading = button("", "time-calendar__day-heading", () => choose(iso));
    const caption = calendarDayCaption(day, days === 1);
    heading.append(
      el("span", "time-calendar__weekday", caption.weekday),
      el("strong", "", caption.number),
      el("span", "time-calendar__month", caption.month),
    );
    heading.setAttribute("aria-label", formatDate(iso));
    heading.classList.toggle("is-today", today); headings.append(heading);
    const withoutTime = el("div", ""); for (const event of events.filter(item => item.date === iso && !item.time)) withoutTime.append(eventButton(event, open)); allDay.append(withoutTime);
    heading.classList.toggle("is-chosen", iso === selected);
    const column = el("div", "time-calendar__column"); column.classList.toggle("is-today", today); column.classList.toggle("is-weekend", day.getDay() === 0 || day.getDay() === 6);
    for (const item of daySegments(events, day, MIN_CARD_HEIGHT / HOUR_HEIGHT * 60)) {
      const node = eventButton(item.event, open);
      const minutes = (item.end - item.start) / 60000;
      node.style.top = (item.start - day.getTime()) / 60000 * 52 / 60 + "px";
      node.classList.toggle("is-short", Boolean(item.event.duration_min && minutes < 30));
      node.classList.toggle("is-point", !item.event.duration_min);
      const height = Math.max(MIN_CARD_HEIGHT, minutes * HOUR_HEIGHT / 60);
      // Integer line budgets prevent a half-cut last line from colliding with time.
      const lines = Math.max(1, Math.min(3, Math.floor((height - 22) / 14)));
      node.style.setProperty("--event-title-lines", String(lines));
      node.classList.toggle("is-compact", lines === 1);
      node.style.height = height + "px";
      node.style.left = `calc(${100 * item.lane / item.lanes}% + 3px)`; node.style.width = `calc(${100 / item.lanes}% - 6px)`;
      column.append(node);
    }
    if (today) {
      const now = clock.now(), top = (now.getHours() * 60 + now.getMinutes()) * 52 / 60;
      const line = el("div", "time-calendar__now"); line.style.top = top + "px"; line.setAttribute("aria-label", "Текущее время"); column.append(line);
      const badge = el("time", "time-calendar__now-label", now.toLocaleTimeString("ru-RU", { hour: "2-digit", minute: "2-digit" })); badge.style.top = top + "px"; axis.append(badge);
    }
    body.append(column);
  }
  shell.append(headings);
  if (events.some(event => event.date && !event.time && event.date >= isoDay(range.start) && event.date < isoDay(range.end))) shell.append(allDay);
  shell.append(body); host.append(shell);
}
