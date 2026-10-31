// @ts-check
// Тот же список держит backend/app/services/text_guard.py.

const TOKEN = /[0-9A-Za-zА-Яа-яЁё]+(?:[*._'\-]+[0-9A-Za-zА-Яа-яЁё]+)*/g;
/** @type {Record<string, string>} */
const LEET = { "@": "а", "0": "о", "3": "е", "6": "б" };
const LETTERS = "абвгдежзийклмнопрстуфхцчшщъыьэюя";
const OBSCENE = new RegExp(
  "^(?:" +
    "ху[йяеи][а-я]*" +
    "|пизд[а-я]*" +
    "|пезд[а-я]*" +
    "|(?:по|на|за|вы|до|от|раз|рас|про|пере|под|при|из|об|вз|долбо|у|о|с)*еб(?:[ауиолстшеы][а-я]*)?" +
    "|бля(?:ть|д[а-я]*)?" +
    "|су(?:ка|ки|ку|ке|кой|кою|кам|ках|чар[а-я]*)" +
    "|пид[оае]р[а-я]*" +
    "|пидр[а-я]*" +
    "|муд(?:ак[а-я]*|ач[а-я]*|ил[а-я]*|о[а-я]*)" +
    "|гандон[а-я]*" +
    "|залуп[а-я]*" +
    "|дроч[а-я]*" +
    "|елд[аыуе][а-я]*" +
    "|(?:по|на)хер[а-я]*" +
    "|хер(?:а[а-я]*|у[а-я]*|ом[а-я]*|ня[а-я]*|ов[а-я]*|е[а-я]*)?" +
    "|манда" +
    ")$",
);

/** @param {string} text @returns {string[]} */
function expand(text) {
  if (!text.includes("?")) return [text];
  const index = text.indexOf("?");
  const head = text.slice(0, index);
  const tail = text.slice(index + 1);
  /** @type {string[]} */
  const found = [];
  for (const piece of expand(tail)) {
    found.push(head + piece);
    for (const letter of LETTERS) found.push(head + letter + piece);
  }
  return found;
}

/** @param {string} token @returns {string[]} */
function keys(token) {
  let text = token.toLowerCase().replaceAll("ё", "е");
  text = [...text].map((char) => LEET[char] || char).join("");
  text = text.replace(/[*._'\-]+/g, "?");
  text = text.replace(/(.)\1+/g, "$1");
  if ((text.match(/\?/g) || []).length > 2) text = text.replaceAll("?", "");
  return expand(text).filter(Boolean);
}

/** @param {string} token */
function obscene(token) {
  return keys(token).some((key) => OBSCENE.test(key));
}

/** @param {string} text @returns {Array<[number, number]>} */
function spans(text) {
  /** @type {Array<[number, number]>} */
  const found = [];
  TOKEN.lastIndex = 0;
  for (const match of text.matchAll(TOKEN)) {
    if (match.index !== undefined && obscene(match[0])) found.push([match.index, match.index + match[0].length]);
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
