// @ts-check
import { element } from "./ui.js";

/** Explicit independent state for the two optional columns. */
export function setupDayPanel() {
  const layout = element("layout"), panel = element("day-panel"), open = element("day-open");
  const toggle = (/** @type {boolean} */ hidden, focus = true) => {
    panel.hidden = hidden;
    layout.classList.toggle("day-hidden", hidden);
    open.setAttribute("aria-expanded", String(!hidden));
    open.setAttribute("aria-label", hidden ? "Показать Мой день" : "Скрыть Мой день");
    open.title = hidden ? "Показать Мой день" : "Скрыть Мой день";
    try { localStorage.setItem("ritm.day-hidden", String(hidden)); } catch { /* preference optional */ }
    if (focus) open.focus();
  };
  open.addEventListener("click", () => toggle(!panel.hidden));
  try { toggle(localStorage.getItem("ritm.day-hidden") === "true", false); } catch { /* storage optional */ }
}
