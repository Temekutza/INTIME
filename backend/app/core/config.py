from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    model_config = SettingsConfigDict(env_file=".env", extra="ignore")

    app_name: str = "intime2"
    postgres_user: str = "intime"
    postgres_password: str = "intime"
    postgres_db: str = "intime"
    postgres_host: str = "db"
    postgres_port: int = 5432
    session_ttl_days: int = 14
    session_cookie_secure: bool = False

    llm_api_key: str | None = None
    llm_base_url: str = "https://api.openai.com/v1"
    llm_model: str = "gpt-4o-mini"
    llm_timeout: float = 30

    stt_api_key: str | None = None
    stt_base_url: str | None = None
    stt_model: str = "whisper-1"

    tts_api_key: str | None = None
    tts_base_url: str | None = None
    tts_model: str = "tts-1"
    tts_voice: str = "alloy"

    @property
    def database_url(self) -> str:
        return (
            f"postgresql+asyncpg://{self.postgres_user}:{self.postgres_password}"
            f"@{self.postgres_host}:{self.postgres_port}/{self.postgres_db}"
        )


settings = Settings()
