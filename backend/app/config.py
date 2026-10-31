from pathlib import Path

from pydantic import Field
from pydantic_settings import BaseSettings, SettingsConfigDict


PROJECT_ROOT = Path(__file__).resolve().parents[2]


class Settings(BaseSettings):
    app_name: str = "Contexa API"
    environment: str = "development"
    database_url: str
    deepgram_api_key: str | None = None
    deepgram_model: str = "nova-3"
    # Nova-3 multilingual supports language detection and code-switching when set to "multi".
    deepgram_language: str = "multi"
    # Optional comma-separated hints, e.g. "en,hi". Hints bias detection but do not restrict it.
    deepgram_language_hints: str | None = None
    # Optional comma-separated names/terms to boost with Nova-3 keyterm prompting,
    # e.g. "Avanti Kapadia,Contexa,Kubernetes". Keep it to the 20-50 terms that matter.
    deepgram_keyterms: str | None = None

    # Preferred Groq configuration. The XAI_* fields remain as backwards compatibility for
    # developers who followed the earlier Contexa patch instructions with a Groq key.
    groq_api_key: str | None = None
    groq_base_url: str | None = None
    xai_api_key: str | None = None
    xai_base_url: str | None = None
    memory_model: str = "openai/gpt-oss-120b"
    # One source-grounded extraction run after the meeting ends; never call Groq per segment.
    # `MEMORY_AUTO_EXTRACT` is retained only for old .env compatibility and no longer enables live extraction.
    memory_auto_extract: bool = False
    memory_auto_extract_on_end: bool = True

    # An active session with no transcript activity for this long is treated as abandoned
    # (for example after a crash) by POST /api/meetings/cleanup.
    stale_active_meeting_minutes: int = 20
    # A deliberately suspended auto-capture session can be reclaimed after app restart
    # only during this bounded window. The active meeting itself may remain open longer;
    # after this window a fresh Contexa session is created for a still-open provider call.
    suspended_session_resume_grace_seconds: int = 300

    cors_origins: list[str] = Field(
        default_factory=lambda: [
            "http://localhost:5173",
            "http://127.0.0.1:5173",
            "http://127.0.0.1:4173",
            "http://localhost:4173",
        ]
    )

    model_config = SettingsConfigDict(
        env_file=PROJECT_ROOT / ".env",
        env_file_encoding="utf-8",
        extra="ignore",
    )

    @property
    def memory_api_key(self) -> str:
        return (self.groq_api_key or self.xai_api_key or "").strip()

    @property
    def memory_base_url(self) -> str:
        if self.groq_api_key and self.groq_api_key.strip():
            return (self.groq_base_url or "https://api.groq.com/openai/v1").rstrip("/")
        if self.xai_api_key and self.xai_api_key.strip():
            return (self.xai_base_url or "https://api.x.ai/v1").rstrip("/")
        return (self.groq_base_url or self.xai_base_url or "https://api.groq.com/openai/v1").rstrip("/")

    @property
    def memory_provider(self) -> str:
        base_url = self.memory_base_url.lower()
        return "groq" if "api.groq.com" in base_url else "xai"

    @property
    def language_hints(self) -> list[str]:
        if not self.deepgram_language_hints:
            return []
        return [hint.strip() for hint in self.deepgram_language_hints.split(",") if hint.strip()]

    @property
    def keyterms(self) -> list[str]:
        from app.transcription_params import parse_keyterms

        return parse_keyterms(self.deepgram_keyterms)


settings = Settings()
