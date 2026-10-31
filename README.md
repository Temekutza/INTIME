# InTime

MVP планировщика с голосовым ассистентом: задачи, встречи, напоминания, рабочие пространства, календарь и чат. Стек поднимается через Docker Compose.

Фронт ходит на слой `/api` (задачи/встречи/напоминания как `events`). `/api/v1` — отдельный API с регистрацией и cookie-сессией. Контракт `/api/v1` слой совместимости не меняет.

## Стек

- Backend: Python 3.12, FastAPI, Pydantic, SQLAlchemy async, PostgreSQL 16.
- Frontend: статические ES-модули в nginx, без React и без сборки.
- Ассистент: опциональный LLM через LiteLLM. STT/TTS тоже опциональны.
- Тесты: pytest на изолированной БД `intime_test`; unit-тесты фронта — Node.

## Структура

```
.
├── docker-compose.yml
├── .env.example
├── backend/
│   ├── Dockerfile
│   ├── requirements.txt
│   ├── sql/                 # схема PostgreSQL, источник правды по таблицам
│   └── app/
│       ├── main.py
│       ├── api/v1/          # /api/v1: auth, items, workspaces, assistant, voice
│       ├── api/compat/      # /api: контракт фронта, не меняет /api/v1
│       ├── core/
│       ├── models/
│       ├── schemas/
│       ├── repositories/
│       ├── services/
│       └── integrations/    # LLM, STT, TTS
├── frontend/                # nginx + web/ (не заглушка)
├── tests/                   # pytest
├── scripts/
│   ├── check_stack.py       # диагностика живого стенда
│   └── testdatagen/         # посев демо-данных
└── llm/                     # шлюз LiteLLM, см. llm/README.md
```

Схема: `backend/sql/001_init.sql`, `002_sessions.sql`, `003_interface_fields.sql`, `004_workspaces.sql`. SQL из этого каталога накатывается только при **первом** создании volume Postgres. Новые файлы на уже существующий volume сами не применяются.

## Запуск

```bash
cp .env.example .env   # если .env ещё нет
docker compose up --build
```

Если плагин `docker compose` недоступен, тот же файл поднимает бинарь `docker-compose`.

- Интерфейс: http://127.0.0.1:3010
- API и Swagger: http://127.0.0.1:8010/docs
- Liveness: http://127.0.0.1:8010/api/v1/live
- Readiness / БД: http://127.0.0.1:8010/api/v1/health и `/api/health`
- Postgres с хоста: `127.0.0.1:5435` (логин и пароль из `.env`)

Код backend смонтирован в контейнер (`./backend:/app`), uvicorn перезапускается сам. Образ frontend копирует статику на сборке: после правок HTML/JS/CSS нужна пересборка.

```bash
docker compose build frontend && docker compose up -d --no-deps frontend
```

Пустой `LLM_API_KEY` выключает ассистента. Ключ приложения — не `LITELLM_MASTER_KEY`; см. `llm/README.md`.

### Демо-данные

Фронт без cookie ходит в `/api` от пользователя `COMPAT_USER_LOGIN` (по умолчанию `anna`). Пока пользователя нет в БД, список записей не загрузится.

```bash
pip install -r scripts/testdatagen/requirements.txt
python scripts/testdatagen/seed.py
```

Скрипт подключается по `DATABASE_URL` или `POSTGRES_*` из `.env` (с хоста это `127.0.0.1:5435`). Повторный запуск удаляет пользователей `anna`, `boris`, `clara` вместе с их записями и создаёт набор заново. Пароль у всех: `testpass` (только для стенда).

У `anna` три пространства: «Общее пространство», «Работа», «Личное». Выбранное пространство фильтрует списки, поиск, историю ассистента и создание записей. Id пространства браузер помнит в `localStorage` (`ritm.workspace-id`); после пересева id меняются — если экран пустой, сбросьте ключ или выберите пространство заново.

Состав набора: `scripts/testdatagen/testdescription.md`.

Не выполняйте `docker compose down -v` без отдельной договорённости: это удаляет данные volume.

## Что умеет интерфейс

- Задачи, встречи, напоминания; статусы `planned` / `done`.
- Календарь: день, неделя, месяц, год, список.
- «Мой день», поиск, цвета типа и отдельной записи.
- Создание формой и через ассистента. Создание и изменение через чат ждут подтверждения.
- Валидация: название обязательно; у задачи дата и время необязательны; у встречи и напоминания нужны дата и время; длительность встречи 1–1440 минут.

Подробности по модулям фронта: `frontend/web/README.md`.

## API

Два префикса, одна база.

| Слой | Кто ходит | Авторизация |
| --- | --- | --- |
| `/api/...` | интерфейс | cookie/Bearer или демо-пользователь `COMPAT_USER_LOGIN` |
| `/api/v1/...` | прямой API | регистрация `/api/v1/auth/register`, вход, cookie |

Основные маршруты фронта:

| Метод | Назначение |
| --- | --- |
| `GET, POST /api/workspaces` | список и создание пространств |
| `PATCH /api/workspaces/{id}` | переименование |
| `GET, POST /api/events` | список и создание записи |
| `GET, PATCH, DELETE /api/events/{id}` | чтение, правка, удаление |
| `GET /api/search` | поиск в текущем пространстве |
| `GET, PATCH /api/colors...` | цвета типов и записей |
| `POST /api/message` | ассистент; `require_confirmation` для записи |
| `GET /api/history` | история диалога пространства |
| `POST /api/speech` | распознавание речи (PCM) |
| `GET /api/health` | готовность (SELECT 1) |

`GET /api/events`, поиск и история принимают `workspace_id`. Фронт всегда передаёт выбранное пространство. Без параметра список не фильтруется по пространству; создание без `workspace_id` пишет в пространство по умолчанию.

## Тесты

Pytest всегда идёт в изолированную БД `intime_test` на `127.0.0.1:5435`. Рабочие базы `intime` и `aivritm` для тестов запрещены. Платные LLM в обычных прогонах не вызываются.

```bash
pip install -r tests/requirements.txt
python3 -m pytest -q
```

Схема тестовой БД пересоздаётся из `backend/sql/*.sql`. Явно накатить её:

```bash
python scripts/testdatagen/apply_schema.py
```

Фронт, из каталога `frontend/web`:

```bash
npm test          # node --test, unit
npm run typecheck
npm run lint
```

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
python3 scripts/check_stack.py --backend-url http://127.0.0.1:8010 --frontend-url http://127.0.0.1:3010
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
