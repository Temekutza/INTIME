// @ts-check
import { createWorkspace, listWorkspaces } from "./api.js";

const STORAGE_KEY = "ritm.workspace-id";

/** @returns {number | null} */
function readSaved() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    const id = Number(raw);
    return Number.isSafeInteger(id) && id >= 1 ? id : null;
  } catch {
    return null;
  }
}

/** @param {number} id */
function writeSaved(id) {
  try { localStorage.setItem(STORAGE_KEY, String(id)); } catch { /* optional preference */ }
}

export class WorkspaceStore extends EventTarget {
  /** @type {import('./types').Workspace[]} */
  workspaces = [];
  /** @type {number | null} */
  currentId = null;
  loaded = false;
  error = "";

  changed() { this.dispatchEvent(new Event("change")); }

  /** @param {import('./types').Workspace[]} rows */
  pick(rows) {
    const saved = readSaved();
    if (saved != null && rows.some(row => row.id === saved)) return saved;
    const fallback = rows.find(row => row.is_default) || rows[0];
    return fallback ? fallback.id : null;
  }

  async load() {
    this.error = "";
    try {
      this.workspaces = await listWorkspaces();
      this.currentId = this.pick(this.workspaces);
      if (this.currentId != null) writeSaved(this.currentId);
    } catch (error) {
      this.error = error instanceof Error ? error.message : "Не удалось загрузить пространства.";
      this.workspaces = [];
      this.currentId = null;
    } finally {
      this.loaded = true;
      this.changed();
    }
  }

  /** @param {number} id */
  select(id) {
    if (!this.workspaces.some(row => row.id === id)) return;
    this.currentId = id;
    writeSaved(id);
    this.changed();
  }

  /** @param {string} name */
  async create(name) {
    const created = await createWorkspace(name);
    this.workspaces = [...this.workspaces.filter(row => row.id !== created.id), created];
    this.select(created.id);
    return created;
  }
}

export const workspaceStore = new WorkspaceStore();
