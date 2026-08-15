import * as net from "net";
import * as readline from "readline";
import { EventBus } from "./event-bus.js";
import { ObservationPlatform } from "../kernel/observation.js";

const observation = ObservationPlatform.getInstance();

// Reconnect-with-backoff tuning for startAudioClient (I5) -- docker-
// compose.yml's `depends_on` only controls container START ORDER, not
// readiness, and the daemon takes many seconds to import torch/
// faster-whisper/kokoro after its process starts. Without a retry loop, a
// connection attempt that loses that race (ECONNREFUSED/ENOENT) would
// previously give up permanently for the life of the process. Starts at
// 1s and doubles on every failed attempt, capped at 30s, resetting back to
// the initial delay on the next successful connection.
const INITIAL_RECONNECT_DELAY_MS = 1000;
const MAX_RECONNECT_DELAY_MS = 30000;

// Only real base64 alphabet characters, with 0-2 trailing "=" padding, and
// a length that's a multiple of 4 (base64's own encoding invariant).
const BASE64_PATTERN = /^[A-Za-z0-9+/]*={0,2}$/;

/**
 * Decodes a base64 string, actually rejecting malformed input -- unlike
 * plain `Buffer.from(str, "base64")`, which never throws on malformed
 * base64 in Node.js: it silently decodes whatever valid-looking characters
 * it finds and ignores the rest, producing garbage bytes rather than
 * raising. A bare try/catch around Buffer.from(..., "base64") therefore
 * never actually catches anything (M12 finding) -- this does a real format
 * check (character set + length-is-a-multiple-of-4) BEFORE decoding, so a
 * genuinely malformed chunk is dropped instead of silently corrupting the
 * concatenated result with garbage bytes. Returns null (not a partial/
 * garbage Buffer) on anything that isn't well-formed base64.
 */
function decodeBase64Strict(value: unknown): Buffer | null {
  if (typeof value !== "string") return null;
  if (value.length === 0) return Buffer.alloc(0);
  if (value.length % 4 !== 0 || !BASE64_PATTERN.test(value)) return null;
  return Buffer.from(value, "base64");
}

/**
 * Bridges the voice daemon's Unix domain socket to the in-process event
 * bus — and does nothing else. No LLM calls, no tool-calling, no memory/
 * knowledge-graph access happen here; that boundary belongs to the
 * voice-session handler that consumes voice:transcript downstream (a
 * separate piece of work). This module only translates newline-delimited
 * JSON control messages on the socket into bus events, and voice:reply
 * bus events back into a "speak" message on the socket.
 *
 * Reconnects automatically with capped exponential backoff (I5) on any
 * connection failure or drop that wasn't caused by an explicit stop() —
 * see INITIAL_RECONNECT_DELAY_MS/MAX_RECONNECT_DELAY_MS above. Each failed
 * connection attempt still publishes exactly one voice:error (deduped per
 * attempt, same guarantee the original single-shot version had), but the
 * client keeps retrying indefinitely instead of giving up after the first
 * failure.
 */
export function startAudioClient(socketPath: string, sessionId: string = "", username: string = ""): { stop: () => void } {
  const bus = EventBus.getInstance();
  let stopped = false;
  let socket: net.Socket | null = null;
  let rl: readline.Interface | null = null;
  let reconnectTimer: NodeJS.Timeout | null = null;
  let backoffMs = INITIAL_RECONNECT_DELAY_MS;

  const unsubscribeReply = bus.subscribe("voice:reply", (payload: any) => {
    // A reply for a DIFFERENT session must never be spoken over THIS
    // connection's daemon socket -- with multiple concurrent sessions now
    // possible, voice:reply is no longer implicitly "the one reply
    // everyone's waiting on".
    if (stopped || !socket || !socket.writable || payload.sessionId !== sessionId) return;
    socket.write(JSON.stringify({ type: "speak", text: payload.text }) + "\n");
  });

  const scheduleReconnect = () => {
    if (stopped) return;
    const delay = backoffMs;
    backoffMs = Math.min(backoffMs * 2, MAX_RECONNECT_DELAY_MS);
    reconnectTimer = setTimeout(() => {
      reconnectTimer = null;
      connect();
    }, delay);
    // unref() so this timer alone never keeps the Node process alive --
    // correct for the real long-running server process (which always has
    // other reasons to stay up), and means a test/script that forgets to
    // call stop() hangs on nothing rather than hanging the process itself.
    reconnectTimer.unref();
  };

  const connect = () => {
    if (stopped) return;
    // A real connect failure fires exactly one "error" then exactly one
    // "close" on the same socket — both handlers below would otherwise each
    // publish their own voice:error for that single episode. This flag is
    // scoped per connection attempt so only one voice:error ever goes out
    // per connection-failure/drop, regardless of which event leads — and a
    // fresh one applies to each new attempt across reconnects.
    let errorReported = false;

    const newSocket = net.createConnection({ path: socketPath });
    socket = newSocket;

    const newRl = readline.createInterface({ input: newSocket });
    rl = newRl;
    // readline.Interface forwards its input stream's own "error" event as an
    // "error" event on itself (see node:internal/readline/interface's
    // onerror listener) — with no listener here, Node's default EventEmitter
    // behavior re-throws it as an uncaught exception and kills the process.
    // The real handling already happens in newSocket.on("error", ...) below;
    // this is only here so that forwarded duplicate doesn't crash the host.
    newRl.on("error", () => {});
    newRl.on("line", (line) => {
      if (!line.trim()) return;
      let msg: any;
      try {
        msg = JSON.parse(line);
      } catch {
        observation.logTelemetry(
          "warn",
          "AudioClient",
          `Malformed line from voice daemon, ignoring: ${line.slice(0, 200)}`
        );
        return;
      }

      if (msg.type === "transcript") {
        bus.publish("voice:transcript", { text: msg.text, sessionId, username });
      } else if (msg.type === "audio_chunk") {
        bus.publish("voice:audio-chunk", { data: msg.data, sessionId });
      } else if (msg.type === "queued") {
        bus.publish("voice:queued", { position: msg.position, sessionId });
      }
    });

    newSocket.on("connect", () => {
      // A real connection succeeded -- reset backoff so the *next*
      // failure episode (if any) starts fresh from the initial delay
      // rather than continuing to climb from wherever a prior episode
      // left off.
      backoffMs = INITIAL_RECONNECT_DELAY_MS;
    });

    newSocket.on("error", (err: any) => {
      if (stopped || errorReported) return;
      errorReported = true;
      observation.logTelemetry("warn", "AudioClient", `Voice daemon socket error: ${err.message || err}`);
      bus.publish("voice:error", { message: err.message || String(err), sessionId });
    });

    newSocket.on("close", () => {
      newRl.close();
      if (stopped) return;
      if (!errorReported) {
        errorReported = true;
        bus.publish("voice:error", { message: "Voice daemon connection closed unexpectedly", sessionId });
      }
      scheduleReconnect();
    });
  };

  connect();

  return {
    stop: () => {
      if (stopped) return;
      stopped = true;
      unsubscribeReply();
      if (reconnectTimer) {
        clearTimeout(reconnectTimer);
        reconnectTimer = null;
      }
      if (rl) rl.close();
      if (socket) socket.destroy();
    },
  };
}

// Outgoing audio_data messages are split into pieces this size (bytes of
// raw PCM, pre-base64) so one big recorded clip doesn't arrive as a single
// huge line on the socket -- mirrors SPEAK_CHUNK_BYTES on the daemon side
// (daemon/voice_engine.py) for outgoing "speak" audio.
const TRANSCRIBE_CHUNK_BYTES = 32000;

/**
 * One-shot request/response transcription against the voice daemon, for
 * callers that already have a complete, pre-recorded clip (as opposed to
 * startAudioClient's long-lived bridge for the continuous mic-stream
 * flow). Opens its own short-lived connection: sends the whole clip as
 * one or more "audio_data" messages, then an explicit "transcribe"
 * control message (daemon/voice_engine.py's _handle_transcribe) so the
 * daemon transcribes immediately, and resolves with the first "transcript"
 * reply. `pcmBytes` must already be raw 16-bit PCM, mono, 16kHz -- the
 * same format the daemon's SpeechToText.transcribe expects; this function
 * does no audio decoding of its own.
 *
 * Deliberately sends "audio_data", NOT "audio_chunk": the daemon routes
 * every "audio_chunk" through UtteranceEndDetector.feed() (see
 * daemon/voice_engine.py's _handle_audio_chunk), which is silence-based
 * heuristic logic built for the continuous mic-stream flow. A pre-recorded
 * clip can easily contain a long silent stretch (e.g. a trailing pause
 * before the browser stopped recording) that would trip that detector and
 * produce a truncated transcript *before* the explicit "transcribe"
 * message below even arrives. "audio_data" (see _handle_audio_data) only
 * ever buffers PCM -- it never touches the detector -- so this function's
 * own "transcribe" message is the only thing that can ever trigger a
 * response here.
 */
export function transcribeOverSocket(
  socketPath: string,
  pcmBytes: Buffer,
  timeoutMs = 60000
): Promise<string> {
  return new Promise((resolve, reject) => {
    const socket = net.createConnection({ path: socketPath });
    const rl = readline.createInterface({ input: socket });
    // Same rationale as startAudioClient's identical rl.on("error", ...):
    // readline forwards the input stream's "error" as its own, and the
    // real handling already happens via socket.on("error", ...) below.
    rl.on("error", () => {});

    let settled = false;
    const timer = setTimeout(() => {
      finish(() => reject(new Error("Timed out waiting for the voice daemon to transcribe audio")));
    }, timeoutMs);

    function finish(action: () => void): void {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      rl.close();
      socket.destroy();
      action();
    }

    rl.on("line", (line) => {
      if (!line.trim()) return;
      let msg: any;
      try {
        msg = JSON.parse(line);
      } catch {
        observation.logTelemetry(
          "warn",
          "AudioClient",
          `Malformed line from voice daemon during one-shot transcription, ignoring: ${line.slice(0, 200)}`
        );
        return;
      }
      if (msg.type === "transcript") {
        finish(() => resolve(typeof msg.text === "string" ? msg.text : ""));
      }
    });

    socket.on("error", (err: any) => {
      finish(() => reject(err instanceof Error ? err : new Error(String(err))));
    });

    socket.on("close", () => {
      finish(() => reject(new Error("Voice daemon connection closed before a transcript was received")));
    });

    socket.on("connect", () => {
      for (let i = 0; i < pcmBytes.length; i += TRANSCRIBE_CHUNK_BYTES) {
        const chunk = pcmBytes.subarray(i, i + TRANSCRIBE_CHUNK_BYTES);
        socket.write(JSON.stringify({ type: "audio_data", data: chunk.toString("base64") }) + "\n");
      }
      socket.write(JSON.stringify({ type: "transcribe" }) + "\n");
    });
  });
}

/**
 * One-shot request/response synthesis against the voice daemon -- the TTS
 * mirror of transcribeOverSocket above, following the same conventions
 * (short-lived connection, timeout, single-settle resolve/reject). Sends a
 * single "speak" control message (daemon/voice_engine.py's _handle_speak),
 * then collects every "audio_chunk" reply it writes back -- one per
 * SPEAK_CHUNK_BYTES-sized slice of the synthesized PCM -- and resolves with
 * all of them concatenated IN ORDER once (and only once) the terminal
 * "speak_done" message arrives.
 *
 * Deliberately does NOT resolve on the first "audio_chunk": _handle_speak
 * can (and for anything but a very short utterance, will) write several
 * audio_chunk messages before speak_done, so resolving early would silently
 * truncate the synthesized audio -- the same bug class Task 7 found and
 * fixed for the transcription direction (see transcribeOverSocket's
 * "audio_data" vs "audio_chunk" rationale above).
 *
 * Returns the raw concatenated PCM bytes exactly as the daemon produced
 * them (16-bit signed, mono, Kokoro's fixed 24kHz -- see daemon/models.py's
 * TextToSpeech.synthesize) with no container/format wrapping; callers that
 * need a playable file (e.g. a browser <audio> element) are responsible for
 * that, same separation of concerns as transcribeOverSocket returning bare
 * text rather than an SRT/VTT file.
 */
export function synthesizeOverSocket(
  socketPath: string,
  text: string,
  timeoutMs = 60000
): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const socket = net.createConnection({ path: socketPath });
    const rl = readline.createInterface({ input: socket });
    // Same rationale as transcribeOverSocket's identical rl.on("error", ...).
    rl.on("error", () => {});

    let settled = false;
    const chunks: Buffer[] = [];
    const timer = setTimeout(() => {
      finish(() => reject(new Error("Timed out waiting for the voice daemon to synthesize speech")));
    }, timeoutMs);

    function finish(action: () => void): void {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      rl.close();
      socket.destroy();
      action();
    }

    rl.on("line", (line) => {
      if (!line.trim()) return;
      let msg: any;
      try {
        msg = JSON.parse(line);
      } catch {
        observation.logTelemetry(
          "warn",
          "AudioClient",
          `Malformed line from voice daemon during one-shot synthesis, ignoring: ${line.slice(0, 200)}`
        );
        return;
      }
      if (msg.type === "audio_chunk") {
        const decoded = decodeBase64Strict(msg.data);
        if (decoded === null) {
          observation.logTelemetry(
            "warn",
            "AudioClient",
            `Malformed base64 audio_chunk from voice daemon during one-shot synthesis, dropping: ${String(msg.data).slice(0, 100)}`
          );
        } else {
          chunks.push(decoded);
        }
      } else if (msg.type === "speak_done") {
        finish(() => resolve(Buffer.concat(chunks)));
      }
    });

    socket.on("error", (err: any) => {
      finish(() => reject(err instanceof Error ? err : new Error(String(err))));
    });

    socket.on("close", () => {
      finish(() => reject(new Error("Voice daemon connection closed before speak_done was received")));
    });

    socket.on("connect", () => {
      socket.write(JSON.stringify({ type: "speak", text }) + "\n");
    });
  });
}
