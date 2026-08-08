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
    if (stopped) return;
    observation.logTelemetry("warn", "AudioClient", `Voice daemon socket error: ${err.message || err}`);
    bus.publish("voice:error", { message: err.message || String(err) });
  });

  socket.on("close", () => {
    if (stopped) return;
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
