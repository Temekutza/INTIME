// @ts-check
import { requestJson, isEvent } from "./api.js";
import { workspaceStore } from "./workspace.js";
import { colorStore } from "./colors.js";
import { ColorPicker } from "./color-picker.js";
import { button, el, icon } from "./ui.js";
import { validatePatch } from "./model.js";
import { hasProfanity } from "./profanity.js";
import { enhanceFields } from "./fields.js";
import { confirmDiscard } from "./confirm-dialog.js";

/** @typedef {import('./types').EventType} EventType */
/** @typedef {import('./types').RitmEvent} RitmEvent */

/** @param {unknown} data @returns {data is {kind: string, text: string, events: RitmEvent[]}} */
function isReply(data) {
  return typeof data === "object" && data !== null && "kind" in data && typeof data.kind === "string" &&
    "text" in data && typeof data.text === "string" && "events" in data && Array.isArray(data.events) && data.events.every(isEvent);
}

export class CreateEventDialog {
  busy = false;
  dirty = false;
  /** @type {ColorPicker | null} */
  picker = null;
  /** @param {(event: RitmEvent) => Promise<void>} created */
  constructor(created) {
    this.created = created;
    this.dialog = el("dialog", "create-dialog"); this.dialog.id = "create-dialog";
    this.dialog.setAttribute("aria-labelledby", "create-title");
    document.body.append(this.dialog);
    this.dialog.addEventListener("cancel", event => { event.preventDefault(); this.close(); });
    colorStore.addEventListener("change", () => this.picker?.refresh());
  }
  async close() {
    if (this.busy || this.picker?.busy) return;
    if (this.dirty && !await confirmDiscard("Закрыть форму без создания записи?", "Закрыть форму")) return;
    this.dialog.close(); this.picker?.destroy(); this.picker = null;
  }

  /** @param {EventType} initialType */
  open(initialType) {
    if (this.dialog.open) return;
    this.dialog.replaceChildren(); this.dirty = false;
    const session = "form-" + crypto.randomUUID();
    let requestId = crypto.randomUUID();
    /** @type {string | null} */
    let color = null;
    /** @type {string | null} */
    let lastPayload = null;
    const heading = el("div", "section-heading");
    const title = el("h2", "", "Новая запись"); title.id = "create-title";
    const close = button("", "icon-btn", () => this.close()); close.append(icon("close")); close.setAttribute("aria-label", "Закрыть форму создания");
    heading.append(title, close);
    const form = el("form", "create-form");
    const kind = el("select"); kind.id = "create-type";
    kind.append(new Option("Задача", "task"), new Option("Встреча", "meeting"), new Option("Напоминание", "reminder")); kind.value = initialType;
    const name = el("input"); name.id = "create-name"; name.required = true; name.maxLength = 300; name.autocomplete = "off"; name.placeholder = "Что нужно сделать?";
    const date = el("input"); date.id = "create-date"; date.type = "date";
    const time = el("input"); time.id = "create-time"; time.type = "time";
    const duration = el("input"); duration.id = "create-duration"; duration.type = "number"; duration.min = "1"; duration.max = "1440"; duration.value = "60";
    const deadline = el("input"); deadline.id = "create-deadline"; deadline.type = "checkbox";
    const field = (/** @type {string} */ label, /** @type {HTMLInputElement | HTMLSelectElement} */ node) => {
      const wrapper = el("label", "form-field", label); wrapper.htmlFor = node.id; wrapper.append(node); return wrapper;
    };
    const dates = el("div", "form-columns"); dates.append(field("Дата", date), field("Время", time));
    const durationField = field("Длительность, минут", duration);
    const deadlineField = el("label", "checkbox-field"); deadlineField.htmlFor = deadline.id; deadlineField.append(deadline, el("span", "", "Это срок выполнения задачи"));
    const colorField = el("div", "form-field", "Цвет записи");
    this.picker = new ColorPicker({ label: "Цвет создаваемой записи", getValue: () => color,
      getDefault: () => colorStore.defaultColor(currentType()), ready: () => colorStore.loaded && !this.busy,
      save: async value => { color = value; this.dirty = true; this.picker?.refresh(); },
      savedText: "Сохранится вместе с записью" }); colorField.append(this.picker.host);
    const message = el("p", "create-status"); message.id = "create-status"; message.setAttribute("role", "status");
    const submit = el("button", "btn btn-primary", "Создать задачу"); submit.type = "submit";
    const confirmation = el("div", "create-confirmation"); confirmation.hidden = true;
    const confirm = button("Подтвердить создание", "btn btn-primary", () => { void send(true); });
    const cancel = button("Отменить подтверждение", "btn btn-quiet", () => { confirmation.hidden = true; message.textContent = "Измените поля и отправьте форму заново."; });
    confirmation.append(confirm, cancel);
    form.append(field("Тип записи", kind), field("Название", name), dates, durationField, deadlineField, colorField,
      el("p", "muted", "Дата необязательна для задачи. Время — локальное время сервера."), message, confirmation, submit);
    /** @returns {EventType} */
    function currentType() { return kind.value === "meeting" ? "meeting" : kind.value === "reminder" ? "reminder" : "task"; }
    const refreshType = () => {
      const type = currentType(); const task = type === "task";
      title.textContent = task ? "Новая задача" : type === "meeting" ? "Новая встреча" : "Новое напоминание";
      submit.textContent = task ? "Создать задачу" : type === "meeting" ? "Создать встречу" : "Создать напоминание";
      durationField.hidden = type !== "meeting"; deadlineField.hidden = !task;
      date.required = !task; time.required = !task;
      this.picker?.refresh();
      enhanceFields(form);
    };
    kind.addEventListener("change", refreshType);
    form.addEventListener("input", event => {
      this.dirty = true;
      if (event.target instanceof Element && event.target.closest(".color-picker")) return;
      confirmation.hidden = true; message.textContent = "";
    });
    const setBusy = (/** @type {boolean} */ value) => {
      this.busy = value;
      for (const control of [name, kind, date, time, duration, deadline, submit, confirm, cancel, close]) control.disabled = value;
      this.picker?.refresh();
      enhanceFields(form);
    };
    const send = async (/** @type {boolean} */ confirmed = false) => {
      if (this.busy) return;
      try {
        const type = currentType();
        // The same validation as the editor, without manufacturing a domain object.
        if (hasProfanity(name.value)) throw new Error("Не принимаем ненормативную лексику в названии.");
        validatePatch({ type }, name.value, date.value, time.value, "planned");
        const payload = { type, title: name.value.trim(), date: date.value || null, time: time.value || null,
          duration_min: type === "meeting" ? Number(duration.value) : null, is_deadline: type === "task" && deadline.checked, color,
          ...(workspaceStore.currentId === null ? {} : { workspace_id: workspaceStore.currentId }) };
        if (type === "meeting" && (!Number.isInteger(payload.duration_min) || Number(payload.duration_min) < 1 || Number(payload.duration_min) > 1440)) throw new Error("Укажите длительность от 1 до 1440 минут.");
        const serialized = JSON.stringify(payload);
        const fingerprint = (confirmed ? "confirm:" : "create:") + serialized;
        if (lastPayload !== fingerprint) { requestId = crypto.randomUUID(); lastPayload = fingerprint; }
        setBusy(true); message.textContent = "Сохранение…"; message.classList.remove("is-danger");
        const result = confirmed
          ? await requestJson("/api/message", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ session_id: session, request_id: requestId, text: "Да", new_event_color: color, ...(workspaceStore.currentId === null ? {} : { workspace_id: workspaceStore.currentId }) }) })
          : await requestJson("/api/events", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ session_id: session, request_id: requestId, ...payload }) });
        if (!isReply(result)) throw new Error("Сервер вернул некорректный ответ создания.");
        message.textContent = result.text;
        if ((result.kind === "created" || result.kind === "duplicate") && result.events[0]) {
          this.dirty = false; this.dialog.close(); this.picker?.destroy(); this.picker = null;
          await this.created(result.events[0]);
        } else if (result.kind === "confirm") {
          confirmation.hidden = false; lastPayload = null;
        } else throw new Error(result.text || "Не удалось создать запись. Проверьте поля.");
      } catch (error) {
        message.textContent = error instanceof Error ? error.message : "Не удалось создать запись.";
        message.classList.add("is-danger");
      } finally { setBusy(false); }
    };
    form.addEventListener("submit", event => { event.preventDefault(); void send(); });
    this.dialog.append(heading, form); refreshType(); enhanceFields(form); this.dialog.showModal(); name.focus();
  }
}
