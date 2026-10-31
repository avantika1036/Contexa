from app.speaker_segments import split_words_by_speaker


def w(text, speaker, start=0.0, end=0.0):
    return {"word": text, "punctuated_word": text, "speaker": speaker, "start": start, "end": end}


def test_single_speaker_is_one_run():
    runs = split_words_by_speaker([w("Hello", 0, 0, 0.3), w("everyone.", 0, 0.4, 0.9)])
    assert len(runs) == 1
    assert runs[0].speaker_id == 0
    assert runs[0].text == "Hello everyone."
    assert (runs[0].start, runs[0].end) == (0, 0.9)


def test_speaker_change_splits_into_two_runs_with_own_timing():
    runs = split_words_by_speaker([
        w("I", 0, 0.0, 0.1), w("propose", 0, 0.2, 0.5), w("Redis.", 0, 0.6, 1.0),
        w("Cache", 1, 1.2, 1.5), w("invalidation", 1, 1.6, 2.2), w("worries", 1, 2.3, 2.6), w("me.", 1, 2.7, 3.0),
    ])
    assert [run.speaker_id for run in runs] == [0, 1]
    assert runs[0].text == "I propose Redis."
    assert runs[1].text == "Cache invalidation worries me."
    assert runs[1].start == 1.2 and runs[1].end == 3.0


def test_one_word_diarization_flicker_does_not_create_a_segment():
    runs = split_words_by_speaker([
        w("we", 0), w("should", 0), w("really", 1), w("use", 0), w("replicas", 0),
    ])
    assert len(runs) == 1
    assert runs[0].speaker_id == 0
    assert runs[0].text == "we should really use replicas"


def test_unlabelled_words_inherit_the_current_speaker():
    runs = split_words_by_speaker([w("so", None), w("yes", 2), w("that", None), w("works", 2)])
    assert len(runs) == 1
    assert runs[0].speaker_id == 2


def test_all_unlabelled_words_give_one_run_without_speaker():
    runs = split_words_by_speaker([w("hello", None), w("there", None)])
    assert len(runs) == 1 and runs[0].speaker_id is None


def test_short_leading_run_merges_into_next_speaker():
    runs = split_words_by_speaker([w("Okay", 0), w("let's", 1), w("benchmark", 1), w("first", 1)])
    assert len(runs) == 1 and runs[0].speaker_id == 1


def test_empty_or_invalid_words_return_no_runs():
    assert split_words_by_speaker([]) == []
    assert split_words_by_speaker([{"word": ""}, "not-a-word"]) == []  # type: ignore[list-item]
