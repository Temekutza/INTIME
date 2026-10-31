// @ts-check
import { iconPaths } from "./icon-paths.js";
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

/** SVG paths are vendored from Lucide; all controls use one stroke-based set. */
/** @param {string} name */
export function icon(name) {
  const holder = el("span", "icon");
  const path = iconPaths[name] || iconPaths.calendar;
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
