"""Vosk Speech-to-Text Module for Jarvis-OS.

Provides lightweight CPU speech recognition using Vosk and sounddevice.
"""

import json
import logging
import queue
import sys
import sounddevice as sd
from vosk import Model, KaldiRecognizer

log = logging.getLogger("jarvis.tools.voice")

# Queue to hold incoming audio chunks from sounddevice callback
audio_queue = queue.Queue()

def _audio_callback(indata, frames, time, status):
    """Callback executed by sounddevice for each raw audio block."""
    if status:
        log.warning(f"Audio stream status: {status}")
    audio_queue.put(bytes(indata))

def listen_once(timeout_seconds: int = 10, sample_rate: int = 16000) -> str:
    """Listens to microphone input until a complete phrase is detected or timeout occurs.

    Returns recognized text or an empty string.
    """
    try:
        # Auto-downloads small ~40MB US English model if not already cached
        model = Model(model_name="vosk-model-small-en-us-0.15")
    except Exception as e:
        log.error(f"Failed to load Vosk model: {e}")
        return ""

    rec = KaldiRecognizer(model, sample_rate)
    transcript = ""

    try:
        with sd.RawInputStream(
            samplerate=sample_rate,
            blocksize=8000,
            dtype="int16",
            channels=1,
            callback=_audio_callback
        ):
            log.info("Listening for speech input...")
            print("\n[Voice Input] Speak into your microphone...")

            while True:
                try:
                    data = audio_queue.get(timeout=timeout_seconds)
                except queue.Empty:
                    log.info("Voice listening timed out due to silence.")
                    break

                if rec.AcceptWaveform(data):
                    res = json.loads(rec.Result())
                    transcript = res.get("text", "")
                    if transcript:
                        log.info(f"Final recognized phrase: '{transcript}'")
                        break
                else:
                    partial = json.loads(rec.PartialResult())
                    if partial.get("partial"):
                        print(f"\r[Listening...] {partial['partial']}", end="", flush=True)

    except Exception as e:
        log.error(f"Microphone recording error: {e}")
        return ""

    # Flush any remaining buffer if stream ended without explicit phrase boundary
    if not transcript:
        final_res = json.loads(rec.FinalResult())
        transcript = final_res.get("text", "")

    return transcript.strip()

if __name__ == "__main__":
    logging.basicConfig(level=logging.INFO)
    text = listen_once()
    print(f"\nResult: {text}")