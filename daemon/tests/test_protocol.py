import base64
import pytest
from daemon.protocol import parse_control_message, encode_audio_chunk, decode_audio_chunk, ProtocolError, UtteranceEndDetector

def test_parse_control_message_valid():
    msg = parse_control_message('{"type": "reply", "text": "hello"}')
    assert msg == {"type": "reply", "text": "hello"}

def test_parse_control_message_malformed_raises_protocol_error():
    with pytest.raises(ProtocolError):
        parse_control_message("not json{{{")

def test_parse_control_message_empty_line_raises_protocol_error():
    with pytest.raises(ProtocolError):
        parse_control_message("")

def test_encode_decode_audio_chunk_round_trips():
    original = b"\x00\x01\x02\xff\xfe"
    encoded = encode_audio_chunk(original)
    assert isinstance(encoded, str)
    assert decode_audio_chunk(encoded) == original

def test_decode_audio_chunk_malformed_raises_protocol_error():
    with pytest.raises(ProtocolError):
        decode_audio_chunk("not-valid-base64!!!")

def test_utterance_end_detector_fires_after_sustained_silence():
    # Configured for a short threshold so the test doesn't need real timing —
    # silence_frames_threshold=3 means 3 consecutive non-speech frames end
    # the utterance.
    detector = UtteranceEndDetector(silence_frames_threshold=3)
    assert detector.feed(True) is False   # speech
    assert detector.feed(True) is False   # speech
    assert detector.feed(False) is False  # 1st silence frame
    assert detector.feed(False) is False  # 2nd silence frame
    assert detector.feed(False) is True   # 3rd silence frame -> utterance ends

def test_utterance_end_detector_resets_silence_count_on_new_speech():
    detector = UtteranceEndDetector(silence_frames_threshold=3)
    detector.feed(True)
    detector.feed(False)
    detector.feed(False)
    assert detector.feed(True) is False   # speech resumes, silence count resets
    assert detector.feed(False) is False  # 1st silence frame again, not 3rd
    assert detector.feed(False) is False  # 2nd
    assert detector.feed(False) is True   # 3rd -> now it ends

def test_utterance_end_detector_never_fires_on_leading_silence_alone():
    # Silence before any speech has happened at all must not count as "the
    # utterance ended" -- there was no utterance yet.
    detector = UtteranceEndDetector(silence_frames_threshold=3)
    assert detector.feed(False) is False
    assert detector.feed(False) is False
    assert detector.feed(False) is False
    assert detector.feed(False) is False

def test_utterance_end_detector_reset_clears_in_progress_speech_state():
    detector = UtteranceEndDetector(silence_frames_threshold=3)
    detector.feed(True)   # speech seen
    detector.feed(False)  # 1 silence frame so far
    detector.reset()
    # If reset() didn't actually clear state, 2 more silence frames would
    # reach the threshold of 3 and fire early.
    assert detector.feed(False) is False
    assert detector.feed(False) is False

def test_utterance_end_detector_reset_then_new_utterance_still_fires_normally():
    detector = UtteranceEndDetector(silence_frames_threshold=3)
    detector.feed(True)
    detector.feed(False)
    detector.reset()
    assert detector.feed(True) is False   # fresh speech after reset
    assert detector.feed(False) is False  # 1st silence frame
    assert detector.feed(False) is False  # 2nd
    assert detector.feed(False) is True   # 3rd -> fires

def test_parse_control_message_string_raises_protocol_error():
    # Valid JSON but not an object -- must reject
    with pytest.raises(ProtocolError):
        parse_control_message('"just a string"')

def test_parse_control_message_number_raises_protocol_error():
    with pytest.raises(ProtocolError):
        parse_control_message('42')

def test_parse_control_message_array_raises_protocol_error():
    with pytest.raises(ProtocolError):
        parse_control_message('[1, 2, 3]')

def test_parse_control_message_null_raises_protocol_error():
    with pytest.raises(ProtocolError):
        parse_control_message('null')
