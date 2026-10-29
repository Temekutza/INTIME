from fastapi import APIRouter

from app.api.v1 import health
from app.api.v1.endpoints import assistant, auth, catalogs, items, users, voice

api_router = APIRouter()
api_router.include_router(health.router, tags=["health"])
api_router.include_router(auth.router, prefix="/auth", tags=["auth"])
api_router.include_router(users.router, prefix="/users", tags=["users"])
api_router.include_router(items.router, prefix="/items", tags=["items"])
api_router.include_router(catalogs.router, tags=["catalogs"])
api_router.include_router(assistant.router, prefix="/assistant", tags=["assistant"])
api_router.include_router(voice.router, prefix="/voice", tags=["voice"])
