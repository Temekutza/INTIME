// @ts-check
import { requestJson, workspaceUrl } from "./api.js";
import { workspaceStore } from "./workspace.js";
/** @typedef {import('./types').EventType} EventType */
/** @typedef {import('./types').RitmEvent} RitmEvent */
/** @type {Readonly<Record<EventType, string>>} */
export const SYSTEM_COLORS = Object.freeze({ task: "#847cce", meeting: "#77a08d", reminder: "#b99a37" });
// Semantic priority tokens are independent of all user preferences.
export const PRIORITY_COLORS = Object.freeze({ urgent: "#be5766", important: "#b87937", medium: "#988229", low: "#648c75" });

/** @param {string} value @returns {string | null} */
export function normalizeHex(value) {
  const input = value.trim().toLowerCase();
  if (/^#[0-9a-f]{6}$/.test(input)) return input;
  if (/^#[0-9a-f]{3}$/.test(input)) return "#" + [...input.slice(1)].map(char => char + char).join("");
  return null;
}

/** @param {string} color */
export function swatchInk(color) {
  const safe = normalizeHex(color);
  if (!safe) throw new Error("Некорректный цвет");
  const channels = [1, 3, 5].map(index => parseInt(safe.slice(index, index + 2), 16) / 255)
    .map(value => value <= .04045 ? value / 12.92 : ((value + .055) / 1.055) ** 2.4);
  const luminance = channels[0] * .2126 + channels[1] * .7152 + channels[2] * .0722;
  return (luminance + .05) / .05 >= 1.05 / (luminance + .05) ? "#000000" : "#ffffff";
}

/** @param {string} color */
export function softTint(color) {
  const safe = normalizeHex(color);
  if (!safe) throw new Error("Некорректный цвет");
  return "#" + [1, 3, 5].map(index => Math.round(255 * .92 + parseInt(safe.slice(index, index + 2), 16) * .08).toString(16).padStart(2, "0")).join("");
}

/** @param {unknown} data @returns {data is {defaults: Record<EventType, string | null>, overrides: Record<string, string>}} */
export function isColorSnapshot(data) {
  if (typeof data !== "object" || data === null || !("defaults" in data) || !("overrides" in data)) return false;
  const defaults = data.defaults, overrides = data.overrides;
  if (typeof defaults !== "object" || defaults === null || typeof overrides !== "object" || overrides === null || Array.isArray(overrides)) return false;
  return Object.keys(SYSTEM_COLORS).every(type => {
    /** @type {unknown} */
    const value = Reflect.get(defaults, type);
    return type in defaults && (value === null || typeof value === "string" && /^#[0-9a-f]{6}$/i.test(value));
  }) &&
    Object.entries(overrides).every(([id, color]) => /^[1-9]\d*$/.test(id) && typeof color === "string" && /^#[0-9a-f]{6}$/i.test(color));
}

export class ColorStore extends EventTarget {
  /** @type {Record<EventType, string | null>} */
  defaults = { task: null, meeting: null, reminder: null };
  /** @type {Record<string, string>} */
  overrides = {};
  /** Draft for creation, never a saved inherited override. @type {string | null} */
  creationColor = null;
  /** @type {EventType} */
  creationType = "task";
  loaded = false;
  error = "";
  busy = false;
  revision = 0;
  /** @type {Promise<void> | null} */
  flight = null;
  reloadAfterFlight = false;
  changed() { this.dispatchEvent(new Event("change")); }
  /** @param {EventType} type */
  defaultColor(type) { return this.defaults[type] || SYSTEM_COLORS[type]; }
  /** @param {Pick<RitmEvent, 'id' | 'type'>} event */
  resolve(event) { return this.overrides[String(event.id)] || this.defaultColor(event.type); }

  async load(invalidate = false) {
    if (invalidate) this.revision += 1;
    if (this.flight) { if (invalidate) this.reloadAfterFlight = true; return this.flight; }
    const revision = this.revision;
    this.flight = (async () => {
      try {
        const data = await requestJson("/api/colors");
        if (!isColorSnapshot(data)) throw new Error("Некорректный ответ настроек цвета.");
        if (revision !== this.revision) return;
        this.defaults = data.defaults; this.overrides = data.overrides;
        this.loaded = true; this.error = "";
      } catch (error) { this.error = error instanceof Error ? error.message : "Не удалось загрузить цвета."; }
      finally { this.flight = null; this.changed(); }
    })();
    await this.flight;
    if (this.reloadAfterFlight) { this.reloadAfterFlight = false; await this.load(); }
  }

  /** @param {EventType | number} target @param {string | null} color */
  async save(target, color) {
    if (this.busy) throw new Error("Дождитесь сохранения цвета.");
    if (color !== null && !/^#[0-9a-f]{6}$/i.test(color)) throw new Error("Введите HEX в формате #RRGGBB.");
    if (color !== null) color = color.toLowerCase();
    this.busy = true; this.revision += 1; this.changed();
    try {
      const object = typeof target === "number";
      const url = object ? workspaceUrl(`/api/events/${target}/color`, workspaceStore.currentId) : `/api/colors/defaults/${target}`;
      const result = await requestJson(url, { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ color }) });
      if (typeof result !== "object" || result === null || !("color" in result) || result.color !== color ||
        (object ? !("event_id" in result) || result.event_id !== target : !("type" in result) || result.type !== target)) throw new Error("Некорректное подтверждение цвета.");
      if (typeof target === "number") {
        if (color === null) delete this.overrides[String(target)]; else this.overrides[String(target)] = color;
      } else this.defaults[target] = color;
      this.error = "";
    } catch (error) {
      this.error = error instanceof Error ? error.message : "Не удалось сохранить цвет.";
      throw error;
    } finally { this.revision += 1; this.busy = false; this.changed(); }
  }
}
export const colorStore = new ColorStore();

/** @param {HTMLElement} node @param {Pick<RitmEvent, 'id' | 'type'>} event */
export function paintObject(node, event) {
  const color = normalizeHex(colorStore.resolve(event)) || SYSTEM_COLORS[event.type];
  node.style.setProperty("--object-color", color);
  node.style.setProperty("--object-tint", softTint(color));
}
