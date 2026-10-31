// @ts-check
import { colorStore, SYSTEM_COLORS } from "./colors.js";
import { ColorPicker } from "./color-picker.js";
import { button, el, element, icon } from "./ui.js";

export function setupColorSettings() {
  const dialog = el("dialog", "color-settings"); dialog.setAttribute("aria-labelledby", "colors-title");
  const header = el("div", "section-heading");
  const title = el("h2", "", "Цвета объектов"); title.id = "colors-title";
  const close = button("", "icon-btn", () => dialog.close()); close.append(icon("close")); close.setAttribute("aria-label", "Закрыть настройки цветов");
  header.append(title, close);
  dialog.append(header, el("p", "capability-note", "Настройки общего локального профиля на этом сервере. Цвет типа применяется ко всем объектам без индивидуальной настройки."));
  const status = el("p", "color-settings__status"); status.setAttribute("role", "status");
  const retry = button("Повторить загрузку цветов", "inline-link", () => { void colorStore.load(); });
  const rows = el("div", "color-settings__rows");
  const labels = { task: "Задачи", meeting: "Встречи", reminder: "Напоминания" };
  /** @type {ColorPicker[]} */
  const pickers = [];
  for (const type of /** @type {const} */ (["task", "meeting", "reminder"])) {
    const row = el("section", "color-settings__row");
    const picker = new ColorPicker({ label: "Стандартный цвет: " + labels[type],
      getValue: () => colorStore.defaults[type], getDefault: () => SYSTEM_COLORS[type],
      ready: () => colorStore.loaded && !colorStore.busy, save: color => colorStore.save(type, color) });
    row.append(el("h3", "", labels[type]), picker.host); rows.append(row); pickers.push(picker);
  }
  dialog.append(status, retry, rows, el("p", "capability-note", "Календарь использует цвета задач, встреч и напоминаний. Отдельные события календаря, категории и пространства пока не поддерживаются. Цвет объекта не меняет его приоритет."));
  document.body.append(dialog);
  element("color-settings-button").addEventListener("click", () => { if (!dialog.open) dialog.showModal(); });
  dialog.addEventListener("click", event => { if (event.target === dialog) {
    const bounds = dialog.getBoundingClientRect();
    if (event.clientX < bounds.left || event.clientX > bounds.right || event.clientY < bounds.top || event.clientY > bounds.bottom) dialog.close();
  } });
  const refresh = () => {
    status.textContent = colorStore.error || (colorStore.loaded ? "Настройки загружены с сервера" : "Загрузка цветов…");
    status.classList.toggle("is-danger", Boolean(colorStore.error)); retry.hidden = !colorStore.error;
    for (const picker of pickers) picker.refresh();
  };
  colorStore.addEventListener("change", refresh); refresh();
}
