"""Record audio channel provenance for split mic/meeting streams.

Revision ID: 20261030_0005
Revises: 20261029_0004
Create Date: 2026-10-30
"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa

revision: str = "20261030_0005"
down_revision: Union[str, None] = "20261029_0004"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.add_column(
        "transcript_segments",
        sa.Column("audio_channel", sa.Integer(), nullable=True),
    )


def downgrade() -> None:
    op.drop_column("transcript_segments", "audio_channel")
