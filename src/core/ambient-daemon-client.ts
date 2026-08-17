import * as net from "net";
import * as readline from "readline";
import { EventBus } from "./event-bus.js";
import { ObservationPlatform } from "../kernel/observation.js";

const observation = ObservationPlatform.getInstance();

// Fixed sessionId every host-mic turn is dispatched under -- there is no
// browser session/login for this path (see this plan's spec), just one
// persistent connection Node opens to the daemon at boot. Reusing
// voice-session.ts's existing voice:transcript/voice:reply contract
// completely unchanged (it only requires sessionId+username to be
// non-empty strings, never checks a session registry) is what lets this
// module add zero new code to the turn-execution pipeline itself.
export const AMBIENT_SESSION_ID = "ambient-host";

const INITIAL_RECONNECT_DELAY_MS = 1000;
const MAX_RECONNECT_DELAY_MS = 30000;

/**
 * Opens ONE persistent connection to the voice daemon, at boot -- not
 * per-browser-session like startAudioClient (src/core/audio-client.ts).
 * On the daemon's "ambient_transcript" message, publishes voice:transcript
 * under AMBIENT_SESSION_ID + defaultUsername, reusing voice-session.ts's
 * existing turn machinery completely unchanged. On the matching
 * voice:reply, sends "speak_local" back down the same connection so the
 * daemon synthesizes and plays the reply directly on the host speaker --
 * unlike startAudioClient's "speak", there is no audio_chunk stream-back
 * expected for this message type (see daemon/voice_engine.py's
 * _handle_speak_local).
 *
 * Deliberately a separate, small reconnect implementation rather than a
 * shared abstraction with startAudioClient -- the two differ enough
 * (fixed vs. per-caller sessionId, "speak_local" vs. "speak", no
 * sendAudioChunk/audio_chunk handling at all) that forcing one shared
 * function would need its own branching special-case, and this codebase
 * already tolerates near-duplicate connection-lifecycle code for exactly
 * this reason (transcribeOverSocket/synthesizeOverSocket in the same
 * file as startAudioClient).
 */
export function startAmbientDaemonClient(socketPath: string, defaultUsername: string): { stop: () => void } {
  const bus = EventBus.getInstance();
  let stopped = false;
  let socket: net.Socket | null = null;
  let rl: readline.Interface | null = null;
  let reconnectTimer: NodeJS.Timeout | null = null;
  let backoffMs = INITIAL_RECONNECT_DELAY_MS;

  const unsubscribeReply = bus.subscribe("voice:reply", (payload: any) => {
    if (stopped || !socket || !socket.writable || payload.sessionId !== AMBIENT_SESSION_ID) return;
    socket.write(JSON.stringify({ type: "speak_local", text: payload.text }) + "\n");
  });

  const scheduleReconnect = () => {
    if (stopped) return;
    const delay = backoffMs;
    backoffMs = Math.min(backoffMs * 2, MAX_RECONNECT_DELAY_MS);
    reconnectTimer = setTimeout(() => {
      reconnectTimer = null;
      connect();
    }, delay);
    reconnectTimer.unref();
  };

  const connect = () => {
    if (stopped) return;
    if (!defaultUsername) {
      observation.logTelemetry(
        "warn",
        "AmbientDaemonClient",
        "AMBIENT_DEFAULT_USERNAME is not set -- ambient host-mic listening will connect to the daemon but will NOT register as the ambient connection, so no wake-word turn can be delivered. Set it to a real registered account to enable the feature."
      );
    }

    let errorReported = false;
    const newSocket = net.createConnection({ path: socketPath });
    socket = newSocket;

    const newRl = readline.createInterface({ input: newSocket });
    rl = newRl;
    newRl.on("error", () => {});
    newRl.on("line", (line) => {
      if (!line.trim()) return;
      let msg: any;
      try {
        msg = JSON.parse(line);
      } catch {
        observation.logTelemetry("warn", "AmbientDaemonClient", `Malformed line from voice daemon, ignoring: ${line.slice(0, 200)}`);
        return;
      }
      if (msg.type === "ambient_transcript" && defaultUsername) {
        bus.publish("voice:transcript", { text: msg.text, sessionId: AMBIENT_SESSION_ID, username: defaultUsername });
      }
      // "speak_local_done" carries no state this module needs to react to
      // -- the daemon's own AmbientListener.turn_complete() (Task 3) is
      // what actually re-arms wake-word detection, triggered daemon-side
      // once it writes that message, not by anything Node does with it.
    });

    newSocket.on("connect", () => {
      backoffMs = INITIAL_RECONNECT_DELAY_MS;
      // Identifies this connection to the daemon as THE ambient one (see
      // daemon/voice_engine.py's "hello_ambient" dispatch case, Task 3) --
      // without this, the daemon has no way to know which of its several
      // simultaneous connections (per-session ones, one-shot
      // transcribe/synthesize ones, and this one) should receive
      // ambient_transcript pushes.
      //
      // Deliberately NOT sent when defaultUsername is empty. With no real
      // account configured, every wake-word turn would be dropped by
      // voice-session.ts's missing-username guard anyway -- but the daemon
      // would still have registered this connection as _ambient_writer,
      // so its AmbientListener would set _turn_in_progress=True on each
      // trigger and then wait forever for a speak_local reply that
      // voice-session.ts never produces, permanently latching ambient
      // listening off. Skipping the handshake leaves _ambient_writer
      // unset, so the daemon takes its "no active ambient connection"
      // branch instead, which correctly re-arms the listener every time.
      if (defaultUsername) {
        newSocket.write(JSON.stringify({ type: "hello_ambient" }) + "\n");
      }
    });

    newSocket.on("error", (err: any) => {
      if (stopped || errorReported) return;
      errorReported = true;
      observation.logTelemetry("warn", "AmbientDaemonClient", `Voice daemon socket error: ${err.message || err}`);
    });

    newSocket.on("close", () => {
      newRl.close();
      if (stopped) return;
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
