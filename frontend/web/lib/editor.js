// @ts-check
import { button, el, icon } from "./ui.js";
import { validatePatch, eventMeta } from "./model.js";
import { typeLabel } from "./views.js";
import { colorStore, paintObject } from "./colors.js";
import { ColorPicker } from "./color-picker.js";
import { enhanceFields } from "./fields.js";
import { confirmDiscard } from "./confirm-dialog.js";

export class EventEditor {
  /** @type {number | null} */
  id = null;
  dirty = false;
  busy = false;
  /** @type {ColorPicker | null} */
  colorPicker = null;
  /** @param {HTMLElement} host @param {import('./store').EventStore} store @param {() => void} closed */
  constructor(host, store, closed) {
    this.host = host; this.store = store; this.closed = closed;
    colorStore.addEventListener("change", () => {
      this.colorPicker?.refresh();
      const event = store.events.find(item => item.id === this.id);
      if (event) paintObject(host, event);
    });
  }

  /** Reflect changes from sidebar, assistant and refreshed data without discarding a draft. */
  synchronize() {
    if (this.id === null || this.dirty || this.busy || !this.store.loaded) return;
    const event = this.store.events.find(item => item.id === this.id);
    if (!event) { this.id = null; this.host.hidden = true; return; }
    const title = this.host.querySelector("#edit-title");
    const date = this.host.querySelector("#edit-date");
    const time = this.host.querySelector("#edit-time");
    const status = this.host.querySelector("#edit-status");
    if (title instanceof HTMLTextAreaElement) title.value = event.title;
    if (date instanceof HTMLInputElement) date.value = event.date || "";
    if (time instanceof HTMLInputElement) time.value = event.time?.slice(0, 5) || "";
    if (status instanceof HTMLSelectElement) status.value = event.status;
    const complete = this.host.querySelector(".editor-actions .btn-quiet");
    if (complete) complete.textContent = event.status === "done" ? "Вернуть в открытые" : "Завершить запись";
    const info = this.host.querySelector(".editor-info span:last-child");
    if (info) info.textContent = `${typeLabel(event.type)} · ${eventMeta(event)}`;
  }

  async close() {
    if (this.busy || this.colorPicker?.busy) return false;
    if (this.dirty && !await confirmDiscard("Закрыть редактор без сохранения изменений?")) return false;
    this.id = null;
    this.colorPicker?.destroy(); this.colorPicker = null;
    this.dirty = false;
    this.host.hidden = true;
    this.closed();
    return true;
  }

  /** @param {import('./types').RitmEvent} event */
  async open(event) {
    if (this.busy || this.colorPicker?.busy) return false;
    if (this.id !== null && this.dirty && !await confirmDiscard("Открыть другую запись без сохранения изменений?")) return false;
    this.id = event.id;
    this.colorPicker?.destroy();
    this.dirty = false;
    this.host.hidden = false;
    this.host.replaceChildren();
    paintObject(this.host, event);
    const heading = el("div", "section-heading");
    heading.append(el("span", "eyebrow", "ВЫБРАННАЯ ЗАПИСЬ"));
    const close = button("", "icon-btn", () => this.close());
    close.append(icon("close")); close.setAttribute("aria-label", "Закрыть редактор"); heading.append(close);
    const form = el("form", "editor-form");
    const title = el("textarea", "editor-title");
    title.value = event.title; title.maxLength = 300; title.required = true; title.rows = 2;
    title.id = "edit-title";
    const titleLabel = el("label", "visually-hidden", "Название записи"); titleLabel.htmlFor = title.id;
    const status = el("select"); status.id = "edit-status";
    status.append(new Option("Создана", "planned"), new Option("Завершена", "done")); status.value = event.status;
    const statusLabel = el("label", "field-label", "Статус"); statusLabel.htmlFor = status.id;
    const date = el("input"); date.type = "date"; date.value = event.date || ""; date.id = "edit-date";
    const time = el("input"); time.type = "time"; time.value = event.time?.slice(0, 5) || ""; time.id = "edit-time";
    const fields = el("div", "editor-datetime");
    const dateLabel = el("label", "field-label", event.is_deadline ? "Дата дедлайна" : "Дата"); dateLabel.htmlFor = date.id; dateLabel.append(date);
    const timeLabel = el("label", "field-label", "Время"); timeLabel.htmlFor = time.id; timeLabel.append(time);
    fields.append(dateLabel, timeLabel);
    const info = el("div", "editor-info");
    this.colorPicker = new ColorPicker({ label: "Цвет записи", getValue: () => colorStore.overrides[String(event.id)] || null,
      getDefault: () => colorStore.defaultColor(event.type), ready: () => colorStore.loaded && !colorStore.busy,
      save: color => colorStore.save(event.id, color) });
    info.append(icon(event.type === "reminder" ? "bell" : "calendar"), el("span", "", `${typeLabel(event.type)} · ${eventMeta(event)}`));
    const note = el("p", "capability-note", "Описание и приоритет пока недоступны. Все записи с датой видны в календаре приложения. Внешние календари не подключены. Время записей — локальное время сервера.");
    if (event.type === "reminder") note.textContent = "Это отдельная запись с датой и временем. Привязка к задаче и доставка уведомлений пока недоступны.";
    const details = el("details", "editor-notes"); details.append(el("summary", "", "О возможностях записи"), note);
    const message = el("p", "editor-save-status", "Изменений нет"); message.setAttribute("role", "status");
    const save = el("button", "btn btn-primary", "Сохранить изменения"); save.type = "submit";
    const complete = button(event.status === "done" ? "Вернуть в открытые" : "Завершить запись", "btn btn-quiet", () => {
      status.value = status.value === "done" ? "planned" : "done";
      this.dirty = true;
      form.requestSubmit();
    });
    const actions = el("div", "editor-actions"); actions.append(save, complete);
    form.append(titleLabel, title, el("p", "muted", `${typeLabel(event.type)} · №${event.id}`), statusLabel, status, fields, info,
      el("p", "field-label", "Цветовой акцент"), this.colorPicker.host, details, message, actions);
    const dirty = (/** @type {Event} */ event) => {
      if (event.target instanceof Element && event.target.closest(".color-picker")) return;
      this.dirty = true; message.textContent = "Есть несохранённые изменения";
    };
    form.addEventListener("input", dirty);
    form.addEventListener("change", dirty);
    form.addEventListener("submit", async submit => {
      submit.preventDefault();
      if (this.busy) return;
      try {
        const patch = validatePatch(event, title.value, date.value, time.value, status.value);
        this.busy = true;
        for (const field of [title, status, date, time, save, complete, close]) field.disabled = true;
        enhanceFields(form);
        message.textContent = "Сохранение…";
        await this.store.patch(event.id, patch);
        this.dirty = false;
        message.textContent = "Изменения сохранены на сервере";
        message.classList.remove("is-danger");
        complete.textContent = status.value === "done" ? "Вернуть в открытые" : "Завершить запись";
      } catch (error) {
        message.textContent = error instanceof Error ? error.message : "Не удалось сохранить запись.";
        message.classList.add("is-danger");
      } finally {
        this.busy = false;
        for (const field of [title, status, date, time, save, complete, close]) field.disabled = false;
        enhanceFields(form);
      }
    });
    this.host.append(heading, form);
    enhanceFields(form);
    title.focus();
    return true;
  }
}
