import { WebSocket } from "ws";
import { EventBus } from "../core/event-bus.js";
import { ObservationPlatform } from "../kernel/observation.js";
import { createVoiceSession, destroyVoiceSession, sendVoiceSessionAudioChunk } from "./voice-session-manager.js";
import { pcm16ToWav, KOKORO_SAMPLE_RATE } from "./tts.js";

const observation = ObservationPlatform.getInstance();

/**
 * Handles one already-authenticated /ws/voice-stream connection end to
 * end: opens a fresh per-connection voice session, forwards every inbound
 * binary frame into it as a raw PCM audio_chunk, accumulates the reply
 * audio the daemon streams back (voice:audio-chunk) until the daemon
 * signals it's done synthesizing (voice:speak-done), then sends the whole
 * reply as one playable WAV blob in a single "turn_complete" control
 * message and closes -- or relays voice:error and closes, on failure.
 *
 * Deliberately does NOT subscribe to voice:reply: that event fires the
 * moment a text reply exists and synthesis has just been REQUESTED, not
 * when the audio is actually finished streaming -- closing on voice:reply
 * would truncate the reply. voice:speak-done is the precise "audio is
 * done" signal (see audio-client.ts).
 *
 * server.ts owns authentication (ticket/X-API-Key) and wiring this into
 * its own httpServer "upgrade" dispatch -- this function starts from an
 * already-known-good username, which keeps it independently testable
 * (see tests/index.test.ts's VoiceStreamWs category) without needing a
 * full authenticated HTTP round trip.
 */
export function handleVoiceStreamConnection(ws: WebSocket, username: string, socketPath: string): void {
  const bus = EventBus.getInstance();
  const sessionId = createVoiceSession(socketPath, username);
  let closed = false;
  const audioChunks: Buffer[] = [];

  let unsubAudioChunk: () => void = () => {};
  let unsubSpeakDone: () => void = () => {};
  let unsubError: () => void = () => {};

  const finish = (reason: "reply" | "error" | "client-closed", message?: string) => {
    if (closed) return;
    closed = true;
    unsubAudioChunk();
    unsubSpeakDone();
    unsubError();
    if (ws.readyState === ws.OPEN) {
      if (reason === "reply") {
        const pcm = Buffer.concat(audioChunks);
        const wav = pcm16ToWav(pcm, KOKORO_SAMPLE_RATE);
        ws.send(JSON.stringify({ type: "turn_complete", mimeType: "audio/wav", audio: wav.toString("base64") }));
      } else if (reason === "error") {
        ws.send(JSON.stringify({ type: "error", message: message || "Voice pipeline error" }));
      }
      ws.close();
    }
    destroyVoiceSession(sessionId);
    observation.logTelemetry("info", "VoiceStreamWs", `/ws/voice-stream session ${sessionId} for "${username}" ended (${reason}).`);
  };

  unsubAudioChunk = bus.subscribe<{ sessionId?: string; data?: string }>("voice:audio-chunk", (payload) => {
    if (payload?.sessionId !== sessionId || typeof payload.data !== "string") return;
    audioChunks.push(Buffer.from(payload.data, "base64"));
  });
  unsubSpeakDone = bus.subscribe<{ sessionId?: string }>("voice:speak-done", (payload) => {
    if (payload?.sessionId !== sessionId) return;
    finish("reply");
  });
  unsubError = bus.subscribe<{ sessionId?: string; message?: string }>("voice:error", (payload) => {
    if (payload?.sessionId !== sessionId) return;
    finish("error", payload.message);
  });

  observation.logTelemetry("info", "VoiceStreamWs", `/ws/voice-stream session ${sessionId} opened for "${username}".`);

  ws.on("message", (data: Buffer, isBinary: boolean) => {
    if (closed || !isBinary) return;
    sendVoiceSessionAudioChunk(sessionId, data);
  });

  ws.on("error", (err: any) => {
    observation.logTelemetry("warn", "VoiceStreamWs", `/ws/voice-stream socket error for session ${sessionId}: ${err?.message || err}`);
  });

  ws.on("close", () => {
    finish("client-closed");
  });
}
