from app.qa_service import select_relevant_segments


def test_select_relevant_segments_prefers_question_matches_and_keeps_recent_context():
    segments = [
        {"id": str(index), "start_seconds": float(index), "text": text}
        for index, text in enumerate(
            [f"general conversation line {index}" for index in range(50)]
            + ["The team selected PostgreSQL for the database.", "Redis remains an open question."]
        )
    ]
    selected = select_relevant_segments(segments, "Why did the team select PostgreSQL?", limit=12)
    ids = {segment["id"] for segment in selected}
    assert "50" in ids
    assert len(selected) <= 12
    assert [float(segment["start_seconds"]) for segment in selected] == sorted(
        float(segment["start_seconds"]) for segment in selected
    )


def test_select_relevant_segments_bounds_long_meeting_context():
    segments = [{"id": str(index), "start_seconds": index, "text": "unrelated words"} for index in range(200)]
    selected = select_relevant_segments(segments, "summarize", limit=36)
    assert len(selected) <= 36
    assert selected[-1]["id"] == "199"


def test_empty_meeting_only_question_does_not_need_provider_call():
    import asyncio
    from app.qa_service import answer_meeting_question

    result = asyncio.run(answer_meeting_question(
        question="What did we decide?",
        scope="meeting",
        transcript_segments=[],
        memory_items=[],
        api_key="",
        model="test-model",
        base_url="https://example.invalid/v1",
    ))
    assert result["context_segments_used"] == 0
    assert "no saved transcript" in result["meeting_answer"].lower()


def test_broad_question_samples_across_long_meeting():
    segments = [{"id": str(index), "start_seconds": index, "text": f"line {index}"} for index in range(200)]
    selected = select_relevant_segments(segments, "Summarize the conversation", limit=36)
    assert len(selected) == 36
    assert selected[0]["id"] == "0"
    assert selected[-1]["id"] == "199"
    assert int(selected[len(selected) // 2]["id"]) in range(90, 110)
