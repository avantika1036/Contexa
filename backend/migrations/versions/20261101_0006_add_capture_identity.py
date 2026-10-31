"""Add stable meeting capture identity and active-session uniqueness.

Revision ID: 20261101_0006
Revises: 20261030_0005
Create Date: 2026-11-01
"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa

revision: str = "20261101_0006"
down_revision: Union[str, None] = "20261030_0005"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.add_column("meetings", sa.Column("capture_key", sa.String(length=255), nullable=True))
    op.add_column("meetings", sa.Column("capture_process_name", sa.String(length=100), nullable=True))
    op.create_index(
        "uq_meetings_active_capture_key",
        "meetings",
        ["capture_key"],
        unique=True,
        postgresql_where=sa.text("status = 'active' AND capture_key IS NOT NULL"),
        sqlite_where=sa.text("status = 'active' AND capture_key IS NOT NULL"),
    )


def downgrade() -> None:
    op.drop_index("uq_meetings_active_capture_key", table_name="meetings")
    op.drop_column("meetings", "capture_process_name")
    op.drop_column("meetings", "capture_key")
