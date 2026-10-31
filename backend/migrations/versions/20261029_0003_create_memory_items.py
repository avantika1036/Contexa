"""Create structured meeting-memory items.

Revision ID: 20261029_0003
Revises: 20261029_0002
Create Date: 2026-10-29
"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa

revision: str = "20261029_0003"
down_revision: Union[str, None] = "20261029_0002"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.create_table(
        "memory_items",
        sa.Column("id", sa.String(length=36), nullable=False),
        sa.Column("meeting_id", sa.String(length=36), nullable=False),
        sa.Column("item_type", sa.String(length=30), nullable=False),
        sa.Column("title", sa.String(length=200), nullable=False),
        sa.Column("content", sa.Text(), nullable=False),
        sa.Column("status", sa.String(length=30), nullable=False),
        sa.Column("owner", sa.String(length=200), nullable=True),
        sa.Column("speaker_id", sa.Integer(), nullable=True),
        sa.Column("evidence_quote", sa.Text(), nullable=False),
        sa.Column("source_segment_ids", sa.JSON(), nullable=False),
        sa.Column("related_entities", sa.JSON(), nullable=False),
        sa.Column("start_seconds", sa.Float(), nullable=False),
        sa.Column("end_seconds", sa.Float(), nullable=False),
        sa.Column("confidence", sa.Float(), nullable=False),
        sa.Column("source", sa.String(length=30), nullable=False),
        sa.Column("model_name", sa.String(length=100), nullable=True),
        sa.Column("dedupe_key", sa.String(length=64), nullable=False),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("updated_at", sa.DateTime(timezone=True), nullable=False),
        sa.ForeignKeyConstraint(["meeting_id"], ["meetings.id"], ondelete="CASCADE"),
        sa.PrimaryKeyConstraint("id"),
        sa.UniqueConstraint(
            "meeting_id", "item_type", "dedupe_key",
            name="uq_memory_items_meeting_type_key",
        ),
    )
    op.create_index("ix_memory_items_meeting_id", "memory_items", ["meeting_id"], unique=False)
    op.create_index("ix_memory_items_item_type", "memory_items", ["item_type"], unique=False)
    op.create_index(
        "ix_memory_items_meeting_start", "memory_items", ["meeting_id", "start_seconds"], unique=False
    )


def downgrade() -> None:
    op.drop_index("ix_memory_items_meeting_start", table_name="memory_items")
    op.drop_index("ix_memory_items_item_type", table_name="memory_items")
    op.drop_index("ix_memory_items_meeting_id", table_name="memory_items")
    op.drop_table("memory_items")
