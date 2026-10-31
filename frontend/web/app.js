"use strict";

import { eventStore } from "./lib/store.js";
import { workspaceStore } from "./lib/workspace.js";
import { colorStore, paintObject, normalizeHex } from "./lib/colors.js";
import { confirmationCard, resolveConfirmation } from "./lib/confirmation-card.js";
import { maskProfanity } from "./lib/profanity.js";
import { frameLevel, noteCapture } from "./lib/capture.js";
import { icon as uiIcon } from "./lib/ui.js";
import { workspaceUrl } from "./lib/api.js";

(function () {
  const defaultPlaceholder = () => window.matchMedia("(max-width: 1024px)").matches ? "Напишите или расскажите…" : "Напишите, что нужно сделать…";
  const PLACEHOLDERS = {
    title: "Напишите название…",
    date: "Напишите день…",
    time: "Напишите время…",
    datetime: "Напишите день и время…",
    confirmation: "Напишите «да» или «нет»…",
    choice: "Напишите номер записи…",
  };
  const WEEKDAYS = ["вс", "пн", "вт", "ср", "чт", "пт", "сб"];
  const MONTHS = ["янв.", "февр.", "мар.", "апр.", "мая", "июн.", "июл.", "авг.", "сент.", "окт.", "нояб.", "дек."];
  const MIC_DENIED = "Нет доступа к микрофону. Разрешите его в браузере или напишите текстом.";
  const VOICE_UNSUPPORTED = "Голос в этом браузере недоступен.";
  const SPEECH_UNAVAILABLE = "Распознавание речи сейчас недоступно. Напишите текстом.";
  const SPEECH_UNSUPPORTED = "Озвучивание в этом браузере недоступно.";
  const SEND_ERROR = "Не удалось отправить. Проверьте соединение.";
  const TIMEOUT_MS = 20000;
  const MESSAGE_TIMEOUT_MS = 180000;

  const dialogue = document.getElementById("dialogue");
  const dialogueScroll = document.getElementById("dialogue-scroll");
  const historyStatus = document.getElementById("history-status");
  const historyRetry = document.getElementById("history-retry");
  const pendingHint = document.getElementById("pending-hint");
  const suggestions = document.getElementById("suggestions");
  const composer = document.getElementById("composer");
  const composerBox = composer.querySelector(".composer-box");
  const voiceUnsupported = document.getElementById("voice-unsupported");
  const micDenied = document.getElementById("mic-denied");
  const composerStatus = document.getElementById("composer-status");
  const messageInput = document.getElementById("message-input");
  const sendButton = document.getElementById("send-button");
  const menuButton = document.getElementById("menu-button");
  const menu = document.getElementById("menu");
  const newChatButton = document.getElementById("new-chat");
  const header = document.getElementById("header");
  const layout = document.getElementById("layout");
  const speechUnsupported = document.getElementById("speech-unsupported");
  const speechToggle = document.getElementById("speech-toggle");
  const speechStop = document.getElementById("speech-stop");
  const confirmDialog = document.getElementById("confirm-dialog");
  const confirmText = document.getElementById("confirm-text");
  const confirmDelete = document.getElementById("confirm-delete");
  const confirmRetry = document.getElementById("confirm-retry");
  const confirmKeep = document.getElementById("confirm-keep");
  const liveStatus = document.getElementById("live-status");
  const liveReply = document.getElementById("live-reply");

  let micButton = document.getElementById("mic-button");
  const micTimer = document.getElementById("mic-timer");
  const cardData = new WeakMap();
  const patching = new Set();
  let activeWorkspaceId = workspaceStore.currentId || 1;
  let workspaceReady = false;
  const workspaceDrafts = new Map();
  const pendingKey = () => activeWorkspaceId === 1 ? "ritm.pending" : "ritm.pending.workspace." + activeWorkspaceId;

  const state = {
    sessionId: "",
    sending: false,
    recording: false,
    recordMode: "send",
    draftBeforeRecord: "",
    latestTranscript: "",
    recognition: null,
    micDenied: false,
    speechOn: false,
    speechReady: false,
    speechGeneration: 0,
    spokenIds: new Set(),
    lastReply: null,
    today: "",
    posted: false,
    confirm: null,
    deleteFlight: false,
    listenGeneration: 0,
    listenError: "",
    stopRequested: false,
    cloudDown: false,
    localDown: false,
    localCapture: false,
    localFinishing: false,
    audioContext: null,
    localSession: null,
    liveParts: [],
    liveChain: Promise.resolve(),
    placeholderBefore: "",
    historyGeneration: 0,
    micTimerId: 0,
  };

  function el(tag, className, text) {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined) node.textContent = text;
    return node;
  }

  function escapeAttr(value) {
    const text = String(value);
    if (window.CSS && typeof window.CSS.escape === "function") return window.CSS.escape(text);
    return text.replace(/[^a-zA-Z0-9_-]/g, "\\$&");
  }

  function readStore(storage, key) {
    try {
      return storage.getItem(key);
    } catch (error) {
      return null;
    }
  }

  function writeStore(storage, key, value) {
    try {
      storage.setItem(key, value);
    } catch (error) {
      /* хранилище может быть закрыто */
    }
  }

  function removeStore(storage, key) {
    try {
      storage.removeItem(key);
    } catch (error) {
      /* хранилище может быть закрыто */
    }
  }

  function ensureSessionId() {
    const existing = readStore(localStorage, "ritm.session_id");
    if (existing && existing.length >= 1 && existing.length <= 100) return existing;
    const created = crypto.randomUUID();
    writeStore(localStorage, "ritm.session_id", created);
    return created;
  }

  function readPending() {
    const raw = readStore(sessionStorage, pendingKey());
    if (!raw) return null;
    try {
      const data = JSON.parse(raw);
      if (!data || typeof data.request_id !== "string" || typeof data.text !== "string") return null;
      if (!data.request_id || !data.text) return null;
      return { request_id: data.request_id, text: data.text, new_event_color: typeof data.new_event_color === "string" ? normalizeHex(data.new_event_color) : null };
    } catch (error) {
      return null;
    }
  }

  function savePending(pending) {
    writeStore(sessionStorage, pendingKey(), JSON.stringify({
      request_id: pending.request_id,
      text: pending.text,
      new_event_color: pending.new_event_color || null,
    }));
  }

  function clearPending() {
    removeStore(sessionStorage, pendingKey());
  }

  function startOfToday() {
    const now = new Date();
    return new Date(now.getFullYear(), now.getMonth(), now.getDate());
  }

  function isoDate(day) {
    const month = String(day.getMonth() + 1).padStart(2, "0");
    const date = String(day.getDate()).padStart(2, "0");
    return day.getFullYear() + "-" + month + "-" + date;
  }

  function parseIsoDate(iso) {
    const parts = String(iso).split("-");
    return new Date(Number(parts[0]), Number(parts[1]) - 1, Number(parts[2]));
  }

  function formatDay(iso, today) {
    if (!iso) return "без даты";
    const day = parseIsoDate(iso);
    const base = today || startOfToday();
    const diff = Math.round((day.getTime() - base.getTime()) / 86400000);
    if (diff === 0) return "сегодня";
    if (diff === 1) return "завтра";
    if (diff === -1) return "вчера";
    return WEEKDAYS[day.getDay()] + ", " + day.getDate() + " " + MONTHS[day.getMonth()];
  }

  function isDeadline(event) {
    return event.is_deadline === true || event.is_deadline === 1;
  }

  function clockText(value) {
    const match = String(value).match(/^(\d{2}:\d{2})/);
    return match ? match[1] : String(value);
  }

  function formatMeta(event, withDuration) {
    const parts = [];
    if (event.date && event.time) {
      parts.push(formatDay(String(event.date)) + " в " + clockText(event.time));
    } else if (event.date) {
      const day = formatDay(String(event.date));
      parts.push(isDeadline(event) ? "до " + day : day);
    } else {
      parts.push("без даты");
    }
    if (withDuration && typeof event.duration_min === "number" && Number.isFinite(event.duration_min)) {
      parts.push(String(event.duration_min) + " мин");
    }
    return parts.join(", ");
  }

  function typeLabel(type) {
    if (type === "task") return "Задача";
    if (type === "reminder") return "Напоминание";
    if (type === "meeting") return "Встреча";
    return String(type || "");
  }

  function accusative(type) {
    if (type === "task") return "задачу";
    if (type === "reminder") return "напоминание";
    if (type === "meeting") return "встречу";
    return String(type || "запись");
  }

  function sourceInfo(source) {
    if (source === "archive") return { label: "архив", card: "is-archive" };
    if (source === "user") return { label: "моя", card: "is-user" };
    if (!source) return null;
    return { label: String(source), card: "" };
  }

  function cardMeta(event) {
    const parts = [typeLabel(event.type), formatMeta(event, true)];
    if (event.source === "archive") parts.push("архив");
    if (event.status === "done") parts.push("выполнена");
    return parts.filter(Boolean).join("  ");
  }

  function cardName(event) {
    const parts = [typeLabel(event.type), event.title || "", formatMeta(event, true)];
    const source = sourceInfo(event.source);
    if (source && source.label) parts.push(source.label);
    if (event.status === "done") parts.push("выполнена");
    return parts.join(", ");
  }

  function choiceText(index) {
    return "номер " + index;
  }

  function sayStatus(text) {
    composerStatus.textContent = text;
    liveStatus.textContent = text;
  }

  function publishReply(text) {
    composerStatus.textContent = "";
    liveStatus.textContent = "";
    liveReply.textContent = text;
  }

  function scrollDialogue() {
    dialogueScroll.scrollTop = dialogueScroll.scrollHeight;
  }

  function revealReply(item) {
    if (!item) {
      scrollDialogue();
      return;
    }
    if (item.querySelector('.confirmation-card[data-state="pending"]')) { scrollDialogue(); return; }
    const user = item.previousElementSibling;
    const anchor = user && user.classList.contains("message-user") ? user : item;
    const top = anchor.offsetTop - dialogue.offsetTop;
    const bottom = item.offsetTop + item.offsetHeight - dialogue.offsetTop;
    if (bottom - top > dialogueScroll.clientHeight) dialogueScroll.scrollTop = Math.max(0, top - 8);
    else scrollDialogue();
  }

  function replyLead(text, events) {
    if (!events.length) return text;
    const lines = String(text).split("\n");
    const listed = lines.slice(1).filter((line) => /^\s*\d+[.)]\s/.test(line)).length;
    return listed >= Math.min(events.length, 2) ? lines[0] : text;
  }

  function resizeInput() {
    messageInput.style.height = "auto";
    const next = Math.min(messageInput.scrollHeight, 160);
    messageInput.style.height = next + "px";
    composer.classList.toggle("has-text", messageInput.value.trim() !== "" && !state.recording);
  }

  function claimReplyText(node) {
    const previous = document.getElementById("last-reply-text");
    if (previous && previous !== node) previous.removeAttribute("id");
    node.id = "last-reply-text";
  }

  function enterChat() {
    document.body.classList.remove("is-empty");
  }

  function enterEmpty() {
    document.body.classList.add("is-empty");
  }

  function hideThinking() {
    dialogue.querySelectorAll(".message-thinking").forEach((node) => node.remove());
  }

  function showThinking(requestId) {
    hideThinking();
    const item = el("li", "message message-assistant message-thinking");
    if (requestId) item.dataset.requestId = requestId;
    const status = el("p", "message__text thinking-indicator");
    const dots = el("span", "thinking-dots");
    dots.setAttribute("aria-hidden", "true");
    dots.append(el("span"), el("span"), el("span"));
    status.append(dots, el("span", "", "Думаю…"));
    item.append(status);
    dialogue.append(item);
    scrollDialogue();
  }

  function setBusy(busy, requestId) {
    state.sending = busy;
    messageInput.disabled = busy;
    sendButton.disabled = busy || state.recording;
    if (micButton && !state.micDenied) micButton.disabled = busy;
    suggestions.querySelectorAll("button").forEach((button) => {
      button.disabled = busy;
    });
    dialogueScroll.setAttribute("aria-busy", busy ? "true" : "false");
    dialogue.querySelectorAll('.confirmation-card[data-state="pending"] .confirmation-card__status').forEach(node => {
      node.textContent = busy ? "Обработка действия…" : "Ожидает подтверждения";
    });
    if (busy) showThinking(requestId);
    else hideThinking();
    colorStore.changed();
  }

  function resetPlaceholder() {
    messageInput.placeholder = defaultPlaceholder();
    messageInput.removeAttribute("aria-describedby");
  }

  function clearSuggestions() {
    suggestions.replaceChildren();
    suggestions.hidden = true;
  }

  function renderSuggestions(labels, expecting) {
    suggestions.replaceChildren();
    let items = labels.slice();
    if (!items.length && expecting === "confirmation") items = ["Да", "Нет"];
    if (!items.length) {
      suggestions.hidden = true;
      return;
    }
    items.forEach((label) => {
      const confirmation = expecting === "confirmation";
      const affirmative = String(label) === "Да";
      const button = el("button", confirmation ? (affirmative ? "btn btn-primary" : "btn btn-quiet") : "suggestion",
        confirmation && ["Да", "Нет"].includes(String(label)) ? (affirmative ? "Подтвердить" : "Отказаться") : String(label));
      button.type = "button";
      button.addEventListener("click", () => {
        submitText(String(label));
      });
      if (state.sending) button.disabled = true;
      suggestions.append(button);
    });
    const reply = document.getElementById("last-reply-text");
    const host = reply ? reply.closest(".message-assistant") : null;
    if (host) {
      const actions = expecting === "confirmation" ? host.querySelector(".confirmation-card__actions") : null;
      (actions || host).append(suggestions);
    }
    suggestions.hidden = false;
  }

  function applyReplyChrome(data) {
    const expecting = data.expecting || null;
    const labels = Array.isArray(data.suggestions) ? data.suggestions.map(String) : [];
    messageInput.placeholder = PLACEHOLDERS[expecting] || defaultPlaceholder();
    if (expecting) messageInput.setAttribute("aria-describedby", "composer-status last-reply-text");
    else messageInput.removeAttribute("aria-describedby");
    renderSuggestions(labels, expecting);
  }

  function findUserMessage(requestId) {
    return dialogue.querySelector('.message-user[data-request-id="' + escapeAttr(requestId) + '"]');
  }

  function findAssistantMessage(requestId) {
    return dialogue.querySelector('.message-assistant[data-request-id="' + escapeAttr(requestId) + '"]:not(.message-thinking)');
  }

  function removeSendError(requestId) {
    const node = dialogue.querySelector('.message-error[data-request-id="' + escapeAttr(requestId) + '"]');
    if (node && node.dataset.retry !== "patch") node.remove();
  }

  function removeAllSendErrors() {
    dialogue.querySelectorAll(".message-error[data-request-id]").forEach((node) => {
      if (node.dataset.retry !== "patch") node.remove();
    });
  }

  function appendUserMessage(text, requestId) {
    const item = el("li", "message message-user");
    if (requestId) item.dataset.requestId = requestId;
    item.append(el("p", "message__text", maskProfanity(text)));
    dialogue.append(item);
    scrollDialogue();
    return item;
  }

  function bubbleClass(kind) {
    if (kind === "duplicate") return "is-duplicate";
    if (kind === "error") return "is-error";
    if (kind === "clarify" || kind === "confirm" || kind === "choice") return "is-ask";
    return "";
  }

  function appendAssistantBubble(text, kind, requestId) {
    const item = el("li", "message message-assistant");
    const extra = bubbleClass(kind);
    if (extra) item.classList.add(extra);
    if (kind) item.dataset.kind = kind;
    if (requestId) item.dataset.requestId = requestId;
    const paragraph = el("p", "message__text", text);
    claimReplyText(paragraph);
    item.append(paragraph);
    dialogue.append(item);
    scrollDialogue();
    return item;
  }

  function appendLocalAssistant(text) {
    return appendAssistantBubble(text, "", "");
  }

  function createCard(event, options) {
    const article = el("article", "event-card");
    paintObject(article, event);
    article.dataset.eventId = String(event.id);
    article.dataset.type = event.type ? String(event.type) : "";
    article.dataset.source = event.source ? String(event.source) : "";
    article.dataset.status = event.status ? String(event.status) : "";
    if (event.status === "done") article.classList.add("is-done");
    const source = sourceInfo(event.source);
    if (source && source.card) article.classList.add(source.card);
    article.setAttribute("aria-label", cardName(event));
    cardData.set(article, event);

    const title = event.title || "";
    const lead = options.showIndex
      ? el("span", "event-card__index", String(options.index))
      : el("span", "event-card__dot");
    lead.setAttribute("aria-hidden", "true");

    const body = el("div", "event-card__body");
    body.append(el("h3", "event-card__title", title), el("p", "event-card__meta", cardMeta(event)));

    const actions = el("div", "event-card__actions");
    const edit = el("button", "card-action", "Редактировать"); edit.type = "button";
    edit.addEventListener("click", () => window.dispatchEvent(new CustomEvent("ritm:edit-event", { detail: { id: event.id } })));
    actions.append(edit);
    if (options.showChoice) {
      const choose = el("button", "choice-btn", "Выбрать");
      choose.type = "button";
      choose.dataset.action = "choice";
      choose.setAttribute("aria-label", "Выбрать " + options.index + ": " + title);
      choose.addEventListener("click", () => {
        submitText(choiceText(options.index));
      });
      actions.append(choose);
    }
    if (event.status === "planned") {
      const doneButton = el("button", "card-action", "Завершить");
      doneButton.type = "button";
      doneButton.setAttribute("aria-label", "Отметить «" + title + "» выполненной");
      doneButton.dataset.action = "done";
      doneButton.addEventListener("click", () => {
        markDone(event);
      });
      actions.append(doneButton);
    }
    const remove = iconButton("trash", "Удалить «" + title + "»", "Удалить");
    remove.dataset.action = "delete";
    remove.addEventListener("click", () => {
      onDeleteClick(event, remove);
    });
    actions.append(remove);

    article.append(lead, body, actions);
    return article;
  }

  function iconButton(name, label, hint) {
    const button = el("button", "icon-btn");
    button.type = "button";
    button.setAttribute("aria-label", label);
    button.title = hint;
    button.append(uiIcon(name));
    return button;
  }

  function appendCards(item, events, options) {
    if (!events.length) return;
    const list = el("div", "event-list");
    const cards = events.map((event, index) => createCard(event, {
      showIndex: options.showIndex,
      showChoice: options.showChoice,
      index: index + 1,
    }));
    const collapse = cards.length > 7;
    cards.forEach((card, index) => {
      if (collapse && index >= 5) card.hidden = true;
      list.append(card);
    });
    const paragraph = item.querySelector(".message__text");
    if (paragraph) paragraph.insertAdjacentElement("afterend", list);
    else item.append(list);
    if (!collapse) return;
    const more = el("button", "text-btn more-btn", "Показать ещё " + (cards.length - 5));
    more.type = "button";
    more.addEventListener("click", () => {
      cards.forEach((card) => {
        card.hidden = false;
      });
      more.remove();
      if (cards[5]) {
        const next = cards[5].querySelector("button");
        if (next) next.focus();
      }
    });
    list.insertAdjacentElement("afterend", more);
  }

  function refreshCardDates() {
    document.querySelectorAll("article.event-card").forEach((card) => {
      const event = cardData.get(card);
      if (!event) return;
      const meta = card.querySelector(".event-card__meta");
      if (meta) meta.textContent = cardMeta(event);
      card.setAttribute("aria-label", cardName(event));
    });
  }

  function applyDone(eventId) {
    const selector = 'article.event-card[data-event-id="' + escapeAttr(String(eventId)) + '"]';
    document.querySelectorAll(selector).forEach((card) => {
      const event = cardData.get(card);
      if (event) event.status = "done";
      card.classList.add("is-done");
      card.dataset.status = "done";
      const mark = card.querySelector('[data-action="done"]');
      if (mark) mark.remove();
      if (event) {
        const meta = card.querySelector(".event-card__meta");
        if (meta) meta.textContent = cardMeta(event);
        card.setAttribute("aria-label", cardName(event));
      }
    });
  }

  function removeCards(eventId) {
    const selector = 'article.event-card[data-event-id="' + escapeAttr(String(eventId)) + '"]';
    document.querySelectorAll(selector).forEach((card) => {
      const list = card.parentElement;
      card.remove();
      if (list && list.classList.contains("event-list") && !list.childElementCount) list.remove();
    });
  }

  async function request(url, options, timeoutMs) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs || TIMEOUT_MS);
    window.dispatchEvent(new CustomEvent("ritm:request", { detail: { phase: "start" } }));
    try {
      const response = await fetch(url, Object.assign({}, options, { signal: controller.signal }));
      window.dispatchEvent(new CustomEvent("ritm:request", { detail: { phase: "end", ok: response.ok } }));
      return response;
    } catch (error) {
      window.dispatchEvent(new CustomEvent("ritm:request", { detail: { phase: "end", ok: false } }));
      throw error;
    } finally {
      clearTimeout(timer);
    }
  }

  function showSendError(pending, text, withRetry) {
    removeSendError(pending.request_id);
    composerStatus.textContent = "";
    liveStatus.textContent = "";
    liveReply.textContent = text;
    const item = el("li", "message message-error");
    item.dataset.requestId = pending.request_id;
    item.append(el("p", "message__text", text));
    if (withRetry) {
      const button = el("button", "btn btn-quiet", "Повторить");
      button.type = "button";
      button.addEventListener("click", () => {
        beginSend(pending, false);
      });
      item.append(button);
    }
    const user = findUserMessage(pending.request_id);
    if (user) user.insertAdjacentElement("afterend", item);
    else dialogue.append(item);
    scrollDialogue();
  }

  function showPatchError(event) {
    const text = "Не удалось отметить выполненной. Проверьте соединение.";
    dialogue.querySelectorAll('.message-error[data-retry="patch"]').forEach((node) => {
      if (node.dataset.eventId === String(event.id)) node.remove();
    });
    liveReply.textContent = text;
    const item = el("li", "message message-error");
    item.dataset.retry = "patch";
    item.dataset.eventId = String(event.id);
    item.append(el("p", "message__text", text));
    const button = el("button", "btn btn-quiet", "Повторить");
    button.type = "button";
    button.dataset.retry = "patch";
    button.dataset.eventId = String(event.id);
    button.addEventListener("click", () => {
      item.remove();
      markDone(event);
    });
    item.append(button);
    dialogue.append(item);
    scrollDialogue();
  }

  function renderReply(data) {
    dialogue.querySelectorAll('.confirmation-card[data-state="pending"]').forEach(card => resolveConfirmation(card, data.kind));
    window.dispatchEvent(new Event("ritm:data-changed"));
    const requestId = data.request_id ? String(data.request_id) : "";
    const kind = data.kind ? String(data.kind) : "";
    if (requestId) removeSendError(requestId);
    state.lastReply = data;
    if (data.proposal && ["task", "meeting", "reminder"].includes(data.proposal.event_type)) {
      colorStore.creationType = data.proposal.event_type; colorStore.changed();
    }
    const existing = requestId ? findAssistantMessage(requestId) : null;
    if (existing) {
      const paragraph = existing.querySelector(".message__text");
      if (paragraph) claimReplyText(paragraph);
    } else {
      const events = Array.isArray(data.events) ? data.events : [];
      const labels = Array.isArray(data.suggestions) ? data.suggestions : [];
      const item = appendAssistantBubble(replyLead(data.text || "", events), kind, requestId);
      if (kind !== "confirm") {
        appendCards(item, events, {
          showIndex: kind === "choice",
          showChoice: kind === "choice" && labels.length === 0,
        });
      }
      if (data.proposal && (kind === "confirm" || data.expecting === "confirmation")) {
        item.append(confirmationCard(data.proposal));
      }
    }
    applyReplyChrome(data);
    revealReply(existing || findAssistantMessage(requestId));
    publishReply(data.text || "");
    speakReply(data);
  }

  function beginSend(pending, isNew) {
    if (state.sending) return;
    if (!workspaceStore.loaded || !workspaceStore.workspaces.length) { sayStatus(workspaceStore.error || "Загружаются пространства. Подождите немного."); return; }
    savePending(pending);
    if (isNew) {
      removeAllSendErrors();
      enterChat();
      appendUserMessage(pending.text, pending.request_id);
      messageInput.value = "";
      resizeInput();
    } else {
      removeSendError(pending.request_id);
    }
    cancelSpeech();
    setBusy(true, pending.request_id);
    sayStatus("Думаю…");
    sendPending(pending);
  }

  async function sendPending(pending) {
    const requestWorkspace = activeWorkspaceId;
    const requestSession = state.sessionId;
    let response;
    try {
      response = await request("/api/message", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          session_id: requestSession,
          request_id: pending.request_id,
          text: pending.text,
          new_event_color: pending.new_event_color || null,
          require_confirmation: true,
          workspace_id: requestWorkspace,
        }),
      }, MESSAGE_TIMEOUT_MS);
    } catch (error) {
      if (requestWorkspace !== activeWorkspaceId) return;
      setBusy(false);
      showSendError(pending, SEND_ERROR, true);
      return;
    }
    if (requestWorkspace !== activeWorkspaceId || requestSession !== state.sessionId) return;
    if (response.status === 200) {
      let data;
      try {
        data = await response.json();
      } catch (error) {
        setBusy(false);
        showSendError(pending, SEND_ERROR, true);
        return;
      }
      clearPending();
      state.posted = true;
      pendingHint.hidden = true;
      setBusy(false);
      if (data.kind === "created" || data.kind === "cancelled") {
        colorStore.creationColor = null;
        colorStore.changed();
      }
      renderReply(data);
      return;
    }
    setBusy(false);
    if (response.status === 422) {
      clearPending();
      showSendError(pending, "Сервер не принял фразу. Сократите её или скажите иначе.", false);
      return;
    }
    if (response.status === 409) {
      clearPending();
      showSendError(pending, "Эта фраза уже отправлялась с другим текстом. Напишите её ещё раз.", false);
      return;
    }
    showSendError(pending, SEND_ERROR, true);
  }

  function invalidateRecognition() {
    state.listenGeneration += 1;
  }

  function submitText(raw) {
    if (state.recording) {
      invalidateRecognition();
      resetRecordingChrome();
      try {
        if (state.recognition) state.recognition.abort();
      } catch (error) {
        /* распознавание уже остановлено */
      }
    }
    if (state.sending) return;
    const text = String(raw == null ? "" : raw).trim();
    if (!text) {
      sayStatus("Напишите или скажите фразу.");
      return;
    }
    if (text.length > 1000) {
      sayStatus("Можно не больше 1000 символов. Сократите фразу.");
      return;
    }
    beginSend({ request_id: crypto.randomUUID(), text: text, new_event_color: colorStore.creationColor }, true);
  }

  function appendHistoryUser(message) {
    appendUserMessage(message.text || "", "");
  }

  function appendHistoryAssistant(message) {
    const kind = message.kind ? String(message.kind) : "";
    const item = appendAssistantBubble(message.text || "", kind, "");
    if (kind === "confirm") {
      const card = confirmationCard(message.proposal);
      if (!message.active_confirmation) resolveConfirmation(card, message.resolution || "inactive");
      item.append(card);
    }
  }

  function restoreFromHistory(message) {
    const kind = message.kind ? String(message.kind) : "";
    if (Object.prototype.hasOwnProperty.call(message, "pending_color")) {
      colorStore.creationColor = typeof message.pending_color === "string" ? normalizeHex(message.pending_color) : null; colorStore.changed();
    }
    if (message.active_confirmation && message.proposal && ["task", "meeting", "reminder"].includes(message.proposal.event_type)) {
      colorStore.creationType = message.proposal.event_type; colorStore.changed();
    }
    const hasExpecting = Object.prototype.hasOwnProperty.call(message, "expecting");
    const hasSuggestions = Object.prototype.hasOwnProperty.call(message, "suggestions");
    if (!hasExpecting && !hasSuggestions && (kind === "clarify" || kind === "confirm" || kind === "choice")) {
      pendingHint.hidden = state.posted;
      resetPlaceholder();
      clearSuggestions();
      return;
    }
    pendingHint.hidden = true;
    applyReplyChrome({
      kind: kind,
      expecting: kind === "confirm" && message.active_confirmation === false ? null : hasExpecting ? message.expecting : null,
      suggestions: kind === "confirm" && message.active_confirmation === false ? [] : hasSuggestions ? message.suggestions : [],
    });
  }

  function renderHistory(messages) {
    const sorted = messages.slice().sort((left, right) => {
      return String(left.created_at || "").localeCompare(String(right.created_at || ""));
    });
    dialogue.querySelectorAll(":scope > .message").forEach((node) => node.remove());
    if (!sorted.length) {
      if (!dialogue.childElementCount) enterEmpty();
      clearSuggestions();
      resetPlaceholder();
      pendingHint.hidden = true;
      reconcilePending(sorted);
      return;
    }
    enterChat();
    let lastAssistant = null;
    sorted.forEach((message) => {
      if (message.role === "user") appendHistoryUser(message);
      else if (message.role === "assistant") {
        appendHistoryAssistant(message);
        lastAssistant = message;
      }
    });
    if (lastAssistant) restoreFromHistory(lastAssistant);
    else {
      resetPlaceholder();
      clearSuggestions();
    }
    reconcilePending(sorted);
    scrollDialogue();
  }

  function reconcilePending(messages) {
    const pending = readPending();
    if (!pending) return;
    let index = -1;
    for (let i = 0; i < messages.length; i += 1) {
      const shown = maskProfanity(pending.text);
      if (messages[i].role === "user" && (messages[i].text === pending.text || messages[i].text === shown)) index = i;
    }
    if (index >= 0 && messages.slice(index + 1).some((message) => message.role === "assistant")) {
      clearPending();
      return;
    }
    enterChat();
    let user = findUserMessage(pending.request_id);
    if (!user) {
      const matches = [...dialogue.querySelectorAll(".message-user")].filter((node) => {
        const paragraph = node.querySelector(".message__text");
        const shown = maskProfanity(pending.text);
        return paragraph && (paragraph.textContent === pending.text || paragraph.textContent === shown);
      });
      user = matches.length ? matches[matches.length - 1] : null;
      if (user) user.dataset.requestId = pending.request_id;
    }
    if (!user) appendUserMessage(pending.text, pending.request_id);
    showSendError(pending, SEND_ERROR, true);
  }

  async function loadHistory() {
    const generation = ++state.historyGeneration;
    const sessionId = state.sessionId;
    const workspaceId = activeWorkspaceId;
    historyStatus.hidden = false;
    historyStatus.textContent = "Загружаю диалог…";
    liveStatus.textContent = "Загружаю диалог…";
    historyRetry.hidden = true;
    try {
      const response = await fetch(
        "/api/history?session_id=" + encodeURIComponent(sessionId) + "&limit=50&workspace_id=" + workspaceId,
        { signal: AbortSignal.timeout(TIMEOUT_MS) },
      );
      if (!response.ok) throw new Error("history");
      const data = await response.json();
      if (sessionId !== state.sessionId || generation !== state.historyGeneration || state.sending || state.posted) return;
      historyStatus.hidden = true;
      historyStatus.textContent = "";
      if (liveStatus.textContent === "Загружаю диалог…") liveStatus.textContent = "";
      renderHistory(Array.isArray(data.messages) ? data.messages : []);
    } catch (error) {
      if (sessionId !== state.sessionId || generation !== state.historyGeneration || state.sending || state.posted) return;
      historyStatus.hidden = false;
      historyStatus.textContent = "Не удалось загрузить диалог.";
      historyRetry.hidden = false;
      liveStatus.textContent = "Не удалось загрузить диалог.";
    }
  }

  function maybeNewDay() {
    const today = isoDate(startOfToday());
    if (state.today && today !== state.today) refreshCardDates();
    state.today = today;
  }

  function startNewChat() {
    closeMenu(false);
    if (state.sending) return;
    state.historyGeneration += 1;
    colorStore.creationColor = null; colorStore.changed();
    if (state.recording) requestStopRecording("cancel");
    cancelSpeech();
    clearPending();
    const created = crypto.randomUUID();
    writeStore(localStorage, "ritm.session_id", created);
    state.sessionId = created;
    state.lastReply = null;
    state.posted = false;
    dialogue.replaceChildren();
    clearSuggestions();
    resetPlaceholder();
    pendingHint.hidden = true;
    historyStatus.hidden = true;
    historyRetry.hidden = true;
    composerStatus.textContent = "";
    liveStatus.textContent = "";
    messageInput.value = "";
    resizeInput();
    enterEmpty();
    messageInput.focus();
  }

  function openMenu() {
    menu.hidden = false;
    menuButton.setAttribute("aria-expanded", "true");
    const first = menu.querySelector("button:not([hidden])");
    if (first) first.focus();
  }

  function closeMenu(restoreFocus) {
    if (menu.hidden) return;
    menu.hidden = true;
    menuButton.setAttribute("aria-expanded", "false");
    if (restoreFocus) menuButton.focus();
  }

  async function markDone(event) {
    const key = String(event.id);
    if (patching.has(key)) return;
    patching.add(key);
    try {
      await eventStore.patch(Number(event.id), { status: "done" });
    } catch (error) {
      showPatchError(event);
      return;
    } finally {
      patching.delete(key);
    }
    applyDone(event.id);
    const visible = "Отметила «" + (event.title || "") + "» выполненной.";
    appendLocalAssistant(visible);
    publishReply(visible);
    speak("Отметила " + (event.title || "") + " выполненной.");
  }

  function deleteQuestion(event) {
    const name = accusative(event.type);
    const title = event.title || "";
    if (!event.date && !event.time) return "Удалить " + name + " «" + title + "»?";
    return "Удалить " + name + " «" + title + "», " + formatMeta(event, false) + "?";
  }

  function dialogButtons() {
    return [...confirmDialog.querySelectorAll("button")].filter((button) => !button.hidden);
  }

  function closeConfirm() {
    if (state.deleteFlight) return;
    const opener = state.confirm && state.confirm.opener;
    confirmDialog.hidden = true;
    header.inert = false;
    layout.inert = false;
    state.confirm = null;
    if (opener && opener.isConnected) opener.focus();
    else messageInput.focus();
  }

  function openConfirm(event, opener) {
    state.confirm = { event: event, opener: opener };
    confirmText.textContent = deleteQuestion(event);
    confirmDelete.hidden = false;
    confirmRetry.hidden = true;
    confirmDelete.disabled = false;
    confirmRetry.disabled = false;
    confirmDialog.hidden = false;
    header.inert = true;
    layout.inert = true;
    confirmKeep.focus();
  }

  function onDeleteClick(event, opener) {
    const last = state.lastReply;
    if (last && last.kind === "confirm" && last.expecting === "confirmation") {
      const events = Array.isArray(last.events) ? last.events : [];
      const matches = events.some((item) => String(item.id) === String(event.id));
      if (matches) {
        const yes = [...suggestions.querySelectorAll("button")].find((button) => button.textContent === "Подтвердить");
        if (yes && !yes.disabled) yes.click();
        else submitText("Да");
        return;
      }
    }
    openConfirm(event, opener);
  }

  async function performDelete() {
    if (!state.confirm || state.deleteFlight) return;
    const event = state.confirm.event;
    state.deleteFlight = true;
    confirmDelete.disabled = true;
    confirmRetry.disabled = true;
    let response;
    try {
      response = await request(workspaceUrl("/api/events/" + encodeURIComponent(String(event.id)), activeWorkspaceId), {
        method: "DELETE",
      });
      if (!response.ok) throw new Error("delete");
    } catch (error) {
      state.deleteFlight = false;
      confirmDelete.disabled = false;
      confirmRetry.disabled = false;
      if (!state.confirm) return;
      confirmText.textContent = "Не удалось удалить. Проверьте соединение.";
      confirmDelete.hidden = true;
      confirmRetry.hidden = false;
      confirmRetry.focus();
      return;
    }
    state.deleteFlight = false;
    confirmDelete.disabled = false;
    confirmRetry.disabled = false;
    removeCards(event.id);
    window.dispatchEvent(new Event("ritm:data-changed"));
    const opener = state.confirm && state.confirm.opener;
    state.confirm = null;
    confirmDialog.hidden = true;
    header.inert = false;
    layout.inert = false;
    if (opener && opener.isConnected) opener.focus();
    else messageInput.focus();
    const name = accusative(event.type);
    const visible = "Удалила " + name + " «" + (event.title || "") + "».";
    appendLocalAssistant(visible);
    publishReply(visible);
    speak("Удалила " + name + " " + (event.title || "") + ".");
  }

  function pickVoice() {
    if (!window.speechSynthesis) return null;
    const voices = window.speechSynthesis.getVoices();
    for (let i = 0; i < voices.length; i += 1) {
      const lang = String(voices[i].lang || "").toLowerCase();
      if (lang.startsWith("ru")) return voices[i];
    }
    return null;
  }

  function cancelSpeech() {
    state.speechGeneration += 1;
    if (window.speechSynthesis) {
      try {
        window.speechSynthesis.cancel();
      } catch (error) {
        /* синтез уже остановлен */
      }
    }
    speechStop.hidden = true;
  }

  function speak(text) {
    if (!state.speechOn || !state.speechReady || !text || !window.speechSynthesis) return;
    cancelSpeech();
    const generation = state.speechGeneration;
    const utterance = new SpeechSynthesisUtterance(text);
    utterance.lang = "ru-RU";
    utterance.rate = 1;
    utterance.pitch = 1;
    const voice = pickVoice();
    if (voice) utterance.voice = voice;
    const finish = () => {
      if (generation !== state.speechGeneration) return;
      speechStop.hidden = true;
    };
    utterance.onend = finish;
    utterance.onerror = finish;
    speechStop.hidden = false;
    try {
      window.speechSynthesis.speak(utterance);
    } catch (error) {
      speechStop.hidden = true;
    }
  }

  function speakReply(data) {
    const speech = data.speech ? String(data.speech).trim() : "";
    if (!speech || !state.speechOn || !state.speechReady) return;
    const requestId = data.request_id ? String(data.request_id) : "";
    if (requestId && state.spokenIds.has(requestId)) return;
    if (requestId) state.spokenIds.add(requestId);
    speak(speech);
  }

  function renderSpeechToggle() {
    speechToggle.setAttribute("aria-pressed", state.speechOn ? "true" : "false");
    speechToggle.textContent = state.speechOn ? "Озвучивание: вкл" : "Озвучивание: выкл";
  }

  function setupSpeech() {
    if (!("speechSynthesis" in window) || !window.speechSynthesis) {
      speechToggle.hidden = true;
      speechStop.hidden = true;
      speechUnsupported.hidden = false;
      state.speechOn = false;
      state.speechReady = false;
      return;
    }
    speechUnsupported.hidden = true;
    state.speechReady = true;
    state.speechOn = readStore(localStorage, "ritm.speech") !== "off";
    renderSpeechToggle();
    speechToggle.hidden = false;
    speechStop.hidden = true;
    window.speechSynthesis.getVoices();
    window.speechSynthesis.addEventListener("voiceschanged", () => {
      window.speechSynthesis.getVoices();
    });
  }

  function setMicTimer(ms) {
    if (!micTimer) return;
    micTimer.hidden = false;
    micTimer.textContent = Math.floor(ms / 1000) + " с";
  }

  function stopMicTimer() {
    if (state.micTimerId) window.clearInterval(state.micTimerId);
    state.micTimerId = 0;
    if (!micTimer) return;
    micTimer.hidden = true;
    micTimer.textContent = "";
  }

  function startMicTimer() {
    stopMicTimer();
    const started = performance.now();
    setMicTimer(0);
    state.micTimerId = window.setInterval(() => setMicTimer(performance.now() - started), 200);
  }

  function resetRecordingChrome() {
    stopMicTimer();
    state.recording = false;
    messageInput.readOnly = false;
    messageInput.classList.remove("is-interim");
    if (composerBox) composerBox.classList.remove("is-listening");
    if (state.placeholderBefore) {
      messageInput.placeholder = state.placeholderBefore;
      state.placeholderBefore = "";
    }
    if (micButton) {
      micButton.classList.remove("is-recording");
      micButton.setAttribute("aria-pressed", "false");
      micButton.setAttribute("aria-label", "Говорить");
      if (!state.micDenied) micButton.disabled = state.sending;
    }
    sendButton.disabled = state.sending;
  }

  function finishRecording() {
    if (!state.recording) return;
    const mode = state.recordMode;
    const trimmed = String(state.latestTranscript || "").trim();
    const serviceDown = state.listenError === "network"
      || state.listenError === "language-not-supported"
      || state.listenError === "service-not-allowed"
      || state.listenError === "retry-local";
    if (serviceDown && mode === "send" && !state.stopRequested && !trimmed && canCaptureLocally()) {
      state.listenError = "";
      state.cloudDown = true;
      beginLocalCapture();
      return;
    }
    resetRecordingChrome();
    state.latestTranscript = "";
    if (mode === "cancel" || state.micDenied) {
      messageInput.value = state.draftBeforeRecord;
      resizeInput();
      if (state.micDenied) {
        composerStatus.textContent = "";
        liveStatus.textContent = MIC_DENIED;
      } else {
        composerStatus.textContent = "";
        liveStatus.textContent = "";
      }
      return;
    }
    if (!trimmed) {
      messageInput.value = state.draftBeforeRecord;
      resizeInput();
      sayStatus("Не расслышала. Скажите ещё раз или напишите.");
      return;
    }
    messageInput.value = trimmed;
    submitText(trimmed);
  }

  function denyMic() {
    state.micDenied = true;
    micDenied.hidden = false;
    if (micButton) {
      micButton.disabled = true;
      micButton.classList.add("is-denied");
      micButton.classList.remove("is-recording");
      micButton.setAttribute("aria-pressed", "false");
      micButton.setAttribute("aria-label", "Говорить");
    }
    liveStatus.textContent = MIC_DENIED;
  }

  function unlockAudio() {
    const AudioCtx = window.AudioContext || window.webkitAudioContext;
    if (!AudioCtx) return;
    if (!state.audioContext || state.audioContext.state === "closed") {
      state.audioContext = new AudioCtx();
    }
    const ready = state.audioContext.resume();
    if (ready && typeof ready.catch === "function") ready.catch(() => {});
  }

  function encodePcm16(chunks, rate) {
    let length = 0;
    for (let i = 0; i < chunks.length; i += 1) length += chunks[i].length;
    if (!length || !rate) return new Int16Array();
    const merged = new Float32Array(length);
    let offset = 0;
    for (let i = 0; i < chunks.length; i += 1) {
      merged.set(chunks[i], offset);
      offset += chunks[i].length;
    }
    const target = 16000;
    const outLength = Math.max(1, Math.round((merged.length * target) / rate));
    const pcm = new Int16Array(outLength);
    const ratio = rate / target;
    for (let i = 0; i < outLength; i += 1) {
      const src = i * ratio;
      const left = Math.floor(src);
      const frac = src - left;
      const a = merged[left] || 0;
      const b = merged[Math.min(left + 1, merged.length - 1)] || a;
      const sample = Math.max(-1, Math.min(1, a + (b - a) * frac));
      pcm[i] = sample < 0 ? sample * 0x8000 : sample * 0x7fff;
    }
    return pcm;
  }

  function canCaptureLocally() {
    const media = navigator.mediaDevices;
    return !state.localDown && !!media && typeof media.getUserMedia === "function";
  }

  function releaseLocal(session) {
    if (!session) return;
    try {
      if (session.processor) {
        session.processor.onaudioprocess = null;
        session.processor.disconnect();
      }
      if (session.node) {
        session.node.port.onmessage = null;
        session.node.disconnect();
      }
      if (session.source) session.source.disconnect();
      if (session.mute) session.mute.disconnect();
    } catch (error) {
      /* граф уже разобран */
    }
    session.stream.getTracks().forEach((track) => track.stop());
  }

  function failLocal(message) {
    state.localCapture = false;
    state.localSession = null;
    state.recordMode = "cancel";
    resetRecordingChrome();
    messageInput.value = state.draftBeforeRecord;
    resizeInput();
    sayStatus(message);
  }

  function openMicrophone() {
    const media = navigator.mediaDevices;
    return media.getUserMedia({
      audio: {
        channelCount: { ideal: 1 },
        echoCancellation: { ideal: false },
        noiseSuppression: { ideal: false },
        autoGainControl: { ideal: false },
      },
    }).catch((error) => {
      const name = error && error.name ? error.name : "";
      if (name === "OverconstrainedError" || name === "ConstraintNotSatisfiedError" || name === "TypeError") {
        return media.getUserMedia({ audio: true });
      }
      throw error;
    });
  }

  function showLiveText() {
    const text = state.liveParts.join(" ").replace(/\s+/g, " ").trim();
    messageInput.value = text;
    messageInput.classList.add("is-interim");
    resizeInput();
  }

  function enqueuePreview(chunks, rate) {
    const generation = state.listenGeneration;
    const pcm = encodePcm16(chunks, rate);
    if (pcm.length < 800) return;
    state.liveChain = state.liveChain.then(async () => {
      if (generation !== state.listenGeneration) return;
      let text = "";
      try {
        text = await transcribePcm(pcm);
      } catch (error) {
        return;
      }
      if (generation !== state.listenGeneration || !text) return;
      state.liveParts.push(text);
      showLiveText();
      if (state.recording) sayStatus("Слушаю…");
    }).catch(() => {});
  }

  async function transcribePcm(pcm) {
    const bytes = new Uint8Array(pcm.buffer, pcm.byteOffset, pcm.byteLength);
    const response = await fetch("/api/speech", {
      method: "POST",
      headers: { "Content-Type": "application/octet-stream" },
      body: bytes,
    });
    if (!response.ok) {
      if (response.status === 503) state.localDown = true;
      return "";
    }
    const data = await response.json();
    return data && data.text ? String(data.text).trim() : "";
  }

  function absorbSamples(bucket, input, rate) {
    bucket.chunks.push(new Float32Array(input));
    const ms = (input.length / rate) * 1000;
    const action = noteCapture(bucket, frameLevel(input), ms);
    if (action === "preview") {
      enqueuePreview(bucket.chunks.splice(0), rate);
      return;
    }
    if (action === "finish") requestStopRecording("send");
  }

  function captureIsActive() {
    return state.localCapture && state.recording && state.recordMode !== "cancel";
  }

  function beginLocalCapture() {
    if (state.localCapture) return;
    state.localCapture = true;
    sayStatus("Слушаю…");
    if (!canCaptureLocally()) {
      failLocal(SPEECH_UNAVAILABLE);
      return;
    }
    openMicrophone().then((stream) => {
      const stopStream = () => stream.getTracks().forEach((track) => track.stop());
      if (!captureIsActive()) {
        stopStream();
        state.localCapture = false;
        return;
      }
      const audioContext = state.audioContext;
      if (!audioContext || typeof audioContext.createScriptProcessor !== "function") {
        stopStream();
        failLocal(SPEECH_UNAVAILABLE);
        return;
      }
      const resume = audioContext.resume();
      const startGraph = () => {
        if (!captureIsActive()) {
          stopStream();
          state.localCapture = false;
          return;
        }
        try {
          const source = audioContext.createMediaStreamSource(stream);
          const processor = audioContext.createScriptProcessor(4096, 1, 1);
          const mute = audioContext.createGain();
          mute.gain.value = 0.00001;
          const bucket = {
            chunks: [], heard: false, quiet: 0, elapsed: 0,
            chunkHeard: false, chunkQuiet: 0, chunkElapsed: 0,
          };
          const rate = audioContext.sampleRate || 48000;
          processor.onaudioprocess = (event) => {
            if (!state.localCapture) return;
            absorbSamples(bucket, event.inputBuffer.getChannelData(0), rate);
          };
          source.connect(processor);
          processor.connect(mute);
          mute.connect(audioContext.destination);
          state.localSession = { stream, source, processor, mute, chunks: bucket.chunks, rate, bucket };
        } catch (error) {
          stopStream();
          failLocal(SPEECH_UNAVAILABLE);
        }
      };
      if (resume && typeof resume.then === "function") resume.then(startGraph, startGraph);
      else startGraph();
    }).catch((error) => {
      const name = error && error.name ? error.name : "";
      state.localCapture = false;
      if (name === "NotAllowedError" || name === "SecurityError") {
        state.recordMode = "cancel";
        denyMic();
        resetRecordingChrome();
        messageInput.value = state.draftBeforeRecord;
        resizeInput();
        return;
      }
      failLocal(SPEECH_UNAVAILABLE);
    });
  }

  async function finishLocalCapture() {
    if (state.localFinishing) return;
    state.localFinishing = true;
    const session = state.localSession;
    const mode = state.recordMode;
    state.localSession = null;
    state.localCapture = false;
    releaseLocal(session);
    resetRecordingChrome();
    state.latestTranscript = "";
    if (mode === "cancel" || state.micDenied) {
      state.listenGeneration += 1;
      messageInput.value = state.draftBeforeRecord;
      resizeInput();
      composerStatus.textContent = "";
      liveStatus.textContent = state.micDenied ? MIC_DENIED : "";
      state.localFinishing = false;
      return;
    }
    const generation = state.listenGeneration;
    if (session && session.bucket.chunkHeard && session.chunks.length) {
      enqueuePreview(session.chunks.splice(0), session.rate);
    }
    sayStatus(state.liveParts.length ? "Распознаю…" : "Слушаю…");
    messageInput.classList.add("is-interim");
    sendButton.disabled = true;
    if (micButton) micButton.disabled = true;
    try {
      await state.liveChain;
      if (generation !== state.listenGeneration) return;
      const text = state.liveParts.join(" ").replace(/\s+/g, " ").trim();
      messageInput.classList.remove("is-interim");
      if (!text) {
        messageInput.value = state.draftBeforeRecord;
        resizeInput();
        sayStatus(state.localDown ? SPEECH_UNAVAILABLE : "Не расслышала. Скажите ещё раз или напишите.");
        return;
      }
      messageInput.value = text;
      resizeInput();
      submitText(text);
    } catch (error) {
      if (generation !== state.listenGeneration) return;
      messageInput.classList.remove("is-interim");
      messageInput.value = state.draftBeforeRecord;
      resizeInput();
      sayStatus(SEND_ERROR);
    } finally {
      state.localFinishing = false;
      if (!state.sending) {
        sendButton.disabled = false;
        if (micButton && !state.micDenied) micButton.disabled = false;
      }
    }
  }

  function startCloudRecognition() {
    const recognition = state.recognition;
    const generation = state.listenGeneration;
    if (!recognition || !state.recording) {
      resetRecordingChrome();
      messageInput.value = state.draftBeforeRecord;
      resizeInput();
      sayStatus(SPEECH_UNAVAILABLE);
      return;
    }
    let ended = false;
    recognition.onend = () => {
      if (ended || generation !== state.listenGeneration) return;
      ended = true;
      if (String(state.latestTranscript || "").trim()) {
        finishRecording();
        return;
      }
      window.setTimeout(() => {
        if (generation !== state.listenGeneration || !state.recording) return;
        finishRecording();
      }, 120);
    };
    try {
      recognition.start();
    } catch (error) {
      state.cloudDown = true;
      if (canCaptureLocally()) beginLocalCapture();
      else {
        resetRecordingChrome();
        messageInput.value = state.draftBeforeRecord;
        resizeInput();
        sayStatus(SPEECH_UNAVAILABLE);
      }
    }
  }

  function startRecording() {
    if (state.recording || state.sending || state.micDenied || !micButton) return;
    if (!confirmDialog.hidden) return;
    if (!canCaptureLocally() && !state.recognition) return;
    state.draftBeforeRecord = messageInput.value;
    state.latestTranscript = "";
    state.listenError = "";
    state.recordMode = "send";
    state.stopRequested = false;
    state.localFinishing = false;
    state.liveParts = [];
    state.liveChain = Promise.resolve();
    state.placeholderBefore = messageInput.placeholder;
    state.recording = true;
    state.listenGeneration += 1;
    unlockAudio();
    cancelSpeech();
    messageInput.readOnly = true;
    messageInput.value = "";
    messageInput.placeholder = "Слушаю…";
    messageInput.classList.add("is-interim");
    if (composerBox) composerBox.classList.add("is-listening");
    micButton.classList.add("is-recording");
    startMicTimer();
    micButton.setAttribute("aria-pressed", "true");
    micButton.setAttribute("aria-label", "Остановить запись");
    sendButton.disabled = true;
    sayStatus("Слушаю…");
    // Chrome отправляет Web Speech API на серверы Google. Если они недоступны,
    // браузер отвечает network и фраза пропадает. Сначала пишем звук сами.
    if (canCaptureLocally()) {
      beginLocalCapture();
      return;
    }
    startCloudRecognition();
  }

  function requestStopRecording(mode) {
    if (!state.recording) return;
    state.recordMode = mode;
    state.stopRequested = true;
    if (state.localCapture || state.localSession) {
      finishLocalCapture();
      return;
    }
    try {
      if (!state.recognition) {
        finishRecording();
        return;
      }
      if (mode === "cancel") state.recognition.abort();
      else state.recognition.stop();
    } catch (error) {
      finishRecording();
    }
  }

  function preferOnDevice(recognition) {
    const Ctor = recognition.constructor;
    if (typeof Ctor.available !== "function") return;
    Ctor.available({ langs: ["ru-RU"], processLocally: true }).then((status) => {
      if (status === "available") recognition.processLocally = true;
    }).catch(() => {});
  }

  function bindRecognition(recognition) {
    recognition.lang = "ru-RU";
    recognition.interimResults = true;
    recognition.continuous = false;
    recognition.onresult = (event) => {
      let text = "";
      for (let i = 0; i < event.results.length; i += 1) {
        text += event.results[i][0].transcript;
      }
      state.latestTranscript = text;
      messageInput.value = text;
      messageInput.classList.add("is-interim");
      resizeInput();
    };
    recognition.onerror = (event) => {
      const code = event.error || "";
      if (code === "not-allowed") {
        state.recordMode = "cancel";
        denyMic();
        return;
      }
      if (code === "network" || code === "language-not-supported" || code === "service-not-allowed") {
        state.listenError = code;
        return;
      }
      if (code === "no-speech" || code === "audio-capture") {
        state.listenError = "retry-local";
        return;
      }
      if (code === "aborted") {
        if (state.recordMode !== "send") state.recordMode = "cancel";
      }
    };
    state.recognition = recognition;
    preferOnDevice(recognition);
  }

  function setupRecognition() {
    const Ctor = window.SpeechRecognition || window.webkitSpeechRecognition;
    const localOk = canCaptureLocally();
    if (!Ctor && !localOk) {
      if (micButton) micButton.remove();
      micButton = null;
      voiceUnsupported.hidden = false;
      liveStatus.textContent = VOICE_UNSUPPORTED;
      return;
    }
    voiceUnsupported.hidden = true;
    if (Ctor) {
      try {
        bindRecognition(new Ctor());
      } catch (error) {
        if (!localOk) {
          if (micButton) micButton.remove();
          micButton = null;
          voiceUnsupported.hidden = false;
          liveStatus.textContent = VOICE_UNSUPPORTED;
          return;
        }
      }
    }
    if (!micButton) return;
    micButton.addEventListener("click", () => {
      if (state.micDenied || micButton.disabled) return;
      if (state.recording) requestStopRecording("send");
      else startRecording();
    });
  }

  function onKeyDown(event) {
    if (event.key === "Escape") {
      if (!menu.hidden) {
        event.preventDefault();
        closeMenu(true);
        return;
      }
      if (!confirmDialog.hidden) {
        event.preventDefault();
        closeConfirm();
        return;
      }
      if (state.recording) {
        event.preventDefault();
        requestStopRecording("cancel");
        return;
      }
      if (!speechStop.hidden) {
        event.preventDefault();
        cancelSpeech();
      }
      return;
    }
    if (event.key === "Tab" && !confirmDialog.hidden) {
      const buttons = dialogButtons();
      if (!buttons.length) return;
      const first = buttons[0];
      const last = buttons[buttons.length - 1];
      const active = document.activeElement;
      if (event.shiftKey && (active === first || !confirmDialog.contains(active))) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && (active === last || !confirmDialog.contains(active))) {
        event.preventDefault();
        first.focus();
      }
      return;
    }
    if (event.altKey && !event.ctrlKey && !event.metaKey && event.code === "KeyM") {
      if (!confirmDialog.hidden) return;
      if (!micButton || !micButton.isConnected || state.micDenied) return;
      event.preventDefault();
      if (state.recording) requestStopRecording("send");
      else startRecording();
    }
  }

  function bind() {
    colorStore.addEventListener("change", () => {
      document.querySelectorAll("article.event-card").forEach((card) => {
        const event = cardData.get(card);
        if (event) paintObject(card, event);
      });
    });
    eventStore.addEventListener("change", () => {
      document.querySelectorAll("article.event-card").forEach((card) => {
        const current = eventStore.events.find((event) => event.id === Number(card.dataset.eventId));
        const previous = cardData.get(card);
        if (current && previous && ["title", "date", "time", "status"].some((key) => current[key] !== previous[key])) {
          const index = card.querySelector(".event-card__index");
          const next = createCard(current, {
            showIndex: Boolean(index), index: index ? Number(index.textContent) : 0,
            showChoice: Boolean(card.querySelector('[data-action="choice"]')),
          });
          next.hidden = card.hidden;
          card.replaceWith(next);
          card = next;
        }
        const busy = eventStore.saving.has(Number(card.dataset.eventId));
        card.querySelectorAll("button").forEach((button) => { button.disabled = busy; });
      });
    });
    function stopHiddenVoice() {
      if (state.recording) requestStopRecording("cancel");
      cancelSpeech();
    }
    window.addEventListener("ritm:assistant-hidden", stopHiddenVoice);
    window.addEventListener("pagehide", stopHiddenVoice);
    document.getElementById("skip-to-input").addEventListener("click", (event) => {
      event.preventDefault();
      const mobileOpen = document.getElementById("mobile-ai-open");
      if (window.matchMedia("(max-width: 1024px)").matches && mobileOpen instanceof HTMLElement) {
        if (mobileOpen.getAttribute("aria-expanded") !== "true") mobileOpen.click();
      } else document.getElementById("assistant-open").click();
      messageInput.focus();
    });
    composer.addEventListener("submit", (event) => {
      event.preventDefault();
      if (state.recording) return;
      submitText(messageInput.value);
    });
    messageInput.addEventListener("keydown", (event) => {
      if (event.key === "Enter" && !event.shiftKey) {
        event.preventDefault();
        if (!state.recording) submitText(messageInput.value);
      }
    });
    messageInput.addEventListener("input", resizeInput);
    historyRetry.addEventListener("click", () => {
      loadHistory();
    });
    menuButton.addEventListener("click", () => {
      if (menu.hidden) openMenu();
      else closeMenu(true);
    });
    document.addEventListener("click", (event) => {
      if (menu.hidden) return;
      if (menu.contains(event.target) || menuButton.contains(event.target)) return;
      closeMenu(false);
    });
    newChatButton.addEventListener("click", startNewChat);
    speechToggle.addEventListener("click", () => {
      state.speechOn = !state.speechOn;
      writeStore(localStorage, "ritm.speech", state.speechOn ? "on" : "off");
      renderSpeechToggle();
      if (!state.speechOn) cancelSpeech();
      else {
        try { window.speechSynthesis.resume(); } catch { /* browser may not implement resume */ }
        speak(state.lastReply?.speech || "Озвучивание включено");
      }
    });
    speechStop.addEventListener("click", () => {
      cancelSpeech();
    });
    confirmKeep.addEventListener("click", closeConfirm);
    confirmDelete.addEventListener("click", () => {
      performDelete();
    });
    confirmRetry.addEventListener("click", () => {
      performDelete();
    });
    confirmDialog.addEventListener("click", (event) => {
      if (event.target === confirmDialog) closeConfirm();
    });
    document.addEventListener("keydown", onKeyDown);
    document.addEventListener("visibilitychange", () => {
      if (document.visibilityState === "visible") maybeNewDay();
    });
    window.addEventListener("focus", maybeNewDay);
  }

  state.sessionId = ensureSessionId();
  window.addEventListener("ritm:workspace-before-change", event => {
    if (state.sending || state.recording || state.localFinishing || state.deleteFlight || state.confirm || patching.size) event.preventDefault();
  });
  window.addEventListener("ritm:workspace-changed", event => {
    const next = event.detail.id || 1;
    if (workspaceReady && next === activeWorkspaceId) return;
    if (workspaceReady) workspaceDrafts.set(activeWorkspaceId, messageInput.value);
    else workspaceDrafts.set(next, messageInput.value);
    activeWorkspaceId = next; workspaceReady = true;
    state.historyGeneration += 1; state.posted = false; state.lastReply = null;
    cancelSpeech(); dialogue.replaceChildren(); clearSuggestions(); resetPlaceholder();
    pendingHint.hidden = true; composerStatus.textContent = "";
    messageInput.value = workspaceDrafts.get(next) || ""; resizeInput();
    colorStore.creationColor = null; colorStore.changed();
    enterEmpty(); loadHistory();
  });
  setupSpeech();
  setupRecognition();
  window.addEventListener("ritm:event-deleted", event => {
    dialogue.querySelectorAll(`[data-event-id="${event.detail.id}"]`).forEach(card => card.remove());
  });
  bind();
  resizeInput();
  maybeNewDay();
  if (workspaceStore.loaded) loadHistory();
  // Dashboard navigation keeps focus until the user opens the composer.
})();
