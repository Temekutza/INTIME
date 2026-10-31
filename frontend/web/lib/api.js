// @ts-check
import { dayDate, isoDay } from "./model.js";
/** @typedef {import('./types').RitmEvent} RitmEvent */
/** @typedef {import('./types').Workspace} Workspace */

/** @param {unknown} value @returns {value is Record<string, unknown>} */
function record(value) { return typeof value === "object" && value !== null; }

/** @param {unknown} value @returns {value is RitmEvent} */
export function isEvent(value) {
  if (!record(value)) return false;
  return Number.isSafeInteger(value.id) && typeof value.title === "string" &&
    ["task", "meeting", "reminder"].includes(String(value.type)) &&
    ["planned", "done"].includes(String(value.status)) &&
    (value.date === null || (typeof value.date === "string" && /^\d{4}-\d{2}-\d{2}$/.test(value.date) && isoDay(dayDate(value.date)) === value.date)) &&
    (value.time === null || (typeof value.time === "string" && /^([01]\d|2[0-3]):[0-5]\d(:[0-5]\d)?$/.test(value.time))) &&
    (value.duration_min === null || typeof value.duration_min === "number") &&
    typeof value.is_deadline === "boolean" &&
    ["user", "archive"].includes(String(value.source)) &&
    (value.source_ref === null || typeof value.source_ref === "string") &&
    typeof value.created_at === "string" && typeof value.updated_at === "string" &&
    (value.deleted_at === null || typeof value.deleted_at === "string");
}

/** @param {string} url @param {RequestInit} [options] @returns {Promise<unknown>} */
export async function requestJson(url, options = {}) {
  const timeout = AbortSignal.timeout(15000);
  const signal = options.signal ? AbortSignal.any([timeout, options.signal]) : timeout;
  let response;
  try { response = await fetch(url, { ...options, signal }); }
  catch (error) {
    if (options.signal?.aborted) throw error;
    throw new Error(signal.aborted ? "Сервер не ответил вовремя. Повторите попытку." : "Не удалось связаться с сервером. Проверьте соединение.");
  }
  if (!response.ok) {
    let detail = "";
    try {
      const body = await response.json();
      if (record(body) && typeof body.detail === "string") detail = body.detail;
    } catch { /* ответ не JSON */ }
    if (response.status === 401 || response.status === 403) throw new Error("Нет доступа к данным.");
    if (response.status === 404) throw new Error("Запись уже удалена. Обновите список.");
    if (response.status === 409) throw new Error(detail || "Конфликт данных. Обновите список.");
    throw new Error(detail || `Сервер не выполнил запрос (${response.status}). Повторите попытку.`);
  }
  return response.json();
}

/** @param {string} url @param {Record<string, string | number | null | undefined>} params */
function withQuery(url, params) {
  const search = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value == null || value === "") continue;
    search.set(key, String(value));
  }
  const query = search.toString();
  return query ? `${url}?${query}` : url;
}

/** @param {unknown} value @returns {value is Workspace} */
export function isWorkspace(value) {
  return record(value) && Number.isSafeInteger(value.id) && typeof value.name === "string" && typeof value.is_default === "boolean";
}

/** @param {AbortSignal} [signal] @returns {Promise<Workspace[]>} */
export async function listWorkspaces(signal) {
  const data = await requestJson("/api/workspaces", { signal });
  if (!record(data) || !Array.isArray(data.workspaces) || !data.workspaces.every(isWorkspace)) {
    throw new Error("Неожиданный формат списка пространств.");
  }
  return data.workspaces;
}

/** @param {string} name */
export async function createWorkspace(name) {
  const data = await requestJson("/api/workspaces", {
    method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ name }),
  });
  if (!isWorkspace(data)) throw new Error("Неожиданный формат пространства.");
  return data;
}

/** @param {AbortSignal} [signal] @param {number | null} [workspaceId] @returns {Promise<RitmEvent[]>} */
export async function listEvents(signal, workspaceId) {
  const data = await requestJson(withQuery("/api/events", { workspace_id: workspaceId }), { signal });
  if (!record(data) || !Array.isArray(data.events) || !data.events.every(isEvent)) throw new Error("Неожиданный формат списка записей.");
  return data.events;
}

/** @param {number} id @param {import('./types').EventPatch} patch */
export async function patchEvent(id, patch) {
  const data = await requestJson(`/api/events/${id}`, {
    method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify(patch),
  });
  if (!isEvent(data)) throw new Error("Неожиданный формат сохранённой записи.");
  return data;
}

/** @param {string} query @param {AbortSignal} signal @param {number | null} [workspaceId] @returns {Promise<RitmEvent[]>} */
export async function searchEvents(query, signal, workspaceId) {
  const data = await requestJson(withQuery("/api/search", { q: query, limit: 20, workspace_id: workspaceId }), { signal });
  if (!record(data) || !Array.isArray(data.hits)) throw new Error("Неожиданный формат результатов поиска.");
  return data.hits.map((/** @type {unknown} */ hit) => {
    if (!record(hit) || !isEvent(hit.event)) throw new Error("Неожиданный формат найденной записи.");
    return hit.event;
  });
}
