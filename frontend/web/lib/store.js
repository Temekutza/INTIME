// @ts-check
import { listEvents, patchEvent, requestJson, workspaceUrl } from "./api.js";

/** One confirmed event collection for all dashboard views. */
export class EventStore extends EventTarget {
  /** @type {import('./types').RitmEvent[]} */
  events = [];
  loading = false;
  loaded = false;
  error = "";
  /** @type {Set<number>} */
  saving = new Set();
  /** @type {number | null} */
  workspaceId = null;
  revision = 0;
  /** @type {Promise<void> | null} */
  flight = null;
  reloadAfterFlight = false;

  changed() { this.dispatchEvent(new Event("change")); }

  /** Deduplicate reads; if a write overlaps, discard and fetch a fresh snapshot. */
  async load() {
    if (this.flight) return this.flight;
    this.loading = true;
    this.error = "";
    this.changed();
    const revision = this.revision;
    const workspaceId = this.workspaceId;
    this.flight = (async () => {
      try {
        const events = await listEvents(undefined, workspaceId);
        if (this.revision === revision) { this.events = events; this.loaded = true; }
        else this.reloadAfterFlight = true;
      } catch (error) {
        if (workspaceId === this.workspaceId) this.error = error instanceof Error ? error.message : "Не удалось загрузить данные.";
        else this.reloadAfterFlight = true;
      } finally {
        this.loading = false;
        this.flight = null;
        this.changed();
      }
    })();
    await this.flight;
    if (this.reloadAfterFlight) { this.reloadAfterFlight = false; await this.load(); }
  }
  /** @param {number | null} id */
  switchWorkspace(id) {
    this.workspaceId = id; this.revision += 1; this.events = []; this.loaded = false; this.error = ""; this.changed();
    return this.load();
  }

  /** @param {number} id @param {import('./types').EventPatch} patch */
  async patch(id, patch) {
    if (this.saving.has(id)) throw new Error("Дождитесь сохранения записи.");
    this.saving.add(id);
    const workspaceId = this.workspaceId;
    this.error = "";
    this.revision += 1;
    this.changed();
    try {
      const event = await patchEvent(id, patch, workspaceId);
      this.revision += 1;
      if (workspaceId === this.workspaceId) this.upsert(event);
      return event;
    } catch (error) {
      this.error = error instanceof Error ? error.message : "Не удалось сохранить изменения.";
      throw error;
    } finally {
      this.saving.delete(id);
      this.changed();
    }
  }

  /** @param {import('./types').RitmEvent} event */
  upsert(event) {
    const index = this.events.findIndex(item => item.id === event.id);
    if (index < 0) this.events.push(event);
    else this.events[index] = event;
  }

  /** @param {number} id */
  async remove(id) {
    if (this.saving.has(id)) throw new Error("Дождитесь сохранения записи.");
    this.saving.add(id); this.revision += 1; this.changed();
    try {
      await requestJson(workspaceUrl(`/api/events/${id}`, this.workspaceId), { method: "DELETE" });
      this.events = this.events.filter(event => event.id !== id); this.error = "";
      window.dispatchEvent(new CustomEvent("ritm:event-deleted", { detail: { id } }));
    } catch (error) { this.error = error instanceof Error ? error.message : "Не удалось удалить запись"; throw error; }
    finally { this.saving.delete(id); this.revision += 1; this.changed(); }
  }
}

export const eventStore = new EventStore();
