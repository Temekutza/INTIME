// @ts-check
import { button, el, icon } from "./ui.js";
import { AnchoredPopover } from "./popover.js";

export class WorkspaceSwitcher {
  /** @param {HTMLSelectElement} select @param {import('./workspace').WorkspaceStore} store @param {(id: number) => Promise<boolean>} choose @param {() => void} create @param {() => void} manage */
  constructor(select, store, choose, create, manage) {
    this.select = select; this.store = store;
    this.trigger = button("", "workspace-switcher-trigger", () => this.popup.open());
    this.trigger.setAttribute("aria-haspopup", "menu"); this.trigger.setAttribute("aria-label", "Выбрать пространство");
    this.panel = el("div", "ui-popover workspace-menu"); this.panel.setAttribute("role", "menu"); this.panel.setAttribute("aria-label", "Ваши пространства");
    select.classList.add("visually-hidden"); select.tabIndex = -1;
    select.parentElement?.append(this.trigger, this.panel);
    this.popup = new AnchoredPopover(this.trigger, this.panel);
    this.trigger.addEventListener("keydown", event => { if (event.key === "ArrowDown") { event.preventDefault(); this.popup.open(); this.panel.querySelector("button")?.focus(); } });
    this.panel.addEventListener("keydown", event => {
      if (!["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key)) return;
      event.preventDefault(); const items = [...this.panel.querySelectorAll("button:not(:disabled)")];
      const index = items.findIndex(item => item === document.activeElement);
      const next = event.key === "Home" ? 0 : event.key === "End" ? items.length - 1 : (index + (event.key === "ArrowDown" ? 1 : items.length - 1)) % items.length;
      const target = items[next]; if (target instanceof HTMLElement) target.focus();
    });
    this.render = () => {
      const current = store.workspaces.find(row => row.id === store.currentId);
      this.trigger.replaceChildren(el("span", "", current?.name || "Общее пространство"), icon("chevron"));
      this.trigger.title = current?.name || store.error; this.trigger.disabled = !store.loaded || !store.workspaces.length;
      this.panel.replaceChildren(el("p", "workspace-menu__label", "Ваши пространства"));
      for (const row of store.workspaces) {
        const item = button("", "workspace-menu__item", async () => {
          const ok = await choose(row.id);
          if (ok) this.popup.close(); else { const text = el("p", "workspace-menu__error", "Завершите текущий запрос или сохраните изменения."); text.setAttribute("role", "status"); this.panel.append(text); this.popup.position(); }
        });
        item.setAttribute("role", "menuitemradio"); item.setAttribute("aria-checked", String(row.id === store.currentId));
        item.append(el("span", "", row.name), el("span", "", row.id === store.currentId ? "✓" : "")); this.panel.append(item);
      }
      const add = button("", "workspace-menu__item", () => { this.popup.close(); create(); }); add.id = "workspace-add"; add.setAttribute("role", "menuitem"); add.append(icon("plus"), el("span", "", "Создать пространство"));
      const management = button("Управление пространствами", "workspace-menu__item", () => { this.popup.close(); manage(); }); management.setAttribute("role", "menuitem");
      this.panel.append(add, management);
    };
    store.addEventListener("change", this.render); this.render();
  }
}
