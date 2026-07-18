import { GoogleGenAI, Modality } from "@google/genai";
import type WebSocket from "ws";
import { ObservationPlatform } from "../observation/index.js";

const observation = ObservationPlatform.getInstance();

// The SDK's own doc comment on Live.connect() suggests
// "gemini-live-2.5-flash-preview", but that model isn't actually available
// for this API version/key (live-verified: 404 "not found ... or is not
// supported for bidiGenerateContent"). Queried the real models list
// (GET /v1beta/models) for whichever model actually supports
// bidiGenerateContent and used that instead of trusting the doc comment.
const LIVE_MODEL = "gemini-2.5-flash-native-audio-latest";

const VOICE_SYSTEM_INSTRUCTION =
  "You are JARVIS, a highly sophisticated, warm, and brilliant AI companion. " +
  "This is a live spoken conversation — speak naturally and conversationally, " +
  "with refined British poise. Keep replies reasonably concise, as in real speech.";

/**
 * Bridges one browser WebSocket connection to one Gemini Live API session —
 * the voice-native counterpart to the request/response voice loop
 * (/api/voice-input + TTS), which requires a full record -> transcribe ->
 * generate -> synthesize round trip per utterance. This instead holds a
 * single continuous bidirectional stream: raw PCM audio in, raw PCM audio
 * out, as it's generated.
 *
 * Client -> server: raw 16-bit PCM binary WebSocket frames (16kHz mono, the
 * rate Gemini's Live API expects), or a JSON text frame {"type":"end"} when
 * the user stops talking.
 * Server -> client: raw 24kHz PCM binary frames (the rate Gemini's Live API
 * returns) for playback, or a JSON text frame {"type":"turnComplete"} /
 * {"type":"error", message} for control signals.
 */
export async function bridgeVoiceSession(ai: GoogleGenAI, clientSocket: WebSocket, username: string): Promise<void> {
  let liveSession: Awaited<ReturnType<typeof ai.live.connect>> | null = null;

  // ai.live.connect() is a real network round trip (opens a WebSocket to
  // Google, does the setup handshake) — a client that starts streaming
  // audio the instant its own WebSocket opens can easily win that race.
  // Attaching the listener now and queueing anything that arrives before
  // liveSession exists (rather than attaching it after the await below)
  // is what actually fixes that — live-verified this was a real bug: audio
  // sent immediately on open was silently dropped, no error, no response.
  const pendingMessages: { data: Buffer; isBinary: boolean }[] = [];
  const handleClientMessage = (data: Buffer, isBinary: boolean) => {
    if (!liveSession) {
      pendingMessages.push({ data, isBinary });
      return;
    }
    if (isBinary) {
      liveSession.sendRealtimeInput({
        audio: { data: data.toString("base64"), mimeType: "audio/pcm;rate=16000" },
      });
    } else {
      try {
        const msg = JSON.parse(data.toString());
        if (msg.type === "end") {
          liveSession.sendRealtimeInput({ audioStreamEnd: true });
        }
      } catch {
        // Ignore malformed control messages rather than tearing down the session.
      }
    }
  };
  clientSocket.on("message", handleClientMessage);

  try {
    liveSession = await ai.live.connect({
      model: LIVE_MODEL,
      config: {
        responseModalities: [Modality.AUDIO],
        systemInstruction: VOICE_SYSTEM_INSTRUCTION,
      },
      callbacks: {
        onopen: () => {
          observation.logTelemetry("info", "LiveVoice", `Live session opened for "${username}".`);
        },
        onmessage: (message) => {
          if (clientSocket.readyState !== clientSocket.OPEN) return;
          const parts = message.serverContent?.modelTurn?.parts || [];
          for (const part of parts) {
            if (part.inlineData?.data && part.inlineData.mimeType?.startsWith("audio/")) {
              clientSocket.send(Buffer.from(part.inlineData.data, "base64"));
            }
          }
          if (message.serverContent?.turnComplete) {
            clientSocket.send(JSON.stringify({ type: "turnComplete" }));
          }
          if (message.serverContent?.interrupted) {
            clientSocket.send(JSON.stringify({ type: "interrupted" }));
          }
        },
        onerror: (e: any) => {
          observation.logTelemetry("warn", "LiveVoice", `Live session error for "${username}": ${e?.message || e}`);
          if (clientSocket.readyState === clientSocket.OPEN) {
            clientSocket.send(JSON.stringify({ type: "error", message: "Live voice session error." }));
          }
        },
        onclose: () => {
          observation.logTelemetry("info", "LiveVoice", `Live session closed for "${username}".`);
          if (clientSocket.readyState === clientSocket.OPEN) clientSocket.close();
        },
      },
    });
  } catch (err: any) {
    observation.logTelemetry("error", "LiveVoice", `Failed to open live session for "${username}": ${err.message}`);
    clientSocket.send(JSON.stringify({ type: "error", message: `Could not start voice session: ${err.message}` }));
    clientSocket.off("message", handleClientMessage);
    clientSocket.close();
    return;
  }

  // Flush anything that arrived while we were awaiting the connection above.
  while (pendingMessages.length > 0) {
    const { data, isBinary } = pendingMessages.shift()!;
    handleClientMessage(data, isBinary);
  }

  clientSocket.on("close", () => {
    liveSession?.close();
  });

  clientSocket.on("error", () => {
    liveSession?.close();
  });
}
