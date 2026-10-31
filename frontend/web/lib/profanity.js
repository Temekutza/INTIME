// @ts-check
// Словарь снят с пакета safetext. Сервер проверяет текст той же библиотекой.

import { PROFANITY_WORDS } from "./profanity-words.js";

const TOKEN = /[0-9A-Za-zА-Яа-яЁё]+(?:[*._'\-]+[0-9A-Za-zА-Яа-яЁё]+)*/g;
/** @type {Record<string, string>} */
const LEET = { "@": "а", "0": "о", "3": "е", "6": "б" };
const LETTERS = "абвгдежзийклмнопрстуфхцчшщъыьэюя";
const MASK = new Set(["*", ".", "_", "'", "-"]);

/** @param {string} token */
function known(token) {
  return PROFANITY_WORDS.has(token);
}

/** @param {string} token */
function hidden(token) {
  let folded = token.toLowerCase().replaceAll("ё", "е");
  folded = [...folded].map((char) => LEET[char] || char).join("");
  const positions = [...folded].flatMap((char, index) => (MASK.has(char) ? [index] : []));
  if (positions.length !== 1 || folded.length > 24) return false;
  const index = positions[0];
  for (const letter of LETTERS) {
    if (known(folded.slice(0, index) + letter + folded.slice(index + 1))) return true;
  }
  return false;
}

/** @param {string} token */
function obscene(token) {
  const folded = token.toLowerCase().replaceAll("ё", "е");
  return known(folded) || hidden(token);
}

/** @param {string} text @returns {Array<[number, number]>} */
function spans(text) {
  /** @type {Array<[number, number]>} */
  const found = [];
  TOKEN.lastIndex = 0;
  for (const match of text.matchAll(TOKEN)) {
    if (match.index !== undefined && obscene(match[0])) {
      found.push([match.index, match.index + match[0].length]);
    }
  }
  return found;
}

/** @param {string} text */
export function hasProfanity(text) {
  return spans(text).length > 0;
}

/** @param {string} text */
export function maskProfanity(text) {
  let cursor = 0;
  let result = "";
  for (const [start, end] of spans(text)) {
    result += text.slice(cursor, start) + "*".repeat(end - start);
    cursor = end;
  }
  return result + text.slice(cursor);
}
