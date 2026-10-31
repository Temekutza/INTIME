// @ts-check
import { element } from "./ui.js";

/** Explicit independent state for the two optional columns. */
export function setupDayPanel() {
  const layout = element("layout"), panel = element("day-panel"), close = element("day-close"), open = element("day-open");
  const toggle = (/** @type {boolean} */ hidden, focus = true) => {
    panel.hidden = hidden; open.hidden = !hidden;
    layout.classList.toggle("day-hidden", hidden);
    close.setAttribute("aria-expanded", String(!hidden)); open.setAttribute("aria-expanded", String(!hidden));
    try { localStorage.setItem("ritm.day-hidden", String(hidden)); } catch { /* preference optional */ }
    if (focus) (hidden ? open : close).focus();
  };
  close.addEventListener("click", () => toggle(true)); open.addEventListener("click", () => toggle(false));
  try { toggle(localStorage.getItem("ritm.day-hidden") === "true", false); } catch { /* storage optional */ }
}
