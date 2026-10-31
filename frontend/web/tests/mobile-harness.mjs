/**
 * QA-only static server with an in-memory API.
 * It is not a production backend and is not wired into the app.
 */
import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const port = Number(process.env.AIVRITM_MOBILE_PORT || 8791);

function iso(date) {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
}
function shift(days) {
  const date = new Date();
  date.setHours(12, 0, 0, 0);
  date.setDate(date.getDate() + days);
  return iso(date);
}
const now = new Date().toISOString();
let nextId = 20;
/** @type {Array<Record<string, unknown>>} */
let events = [
  { id: 1, type: "meeting", title: "Какая то встреча", date: shift(0), time: "11:00:00", duration_min: 60, is_deadline: false, status: "planned", source: "user", source_ref: "Google Meet · 4 участника", created_at: now, updated_at: now, deleted_at: null },
  { id: 2, type: "meeting", title: "Встреча 2", date: shift(0), time: "14:00:00", duration_min: 60, is_deadline: false, status: "planned", source: "user", source_ref: "Переговорная «Север»", created_at: now, updated_at: now, deleted_at: null },
  { id: 3, type: "meeting", title: "Встреча 3", date: shift(0), time: "16:00:00", duration_min: 45, is_deadline: false, status: "planned", source: "user", source_ref: "Google Meet · 3 участника", created_at: now, updated_at: now, deleted_at: null },
  { id: 4, type: "task", title: "Название задачи", date: shift(1), time: "16:00:00", duration_min: null, is_deadline: true, status: "planned", source: "user", source_ref: "Описание задачи", created_at: now, updated_at: now, deleted_at: null },
  { id: 5, type: "task", title: "Название задачи", date: shift(1), time: "18:00:00", duration_min: null, is_deadline: false, status: "planned", source: "user", source_ref: "Описание задачи", created_at: now, updated_at: now, deleted_at: null },
  { id: 6, type: "task", title: "Название задачи", date: shift(3), time: "12:00:00", duration_min: null, is_deadline: false, status: "planned", source: "user", source_ref: "Описание задачи", created_at: now, updated_at: now, deleted_at: null },
  { id: 7, type: "task", title: "Название задачи", date: shift(0), time: "18:10:00", duration_min: null, is_deadline: true, status: "planned", source: "user", source_ref: null, created_at: now, updated_at: now, deleted_at: null },
  { id: 8, type: "task", title: "Название задачи", date: shift(1), time: "12:20:00", duration_min: null, is_deadline: false, status: "planned", source: "user", source_ref: null, created_at: now, updated_at: now, deleted_at: null },
  { id: 9, type: "task", title: "Название задачи", date: shift(2), time: "14:00:00", duration_min: null, is_deadline: false, status: "planned", source: "user", source_ref: null, created_at: now, updated_at: now, deleted_at: null },
  { id: 10, type: "task", title: "Название задачи", date: shift(-1), time: "09:20:00", duration_min: null, is_deadline: false, status: "done", source: "user", source_ref: null, created_at: now, updated_at: now, deleted_at: null },
  { id: 11, type: "task", title: "Название задачи", date: shift(-1), time: "09:45:00", duration_min: null, is_deadline: false, status: "done", source: "user", source_ref: null, created_at: now, updated_at: now, deleted_at: null },
  { id: 12, type: "reminder", title: "Название", date: shift(0), time: "18:35:00", duration_min: null, is_deadline: true, status: "planned", source: "user", source_ref: null, created_at: now, updated_at: now, deleted_at: null },
  { id: 13, type: "reminder", title: "Название", date: shift(0), time: "19:20:00", duration_min: null, is_deadline: true, status: "planned", source: "user", source_ref: null, created_at: now, updated_at: now, deleted_at: null },
  { id: 14, type: "reminder", title: "Задача 1", date: shift(0), time: "20:00:00", duration_min: null, is_deadline: true, status: "planned", source: "user", source_ref: null, created_at: now, updated_at: now, deleted_at: null },
];
for (let index = 0; index < 16; index += 1) {
  events.push({
    id: 100 + index, type: "task", title: `Прокрутка задачи ${index + 1}`, date: shift((index % 6) - 1),
    time: "10:00:00", duration_min: null, is_deadline: false, status: "planned", source: "user", source_ref: null,
    created_at: now, updated_at: now, deleted_at: null,
  });
}
for (let index = 0; index < 12; index += 1) {
  events.push({
    id: 200 + index, type: "reminder", title: `Прокрутка напоминания ${index + 1}`, date: shift(index + 1),
    time: "09:30:00", duration_min: null, is_deadline: false, status: "planned", source: "user", source_ref: null,
    created_at: now, updated_at: now, deleted_at: null,
  });
}
const colors = {
  defaults: { task: null, meeting: null, reminder: null },
  overrides: { 1: "#847cce", 2: "#77a08d", 3: "#b9a06a", 4: "#e7b089", 5: "#8fbf9b", 6: "#e6d27a", 7: "#e7a0a8", 8: "#e6d27a", 9: "#e7b089", 10: "#e7b089", 11: "#8fbf9b", 12: "#e7a0a8", 13: "#e6d27a", 14: "#e7b089" },
};
const workspaces = [
  { id: 1, name: "Общее пространство", is_default: true },
  { id: 2, name: "Команда", is_default: false },
];
/** @type {Record<string, unknown> | null} */
let pendingProposal = null;

function send(res, status, body) {
  const payload = body === null ? "" : JSON.stringify(body);
  res.writeHead(status, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
  res.end(payload);
}
function readBody(req) {
  return new Promise(resolve => {
    const chunks = [];
    req.on("data", chunk => chunks.push(chunk));
    req.on("end", () => {
      const raw = Buffer.concat(chunks).toString("utf8");
      try { resolve(raw ? JSON.parse(raw) : {}); } catch { resolve({}); }
    });
  });
}
function stamp(event) {
  return { ...event, updated_at: new Date().toISOString() };
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url || "/", "http://127.0.0.1");
  if (url.pathname === "/api/health") return send(res, 200, { ok: true });
  if (url.pathname === "/api/workspaces" && req.method === "GET") return send(res, 200, { workspaces });
  if (url.pathname === "/api/colors" && req.method === "GET") return send(res, 200, colors);
  if (url.pathname === "/api/events" && req.method === "GET") return send(res, 200, { events });
  if (url.pathname === "/api/search" && req.method === "GET") {
    const query = (url.searchParams.get("q") || "").toLowerCase();
    const hits = events.filter(event => String(event.title).toLowerCase().includes(query)).slice(0, 20).map(event => ({ event }));
    return send(res, 200, { hits });
  }
  if (url.pathname === "/api/history" && req.method === "GET") return send(res, 200, { messages: [] });
  const eventMatch = url.pathname.match(/^\/api\/events\/(\d+)$/);
  if (eventMatch && req.method === "PATCH") {
    const body = await readBody(req);
    const id = Number(eventMatch[1]);
    const index = events.findIndex(event => event.id === id);
    if (index < 0) return send(res, 404, { detail: "Запись уже удалена. Обновите список." });
    events[index] = stamp({ ...events[index], ...body, id });
    return send(res, 200, events[index]);
  }
  if (eventMatch && req.method === "DELETE") {
    events = events.filter(event => event.id !== Number(eventMatch[1]));
    res.writeHead(204); return res.end();
  }
  if (url.pathname === "/api/events" && req.method === "POST") {
    const body = await readBody(req);
    pendingProposal = body;
    return send(res, 200, { kind: "confirm", text: "Подтвердите создание записи.", events: [], suggestions: ["Да", "Нет"], expecting: "confirmation" });
  }
  if (url.pathname === "/api/message" && req.method === "POST") {
    const body = await readBody(req);
    const text = String(body.text || "");
    if (/^нет$/i.test(text.trim())) {
      pendingProposal = null;
      return send(res, 200, { kind: "cancelled", text: "Создание отменено.", request_id: body.request_id || "", events: [], suggestions: [] });
    }
    if (pendingProposal && /^да$/i.test(text.trim())) {
      const created = stamp({
        id: nextId++, type: pendingProposal.type || "task", title: pendingProposal.title || "Новая запись",
        date: pendingProposal.date || null, time: pendingProposal.time || null, duration_min: pendingProposal.duration_min ?? null,
        is_deadline: Boolean(pendingProposal.is_deadline), status: "planned", source: "user", source_ref: null,
        created_at: new Date().toISOString(), deleted_at: null,
      });
      events.push(created);
      pendingProposal = null;
      return send(res, 200, { kind: "created", text: "Запись создана.", request_id: body.request_id || "", events: [created], suggestions: [] });
    }
    const proposal = { intent: "create", event_type: "meeting", title: "Встреча с Романом Хедерсом", date: shift(1), time: "15:00:00", duration_min: 30 };
    pendingProposal = { type: "meeting", title: proposal.title, date: proposal.date, time: proposal.time, duration_min: 30 };
    return send(res, 200, {
      kind: "confirm", text: "Правильно понял? На это время у вас нет других событий.", request_id: body.request_id || "",
      events: [], proposal, expecting: "confirmation", suggestions: ["Да", "Нет"],
    });
  }
  const filePath = url.pathname === "/" ? path.join(root, "index.html") : path.join(root, decodeURIComponent(url.pathname.replace(/^\/static\//, "")));
  if (!filePath.startsWith(root)) { res.writeHead(403); return res.end(); }
  fs.readFile(filePath, (error, data) => {
    if (error) { res.writeHead(404); return res.end("not found"); }
    const type = filePath.endsWith(".css") ? "text/css" : filePath.endsWith(".js") ? "text/javascript" : filePath.endsWith(".svg") ? "image/svg+xml" : filePath.endsWith(".woff2") ? "font/woff2" : filePath.endsWith(".png") ? "image/png" : "text/html";
    res.writeHead(200, { "content-type": type, "cache-control": "no-store" });
    res.end(data);
  });
});

server.listen(port, "127.0.0.1");
