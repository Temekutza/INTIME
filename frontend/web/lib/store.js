// @ts-check
import { listEvents, patchEvent } from "./api.js";

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
    this.flight = (async () => {
      try {
        const events = await listEvents(undefined, this.workspaceId);
        if (this.revision === revision) { this.events = events; this.loaded = true; }
        else this.reloadAfterFlight = true;
      } catch (error) {
        this.error = error instanceof Error ? error.message : "Не удалось загрузить данные.";
      } finally {
        this.loading = false;
        this.flight = null;
        this.changed();
      }
    })();
    await this.flight;
    if (this.reloadAfterFlight) { this.reloadAfterFlight = false; await this.load(); }
  }

  /** @param {number} id @param {import('./types').EventPatch} patch */
  async patch(id, patch) {
    if (this.saving.has(id)) throw new Error("Дождитесь сохранения записи.");
    this.saving.add(id);
    this.error = "";
    this.revision += 1;
    this.changed();
    try {
      const event = await patchEvent(id, patch);
      this.revision += 1;
      this.upsert(event);
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
}

export const eventStore = new EventStore();
