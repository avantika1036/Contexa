"""Add the explicit decision lifecycle state to memory items.

Revision ID: 20261029_0004
Revises: 20261029_0003
Create Date: 2026-10-29
"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa

revision: str = "20261029_0004"
down_revision: Union[str, None] = "20261029_0003"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.add_column(
        "memory_items",
        sa.Column("decision_state", sa.String(length=20), nullable=True),
    )
    op.create_index(
        "ix_memory_items_decision_state",
        "memory_items",
        ["decision_state"],
        unique=False,
    )


def downgrade() -> None:
    op.drop_index("ix_memory_items_decision_state", table_name="memory_items")
    op.drop_column("memory_items", "decision_state")
