"""Persist recoverable desktop meeting-session suspensions.

Revision ID: 20261101_0007
Revises: 20261101_0006
Create Date: 2026-11-01
"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa

revision: str = "20261101_0007"
down_revision: Union[str, None] = "20261101_0006"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.add_column("meetings", sa.Column("suspended_at", sa.DateTime(timezone=True), nullable=True))
    op.drop_index("uq_meetings_active_capture_key", table_name="meetings")
    op.create_index(
        "uq_meetings_open_capture_key",
        "meetings",
        ["capture_key"],
        unique=True,
        postgresql_where=sa.text("status IN ('active', 'suspended') AND capture_key IS NOT NULL"),
        sqlite_where=sa.text("status IN ('active', 'suspended') AND capture_key IS NOT NULL"),
    )


def downgrade() -> None:
    op.drop_index("uq_meetings_open_capture_key", table_name="meetings")
    op.create_index(
        "uq_meetings_active_capture_key",
        "meetings",
        ["capture_key"],
        unique=True,
        postgresql_where=sa.text("status = 'active' AND capture_key IS NOT NULL"),
        sqlite_where=sa.text("status = 'active' AND capture_key IS NOT NULL"),
    )
    op.drop_column("meetings", "suspended_at")
