import { ObservationPlatform } from "../observation/index.js";

const observation = ObservationPlatform.getInstance();

export class WhisperIntegrationError extends Error {
  constructor(message: string, public status = 500) {
    super(message);
  }
}

/**
 * Offline speech-to-text via the whisper-cpp Docker service (see
 * docker-compose.yml) — the local-first counterpart to Gemini's multimodal
 * transcription, used when GEMINI_API_KEY isn't set or offline mode is on.
 * audioBase64 is the same base64 payload the client already sends for the
 * Gemini path; whisper-cpp's /inference endpoint takes multipart form data
 * instead, so this decodes and re-wraps it as a Blob.
 */
export async function transcribeAudio(audioBase64: string, mimeType: string): Promise<string> {
  const whisperUrl = process.env.WHISPER_URL;
  if (!whisperUrl) {
    throw new WhisperIntegrationError("WHISPER_URL is not set — offline speech-to-text is unavailable.", 503);
  }

  const audioBuffer = Buffer.from(audioBase64, "base64");
  const form = new FormData();
  form.append("file", new Blob([audioBuffer], { type: mimeType || "audio/webm" }), "audio");
  form.append("response_format", "json");

  const res = await fetch(whisperUrl, { method: "POST", body: form });

  if (!res.ok) {
    const body = await res.text().catch(() => "");
    observation.logTelemetry("warn", "Integrations", `Whisper request failed: ${res.status} ${body}`);
    throw new WhisperIntegrationError(`Whisper service error (${res.status}): ${body}`, res.status);
  }

  const parsed = await res.json() as { text?: string };
  const text = (parsed.text || "").trim();
  observation.logTelemetry("info", "Integrations", `Offline transcription completed: "${text}"`);
  return text;
}
