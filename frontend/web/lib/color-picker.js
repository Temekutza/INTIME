// @ts-check
import { button, el, icon } from "./ui.js";
import { normalizeHex, softTint, swatchInk } from "./colors.js";
import { AnchoredPopover } from "./popover.js";
const PALETTE = ["#847cce", "#4f72d8", "#367f91", "#418766", "#89a640", "#c4a02f", "#cc8741", "#c66456", "#b45584", "#8a60a3", "#667384", "#303139"];
/** @typedef {{label: string, getValue: () => string | null, getDefault: () => string, ready: () => boolean, save: (value: string | null) => Promise<void>, savedText?: string}} PickerOptions */

export class ColorPicker {
  /** @type {string | null} */
  draft = null;
  busy = false;
  /** @param {PickerOptions} options */
  constructor(options) {
    this.options = options;
    this.host = el("div", "color-picker");
    this.trigger = button("", "color-trigger", () => this.open());
    this.trigger.setAttribute("aria-label", options.label);
    this.trigger.setAttribute("aria-haspopup", "dialog");
    this.trigger.setAttribute("aria-expanded", "false");
    this.status = el("p", "color-picker__status"); this.status.setAttribute("role", "status");
    this.panel = el("div", "color-popover"); this.panel.popover = "auto";
    this.panel.setAttribute("role", "dialog"); this.panel.setAttribute("aria-label", options.label);
    this.host.append(this.trigger, this.status, this.panel);
    this.popup = new AnchoredPopover(this.trigger, this.panel);
    this.refresh();
  }

  refresh() {
    const color = this.options.getValue() || this.options.getDefault();
    this.trigger.replaceChildren();
    const dot = el("span", "color-dot"); dot.style.backgroundColor = color;
    this.trigger.append(dot, el("span", "", this.options.getValue() ? color.toUpperCase() : "Цвет по умолчанию"));
    this.trigger.disabled = !this.options.ready() || this.busy;
  }

  destroy() {
    this.popup.destroy();
    this.host.remove();
  }

  open() {
    if (this.busy || !this.options.ready()) return;
    this.draft = this.options.getValue();
    const initial = this.draft || this.options.getDefault();
    const heading = el("div", "section-heading");
    const close = button("", "icon-btn", () => { this.panel.hidePopover(); this.trigger.focus(); }); close.append(icon("close"));
    heading.append(el("strong", "", this.options.label), close);
    heading.lastElementChild?.setAttribute("aria-label", "Закрыть выбор цвета");
    const form = el("div", "color-form");
    const palette = el("div", "color-palette"); palette.setAttribute("role", "group"); palette.setAttribute("aria-label", "Готовые цвета");
    const hex = el("input", "color-hex"); hex.type = "text"; hex.value = initial.toUpperCase(); hex.maxLength = 64;
    hex.setAttribute("aria-label", "HEX-цвет"); hex.autocomplete = "off"; hex.spellcheck = false;
    const native = el("input", "color-native"); native.type = "color"; native.value = initial;
    native.setAttribute("aria-label", "Произвольный цвет");
    const preview = el("div", "color-preview", "Так будет выглядеть цветовой акцент");
    const valueText = el("p", "muted");
    const hint = el("p", "muted", "Выберите оттенок и нажмите «Применить цвет».");
    const error = el("p", "color-error"); error.setAttribute("role", "status");
    const apply = el("button", "btn btn-primary", "Применить цвет"); apply.type = "button";
    const update = () => {
      const effective = this.draft || this.options.getDefault();
      preview.style.borderColor = effective; preview.style.backgroundColor = softTint(effective);
      native.value = effective;
      valueText.textContent = effective.toUpperCase() + (this.draft === null ? " · наследуется" : " · индивидуальный выбор");
      palette.querySelectorAll("button").forEach(node => {
        const selected = this.draft === node.dataset.color;
        node.setAttribute("aria-pressed", String(selected)); node.textContent = selected ? "✓" : "";
      });
    };
    for (const color of PALETTE) {
      const swatch = button("", "color-swatch", () => { this.draft = color; hex.value = color.toUpperCase(); error.textContent = ""; hex.removeAttribute("aria-invalid"); apply.disabled = false; update(); });
      swatch.dataset.color = color; swatch.style.backgroundColor = color; swatch.style.color = swatchInk(color);
      swatch.setAttribute("aria-label", color.toUpperCase()); palette.append(swatch);
    }
    const changed = () => {
      const color = normalizeHex(hex.value);
      hex.setAttribute("aria-invalid", String(!color)); apply.disabled = !color;
      error.textContent = color ? "" : "Введите #RGB или #RRGGBB, например #4F72D8.";
      if (color) { this.draft = color; update(); }
    };
    hex.addEventListener("input", changed);
    native.addEventListener("input", () => { hex.value = native.value.toUpperCase(); changed(); });
    const reset = button("Использовать цвет по умолчанию", "inline-link", () => {
      this.draft = null; hex.value = this.options.getDefault().toUpperCase(); hex.removeAttribute("aria-invalid"); error.textContent = ""; apply.disabled = false; update();
    });
    const inputs = el("div", "color-inputs"); inputs.append(native, hex);
    form.append(palette, inputs, valueText, preview, reset, hint, error, apply);
    hex.addEventListener("keydown", event => {
      if (event.key === "Enter") { event.preventDefault(); event.stopPropagation(); apply.click(); }
    });
    apply.addEventListener("click", async event => {
      event.preventDefault(); if (this.busy || apply.disabled) return;
      this.busy = true; this.status.textContent = "Сохранение цвета…"; this.status.classList.remove("is-danger");
      for (const control of form.querySelectorAll("button, input")) if (control instanceof HTMLButtonElement || control instanceof HTMLInputElement) control.disabled = true;
      try {
        await this.options.save(this.draft);
        this.status.textContent = this.options.savedText || "Цвет сохранён на сервере";
        this.panel.hidePopover(); this.trigger.focus();
      } catch (reason) {
        error.textContent = reason instanceof Error ? reason.message : "Не удалось сохранить цвет.";
        this.status.textContent = error.textContent; this.status.classList.add("is-danger");
      } finally {
        this.busy = false; this.refresh();
        for (const control of form.querySelectorAll("button, input")) if (control instanceof HTMLButtonElement || control instanceof HTMLInputElement) control.disabled = false;
      }
    });
    this.panel.replaceChildren(heading, form); update(); this.popup.open();
    palette.querySelector("button")?.focus();
  }
}
