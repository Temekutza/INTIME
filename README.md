# Aivritm2

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
- Проверка БД: http://localhost:8010/api/v1/health
- Postgres с хоста: `localhost:5435` (логин и пароль из `.env`)
