# InTime

FastAPI, PostgreSQL и статическая заглушка фронтенда. Всё поднимается через Docker Compose.

```
.
├── docker-compose.yml
├── .env.example
├── backend/
│   ├── Dockerfile
│   ├── requirements.txt
│   └── app/
│       ├── main.py
│       ├── api/v1/          # роуты
│       ├── core/            # настройки и подключение к БД
│       ├── models/          # SQLAlchemy-модели
│       ├── schemas/         # Pydantic-схемы
│       └── services/        # бизнес-логика
└── frontend/                # статическая заглушка (nginx)
```

## Запуск

```bash
cp .env.example .env   # если .env ещё нет
docker compose up --build
```

- Фронт: http://localhost:3010
- API и Swagger: http://localhost:8010/docs
- Liveness: http://localhost:8010/api/v1/live
- Readiness / БД: http://localhost:8010/api/v1/health
- Postgres с хоста: `localhost:5435` (логин и пароль из `.env`)

## Health Checks / Проверка работоспособности

Это диагностика уже запущенного стека, а не набор unit-тестов бизнес-логики.

### Уровни

1. **Infrastructure.** Docker healthcheck у `db`, `backend`, `frontend`; у шлюза — `litellm`, `litellm-db`, `litellm-docker`. Скрипт смотрит только контейнеры Compose-проекта (имя каталога, обычно `intime`) и не трогает чужие контейнеры.
2. **Application.** `GET /api/v1/live` — процесс FastAPI жив, без БД и LLM. `GET /api/v1/health` и `GET /api/health` — готовность: `SELECT 1` к PostgreSQL. При недоступной БД — HTTP 503 без секретов и traceback. LLM/STT/TTS в эти запросы не входят.
3. **System smoke.** `scripts/check_stack.py` проверяет контейнеры, Compose-файл, TCP PostgreSQL, HTTP backend/frontend, статику и прокси nginx → backend.

Обязательные сервисы Compose: `db`, `backend`. `frontend` может стоять вне Docker — тогда контейнер помечается SKIP, а HTTP фронта всё равно проверяется. `litellm`, `litellm-db`, `litellm-docker`, STT на хосте `:9000` и TTS необязательны для ядра планировщика.

### Запуск

Из корня репозитория, когда стек уже поднят. Скрипт ничего не стартует и не останавливает.

```bash
python3 scripts/check_stack.py
python3 scripts/check_stack.py --deep
```

Адреса по умолчанию берутся из опубликованных портов Compose (`127.0.0.1:8010` и `127.0.0.1:3010`). Их можно переопределить:

```bash
python scripts/check_stack.py --backend-url http://127.0.0.1:8010 --frontend-url http://127.0.0.1:3010
```

`--deep` проверяет, что LLM/STT/TTS настроены и отвечают на соединение. Список моделей LiteLLM запрашивается, chat/transcription/speech **не** вызываются. Платных inference-запросов скрипт не делает.

Переменные: `INTIME_BACKEND_URL`, `INTIME_FRONTEND_URL`, `COMPOSE_PROJECT_NAME`. Таймаут одной проверки: `--timeout` (секунды).

### Статусы

| Статус | Смысл |
|---|---|
| PASS | проверка пройдена |
| FAIL | ошибка |
| WARN | некритично: сервис стартует, необязательный компонент болен, нет доступа к Docker CLI |
| SKIP | проверка неприменима или выключена |

Скрипт завершается с кодом 1 только при FAIL обязательного компонента. WARN/FAIL у LLM или STT сами по себе не объявляют планировщик неработоспособным.

В отчёте `backend-live` / `backend-ready` — доступность **с хоста**. `backend-from-frontend` — запрос из контейнера `frontend` на `http://backend:8000`. Если с хоста жив, а из контейнера нет, проблема в сети Compose, а не в том, что порт не проброшен на localhost.

### Как читать ошибки

- `docker:db` / `postgres-ready` — PostgreSQL не принимает соединения.
- `backend-live` — контейнер или процесс uvicorn не отвечает.
- `backend-ready` HTTP 503 — приложение живо, до БД не достучалось.
- `frontend-http` / `frontend-asset:*` — nginx или статика.
- `frontend-api-proxy` — страница есть, прокси `/api/` на backend сломан.
- `llm-from-backend` при `--deep` — шлюз виден с хоста (`127.0.0.1:4000`), но контейнер backend не видит `host.docker.internal:4000`.

Пароли, токены и строки подключения в отчёт не попадают.

### Чего эти проверки не гарантируют

- Корректность бизнес-логики, прав доступа и ответов LLM.
- Что ассистент «понимает» фразу пользователя.
- Что STT/TTS реально распознают и синтезируют речь (для этого нужен отдельный inference).
- Состояние Ollama/GigaAM, если они не описаны в Compose.
- Что свежий volume PostgreSQL уже прошёл `backend/sql/*.sql` (init только при первом создании volume).

Локально контракт `/api/v1/live` и `/api/v1/health` покрыт pytest: `python3 -m pytest tests/test_health.py tests/unit/test_check_stack.py`. Это не замена проверки живого стенда.
