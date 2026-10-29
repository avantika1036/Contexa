import json
import logging

from fastapi import FastAPI, HTTPException, WebSocket, WebSocketDisconnect
from fastapi.middleware.cors import CORSMiddleware
from sqlalchemy import text
from sqlalchemy.exc import SQLAlchemyError

from app.config import settings
from app.database import engine


logging.basicConfig(level=logging.INFO)
logger = logging.getLogger(__name__)

app = FastAPI(
    title=settings.app_name,
    version="0.1.0",
    description="Real-time meeting context and memory API.",
)

app.add_middleware(
    CORSMiddleware,
    allow_origins=settings.cors_origins,
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)


@app.get("/health", tags=["health"])
def health_check() -> dict[str, str]:
    return {
        "status": "ok",
        "service": "contexa-api",
    }


@app.get("/health/db", tags=["health"])
def database_health_check() -> dict[str, str]:
    try:
        with engine.connect() as connection:
            connection.execute(text("SELECT 1"))
    except SQLAlchemyError as exc:
        logger.exception("Database health check failed")
        raise HTTPException(
            status_code=503,
            detail="Database connection failed",
        ) from exc

    return {
        "status": "ok",
        "database": "connected",
    }


@app.websocket("/ws/meeting/{meeting_id}")
async def meeting_websocket(
    websocket: WebSocket,
    meeting_id: str,
) -> None:
    await websocket.accept()

    await websocket.send_json(
        {
            "type": "connection.established",
            "meeting_id": meeting_id,
        }
    )

    try:
        while True:
            message = await websocket.receive()

            if message["type"] == "websocket.disconnect":
                break

            text_data = message.get("text")

            if text_data is not None:
                try:
                    payload = json.loads(text_data)
                except json.JSONDecodeError:
                    await websocket.send_json(
                        {
                            "type": "error",
                            "message": "Send a valid JSON message.",
                        }
                    )
                    continue

                if not isinstance(payload, dict):
                    await websocket.send_json(
                        {
                            "type": "error",
                            "message": "The JSON message must be an object.",
                        }
                    )
                    continue

                if payload.get("type") == "ping":
                    await websocket.send_json(
                        {
                            "type": "pong",
                            "meeting_id": meeting_id,
                        }
                    )
                else:
                    await websocket.send_json(
                        {
                            "type": "message.received",
                            "meeting_id": meeting_id,
                            "message_type": payload.get(
                                "type",
                                "unknown",
                            ),
                        }
                    )

                continue

            audio_chunk = message.get("bytes")

            if audio_chunk is not None:
                await websocket.send_json(
                    {
                        "type": "audio.chunk.received",
                        "meeting_id": meeting_id,
                        "byte_length": len(audio_chunk),
                        "transcription_status": "not_implemented",
                    }
                )

    except WebSocketDisconnect:
        logger.info(
            "Meeting WebSocket disconnected: %s",
            meeting_id,
        )
