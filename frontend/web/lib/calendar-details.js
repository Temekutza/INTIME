// @ts-check
import { button, el, icon } from "./ui.js";
import { eventStart, formatDate } from "./model.js";
import { paintObject } from "./colors.js";
import { typeLabel } from "./views.js";

/** Read-only selection, deliberately separate from the existing editor.
 * @param {HTMLElement} host
 * @param {import('./types').RitmEvent | null} event
 * @param {() => void} edit @param {() => void} clear
 */
export function renderCalendarDetails(host, event, edit, clear) {
  const focused = host.contains(document.activeElement) && document.activeElement instanceof HTMLElement ? document.activeElement.dataset.action : null;
  host.replaceChildren();
  host.classList.toggle("has-selection", event !== null);
  if (!event) {
    host.append(el("p", "calendar-details__empty", "Выберите событие в календаре, чтобы посмотреть подробности"));
    return;
  }
  paintObject(host, event);
  const heading = el("div", "section-heading");
  heading.append(el("span", "eyebrow", "ВЫБРАННОЕ СОБЫТИЕ"));
  const actions = el("div", "calendar-details__actions");
  const editing = button("Редактировать", "btn btn-quiet", edit); editing.dataset.action = "edit";
  const close = button("", "icon-btn", clear); close.append(icon("close")); close.dataset.action = "close";
  close.setAttribute("aria-label", "Снять выбор события");
  actions.append(editing, close); heading.append(actions);
  const body = el("div", "calendar-details__columns");
  const title = el("div", "calendar-details__identity");
  title.append(el("h2", "", event.title), el("p", "muted", typeLabel(event.type)));
  const schedule = el("div", "calendar-details__schedule");
  const date = el("p"); date.append(icon("calendar"), el("span", "", formatDate(event.date)));
  const time = el("p"), start = eventStart(event);
  const interval = event.time ? event.time.slice(0, 5) + (start && event.duration_min ? " — " + new Date(start.getTime() + event.duration_min * 60000).toLocaleTimeString("ru-RU", { hour: "2-digit", minute: "2-digit" }) : "") : "Время не указано";
  time.append(icon("time"), el("span", "", interval));
  schedule.append(date, time);
  if (start && event.duration_min && new Date(start.getTime() + event.duration_min * 60000).getDate() !== start.getDate()) schedule.append(el("p", "muted", "Окончание на следующий день или позже"));
  const meta = el("div", "calendar-details__meta");
  meta.append(el("span", "calendar-details__label", "СТАТУС"), el("p", "", event.status === "done" ? "Завершено" : "Открыта"));
  if (event.is_deadline) meta.append(el("p", "muted", "Указан срок выполнения"));
  if (event.duration_min) meta.append(el("p", "muted", `${event.duration_min} мин`));
  body.append(title, schedule, meta); host.append(heading, body);
  if (focused) { const node = host.querySelector(`[data-action="${focused}"]`); if (node instanceof HTMLElement) node.focus(); }
}
