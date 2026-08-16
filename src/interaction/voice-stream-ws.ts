import { WebSocket } from "ws";
import { EventBus } from "../core/event-bus.js";
import { ObservationPlatform } from "../kernel/observation.js";
import { createVoiceSession, destroyVoiceSession, sendVoiceSessionAudioChunk } from "./voice-session-manager.js";
import { pcm16ToWav, KOKORO_SAMPLE_RATE } from "./tts.js";

const observation = ObservationPlatform.getInstance();

// Hard ceiling on how long one ambient turn may stay open. Nothing else
// bounds this connection: if the trigger produced silence, an empty
// transcript, or the daemon's own inference failed, neither
// voice:speak-done nor voice:error ever fires, so finish() would never
// run -- leaking the daemon connection and the session-manager entry, and
// leaving the browser streaming live microphone audio indefinitely. Since
// /ws/voice-stream is remotely reachable by any authenticated personal
// user, an unbounded turn is also a trivial resource-exhaustion vector.
const TURN_TIMEOUT_MS = 60_000;

// Bounds on inbound mic PCM, independent of TURN_TIMEOUT_MS above -- the
// timeout caps how long a turn can stay open, not how much data a client
// sends while it's open. At 16kHz mono 16-bit PCM, one second of real audio
// is 32,000 bytes; MAX_PCM_BYTES_PER_TURN gives a wide margin over what a
// real 60-second turn could ever legitimately produce (60s * 32,000B/s =
// ~1.9MB) without letting a malicious/misbehaving client force unbounded
// base64 allocations or unbounded writes to the daemon socket.
const MAX_PCM_FRAME_BYTES = 64 * 1024;
const MAX_PCM_BYTES_PER_TURN = 4 * 1024 * 1024;

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
  let receivedPcmBytes = 0;

  let unsubAudioChunk: () => void = () => {};
  let unsubSpeakDone: () => void = () => {};
  let unsubError: () => void = () => {};
  let turnTimeout: NodeJS.Timeout | undefined;

  const finish = (reason: "reply" | "error" | "client-closed", message?: string) => {
    if (closed) return;
    closed = true;
    if (turnTimeout) clearTimeout(turnTimeout);
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

  // Armed before any subscription exists, so finish() can never be reached
  // (by a bus event or a client close) while the timer is still unset; the
  // clearTimeout in finish() then makes a normal completion cancel it, and
  // the `closed` guard means it can never fire twice or after the fact.
  turnTimeout = setTimeout(() => {
    finish("error", "Ambient voice turn timed out waiting for a reply");
  }, TURN_TIMEOUT_MS);

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
    if (data.length > MAX_PCM_FRAME_BYTES || receivedPcmBytes + data.length > MAX_PCM_BYTES_PER_TURN) {
      finish("error", "Ambient voice audio limit exceeded");
      return;
    }
    receivedPcmBytes += data.length;
    sendVoiceSessionAudioChunk(sessionId, data);
  });

  ws.on("error", (err: any) => {
    observation.logTelemetry("warn", "VoiceStreamWs", `/ws/voice-stream socket error for session ${sessionId}: ${err?.message || err}`);
  });

  ws.on("close", () => {
    finish("client-closed");
  });
}
