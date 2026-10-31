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
  return date ? new Intl.DateTimeFormat("ru-RU", { day: "numeric", month: "long", year: "numeric" }).format(dayDate(date)) : "Без даты";
}

/** @param {RitmEvent} event */
export function eventMeta(event) {
  return [event.is_deadline ? "До " + formatDate(event.date) : formatDate(event.date), event.time?.slice(0, 5)].filter(Boolean).join(" · ");
}

/** @param {RitmEvent} event */
export function eventStart(event) {
  // Date-only entries do not have an invented midnight deadline.
  return event.date && event.time ? new Date(event.date + "T" + event.time) : null;
}

/** @param {RitmEvent} event @param {Date} now */
export function relativeTime(event, now) {
  const start = eventStart(event);
  if (!start) return event.date ? "Время не указано" : "Дата не указана";
  const delta = start.getTime() - now.getTime();
  if (delta < 0) return event.status === "done" ? "Завершено" : "Время прошло";
  const minutes = Math.ceil(delta / 60000);
  if (minutes === 0) return "Сейчас";
  if (minutes < 60) return `Через ${minutes} мин`;
  if (minutes < 1440) return `Через ${Math.floor(minutes / 60)} ч${minutes % 60 ? " " + minutes % 60 + " мин" : ""}`;
  return `Через ${Math.floor(minutes / 1440)} дн`;
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

/** @param {readonly RitmEvent[]} events */
export function groupTasks(events) {
  return {
    planned: events.filter(event => event.type === "task" && event.status === "planned"),
    done: events.filter(event => event.type === "task" && event.status === "done"),
  };
}

/** @param {Pick<RitmEvent, 'type'>} event @param {string} title @param {string} date @param {string} time @param {string} status */
export function validatePatch(event, title, date, time, status) {
  if (!title.trim() || title.trim().length > 300) throw new Error("Название должно содержать от 1 до 300 символов.");
  if (status !== "planned" && status !== "done") throw new Error("Недопустимый статус.");
  if (date && (!/^\d{4}-\d{2}-\d{2}$/.test(date) || isoDay(dayDate(date)) !== date)) throw new Error("Проверьте дату.");
  if (time && !/^([01]\d|2[0-3]):[0-5]\d$/.test(time)) throw new Error("Проверьте время.");
  if (time && !date) throw new Error("Для времени укажите дату.");
  if (event.type !== "task" && (!date || !time)) throw new Error("Для встречи или напоминания нужны дата и время.");
  /** @type {import('./types').EventPatch} */
  const patch = { title: title.trim(), date: date || null, time: time || null, status };
  return patch;
}
