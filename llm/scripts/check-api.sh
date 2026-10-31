#!/usr/bin/env bash
# Проверка локального LiteLLM: живость, отказ без ключа, модели, ответ, stream.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
BASE_URL="${LITELLM_BASE_URL:-http://127.0.0.1:4000}"
ALIAS="${KEY_ALIAS:-intime-app}"
KEY_FILE="${KEY_FILE:-$ROOT/llm/secrets/${ALIAS}.key}"

die() {
  echo "FAIL: $*" >&2
  exit 1
}

ok() {
  echo "OK: $*"
}

[[ -f "$KEY_FILE" ]] || die "Нет ключа $KEY_FILE. Сначала: llm/scripts/keys.sh create --alias ${ALIAS}"
KEY="$(tr -d '[:space:]' < "$KEY_FILE")"
[[ "$KEY" == sk-* ]] || die "Ключ в файле не похож на sk-"

code="$(curl -sS -o /tmp/intime-llm-live.txt -w '%{http_code}' "${BASE_URL}/health/liveliness")"
[[ "$code" == "200" ]] || die "liveliness HTTP ${code}"
ok "шлюз отвечает на ${BASE_URL}"

code="$(curl -sS -o /tmp/intime-llm-noauth.txt -w '%{http_code}' \
  -H 'Content-Type: application/json' \
  -d '{"model":"qwen3-32b","messages":[{"role":"user","content":"ping"}]}' \
  "${BASE_URL}/v1/chat/completions")"
[[ "$code" == "401" || "$code" == "403" ]] || die "запрос без ключа вернул ${code}, ожидался отказ"
ok "запрос без ключа отклонён (${code})"

code="$(curl -sS -o /tmp/intime-llm-models.json -w '%{http_code}' \
  -H "Authorization: Bearer ${KEY}" \
  "${BASE_URL}/v1/models")"
[[ "$code" == "200" ]] || die "список моделей HTTP ${code}: $(cat /tmp/intime-llm-models.json)"
python3 - <<'PY' || die "в списке моделей нет qwen3-32b"
import json
data = json.load(open("/tmp/intime-llm-models.json"))
names = [item.get("id") for item in data.get("data", [])]
if "qwen3-32b" not in names:
    raise SystemExit(names)
PY
ok "модель qwen3-32b видна"

code="$(curl -sS -o /tmp/intime-llm-chat.json -w '%{http_code}' \
  -H "Authorization: Bearer ${KEY}" \
  -H 'Content-Type: application/json' \
  -d '{"model":"qwen3-32b","max_tokens":16,"temperature":0,"messages":[{"role":"user","content":"Ответь одним словом: да"}]}' \
  "${BASE_URL}/v1/chat/completions")"
[[ "$code" == "200" ]] || die "chat/completions HTTP ${code}: $(cat /tmp/intime-llm-chat.json)"
python3 - <<'PY' || die "в ответе нет текста"
import json
data = json.load(open("/tmp/intime-llm-chat.json"))
content = data["choices"][0]["message"].get("content") or ""
if not content.strip():
    raise SystemExit(json.dumps(data, ensure_ascii=False)[:500])
print(content.strip())
PY
ok "генерация ответа"

curl -sS -N \
  -H "Authorization: Bearer ${KEY}" \
  -H 'Content-Type: application/json' \
  -d '{"model":"qwen3-32b","max_tokens":16,"temperature":0,"stream":true,"messages":[{"role":"user","content":"Ответь одним словом: да"}]}' \
  "${BASE_URL}/v1/chat/completions" > /tmp/intime-llm-stream.txt
grep -q '^data: ' /tmp/intime-llm-stream.txt || die "stream не содержит data:"
grep -q '\[DONE\]' /tmp/intime-llm-stream.txt || die "stream не содержит [DONE]"
ok "streaming"

rm -f /tmp/intime-llm-live.txt /tmp/intime-llm-noauth.txt /tmp/intime-llm-models.json /tmp/intime-llm-chat.json /tmp/intime-llm-stream.txt
echo "проверки пройдены"
