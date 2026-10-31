#!/usr/bin/env bash
# Локальный алиас Qwen3 поверх уже скачанных весов. Службу Ollama не меняет.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
export OLLAMA_HOST="${OLLAMA_HOST:-http://127.0.0.1:11435}"

ollama create intime-qwen3-32b -f "$ROOT/llm/gateway/Modelfile.qwen3"
ollama list
