import { ObservationPlatform } from "../kernel/observation.js";
import { synthesizeOverSocket } from "../core/audio-client.js";

const observation = ObservationPlatform.getInstance();

export class TtsIntegrationError extends Error {
  constructor(message: string, public status = 500) {
    super(message);
  }
}

// Same default the server itself uses to start the daemon bridge (see
// startAudioClient's call site in src/server.ts) -- kept in sync manually
// since this module and src/core/audio-client.ts each open their own
// connection to the same daemon rather than sharing one. Mirrors
// whisper.ts's identical constant for the STT direction.
const DEFAULT_VOICE_DAEMON_SOCKET = "/tmp/jarvis-voice/voice.sock";

// The sample rate daemon/models.py's TextToSpeech.synthesize actually
// produces -- Kokoro-82M's output is fixed at 24kHz (see Task 2's report:
// "There's no sample rate returned -- Kokoro's output is fixed at 24kHz",
// confirmed live against the real model, and used again as the samplerate
// when Task 2 wrote its own live-check .wav via soundfile). The daemon
// sends back bare 16-bit PCM with no header, so this value is required
// here to wrap it into a real, browser-playable WAV container.
const KOKORO_SAMPLE_RATE = 24000;
const PCM_BITS_PER_SAMPLE = 16;
const PCM_CHANNELS = 1;

/**
 * Wraps raw 16-bit PCM (mono, sampleRate) in a minimal 44-byte canonical
 * WAV header. The voice daemon (daemon/models.py's TextToSpeech.synthesize)
 * returns headerless PCM bytes, but every real caller of synthesizeSpeech
 * hands the result straight to something that expects a self-describing,
 * playable audio file: the /api/integrations/tts/speak HTTP route sends it
 * as a Content-Type response body played via a browser <audio> element
 * (src/interaction/static/index.html's speakText), and the speak_text tool
 * base64-encodes it into an audioDirective the same page plays through a
 * Blob of the given mimeType (playAudioBase64). A bare PCM buffer labeled
 * with an audio mime type is not decodable by either path -- wrapping it in
 * a real WAV container (and returning "audio/wav" as the content type,
 * see synthesizeSpeech below) is what makes the daemon's actual output
 * format match what those existing callers already assume.
 */
function pcm16ToWav(pcm: Buffer, sampleRate: number): Buffer {
  const byteRate = (sampleRate * PCM_CHANNELS * PCM_BITS_PER_SAMPLE) / 8;
  const blockAlign = (PCM_CHANNELS * PCM_BITS_PER_SAMPLE) / 8;
  const header = Buffer.alloc(44);
  header.write("RIFF", 0);
  header.writeUInt32LE(36 + pcm.length, 4);
  header.write("WAVE", 8);
  header.write("fmt ", 12);
  header.writeUInt32LE(16, 16); // fmt chunk size
  header.writeUInt16LE(1, 20); // PCM
  header.writeUInt16LE(PCM_CHANNELS, 22);
  header.writeUInt32LE(sampleRate, 24);
  header.writeUInt32LE(byteRate, 28);
  header.writeUInt16LE(blockAlign, 32);
  header.writeUInt16LE(PCM_BITS_PER_SAMPLE, 34);
  header.write("data", 36);
  header.writeUInt32LE(pcm.length, 40);
  return Buffer.concat([header, pcm]);
}

/**
 * Offline text-to-speech via the local voice daemon (daemon/voice_engine.py,
 * over its Unix socket) -- the local-first counterpart to whatever live
 * voice path Gemini's Live API provides, used by the speak_text tool and by
 * the /api/integrations/tts/speak HTTP route (src/interaction/routes/
 * integrations-routes.ts). Does a one-shot synthesis request/response over
 * the daemon's socket (see synthesizeOverSocket in src/core/
 * audio-client.ts), then wraps the raw PCM it gets back into a real WAV
 * container so callers get a directly playable file, same as the removed
 * TTS_URL-based HTTP service used to hand back (there, an actual
 * audio/mpeg MP3; here, audio/wav -- either way, a self-describing format,
 * not bare PCM).
 *
 * opts.voice/opts.model are accepted (unchanged signature, so existing
 * callers need no changes) but currently have no effect: the daemon's
 * Kokoro pipeline uses a single fixed voice (KOKORO_VOICE in daemon/
 * models.py) and there is no alternate model to select -- unlike the
 * removed HTTP service, which proxied arbitrary Edge TTS voice IDs.
 */
export async function synthesizeSpeech(
  text: string,
  opts: { voice?: string; model?: string } = {}
): Promise<{ audio: Buffer; contentType: string }> {
  void opts;
  const socketPath = process.env.VOICE_DAEMON_SOCKET || DEFAULT_VOICE_DAEMON_SOCKET;

  let pcm: Buffer;
  try {
    pcm = await synthesizeOverSocket(socketPath, text);
  } catch (err: any) {
    const message = err?.message || String(err);
    observation.logTelemetry("warn", "Integrations", `Voice daemon synthesis request failed: ${message}`);
    throw new TtsIntegrationError(`Voice daemon error: ${message}`, 503);
  }

  observation.logTelemetry("info", "Integrations", `Synthesized speech for ${text.length} characters`);
  return {
    audio: pcm16ToWav(pcm, KOKORO_SAMPLE_RATE),
    contentType: "audio/wav",
  };
}
