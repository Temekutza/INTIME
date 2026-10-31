// @ts-check
import { el, element } from "./ui.js";
import { colorStore } from "./colors.js";

const QUERY = "(max-width: 1024px)";
const INERT_IDS = ["header", "workspace-main", "day-panel", "mobile-tabbar", "mobile-scrim", "account-menu", "create-sheet"];

/** @type {boolean} */
let assistantOpen = false;
/** @type {boolean} */
let shellReady = false;
/** @type {{ records: number, grid: number } | null} */
let scrollSnapshot = null;
/** @type {ScrollRestoration | null} */
let previousRestoration = null;
/** @type {() => void} */
let closeTransient = () => {};

export function isMobileViewport() {
  return window.matchMedia(QUERY).matches;
}

export function isMobileAssistantOpen() {
  return assistantOpen;
}

/** @param {boolean} on */
function setInert(on) {
  for (const id of INERT_IDS) {
    const node = document.getElementById(id);
    if (!node) continue;
    if (on) node.setAttribute("inert", "");
    else node.removeAttribute("inert");
  }
}

/** @param {number} height @param {number} top @param {number} inset */
function applyViewportBox(height, top, inset) {
  const root = document.documentElement;
  root.style.setProperty("--vv-height", `${Math.max(0, Math.round(height))}px`);
  root.style.setProperty("--vv-top", `${Math.max(0, Math.round(top))}px`);
  root.style.setProperty("--keyboard-inset", `${Math.max(0, Math.round(inset))}px`);
  root.classList.toggle("keyboard-open", inset > 80);
}

function syncFromVisualViewport() {
  const viewport = window.visualViewport;
  if (!viewport) return;
  const inset = Math.max(0, window.innerHeight - viewport.height - viewport.offsetTop);
  applyViewportBox(viewport.height, viewport.offsetTop, inset);
}

function focusComposer() {
  const input = document.getElementById("message-input");
  if (input instanceof HTMLElement) input.focus({ preventScroll: true });
}

function captureScroll() {
  const records = document.getElementById("records");
  const grid = document.getElementById("content-grid");
  scrollSnapshot = {
    records: records instanceof HTMLElement ? records.scrollTop : 0,
    grid: grid instanceof HTMLElement ? grid.scrollTop : 0,
  };
}

function restoreScroll() {
  const snapshot = scrollSnapshot;
  if (!snapshot) return;
  const apply = () => {
    const records = document.getElementById("records");
    const grid = document.getElementById("content-grid");
    if (records instanceof HTMLElement) records.scrollTop = snapshot.records;
    if (grid instanceof HTMLElement) grid.scrollTop = snapshot.grid;
  };
  apply();
  requestAnimationFrame(apply);
}

/** @param {boolean} open @param {{ deferInert?: boolean }} [options] */
function paintAssistant(open, options = {}) {
  const mobile = isMobileViewport();
  const show = mobile && open;
  const panel = element("assistant-panel");
  if (!show) setInert(false);
  document.documentElement.classList.toggle("ai-open", show);
  panel.classList.toggle("is-open", show);
  panel.classList.remove("sheet-peek", "sheet-expanded", "sheet-full");
  document.documentElement.classList.remove("sheet-peek", "sheet-expanded", "sheet-full");
  if (show) {
    panel.hidden = false;
    panel.setAttribute("role", "dialog");
    panel.setAttribute("aria-modal", "true");
  } else if (mobile) {
    panel.hidden = true;
    panel.removeAttribute("role");
    panel.removeAttribute("aria-modal");
  }
  const opener = document.getElementById("mobile-ai-open");
  if (opener) opener.setAttribute("aria-expanded", String(show));
  if (show && !options.deferInert) setInert(true);
}

/** @param {{ focus?: boolean, fromHistory?: boolean }} [options] */
export function openMobileAssistant(options = {}) {
  if (!isMobileViewport()) return false;
  const focus = options.focus !== false;
  if (assistantOpen) {
    if (focus) focusComposer();
    return true;
  }
  closeTransient();
  document.documentElement.classList.remove("is-search-open", "is-day-open");
  captureScroll();
  assistantOpen = true;
  if (previousRestoration === null && "scrollRestoration" in history) {
    previousRestoration = history.scrollRestoration;
    history.scrollRestoration = "manual";
  }
  const openedAt = performance.now();
  try { performance.mark("intime-ai-open-start"); } catch { /* measurement is optional */ }
  // Shell first. Inert and focus run after the first paint so a long history
  // does not block the composer from appearing.
  paintAssistant(true, { deferInert: true });
  try {
    performance.mark("intime-ai-shell");
    performance.measure("intime-ai-shell", "intime-ai-open-start", "intime-ai-shell");
  } catch { /* measurement is optional */ }
  requestAnimationFrame(() => {
    requestAnimationFrame(() => {
      if (!assistantOpen) return;
      setInert(true);
      if (focus) focusComposer();
      try {
        performance.mark("intime-ai-ready");
        performance.measure("intime-ai-open", { start: openedAt, end: performance.now() });
      } catch { /* measurement is optional */ }
    });
  });
  if (!options.fromHistory) {
    try { history.pushState({ ritmAi: 1 }, ""); } catch { /* history is optional */ }
  }
  return true;
}

/** @param {{ focus?: boolean, fromHistory?: boolean }} [options] */
export function closeMobileAssistant(options = {}) {
  if (!assistantOpen) return false;
  const focus = options.focus !== false;
  assistantOpen = false;
  paintAssistant(false);
  restoreScroll();
  if (previousRestoration !== null && "scrollRestoration" in history) {
    history.scrollRestoration = previousRestoration;
    previousRestoration = null;
  }
  window.dispatchEvent(new Event("ritm:assistant-hidden"));
  if (!options.fromHistory && history.state?.ritmAi) {
    try { history.back(); } catch { /* history is optional */ }
  }
  if (focus) {
    const opener = document.getElementById("mobile-ai-open");
    if (opener instanceof HTMLElement) opener.focus({ preventScroll: true });
  }
  return true;
}

function applyShell() {
  const mobile = isMobileViewport();
  document.documentElement.classList.toggle("is-mobile", mobile);
  const panel = element("assistant-panel");
  const input = element("message-input");
  if (input instanceof HTMLTextAreaElement) {
    input.placeholder = mobile ? "Напишите или расскажите…" : "Напишите, что нужно сделать…";
  }
  if (!mobile && assistantOpen) {
    assistantOpen = false;
    if (history.state?.ritmAi) {
      try { history.replaceState(null, ""); } catch { /* history is optional */ }
    }
    if (previousRestoration !== null && "scrollRestoration" in history) {
      history.scrollRestoration = previousRestoration;
      previousRestoration = null;
    }
  }
  if (mobile) {
    paintAssistant(assistantOpen);
    return;
  }
  document.documentElement.classList.remove("ai-open");
  panel.classList.remove("is-open", "sheet-peek", "sheet-expanded", "sheet-full");
  document.documentElement.classList.remove("sheet-peek", "sheet-expanded", "sheet-full");
  panel.removeAttribute("role");
  panel.removeAttribute("aria-modal");
  setInert(false);
  const opener = document.getElementById("mobile-ai-open");
  if (opener) opener.setAttribute("aria-expanded", "false");
  let closed = false;
  try { closed = localStorage.getItem("ritm.assistant-hidden") === "true"; } catch { /* preference optional */ }
  panel.hidden = closed;
  element("layout").classList.toggle("assistant-hidden", closed);
}

/** @param {HTMLElement} panel */
function focusables(panel) {
  return [...panel.querySelectorAll("button, a, input, textarea, select")].filter(node => {
    if (!(node instanceof HTMLElement)) return false;
    if (node.closest("[hidden]")) return false;
    if (node instanceof HTMLButtonElement && node.disabled) return false;
    if (node.tabIndex < 0) return false;
    const style = getComputedStyle(node);
    return style.display !== "none" && style.visibility !== "hidden";
  });
}

/** @param {{ onCreate: (type: "task" | "meeting" | "reminder") => void }} options */
export function setupMobileShell(options) {
  if (shellReady) return;
  shellReady = true;
  document.documentElement.dataset.mobileShell = "ready";

  const scrim = document.getElementById("mobile-scrim");
  const createSheet = document.getElementById("create-sheet");
  const accountMenu = document.getElementById("account-menu");
  const closeMenus = () => {
    if (createSheet) createSheet.hidden = true;
    if (accountMenu) accountMenu.hidden = true;
    if (scrim) scrim.hidden = true;
    document.documentElement.classList.remove("is-day-open");
  };
  closeTransient = closeMenus;
  const openLayer = (/** @type {HTMLElement | null} */ node) => {
    const willOpen = Boolean(node?.hidden);
    if (createSheet) createSheet.hidden = true;
    if (accountMenu) accountMenu.hidden = true;
    document.documentElement.classList.remove("is-day-open");
    if (node && willOpen) node.hidden = false;
    if (scrim) scrim.hidden = !willOpen;
    const focusTarget = node?.querySelector("button");
    if (willOpen && focusTarget instanceof HTMLElement) focusTarget.focus();
  };

  document.getElementById("mobile-ai-open")?.addEventListener("click", () => {
    if (assistantOpen) closeMobileAssistant({ focus: true });
    else openMobileAssistant({ focus: true });
  });
  document.getElementById("assistant-back")?.addEventListener("click", () => closeMobileAssistant({ focus: true }));

  document.getElementById("mobile-search-open")?.addEventListener("click", () => {
    document.documentElement.classList.add("is-search-open");
    const input = element("search-input");
    if (input instanceof HTMLInputElement) input.focus();
  });
  document.getElementById("mobile-create")?.addEventListener("click", () => openLayer(createSheet));
  document.getElementById("mobile-account")?.addEventListener("click", () => openLayer(accountMenu));
  scrim?.addEventListener("click", closeMenus);
  createSheet?.addEventListener("click", event => {
    const target = event.target instanceof Element ? event.target.closest("[data-create]") : null;
    if (!(target instanceof HTMLElement)) return;
    const type = target.dataset.create;
    closeMenus();
    if (type === "task" || type === "meeting" || type === "reminder") options.onCreate(type);
  });
  document.getElementById("account-colors")?.addEventListener("click", () => {
    closeMenus();
    element("color-settings-button").click();
  });
  document.getElementById("account-day")?.addEventListener("click", () => {
    if (accountMenu) accountMenu.hidden = true;
    document.documentElement.classList.add("is-day-open");
    if (scrim) scrim.hidden = false;
    const dayButton = element("day-panel").querySelector("button");
    if (dayButton instanceof HTMLElement) dayButton.focus();
  });
  document.getElementById("day-sheet-close")?.addEventListener("click", closeMenus);

  const records = element("records");
  let originX = 0;
  let originY = 0;
  let stripGesture = false;
  records.addEventListener("pointerdown", event => {
    if (!(event.target instanceof Element) || !event.target.closest(".week-strip")) return;
    originX = event.clientX;
    originY = event.clientY;
    stripGesture = true;
  });
  records.addEventListener("pointerup", event => {
    if (!stripGesture) return;
    stripGesture = false;
    const dx = event.clientX - originX;
    const dy = event.clientY - originY;
    if (Math.abs(dx) < 56 || Math.abs(dx) < Math.abs(dy)) return;
    element(dx < 0 ? "calendar-next" : "calendar-prev").click();
  });

  const quick = document.querySelector(".quick-section");
  quick?.addEventListener("toggle", () => { if (quick instanceof HTMLDetailsElement) quick.dataset.userToggled = "1"; });
  if (quick instanceof HTMLDetailsElement && isMobileViewport() && !quick.dataset.userToggled) quick.open = false;

  const viewport = window.visualViewport;
  const onViewport = () => syncFromVisualViewport();
  if (viewport) {
    viewport.addEventListener("resize", onViewport);
    viewport.addEventListener("scroll", onViewport);
    syncFromVisualViewport();
  }
  /** @param {Event} event */
  const onKeyboardMetrics = event => {
    if (!(event instanceof CustomEvent) || !event.detail || typeof event.detail !== "object") return;
    const detail = /** @type {{ inset?: number, height?: number, top?: number }} */ (event.detail);
    const inset = Number(detail.inset) || 0;
    const height = Number(detail.height) || window.innerHeight - inset;
    const top = Number(detail.top) || 0;
    applyViewportBox(height, top, inset);
  };
  window.addEventListener("ritm:keyboard-metrics", onKeyboardMetrics);
  window.addEventListener("pagehide", () => {
    viewport?.removeEventListener("resize", onViewport);
    viewport?.removeEventListener("scroll", onViewport);
    window.removeEventListener("ritm:keyboard-metrics", onKeyboardMetrics);
  }, { once: true });

  document.addEventListener("keydown", event => {
    if (!isMobileViewport()) return;
    if (assistantOpen && event.key === "Tab") {
      const items = focusables(element("assistant-panel"));
      if (!items.length) return;
      const first = items[0];
      const last = items[items.length - 1];
      const active = document.activeElement;
      const inside = active instanceof Node && element("assistant-panel").contains(active);
      if (event.shiftKey && (active === first || !inside)) {
        event.preventDefault();
        if (last instanceof HTMLElement) last.focus();
      } else if (!event.shiftKey && (active === last || !inside)) {
        event.preventDefault();
        if (first instanceof HTMLElement) first.focus();
      }
      return;
    }
    if (event.key !== "Escape" || document.querySelector("dialog[open]")) return;
    const menu = document.getElementById("menu");
    if (menu && !menu.hidden) return;
    const speechStop = document.getElementById("speech-stop");
    if (speechStop && !speechStop.hidden) return;
    if ((createSheet && !createSheet.hidden) || (accountMenu && !accountMenu.hidden) || document.documentElement.classList.contains("is-day-open")) {
      closeMenus();
      return;
    }
    if (document.documentElement.classList.contains("is-search-open")) {
      document.documentElement.classList.remove("is-search-open");
      return;
    }
    if (assistantOpen) {
      event.preventDefault();
      closeMobileAssistant({ focus: true });
    }
  });

  window.addEventListener("popstate", () => {
    if (!isMobileViewport()) return;
    const wantOpen = Boolean(history.state?.ritmAi);
    if (wantOpen) openMobileAssistant({ fromHistory: true, focus: true });
    else if (assistantOpen) closeMobileAssistant({ fromHistory: true, focus: true });
  });

  applyShell();
  window.matchMedia(QUERY).addEventListener("change", () => {
    applyShell();
    const quickSection = document.querySelector(".quick-section");
    if (quickSection instanceof HTMLDetailsElement && isMobileViewport() && !quickSection.dataset.userToggled) quickSection.open = false;
    window.dispatchEvent(new Event("ritm:viewport-mode"));
  });
}

/** @param {HTMLElement} host */
export function renderTypeLegend(host) {
  host.replaceChildren();
  for (const [type, label] of /** @type {const} */ ([["task", "Задачи"], ["meeting", "Встречи"], ["reminder", "Напоминания"]])) {
    const item = el("span", "type-legend__item", label);
    item.style.setProperty("--legend-color", colorStore.defaultColor(type));
    host.append(item);
  }
}

/** @param {string} name */
export function initials(name) {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  if (!parts.length) return "•";
  return parts.slice(0, 2).map(part => part[0] || "").join("").toUpperCase();
}
