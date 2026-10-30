// @ts-check
/** @template {keyof HTMLElementTagNameMap} K @param {K} tag @param {string} [className] @param {string} [text] */
export function el(tag, className = "", text = "") {
  const node = document.createElement(tag);
  node.className = className;
  node.textContent = text;
  return node;
}

/** Runtime narrowing instead of unchecked DOM assertions. @param {string} id */
export function element(id) {
  const node = document.getElementById(id);
  if (!(node instanceof HTMLElement)) throw new Error(`Missing element: ${id}`);
  return node;
}
/** @param {string} id */
export function input(id) {
  const node = element(id);
  if (!(node instanceof HTMLInputElement)) throw new Error(`Missing input: ${id}`);
  return node;
}
/** @param {string} id */
export function select(id) {
  const node = element(id);
  if (!(node instanceof HTMLSelectElement)) throw new Error(`Missing select: ${id}`);
  return node;
}

/** One small outline icon set, rendered from static paths only. */
/** @type {Record<string, string>} */
const paths = {
  plus: '<path d="M12 5v14M5 12h14"/>',
  close: '<path d="m6 6 12 12M6 18 18 6"/>',
  search: '<circle cx="10.5" cy="10.5" r="6.5"/><path d="m16 16 4 4"/>',
  calendar: '<rect x="3" y="5" width="18" height="16" rx="2"/><path d="M7 3v4M17 3v4M3 11h18M7 15h2M13 15h2"/>',
  bell: '<path d="M18 8a6 6 0 0 0-12 0c0 7-3 7-3 9h18c0-2-3-2-3-9M10 21h4"/>',
  check: '<rect x="3" y="3" width="18" height="18" rx="2"/><path d="m7 12 3 3 7-7"/>',
  panel: '<rect x="3" y="4" width="18" height="16" rx="1"/><path d="M15 4v16m-4-12-4 4 4 4"/>',
  cloud: '<path d="M6 17a5 5 0 0 1-1-10 7 7 0 0 1 13-1 5 5 0 0 1 1 10M9 18l3 3 5-6"/>',
  sort: '<path d="M4 5h15M4 10h11M4 15h7m4 0 3 4 3-4m-3-8v12"/>',
  sparkles: '<path d="m12 3 2.5 6.5L21 12l-6.5 2.5L12 21l-2.5-6.5L3 12l6.5-2.5L12 3ZM20 2v4m-2-2h4"/>',
  time: '<circle cx="12" cy="12" r="9"/><path d="M12 6v6l4 2"/>',
  paperclip: '<path d="m9 15 7-7a3 3 0 0 0-4-4l-8 8a5 5 0 0 0 7 7l9-9M8 14l7-7"/>',
};

/** @param {string} name */
export function icon(name) {
  const holder = el("span", "icon");
  const path = paths[name] || paths.calendar;
  holder.innerHTML = `<svg viewBox="0 0 24 24" width="17" height="17" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${path}</svg>`;
  return holder;
}

/** @param {string} text @param {string} className @param {() => void} action */
export function button(text, className, action) {
  const node = el("button", className, text);
  node.type = "button";
  node.addEventListener("click", action);
  return node;
}

/** @param {string} text */
export function empty(text) {
  const box = el("div", "empty-state");
  box.append(icon("calendar"), el("p", "", text));
  return box;
}
