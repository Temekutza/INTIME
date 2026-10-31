// @ts-check
/** Shared top-layer positioning and lifecycle for contextual controls. */
export class AnchoredPopover {
  /** @param {HTMLElement} trigger @param {HTMLElement} panel */
  constructor(trigger, panel) {
    this.trigger = trigger; this.panel = panel; panel.popover = "auto";
    this.position = () => {
      if (!panel.matches(":popover-open")) return;
      const viewportHeight = window.visualViewport?.height || innerHeight;
      if (window.matchMedia("(max-width: 1024px)").matches) {
        panel.style.left = "0";
        panel.style.right = "0";
        panel.style.top = "auto";
        panel.style.bottom = "0";
        panel.style.width = "100%";
        panel.style.maxWidth = "100%";
        panel.style.maxHeight = Math.max(180, viewportHeight * 0.72) + "px";
        panel.style.borderRadius = "18px 18px 0 0";
        return;
      }
      panel.style.right = "";
      panel.style.bottom = "";
      panel.style.width = "";
      panel.style.maxWidth = "";
      panel.style.borderRadius = "";
      panel.style.maxHeight = Math.max(100, innerHeight - 24) + "px";
      const anchor = trigger.getBoundingClientRect(), box = panel.getBoundingClientRect();
      panel.style.left = Math.max(12, Math.min(anchor.left, innerWidth - box.width - 12)) + "px";
      panel.style.top = (anchor.bottom + box.height + 8 <= innerHeight ? anchor.bottom + 8 : Math.max(12, anchor.top - box.height - 8)) + "px";
    };
    this.toggle = () => {
      const open = panel.matches(":popover-open"); trigger.setAttribute("aria-expanded", String(open));
      if (open) { this.position(); window.addEventListener("resize", this.position); document.addEventListener("scroll", this.position, true); }
      else this.detach();
    };
    panel.addEventListener("toggle", this.toggle);
    panel.addEventListener("keydown", event => {
      if (event.key === "Escape") { event.stopPropagation(); event.preventDefault(); this.close(); }
    });
  }
  open() { this.panel.showPopover(); this.position(); }
  close() { if (this.panel.matches(":popover-open")) this.panel.hidePopover(); this.trigger.focus(); }
  detach() { window.removeEventListener("resize", this.position); document.removeEventListener("scroll", this.position, true); }
  destroy() { this.detach(); this.panel.removeEventListener("toggle", this.toggle); if (this.panel.matches(":popover-open")) this.panel.hidePopover(); }
}
