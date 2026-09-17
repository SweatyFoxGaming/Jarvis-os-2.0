from unittest.mock import MagicMock

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

def test_speech_to_text_concurrent_transcribe_loads_model_only_once():
    # Regression test for a real race: voice_engine.py runs transcribe()
    # via asyncio.to_thread, so multiple connections can call
    # _ensure_loaded() concurrently on separate worker threads. Without a
    # lock, a slow loader (real weight loading takes tens of seconds) lets
    # several threads pass the "is None" check before any of them sets
    # self._model, triggering redundant concurrent loads. This drives many
    # concurrent transcribe() calls through a deliberately slow loader and
    # asserts it only ever runs once.
    import threading
    import time
    from concurrent.futures import ThreadPoolExecutor
    from daemon.models import SpeechToText

    load_count = {"n": 0}
    count_lock = threading.Lock()

    def slow_loader():
        with count_lock:
            load_count["n"] += 1
        time.sleep(0.2)  # simulate a slow real model load
        fake_model = MagicMock()
        fake_model.transcribe.return_value = ([], MagicMock())
        return fake_model

    stt = SpeechToText(model_loader=slow_loader)
    with ThreadPoolExecutor(max_workers=8) as executor:
        futures = [executor.submit(stt.transcribe, b"\x00\x01") for _ in range(8)]
        for f in futures:
            f.result()

    assert load_count["n"] == 1

def test_text_to_speech_concurrent_synthesize_loads_model_only_once():
    # Same race as the SpeechToText version above, for TextToSpeech.
    import threading
    import time
    from concurrent.futures import ThreadPoolExecutor
    import numpy as np
    from daemon.models import TextToSpeech

    load_count = {"n": 0}
    count_lock = threading.Lock()

    def slow_loader():
        with count_lock:
            load_count["n"] += 1
        time.sleep(0.2)  # simulate a slow real model load
        fake_audio = np.array([0.0, 0.5], dtype=np.float32)

        def fake_call(text, voice=None):
            fake_result = MagicMock()
            fake_result.output.audio = fake_audio
            return iter([fake_result])  # fresh iterator per call

        fake_model = MagicMock(side_effect=fake_call)
        return fake_model

    tts = TextToSpeech(model_loader=slow_loader)
    with ThreadPoolExecutor(max_workers=8) as executor:
        futures = [executor.submit(tts.synthesize, "hello") for _ in range(8)]
        for f in futures:
            f.result()

    assert load_count["n"] == 1

def test_parse_device_env_numeric_string_becomes_a_real_int():
    # sounddevice only treats a real Python `int` as a numeric device index
    # -- a plain string like "2" (which is exactly what os.environ.get
    # always returns) is instead matched by substring against device
    # *names*, so AMBIENT_MIC_DEVICE=2 would silently never select device
    # index 2 unless this conversion happens.
    from daemon.models import parse_device_env
    result = parse_device_env("2")
    assert result == 2
    assert isinstance(result, int)

def test_parse_device_env_device_name_stays_a_string():
    from daemon.models import parse_device_env
    result = parse_device_env("hw:1,0")
    assert result == "hw:1,0"
    assert isinstance(result, str)

def test_parse_device_env_blank_or_none_becomes_none():
    from daemon.models import parse_device_env
    assert parse_device_env("") is None
    assert parse_device_env(None) is None

def test_audio_player_calls_the_injected_backend_with_the_right_sample_rate():
    import numpy as np
    from daemon.models import AudioPlayer

    calls = []

    # Matches the real sounddevice-shaped call AudioPlayer.play() makes
    # below: backend.play(audio_array, samplerate=..., device=...) followed
    # by backend.wait() -- NOT a (pcm_bytes, sample_rate) positional shape.
    class FakeBackend:
        def play(self, data, samplerate=None, device=None):
            calls.append((data, samplerate, device))

        def wait(self):
            calls.append("waited")

    player = AudioPlayer(player_loader=lambda: FakeBackend())
    player.play(b"\x01\x00\x02\x00", 24000)

    assert len(calls) == 2, f"expected one play() call and one wait() call, got: {calls}"
    data, samplerate, device = calls[0]
    assert np.array_equal(data, np.array([1, 2], dtype=np.int16)), f"expected the PCM bytes decoded as int16, got: {data}"
    assert samplerate == 24000
    assert calls[1] == "waited"
