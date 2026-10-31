// @ts-check
import { button, el, empty, icon } from "./ui.js";
import { paintObject } from "./colors.js";
import { calendarRange, addDays } from "./calendar.js";
import { clock, eventStart, isoDay, relativeTime, sortedEvents } from "./model.js";
import { typeLabel } from "./views.js";
/** @typedef {import('./types').RitmEvent} RitmEvent */

/** @param {number} value @param {string} one @param {string} few @param {string} many */
export function ruCount(value, one, few, many) {
  const mod10 = value % 10;
  const mod100 = value % 100;
  const word = mod10 === 1 && mod100 !== 11 ? one : mod10 >= 2 && mod10 <= 4 && (mod100 < 12 || mod100 > 14) ? few : many;
  return `${value} ${word}`;
}

/** @param {Date} date */
export function isoWeekNumber(date) {
  const target = new Date(date.getFullYear(), date.getMonth(), date.getDate());
  target.setDate(target.getDate() + 3 - ((target.getDay() + 6) % 7));
  const week1 = new Date(target.getFullYear(), 0, 4);
  return 1 + Math.round(((target.getTime() - week1.getTime()) / 86400000 - 3 + ((week1.getDay() + 6) % 7)) / 7);
}

/** @param {Date} start @param {Date} end */
export function weekRangeLabel(start, end) {
  const sameMonth = start.getMonth() === end.getMonth() && start.getFullYear() === end.getFullYear();
  const left = start.toLocaleDateString("ru-RU", sameMonth ? { day: "numeric" } : { day: "numeric", month: "long" });
  const right = end.toLocaleDateString("ru-RU", { day: "numeric", month: "long" });
  return `${left} — ${right} · ${isoWeekNumber(start)}-я неделя`;
}

/** @param {Date} date */
function gmtLabel(date) {
  const offset = -date.getTimezoneOffset() / 60;
  const hours = Number.isInteger(offset) ? String(offset) : String(offset);
  return `GMT${offset >= 0 ? "+" : ""}${hours}`;
}

/** @param {RitmEvent} event */
function endLabel(event) {
  const start = eventStart(event);
  if (!start || !event.duration_min) return "";
  return new Date(start.getTime() + event.duration_min * 60000).toLocaleTimeString("ru-RU", { hour: "2-digit", minute: "2-digit" });
}

/**
 * Week strip plus the selected day's agenda. Reuses calendar range and event records.
 * @param {HTMLElement} host
 * @param {RitmEvent[]} events
 * @param {string} selected
 * @param {(event: RitmEvent) => void} open
 * @param {(date: string) => void} choose
 */
export function renderMobileAgenda(host, events, selected, open, choose) {
  host.replaceChildren();
  const range = calendarRange(selected, "week");
  const shell = el("div", "mobile-agenda");
  const strip = el("div", "week-strip");
  strip.setAttribute("role", "listbox");
  strip.setAttribute("aria-label", "Дни недели");
  const today = isoDay(clock.now());
  for (let index = 0; index < 7; index += 1) {
    const date = addDays(range.start, index);
    const iso = isoDay(date);
    const day = button("", `week-day${iso === selected ? " is-selected" : ""}${iso === today ? " is-today" : ""}`, () => choose(iso));
    day.type = "button";
    day.setAttribute("role", "option");
    day.setAttribute("aria-selected", String(iso === selected));
    day.setAttribute("aria-label", date.toLocaleDateString("ru-RU", { weekday: "long", day: "numeric", month: "long" }));
    day.append(
      el("span", "week-day__name", date.toLocaleDateString("ru-RU", { weekday: "short" }).replace(".", "")),
      el("span", "week-day__num", String(date.getDate())),
    );
    strip.append(day);
  }
  const chosen = selected ? new Date(selected + "T12:00:00") : clock.now();
  const dayEvents = sortedEvents(events.filter(event => event.date === selected));
  const meetings = dayEvents.filter(event => event.type === "meeting").length;
  const caption = meetings
    ? `${ruCount(meetings, "встреча", "встречи", "встреч")} · ${gmtLabel(chosen)}`
    : `${ruCount(dayEvents.length, "запись", "записи", "записей")} · ${gmtLabel(chosen)}`;
  const heading = el("div", "agenda-heading");
  heading.append(
    el("h2", "", chosen.toLocaleDateString("ru-RU", { weekday: "long", day: "numeric", month: "long" })),
    el("p", "muted", caption),
  );
  const list = el("div", "agenda-list");
  if (!dayEvents.length) list.append(empty("На этот день ничего не запланировано."));
  for (const event of dayEvents) {
    const card = button("", `agenda-card${event.status === "done" ? " is-done" : ""}`, () => open(event));
    card.dataset.id = String(event.id);
    paintObject(card, event);
    const start = event.time?.slice(0, 5) || "Весь день";
    const finish = endLabel(event);
    const time = el("span", "agenda-card__time");
    time.append(el("span", "", start));
    if (finish) time.append(el("span", "", finish));
    const body = el("span", "agenda-card__body");
    const meta = [typeLabel(event.type)];
    if (event.duration_min) meta.push(`${event.duration_min} мин`);
    const relative = relativeTime(event, clock.now());
    if (event.status !== "done" && event.time) meta.push(relative);
    if (event.status === "done") meta.push("Завершено");
    body.append(el("strong", event.status === "done" ? "is-struck" : "", event.title), el("span", "muted", meta.join(" · ")));
    card.append(time, body, icon("next"));
    card.setAttribute("aria-label", `${event.title}. ${start}${finish ? " — " + finish : ""}`);
    list.append(card);
  }
  shell.append(strip, heading, list);
  host.append(shell);
}
