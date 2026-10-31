# InTime

Планировщик задач, встреч и напоминаний с текстовым и голосовым ассистентом. Весь стек поднимается одним Docker Compose из корня репозитория.

## Что нужно заранее

- Docker Engine и Docker Compose v2 (`docker compose` или `docker-compose`).
- Системная Ollama на `127.0.0.1:11435` с моделью `hf.co/Qwen/Qwen3-32B-GGUF:Q5_K_M`.
- Для распознавания речи: GigaAM на порту хоста `9000`. Без него интерфейс и API работают, голос нет.

Порт `11434` и контейнер чужой Ollama не используются.

## Первый запуск

```bash
cp .env.example .env
```

В `.env` задайте пароли Postgres и параметры шлюза:

- `POSTGRES_USER`, `POSTGRES_PASSWORD`, `POSTGRES_DB`
- `LITELLM_MASTER_KEY` — только для выпуска ключей, приложениям его не отдают
- `LITELLM_DB_USER`, `LITELLM_DB_PASSWORD`, `LITELLM_DB_NAME`, `LITELLM_DB_PORT` (по умолчанию `5436`)

Создайте алиас модели и ключ приложения:

```bash
OLLAMA_HOST=http://127.0.0.1:11435 ollama create intime-qwen3-32b -f llm/gateway/Modelfile.qwen3
docker compose up -d litellm
llm/scripts/keys.sh create --alias intime-app --rpm 30 --tpm 20000 --duration 30d
```

Ключ появится в `llm/secrets/intime-app.key`. Вставьте его в `LLM_API_KEY`. Пустой `LLM_API_KEY` выключает ассистента. `LLM_BASE_URL` оставьте `http://host.docker.internal:4000/v1`, модель — `qwen3-32b`.

Поднимите остальное:

```bash
docker compose up --build -d
```

Если команда `docker compose` недоступна, используйте `docker-compose`.

## Адреса

| Что | Адрес |
|---|---|
| Интерфейс | http://127.0.0.1:3010 |
| API и Swagger | http://127.0.0.1:8010/docs |
| Проверка процесса | http://127.0.0.1:8010/api/v1/live |
| Проверка базы | http://127.0.0.1:8010/api/v1/health |
| Postgres приложения | `127.0.0.1:5435` |
| Шлюз модели | http://127.0.0.1:4000/v1 |
| Снаружи | https://intime.95-79-92-200.sslip.io:8088 |

Снаружи открыт только уже существующий HTTPS на порту `8088`. Порты `3010`, `8010`, `5435` и `4000` в интернет не пробрасываются.

## Демо-данные

Интерфейс без входа работает от пользователя `anna` (`COMPAT_USER_LOGIN`).

```bash
pip install -r scripts/testdatagen/requirements.txt
python scripts/testdatagen/seed.py
```

Пароль демо-пользователей `anna`, `boris`, `clara`: `testpass`. Повторный запуск удаляет их записи и создаёт набор заново. У `anna` три пространства: «Общее пространство», «Работа», «Личное».

## Проверка

```bash
python3 scripts/check_stack.py
llm/scripts/check-api.sh
```

`--deep` дополнительно проверяет, что шлюз и распознавание отвечают на соединение, без генерации текста.

## После правок

Код backend смонтирован в контейнер, uvicorn подхватывает его сам. Статику фронта нужно пересобрать:

```bash
docker compose build frontend && docker compose up -d --no-deps frontend
```

Только шлюз, без пересоздания приложения:

```bash
docker compose up -d litellm
```

`docker compose down -v` удаляет данные Postgres. Без отдельной договорённости эту команду не запускайте.
