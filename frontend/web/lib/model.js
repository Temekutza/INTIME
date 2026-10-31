// @ts-check
/** @typedef {import('./types').RitmEvent} RitmEvent */

/** Browser clock is injectable; the API stores naive server-local date/time. */
export const clock = { now: () => new Date() };

/** @param {Date} day */
export function isoDay(day) {
  return `${String(day.getFullYear()).padStart(4, "0")}-${String(day.getMonth() + 1).padStart(2, "0")}-${String(day.getDate()).padStart(2, "0")}`;
}

/** @param {string} value */
export function dayDate(value) {
  const [year, month, day] = value.split("-").map(Number);
  const date = new Date(0);
  date.setFullYear(year, month - 1, day);
  date.setHours(0, 0, 0, 0);
  return date;
}

/** @param {string | null} date */
export function formatDate(date) {
  return date ? new Intl.DateTimeFormat("ru-RU", { day: "numeric", month: "long", year: "numeric" }).format(dayDate(date)).replace(/\s*г\.$/u, "") : "Без даты";
}

/** @param {RitmEvent} event */
export function eventMeta(event) {
  return [event.is_deadline ? "До " + formatDate(event.date) : formatDate(event.date), event.time?.slice(0, 5)].filter(Boolean).join("  ");
}

/** @param {RitmEvent} event */
export function eventStart(event) {
  // Date-only entries do not have an invented midnight deadline.
  return event.date && event.time ? new Date(event.date + "T" + event.time) : null;
}

/** @param {RitmEvent} event @param {Date} now */
export function relativeTime(event, now) {
  if (event.status === "done") return "Завершено";
  const start = eventStart(event);
  if (!start) return event.date ? "Время не указано" : "Дата не указана";
  const delta = start.getTime() - now.getTime();
  if (delta < 0) return "Время прошло";
  const minutes = Math.ceil(delta / 60000);
  if (minutes === 0) return "Сейчас";
  if (minutes < 60) return `Через ${minutes} мин`;
  if (minutes < 1440) return `Через ${Math.floor(minutes / 60)} ч${minutes % 60 ? " " + minutes % 60 + " мин" : ""}`;
  return `Через ${Math.floor(minutes / 1440)} дн${Math.floor(minutes % 1440 / 60) ? " " + Math.floor(minutes % 1440 / 60) + " ч" : ""}`;
}

/** @param {readonly RitmEvent[]} events @param {string} direction */
export function sortedEvents(events, direction = "asc") {
  const sign = direction === "desc" ? -1 : 1;
  return [...events].sort((a, b) => {
    // Undated entries always last. IDs give a stable order for equal dates.
    if (!a.date && b.date) return 1;
    if (a.date && !b.date) return -1;
    const aKey = (a.date || "") + (a.time || "23:59:59");
    const bKey = (b.date || "") + (b.time || "23:59:59");
    return aKey.localeCompare(bKey) * sign || a.id - b.id;
  });
}

/** @param {readonly RitmEvent[]} events @param {RitmEvent['type']} type */
function groupByStatus(events, type) {
  return {
    planned: events.filter(event => event.type === type && event.status === "planned"),
    done: events.filter(event => event.type === type && event.status === "done"),
  };
}

/** @param {readonly RitmEvent[]} events */
export function groupTasks(events) {
  return groupByStatus(events, "task");
}

/** @param {readonly RitmEvent[]} events */
export function groupReminders(events) {
  return groupByStatus(events, "reminder");
}

/**
 * @param {Pick<RitmEvent, 'type'>} event
 * @param {string} title
 * @param {string} date
 * @param {string} time
 * @param {string} status
 * @param {{ duration?: string }} [extra]
 */
export function fieldErrors(event, title, date, time, status, extra = {}) {
  /** @type {Record<string, string>} */
  const errors = {};
  if (!title.trim() || title.trim().length > 300) errors.title = "Название должно содержать от 1 до 300 символов.";
  if (status !== "planned" && status !== "done") errors.status = "Недопустимый статус.";
  if (date && (!/^\d{4}-\d{2}-\d{2}$/.test(date) || isoDay(dayDate(date)) !== date)) errors.date = "Проверьте дату.";
  if (time && !/^([01]\d|2[0-3]):[0-5]\d$/.test(time)) errors.time = "Проверьте время.";
  if (time && !date) errors.date = "Для времени укажите дату.";
  if (event.type !== "task") {
    if (!date) errors.date = "Для встречи или напоминания нужны дата и время.";
    if (!time) errors.time = "Для встречи или напоминания нужны дата и время.";
  }
  if (extra.duration !== undefined && event.type === "meeting") {
    const minutes = Number(extra.duration);
    if (!Number.isInteger(minutes) || minutes < 1 || minutes > 1440) {
      errors.duration = "Укажите длительность от 1 до 1440 минут.";
    }
  }
  return errors;
}

/** @param {Pick<RitmEvent, 'type'>} event @param {string} title @param {string} date @param {string} time @param {string} status */
export function validatePatch(event, title, date, time, status) {
  const first = Object.values(fieldErrors(event, title, date, time, status))[0];
  if (first) throw new Error(first);
  /** @type {import('./types').EventPatch} */
  const patch = { title: title.trim(), date: date || null, time: time || null, status };
  return patch;
}
