// @ts-check
import { el, icon } from "./ui.js";
import { formatDate } from "./model.js";
import { normalizeHex, softTint } from "./colors.js";

/** @param {unknown} proposal */
export function confirmationCard(proposal) {
  const card = el("section", "confirmation-card"); card.dataset.state = "pending";
  const badge = el("p", "confirmation-card__status", "Ожидает подтверждения"); badge.setAttribute("role", "status");
  /** @type {Record<string, unknown>} */
  const data = typeof proposal === "object" && proposal !== null ? Object.fromEntries(Object.entries(proposal)) : {};
  const color = typeof data.color === "string" ? normalizeHex(data.color) : null;
  if (color) { card.style.borderTopColor = color; card.style.borderTopWidth = "3px"; card.style.backgroundColor = softTint(color); }
  const title = typeof data.title === "string" ? data.title : "Подтверждение действия";
  const label = data.event_type === "meeting" ? "Встреча" : data.event_type === "reminder" ? "Напоминание" : "Задача";
  card.append(badge, el("h3", "", title));
  if (data.event_type) {
    const meta = el("p", "confirmation-card__meta");
    meta.append(icon(data.event_type === "meeting" ? "calendar" : data.event_type === "reminder" ? "bell" : "check"), el("span", "", label));
    card.append(meta);
  }
  if (typeof data.date === "string") card.append(el("p", "confirmation-card__meta", formatDate(data.date) + (typeof data.time === "string" ? " · " + data.time.slice(0, 5) : "")));
  else if (data.intent === "create") card.append(el("p", "confirmation-card__meta", "Без даты"));
  if (typeof data.duration_min === "number" && data.event_type === "meeting") card.append(el("p", "confirmation-card__meta", `Длительность: ${data.duration_min} мин`));
  if (data.intent === "create") card.append(el("p", "muted", "Запись ещё не создана"));
  card.append(el("div", "confirmation-card__actions"));
  return card;
}

/** @param {HTMLElement} card @param {string} kind */
export function resolveConfirmation(card, kind) {
  card.dataset.state = kind === "created" || kind === "deleted" || kind === "updated" ? "confirmed" : kind === "cancelled" ? "declined" : "replaced";
  const status = card.querySelector(".confirmation-card__status");
  if (status) status.textContent = card.dataset.state === "confirmed" ? "Подтверждено" : card.dataset.state === "declined" ? "Отклонено" : "Предложение больше не активно";
}
