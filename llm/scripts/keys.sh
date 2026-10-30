#!/usr/bin/env bash
# Администрирование виртуальных ключей LiteLLM.
# Master key читается из .env и не печатается.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
ENV_FILE="${ENV_FILE:-$ROOT/.env}"
BASE_URL="${LITELLM_BASE_URL:-http://127.0.0.1:4000}"
SECRETS_DIR="$ROOT/llm/secrets"

die() {
  echo "$*" >&2
  exit 1
}

env_get() {
  local key="$1"
  local line
  [[ -f "$ENV_FILE" ]] || die "Нет файла $ENV_FILE"
  line="$(grep -E "^${key}=" "$ENV_FILE" | tail -n 1 || true)"
  [[ -n "$line" ]] || die "В .env нет ${key}"
  printf '%s' "${line#*=}"
}

master_key() {
  local key
  key="$(env_get LITELLM_MASTER_KEY)"
  [[ "$key" == sk-* ]] || die "LITELLM_MASTER_KEY должен начинаться с sk-"
  printf '%s' "$key"
}

api() {
  local method="$1"
  local path="$2"
  local body="${3:-}"
  local key
  key="$(master_key)"
  if [[ -n "$body" ]]; then
    curl -sS -w '\n%{http_code}' -X "$method" "${BASE_URL}${path}" \
      -H "Authorization: Bearer ${key}" \
      -H "Content-Type: application/json" \
      -d "$body"
  else
    curl -sS -w '\n%{http_code}' -X "$method" "${BASE_URL}${path}" \
      -H "Authorization: Bearer ${key}"
  fi
}

split_response() {
  local raw="$1"
  HTTP_CODE="${raw##*$'\n'}"
  HTTP_BODY="${raw%$'\n'*}"
}

usage() {
  cat <<'EOF'
Использование:
  llm/scripts/keys.sh create --alias NAME [--rpm N] [--tpm N] [--duration 30d] [--models qwen3-32b]
  llm/scripts/keys.sh info --alias NAME
  llm/scripts/keys.sh revoke --alias NAME

Ключ сохраняется в llm/secrets/NAME.key (каталог в .gitignore).
Master key клиентским приложениям не выдаётся.
EOF
}

alias_file() {
  local name="$1"
  [[ "$name" =~ ^[A-Za-z0-9._-]+$ ]] || die "Недопустимый alias"
  printf '%s/%s.key' "$SECRETS_DIR" "$name"
}

cmd_create() {
  local alias="" rpm="30" tpm="20000" duration="30d" models="qwen3-32b"
  while [[ $# -gt 0 ]]; do
    case "$1" in
      --alias) alias="$2"; shift 2 ;;
      --rpm) rpm="$2"; shift 2 ;;
      --tpm) tpm="$2"; shift 2 ;;
      --duration) duration="$2"; shift 2 ;;
      --models) models="$2"; shift 2 ;;
      *) die "Неизвестный аргумент: $1" ;;
    esac
  done
  [[ -n "$alias" ]] || die "Нужен --alias"
  local file payload raw
  file="$(alias_file "$alias")"
  mkdir -p "$SECRETS_DIR"
  chmod 700 "$SECRETS_DIR"
  payload="$(ALIAS="$alias" RPM="$rpm" TPM="$tpm" DURATION="$duration" MODELS="$models" python3 - <<'PY'
import json, os
models = [item.strip() for item in os.environ["MODELS"].split(",") if item.strip()]
print(json.dumps({
    "key_alias": os.environ["ALIAS"],
    "models": models,
    "rpm_limit": int(os.environ["RPM"]),
    "tpm_limit": int(os.environ["TPM"]),
    "duration": os.environ["DURATION"],
}))
PY
)"
  raw="$(api POST /key/generate "$payload")"
  split_response "$raw"
  [[ "$HTTP_CODE" == "200" ]] || die "key/generate вернул ${HTTP_CODE}: ${HTTP_BODY}"
  KEY_FILE="$file" RESPONSE="$HTTP_BODY" python3 - <<'PY'
import json, os
from pathlib import Path
body = json.loads(os.environ["RESPONSE"])
key = body.get("key") or ""
if not key.startswith("sk-"):
    raise SystemExit("В ответе нет ключа")
path = Path(os.environ["KEY_FILE"])
path.write_text(key + "\n", encoding="utf-8")
path.chmod(0o600)
info = body.get("info") or {}
print(f"alias: {body.get('key_alias') or info.get('key_alias')}")
print(f"expires: {body.get('expires') or info.get('expires')}")
print(f"rpm_limit: {body.get('rpm_limit') if body.get('rpm_limit') is not None else info.get('rpm_limit')}")
print(f"tpm_limit: {body.get('tpm_limit') if body.get('tpm_limit') is not None else info.get('tpm_limit')}")
print(f"file: {path}")
PY
}

cmd_info() {
  local alias=""
  while [[ $# -gt 0 ]]; do
    case "$1" in
      --alias) alias="$2"; shift 2 ;;
      *) die "Неизвестный аргумент: $1" ;;
    esac
  done
  [[ -n "$alias" ]] || die "Нужен --alias"
  local file key raw
  file="$(alias_file "$alias")"
  [[ -f "$file" ]] || die "Нет файла ключа: $file"
  key="$(tr -d '[:space:]' < "$file")"
  raw="$(api POST /v2/key/info "$(python3 -c 'import json,os; print(json.dumps({"key_aliases":[os.environ["ALIAS"]]}))' ALIAS="$alias")")"
  split_response "$raw"
  [[ "$HTTP_CODE" == "200" ]] || die "key/info вернул ${HTTP_CODE}: ${HTTP_BODY}"
  RESPONSE="$HTTP_BODY" python3 - <<'PY'
import json, os
body = json.loads(os.environ["RESPONSE"])
info = body.get("info") or body
if isinstance(info, list):
    info = info[0] if info else {}
print(json.dumps({
    "key_alias": info.get("key_alias"),
    "models": info.get("models"),
    "rpm_limit": info.get("rpm_limit"),
    "tpm_limit": info.get("tpm_limit"),
    "expires": info.get("expires"),
    "spend": info.get("spend"),
    "max_budget": info.get("max_budget"),
    "blocked": info.get("blocked"),
}, ensure_ascii=False, indent=2))
PY
}

cmd_revoke() {
  local alias=""
  while [[ $# -gt 0 ]]; do
    case "$1" in
      --alias) alias="$2"; shift 2 ;;
      *) die "Неизвестный аргумент: $1" ;;
    esac
  done
  [[ -n "$alias" ]] || die "Нужен --alias"
  local file key raw
  file="$(alias_file "$alias")"
  [[ -f "$file" ]] || die "Нет файла ключа: $file"
  key="$(tr -d '[:space:]' < "$file")"
  raw="$(api POST /key/delete "$(KEY="$key" python3 -c 'import json,os; print(json.dumps({"keys":[os.environ["KEY"]]}))')")"
  split_response "$raw"
  [[ "$HTTP_CODE" == "200" ]] || die "key/delete вернул ${HTTP_CODE}: ${HTTP_BODY}"
  rm -f "$file"
  echo "отозван: ${alias}"
}

main() {
  local cmd="${1:-}"
  shift || true
  case "$cmd" in
    create) cmd_create "$@" ;;
    info) cmd_info "$@" ;;
    revoke) cmd_revoke "$@" ;;
    -h|--help|help|"") usage ;;
    *) die "Неизвестная команда: $cmd" ;;
  esac
}

main "$@"
