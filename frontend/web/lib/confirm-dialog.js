// @ts-check
import { button, el } from "./ui.js";

let active = false;
/** @param {string} text @param {string} [accept] @param {string} [cancel] @param {string} [heading] @returns {Promise<boolean>} */
export function confirmDiscard(text, accept = "Не сохранять", cancel = "Продолжить редактирование", heading = "Несохранённые изменения") {
  if (active) return Promise.resolve(false);
  active = true;
  const previous = document.activeElement;
  const dialog = el("dialog", "discard-dialog"); dialog.setAttribute("aria-labelledby", "discard-title"); dialog.setAttribute("aria-describedby", "discard-text");
  const title = el("h2", "", heading); title.id = "discard-title";
  const description = el("p", "", text); description.id = "discard-text";
  return new Promise(resolve => {
    const finish = (/** @type {boolean} */ result) => { dialog.close(); dialog.remove(); active = false; if (previous instanceof HTMLElement && previous.isConnected) previous.focus(); resolve(result); };
    const keep = button(cancel, "btn btn-quiet", () => finish(false)); keep.autofocus = true;
    const discard = button(accept, "btn btn-primary", () => finish(true));
    const actions = el("div", "discard-dialog__actions"); actions.append(keep, discard);
    dialog.append(title, description, actions); dialog.addEventListener("cancel", event => { event.preventDefault(); finish(false); });
    document.body.append(dialog); dialog.showModal();
  });
}
