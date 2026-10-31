# LLM API Gateway

Локальный OpenAI-совместимый шлюз к системной Ollama. Модель снаружи называется `qwen3-32b`. За ней стоит локальный алиас `intime-qwen3-32b`: те же веса `hf.co/Qwen/Qwen3-32B-GGUF:Q5_K_M`, но шаблон закрывает блок рассуждений, когда `think` выключен. Исходная модель Ollama не удаляется. Алиас создаётся так:

```bash
OLLAMA_HOST=http://127.0.0.1:11435 ollama create intime-qwen3-32b -f llm/gateway/Modelfile.qwen3
```

Docker Ollama на порту `11434` и контейнер `ai-corptracker_06-ollama-1` к этому шлюзу не относятся.

```text
клиент (SSH-туннель или хост)
        |
        v
LiteLLM 127.0.0.1:4000
        |  ключ, лимиты, учёт
        v
PostgreSQL 127.0.0.1:5436
        |
        v
Ollama 127.0.0.1:11435
        |
        v
Qwen3-32B Q5_K_M на RTX 4090
```

Конфигурация шлюза: `llm/gateway/config.yaml`. Сервисы `litellm` и `litellm-db` описаны в корневом `docker-compose.yml`. Отдельного Compose внутри `llm/` нет.

LiteLLM запущен в сети хоста, потому что Ollama слушает только loopback. Из обычной Docker-сети `127.0.0.1:11435` — это сам контейнер, а не хост. Приложение ходит на `http://host.docker.internal:4000/v1`: сервис `litellm-docker` слушает адрес `docker0` и передаёт запрос на `127.0.0.1:4000`. Адрес локальной сети для этого не используется.

## Запуск

Из корня INTIME, не трогая уже работающие сервисы других проектов:

```bash
docker-compose up -d litellm
```

Compose поднимет `litellm-db` как зависимость. `db`, `backend` и `frontend` этой командой не пересоздаются.

Проверка конфигурации:

```bash
docker-compose config --quiet
```

## Ключи

Master key лежит в `.env` (`LITELLM_MASTER_KEY`) и нужен только для выпуска и отзыва ключей. Приложениям его не передают.

Создать отдельный ключ приложения на 30 дней, 30 запросов в минуту и 20000 токенов в минуту:

```bash
llm/scripts/keys.sh create --alias intime-app --rpm 30 --tpm 20000 --duration 30d
```

Файл ключа: `llm/secrets/intime-app.key`. Каталог `llm/secrets/` не коммитится.

Посмотреть лимиты и расход. Запрос идёт по alias, ключ в URL не попадает:

```bash
llm/scripts/keys.sh info --alias intime-app
```

Отозвать ключ:

```bash
llm/scripts/keys.sh revoke --alias intime-app
```

Повторный `create` с тем же alias LiteLLM может отклонить. Для нового ключа нужен другой alias либо сначала отзыв.

## Вызов

Проверка шлюза, отказа без ключа, списка моделей, ответа и stream:

```bash
llm/scripts/check-api.sh
```

curl:

```bash
curl http://127.0.0.1:4000/v1/chat/completions \
  -H "Authorization: Bearer $(cat llm/secrets/intime-app.key)" \
  -H "Content-Type: application/json" \
  -d '{"model":"qwen3-32b","max_tokens":32,"messages":[{"role":"user","content":"Ответь одним словом: да"}]}'
```

Python (пакет `openai`):

```python
from pathlib import Path
from openai import OpenAI

client = OpenAI(
    base_url="http://127.0.0.1:4000/v1",
    api_key=Path("llm/secrets/intime-app.key").read_text().strip(),
)
response = client.chat.completions.create(
    model="qwen3-32b",
    max_tokens=32,
    messages=[{"role": "user", "content": "Ответь одним словом: да"}],
)
print(response.choices[0].message.content)
```

С другой машины, пока нет HTTPS:

```bash
ssh -L 4000:127.0.0.1:4000 medj@<сервер>
```

После туннеля тот же `http://127.0.0.1:4000/v1` открывается локально.

## Ресурсы

Веса Q5_K_M — около 23 ГБ при 24 ГБ VRAM. В конфиге контекст ограничен `num_ctx: 2048`, а на модель стоит предел 6 запросов в минуту. Одновременно имеет смысл держать один запрос. Таймаут запроса — 600 секунд: первая загрузка модели в GPU долгая.

Системные настройки Ollama не меняются. Смотреть загрузку:

```bash
OLLAMA_HOST=http://127.0.0.1:11435 ollama ps
nvidia-smi
```

## Внешний HTTPS

Публичный endpoint не включён. Пример фрагмента для хостового Caddy лежит в `llm/proxy/Caddyfile.example`. Контейнер `ai-impulse-tls-gate` до `127.0.0.1:4000` не дойдёт. Чужие Caddy, Nginx и firewall не меняются без отдельного подтверждения.
