import { ObservationPlatform } from "../observation/index.js";

const observation = ObservationPlatform.getInstance();

export class TtsIntegrationError extends Error {
  constructor(message: string, public status = 500) {
    super(message);
  }
}

export async function synthesizeSpeech(
  text: string,
  opts: { voice?: string; model?: string } = {}
): Promise<{ audio: Buffer; contentType: string }> {
  const ttsUrl = process.env.TTS_URL;
  if (!ttsUrl) {
    throw new TtsIntegrationError("TTS_URL is not set — text-to-speech is unavailable.", 503);
  }

  const res = await fetch(ttsUrl, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ...(process.env.TTS_API_KEY ? { Authorization: `Bearer ${process.env.TTS_API_KEY}` } : {}),
    },
    body: JSON.stringify({
      model: opts.model || "tts-1",
      voice: opts.voice || "alloy",
      input: text,
    }),
  });

  if (!res.ok) {
    const body = await res.text().catch(() => "");
    observation.logTelemetry("warn", "Integrations", `TTS request failed: ${res.status} ${body}`);
    throw new TtsIntegrationError(`TTS service error (${res.status}): ${body}`, res.status);
  }

  const arrayBuffer = await res.arrayBuffer();
  observation.logTelemetry("info", "Integrations", `Synthesized speech for ${text.length} characters`);
  return {
    audio: Buffer.from(arrayBuffer),
    contentType: res.headers.get("content-type") || "audio/mpeg",
  };
}
