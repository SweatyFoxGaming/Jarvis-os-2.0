import * as net from "net";
import * as readline from "readline";
import { EventBus } from "./event-bus.js";
import { ObservationPlatform } from "../kernel/observation.js";

const observation = ObservationPlatform.getInstance();

/**
 * Bridges the voice daemon's Unix domain socket to the in-process event
 * bus — and does nothing else. No LLM calls, no tool-calling, no memory/
 * knowledge-graph access happen here; that boundary belongs to the
 * voice-session handler that consumes voice:transcript downstream (a
 * separate piece of work). This module only translates newline-delimited
 * JSON control messages on the socket into bus events, and voice:reply
 * bus events back into a "speak" message on the socket.
 */
export function startAudioClient(socketPath: string): { stop: () => void } {
  const bus = EventBus.getInstance();
  let stopped = false;
  // A real connect failure fires exactly one "error" then exactly one
  // "close" on the same socket — both handlers below would otherwise each
  // publish their own voice:error for that single episode. This flag is
  // set by whichever fires first so only one voice:error ever goes out
  // per connection-failure/drop, regardless of which event leads.
  let errorReported = false;

  const socket = net.createConnection({ path: socketPath });

  const rl = readline.createInterface({ input: socket });
  // readline.Interface forwards its input stream's own "error" event as an
  // "error" event on itself (see node:internal/readline/interface's
  // onerror listener) — with no listener here, Node's default EventEmitter
  // behavior re-throws it as an uncaught exception and kills the process.
  // The real handling already happens in socket.on("error", ...) below;
  // this is only here so that forwarded duplicate doesn't crash the host.
  rl.on("error", () => {});
  rl.on("line", (line) => {
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
      bus.publish("voice:transcript", { text: msg.text });
    } else if (msg.type === "audio_chunk") {
      bus.publish("voice:audio-chunk", { data: msg.data });
    }
  });

  socket.on("error", (err: any) => {
    if (stopped || errorReported) return;
    errorReported = true;
    observation.logTelemetry("warn", "AudioClient", `Voice daemon socket error: ${err.message || err}`);
    bus.publish("voice:error", { message: err.message || String(err) });
  });

  socket.on("close", () => {
    if (stopped || errorReported) return;
    errorReported = true;
    bus.publish("voice:error", { message: "Voice daemon connection closed unexpectedly" });
  });

  const unsubscribeReply = bus.subscribe("voice:reply", (payload: any) => {
    if (stopped || !socket.writable) return;
    socket.write(JSON.stringify({ type: "speak", text: payload.text }) + "\n");
  });

  return {
    stop: () => {
      if (stopped) return;
      stopped = true;
      unsubscribeReply();
      rl.close();
      socket.destroy();
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
