import test from "node:test";
import assert from "node:assert/strict";
import { hasProfanity, maskProfanity } from "../lib/profanity.js";

test("ordinary phrase stays", () => {
  const text = "Поставь задачу проверить макет";
  assert.equal(maskProfanity(text), text);
  assert.equal(hasProfanity(text), false);
});

test("similar words are not profanity", () => {
  for (const text of ["учебник по истории", "купить хлеб и сукно", "мандарин и бляха", "поездка в Херсон", "мудрый коллега"]) {
    assert.equal(hasProfanity(text), false, text);
    assert.equal(maskProfanity(text), text);
  }
});

test("mixed phrase is masked", () => {
  assert.equal(maskProfanity("Поставь задачу, блять, проверить макет"), "Поставь задачу, *****, проверить макет");
});

test("obfuscated word is masked", () => {
  assert.equal(maskProfanity("х*й"), "***");
  assert.equal(hasProfanity("х*й"), true);
});
