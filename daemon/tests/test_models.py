from unittest.mock import MagicMock, patch

def test_speech_to_text_transcribe_calls_underlying_model(monkeypatch):
    from daemon.models import SpeechToText
    fake_segment = MagicMock(text=" hello world ")
    fake_model = MagicMock()
    fake_model.transcribe.return_value = ([fake_segment], MagicMock())
    stt = SpeechToText(model_loader=lambda: fake_model)
    result = stt.transcribe(b"\x00\x01")
    assert result == "hello world"
    fake_model.transcribe.assert_called_once()

def test_speech_to_text_empty_segments_returns_empty_string(monkeypatch):
    from daemon.models import SpeechToText
    fake_model = MagicMock()
    fake_model.transcribe.return_value = ([], MagicMock())
    stt = SpeechToText(model_loader=lambda: fake_model)
    assert stt.transcribe(b"\x00\x01") == ""

def test_text_to_speech_synthesize_calls_underlying_model(monkeypatch):
    # NOTE: the real installed `kokoro` 0.9.4 package's KPipeline has no
    # `.create(text, voice=...)` method (that shape, from the original task
    # brief, was written from documentation and doesn't match the real
    # installed package). The real KPipeline instance is *callable* --
    # `model(text, voice=...)` returns a generator of `KPipeline.Result`
    # objects, each carrying `.output.audio` (a torch.FloatTensor waveform).
    # This test's fake mirrors that real shape rather than the brief's
    # guessed one; see daemon/models.py's TextToSpeech.synthesize for the
    # full discrepancy note.
    import numpy as np
    from daemon.models import TextToSpeech
    fake_audio = np.array([0.0, 0.5, -0.5, 1.0], dtype=np.float32)
    fake_result = MagicMock()
    fake_result.output.audio = fake_audio
    fake_model = MagicMock()
    fake_model.return_value = iter([fake_result])
    tts = TextToSpeech(model_loader=lambda: fake_model)
    result = tts.synthesize("hello")
    assert isinstance(result, bytes)
    assert len(result) == len(fake_audio) * 2  # int16 PCM, 2 bytes/sample
    fake_model.assert_called_once()

def test_models_lazy_load_only_on_first_real_call():
    from daemon.models import SpeechToText
    load_count = {"n": 0}
    def loader():
        load_count["n"] += 1
        fake_model = MagicMock()
        fake_model.transcribe.return_value = ([], MagicMock())
        return fake_model
    stt = SpeechToText(model_loader=loader)
    assert load_count["n"] == 0  # constructing SpeechToText must not load the model
    stt.transcribe(b"\x00")
    assert load_count["n"] == 1
    stt.transcribe(b"\x00")
    assert load_count["n"] == 1  # second call reuses the already-loaded model
