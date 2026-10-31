#!/usr/bin/env python3
"""Один запрос к локальному шлюзу через официальный OpenAI SDK."""

import os
import sys
from pathlib import Path

from openai import OpenAI

root = Path(__file__).resolve().parents[2]
alias = os.environ.get("KEY_ALIAS", "intime-app")
key_file = Path(os.environ.get("KEY_FILE", root / "llm" / "secrets" / f"{alias}.key"))
base_url = os.environ.get("LITELLM_BASE_URL", "http://127.0.0.1:4000/v1")

if not key_file.is_file():
    sys.exit(f"Нет ключа {key_file}")

key = key_file.read_text(encoding="utf-8").strip()
client = OpenAI(base_url=base_url, api_key=key)
completion = client.chat.completions.create(
    model="qwen3-32b",
    temperature=0,
    max_tokens=16,
    messages=[{"role": "user", "content": "Ответь одним словом: да"}],
)
text = (completion.choices[0].message.content or "").strip()
if not text:
    sys.exit("SDK получил пустой ответ")
print(text)
print("OK: OpenAI SDK")
