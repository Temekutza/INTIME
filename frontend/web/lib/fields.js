// @ts-check
import { AnchoredPopover } from "./popover.js";
import { el, button, icon } from "./ui.js";
import { clock, dayDate, isoDay } from "./model.js";

/** @param {HTMLInputElement | HTMLSelectElement} control */
function labelOf(control) {
  return control.getAttribute("aria-label") || [...(control.labels || [])].map(label => [...label.childNodes].filter(node => node.nodeType === Node.TEXT_NODE).map(node => node.textContent).join("").trim()).find(Boolean) || control.id;
}
/** @param {HTMLInputElement | HTMLSelectElement} control */
function notify(control) { control.dispatchEvent(new Event("input", { bubbles: true })); control.dispatchEvent(new Event("change", { bubbles: true })); }
/** @param {HTMLElement} panel @param {string} selector */
function focusIn(panel, selector) { const node = panel.querySelector(selector); if (node instanceof HTMLElement) node.focus(); }

class StyledSelect {
  /** @param {HTMLSelectElement} control */
  constructor(control) {
    this.control = control; this.host = el("span", "field-select");
    this.trigger = button("", "field-select__trigger", () => this.open());
    this.trigger.setAttribute("role", "combobox"); this.trigger.setAttribute("aria-label", labelOf(control));
    this.trigger.setAttribute("aria-haspopup", "listbox"); this.trigger.setAttribute("aria-expanded", "false");
    this.panel = el("div", "ui-popover select-options"); this.panel.id = control.id + "-options";
    this.panel.setAttribute("role", "listbox"); this.panel.setAttribute("aria-label", labelOf(control));
    this.trigger.setAttribute("aria-controls", this.panel.id);
    control.before(this.host); this.host.append(control, this.trigger, this.panel);
    control.tabIndex = -1; control.setAttribute("aria-hidden", "true");
    this.popup = new AnchoredPopover(this.trigger, this.panel);
    control.addEventListener("change", () => this.sync());
    control.addEventListener("click", event => { event.preventDefault(); this.open(); });
    control.addEventListener("focus", () => this.trigger.focus());
    this.trigger.addEventListener("keydown", event => {
      if (["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key)) { event.preventDefault(); this.open(event.key === "End" ? control.options.length - 1 : undefined); }
    });
    this.panel.addEventListener("keydown", event => {
      const options = [...this.panel.querySelectorAll("button:not(:disabled)")];
      const index = options.findIndex(node => node === document.activeElement);
      let next = index;
      if (event.key === "ArrowDown") next = (index + 1) % options.length;
      else if (event.key === "ArrowUp") next = (index - 1 + options.length) % options.length;
      else if (event.key === "Home") next = 0; else if (event.key === "End") next = options.length - 1; else return;
      event.preventDefault(); const target = options[next]; if (target instanceof HTMLButtonElement) target.focus();
    });
    this.sync();
  }
  sync() {
    const mark = icon("chevron");
    mark.classList.add("field-chevron");
    mark.setAttribute("aria-hidden", "true");
    this.trigger.replaceChildren(el("span", "", this.control.selectedOptions[0]?.textContent || "Выберите"), mark);
    this.trigger.disabled = this.control.disabled; this.trigger.title = this.control.title;
    this.trigger.setAttribute("aria-label", labelOf(this.control));
    this.panel.setAttribute("aria-label", labelOf(this.control));
  }
  /** @param {number} [focusIndex] */
  open(focusIndex) {
    if (this.control.disabled) return;
    this.panel.replaceChildren();
    for (const option of this.control.options) {
      const item = button("", "select-option", () => { this.control.value = option.value; notify(this.control); this.sync(); this.popup.close(); });
      item.setAttribute("role", "option"); item.setAttribute("aria-selected", String(option.selected)); item.disabled = option.disabled;
      item.append(el("span", "", option.textContent || ""), el("span", "", option.selected ? "✓" : "")); this.panel.append(item);
    }
    this.panel.style.minWidth = this.trigger.getBoundingClientRect().width + "px"; this.popup.open();
    const options = this.panel.querySelectorAll("button"); options[focusIndex ?? Math.max(0, this.control.selectedIndex)]?.focus();
  }
  destroy() { this.popup.destroy(); }
}

class DateField {
  /** @param {HTMLInputElement} control */
  constructor(control) {
    this.control = control; this.host = el("span", "field-date");
    this.trigger = button("", "field-calendar-button", () => this.open()); this.trigger.append(icon("calendar"));
    this.trigger.setAttribute("aria-label", "Открыть календарь: " + labelOf(control)); this.trigger.setAttribute("aria-haspopup", "dialog");
    this.panel = el("div", "ui-popover date-picker"); this.panel.setAttribute("role", "dialog"); this.panel.setAttribute("aria-label", "Выбор даты");
    control.before(this.host); this.host.append(control, this.trigger, this.panel);
    this.popup = new AnchoredPopover(this.trigger, this.panel);
    this.month = clock.now(); this.mode = "days";
    control.addEventListener("click", event => { event.preventDefault(); this.open(); });
    control.addEventListener("keydown", event => { if (event.altKey && event.key === "ArrowDown") { event.preventDefault(); this.open(); } });
    this.sync();
  }
  sync() {
    this.trigger.disabled = this.control.disabled;
    this.host.classList.toggle("is-invalid", this.control.getAttribute("aria-invalid") === "true");
  }
  open() {
    if (this.control.disabled) return;
    this.month = this.control.value ? dayDate(this.control.value) : clock.now(); this.mode = "days"; this.render(); this.popup.open();
    focusIn(this.panel, this.control.value ? 'button[aria-pressed="true"]' : ".is-today");
  }
  /** @param {string} value */
  choose(value) { this.control.value = value; notify(this.control); this.popup.close(); }
  render() {
    this.panel.replaceChildren();
    const heading = el("div", "date-picker__heading");
    const month = button(this.month.toLocaleDateString("ru-RU", { month: "long", year: "numeric" }), "date-picker__month", () => { this.mode = this.mode === "days" ? "months" : "years"; this.render(); this.popup.position(); });
    month.setAttribute("aria-label", "Выбрать месяц и год");
    const move = (/** @type {number} */ delta) => { this.month = new Date(this.month.getFullYear() + (this.mode === "years" ? delta * 12 : this.mode === "months" ? delta : 0), this.month.getMonth() + (this.mode === "days" ? delta : 0), 1); this.render(); this.popup.position(); };
    const prev = button("", "icon-btn", () => move(-1)); prev.append(icon("previous")); prev.setAttribute("aria-label", "Предыдущий период");
    const next = button("", "icon-btn", () => move(1)); next.append(icon("next")); next.setAttribute("aria-label", "Следующий период");
    heading.append(month, prev, next); this.panel.append(heading);
    if (this.mode === "years") {
      const years = el("div", "date-picker__months"); const start = this.month.getFullYear() - 5;
      for (let year = start; year < start + 12; year++) years.append(button(String(year), "date-picker__cell", () => { this.month = new Date(year, this.month.getMonth(), 1); this.mode = "months"; this.render(); }));
      this.panel.append(years);
    } else if (this.mode === "months") {
      const months = el("div", "date-picker__months");
      for (let index = 0; index < 12; index++) months.append(button(new Date(this.month.getFullYear(), index, 1).toLocaleDateString("ru-RU", { month: "short" }), "date-picker__cell", () => { this.month = new Date(this.month.getFullYear(), index, 1); this.mode = "days"; this.render(); this.popup.position(); }));
      this.panel.append(months);
    } else {
      const weekdays = el("div", "date-picker__weekdays"); for (const day of ["Пн", "Вт", "Ср", "Чт", "Пт", "Сб", "Вс"]) weekdays.append(el("span", "", day));
      const grid = el("div", "date-picker__grid"); grid.setAttribute("role", "group"); grid.setAttribute("aria-label", "Дни месяца");
      const start = new Date(this.month.getFullYear(), this.month.getMonth(), 1); start.setDate(1 - (start.getDay() + 6) % 7);
      for (let index = 0; index < 42; index++) {
        const date = new Date(start.getFullYear(), start.getMonth(), start.getDate() + index), iso = isoDay(date);
        const day = button(String(date.getDate()), "date-picker__day", () => this.choose(iso)); day.dataset.date = iso;
        day.classList.toggle("is-other-month", date.getMonth() !== this.month.getMonth()); day.classList.toggle("is-today", iso === isoDay(clock.now()));
        day.setAttribute("aria-label", date.toLocaleDateString("ru-RU", { day: "numeric", month: "long", year: "numeric" })); day.setAttribute("aria-pressed", String(iso === this.control.value));
        day.addEventListener("keydown", event => {
          const offset = { ArrowLeft: -1, ArrowRight: 1, ArrowUp: -7, ArrowDown: 7 }[event.key];
          if (!offset) return; event.preventDefault();
          const target = new Date(date.getFullYear(), date.getMonth(), date.getDate() + offset);
          this.month = target; this.render(); focusIn(this.panel, `button[data-date="${isoDay(target)}"]`);
        }); grid.append(day);
      }
      this.panel.append(weekdays, grid);
    }
    const footer = el("div", "date-picker__footer"); footer.append(button("Удалить", "inline-link", () => this.choose("")), button("Сегодня", "inline-link", () => this.choose(isoDay(clock.now())))); this.panel.append(footer);
  }
  destroy() { this.popup.destroy(); }
}

class TimeField {
  /** @param {HTMLInputElement} control */
  constructor(control) {
    this.control = control; this.host = el("span", "field-date");
    this.trigger = button("", "field-calendar-button", () => this.open()); this.trigger.append(icon("time"));
    this.trigger.setAttribute("aria-label", "Выбрать время: " + labelOf(control));
    this.panel = el("div", "ui-popover time-picker"); this.panel.setAttribute("role", "dialog"); this.panel.setAttribute("aria-label", "Выбор времени");
    control.before(this.host); this.host.append(control, this.trigger, this.panel); this.popup = new AnchoredPopover(this.trigger, this.panel);
    this.trigger.setAttribute("aria-haspopup", "dialog");
    control.addEventListener("click", event => { event.preventDefault(); this.open(); });
    control.addEventListener("keydown", event => { if (event.altKey && event.key === "ArrowDown") { event.preventDefault(); this.open(); } });
    this.sync();
  }
  sync() {
    this.trigger.disabled = this.control.disabled;
    this.host.classList.toggle("is-invalid", this.control.getAttribute("aria-invalid") === "true");
  }
  open() {
    if (this.control.disabled) return;
    const now = clock.now(); const initial = this.control.value || `${String(now.getHours()).padStart(2, "0")}:${String(now.getMinutes()).padStart(2, "0")}`;
    let [hour, minute] = initial.split(":").map(Number);
    this.panel.replaceChildren(el("strong", "", "Выберите время"));
    const columns = el("div", "time-picker__columns");
    const render = () => {
      columns.replaceChildren();
      /** @type {[string, number[]][]} */
      const groups = [["Часы", Array.from({ length: 24 }, (_, i) => i)], ["Минуты", [...new Set([...Array.from({ length: 12 }, (_, i) => i * 5), minute])].sort((a, b) => a - b)]];
      for (const [label, values] of groups) {
        const list = el("div", "time-picker__list"); list.setAttribute("role", "group"); list.setAttribute("aria-label", String(label));
        for (const value of values) {
          const option = button(String(value).padStart(2, "0"), "time-picker__option", () => {
            if (label === "Часы") hour = value; else minute = value;
            render(); focusIn(columns, `[aria-label="${label}"] button[aria-pressed="true"]`);
          });
          option.setAttribute("aria-pressed", String(value === (label === "Часы" ? hour : minute))); list.append(option);
        } columns.append(list);
      }
      columns.querySelectorAll('button[aria-pressed="true"]').forEach(node => node.scrollIntoView({ block: "nearest" }));
    }; render();
    const apply = (/** @type {string} */ value) => { this.control.value = value; notify(this.control); this.popup.close(); };
    const footer = el("div", "date-picker__footer"); footer.append(button("Очистить", "inline-link", () => apply("")), button("Готово", "btn btn-primary", () => apply(`${String(hour).padStart(2, "0")}:${String(minute).padStart(2, "0")}`)));
    this.panel.append(columns, footer); this.popup.open();
    columns.querySelectorAll('button[aria-pressed="true"]').forEach(node => node.scrollIntoView({ block: "nearest" }));
    focusIn(columns, 'button[aria-pressed="true"]');
  }
  destroy() { this.popup.destroy(); }
}

/** @type {Map<HTMLInputElement | HTMLSelectElement, StyledSelect | DateField | TimeField>} */
const controls = new Map();
/** @param {ParentNode} [root] */
export function enhanceFields(root = document) {
  for (const [control, widget] of controls) if (!control.isConnected) { widget.destroy(); controls.delete(control); }
  root.querySelectorAll("select, input[type=date], input[type=time]").forEach(control => {
    if (!(control instanceof HTMLInputElement || control instanceof HTMLSelectElement) || !control.id) return;
    if (control.id === "workspace-select") return;
    const existing = controls.get(control); if (existing) { existing.sync(); return; }
    controls.set(control, control instanceof HTMLSelectElement ? new StyledSelect(control) : control.type === "date" ? new DateField(control) : new TimeField(control));
  });
}

const ERROR_FIELDS = {
  "create-name": "title",
  "create-date": "date",
  "create-time": "time",
  "create-duration": "duration",
  "edit-title": "title",
  "edit-date": "date",
  "edit-time": "time",
};

/** @param {ParentNode} root @param {Record<string, string>} errors */
export function showFieldErrors(root, errors) {
  let first = null;
  for (const control of root.querySelectorAll("input, select, textarea")) {
    if (!(control instanceof HTMLElement) || !control.id) continue;
    const key = ERROR_FIELDS[control.id];
    if (!key) continue;
    const message = errors[key];
    control.setAttribute("aria-invalid", message ? "true" : "false");
    control.closest(".form-field")?.classList.toggle("is-invalid", Boolean(message));
    control.closest(".field-date")?.classList.toggle("is-invalid", Boolean(message));
    control.closest(".field-label")?.classList.toggle("is-invalid", Boolean(message));
    control.closest(".editor-identity")?.classList.toggle("is-invalid", Boolean(message));
    if (message && !first) first = control;
  }
  enhanceFields(root);
  if (first instanceof HTMLElement) first.focus();
}
