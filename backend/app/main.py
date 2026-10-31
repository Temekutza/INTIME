from fastapi import FastAPI
from fastapi.responses import JSONResponse

from app.api.compat.router import router as compat_router
from app.api.v1.router import api_router
from app.core.config import settings
from app.core.errors import ApiError

app = FastAPI(
    title=settings.app_name,
    description="Планировщик задач, встреч и напоминаний.",
    version="0.1.0",
    docs_url="/docs",
    redoc_url="/redoc",
    openapi_url="/openapi.json",
)
app.include_router(api_router, prefix="/api/v1")
app.include_router(compat_router, prefix="/api")


@app.exception_handler(ApiError)
async def api_error_handler(_, exc: ApiError) -> JSONResponse:
    return JSONResponse(status_code=exc.status_code, content={"detail": exc.detail})
