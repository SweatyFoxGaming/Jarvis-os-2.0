import { spawn } from "node:child_process";
import { ObservationPlatform } from "../kernel/observation.js";
import { transcribeOverSocket } from "../core/audio-client.js";

const observation = ObservationPlatform.getInstance();

export class WhisperIntegrationError extends Error {
  constructor(message: string, public status = 500) {
    super(message);
  }
}

// Same default the server itself uses to start the daemon bridge (see
// startAudioClient's call site in src/server.ts) -- kept in sync manually
// since this module and server.ts each open their own connection to the
// same daemon rather than sharing one.
const DEFAULT_VOICE_DAEMON_SOCKET = "/tmp/jarvis-voice/voice.sock";

/**
 * Decodes arbitrary browser-recorded audio (webm/opus, ogg, wav, whatever
 * MediaRecorder produced) into raw 16-bit PCM, mono, 16kHz -- the exact
 * format daemon/models.py's SpeechToText.transcribe expects (it does a
 * bare np.frombuffer(..., dtype=np.int16) with no decoding of its own).
 * Shells out to ffmpeg rather than pulling in a JS decoding dependency;
 * ffmpeg is already a real prerequisite of this stack (see daemon/
 * Dockerfile) and reliably handles every container format a browser might
 * produce.
 */
function decodeToPcm16Mono16k(audioBuffer: Buffer): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    let ffmpeg;
    try {
      ffmpeg = spawn("ffmpeg", [
        "-hide_banner",
        "-loglevel", "error",
        "-i", "pipe:0",
        "-f", "s16le",
        "-ar", "16000",
        "-ac", "1",
        "pipe:1",
      ]);
    } catch (err: any) {
      reject(err);
      return;
    }

    const chunks: Buffer[] = [];
    let stderr = "";
    let settled = false;

    const finish = (action: () => void) => {
      if (settled) return;
      settled = true;
      action();
    };

    ffmpeg.stdout.on("data", (chunk: Buffer) => chunks.push(chunk));
    ffmpeg.stderr.on("data", (chunk: Buffer) => { stderr += chunk.toString(); });
    // Covers e.g. ffmpeg not being installed (ENOENT) -- a real, distinct
    // failure mode from "ffmpeg ran and rejected the input".
    ffmpeg.on("error", (err) => finish(() => reject(err)));
    ffmpeg.on("close", (code) => {
      if (code !== 0) {
        finish(() => reject(new Error(`ffmpeg exited with code ${code}: ${stderr.trim()}`)));
        return;
      }
      finish(() => resolve(Buffer.concat(chunks)));
    });
    // If ffmpeg exits/rejects the input before consuming all of stdin
    // (e.g. malformed audio), writing further triggers EPIPE -- the real
    // failure is already handled by the "close"/"error" listeners above,
    // this just stops that from becoming an unhandled error.
    ffmpeg.stdin.on("error", () => {});
    ffmpeg.stdin.write(audioBuffer);
    ffmpeg.stdin.end();
  });
}

/**
 * Offline speech-to-text via the local voice daemon (daemon/voice_engine.py,
 * over its Unix socket) -- the local-first counterpart to Gemini's
 * multimodal transcription, used when GEMINI_API_KEY isn't set or offline
 * mode is on. audioBase64 is the same base64 payload the client already
 * sends for the Gemini path (a compressed clip, e.g. audio/webm, from the
 * browser's MediaRecorder); this decodes it to the raw PCM the daemon
 * expects, then does a one-shot transcription request/response over the
 * daemon's socket (see transcribeOverSocket in src/core/audio-client.ts).
 */
export async function transcribeAudio(audioBase64: string, mimeType: string): Promise<string> {
  const socketPath = process.env.VOICE_DAEMON_SOCKET || DEFAULT_VOICE_DAEMON_SOCKET;
  const audioBuffer = Buffer.from(audioBase64, "base64");

  let pcm: Buffer;
  try {
    pcm = await decodeToPcm16Mono16k(audioBuffer);
  } catch (err: any) {
    const message = err?.message || String(err);
    observation.logTelemetry("warn", "Integrations", `Failed to decode recorded audio (${mimeType || "unknown"}) for offline transcription: ${message}`);
    throw new WhisperIntegrationError(`Unable to decode audio for offline transcription: ${message}`, 400);
  }

  try {
    const text = (await transcribeOverSocket(socketPath, pcm)).trim();
    observation.logTelemetry("info", "Integrations", `Offline transcription completed: "${text}"`);
    return text;
  } catch (err: any) {
    const message = err?.message || String(err);
    observation.logTelemetry("warn", "Integrations", `Voice daemon transcription request failed: ${message}`);
    throw new WhisperIntegrationError(`Voice daemon error: ${message}`, 503);
  }
}
