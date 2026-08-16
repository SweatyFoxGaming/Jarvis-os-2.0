import * as crypto from "crypto";
import { startAudioClient } from "../core/audio-client.js";
import { ObservationPlatform } from "../kernel/observation.js";

const observation = ObservationPlatform.getInstance();

interface ManagedSession {
  username: string;
  audioClient: { stop: () => void; sendAudioChunk: (pcmBytes: Buffer) => boolean };
}

// Module-level by design (not a class) -- there's exactly one process-wide
// registry of active voice sessions, the same way EventBus.getInstance()
// is a singleton. A future producer (out of scope here) calls
// createVoiceSession() once per activation (e.g. once per wake-word
// trigger) and destroyVoiceSession() once that session's turn/connection
// should end.
const activeSessions = new Map<string, ManagedSession>();

/**
 * Opens one real, independent connection to the voice daemon for this
 * session and returns a fresh sessionId identifying it. The daemon's own
 * per-connection utterance-buffer isolation (daemon/voice_engine.py's
 * handle_connection) is what actually keeps concurrent sessions' audio
 * from mixing -- this function's job is just making sure each session
 * gets its own real connection instead of sharing the old single global
 * one, so that isolation guarantee actually applies.
 */
export function createVoiceSession(socketPath: string, username: string): string {
  const sessionId = crypto.randomUUID();
  const audioClient = startAudioClient(socketPath, sessionId, username);
  activeSessions.set(sessionId, { username, audioClient });
  return sessionId;
}

/**
 * Looks up the username a still-active session was created with. Returns
 * undefined for an unknown/already-destroyed sessionId. This is the
 * supported sessionId -> username resolution path for future callers (e.g.
 * Sub-project B) -- the `username` field on ManagedSession is otherwise
 * write-only today, since no production caller exists yet.
 */
export function getVoiceSessionUsername(sessionId: string): string | undefined {
  return activeSessions.get(sessionId)?.username;
}

/**
 * Forwards one raw PCM audio chunk into a still-active session's daemon
 * connection. Returns false (no throw) for an unknown sessionId or a
 * currently-unwritable connection -- callers (voice-stream-ws.ts) treat
 * false as "this frame was dropped," not a fatal error, since a session
 * can legitimately end mid-stream (the daemon fires an utterance-end
 * transcript, or the browser side disconnects) without every in-flight
 * frame being a bug.
 */
export function sendVoiceSessionAudioChunk(sessionId: string, pcmBytes: Buffer): boolean {
  const session = activeSessions.get(sessionId);
  if (!session) return false;
  return session.audioClient.sendAudioChunk(pcmBytes);
}

/**
 * Closes a session's daemon connection and forgets it. Returns whether a
 * session with that id actually existed, so a caller can tell "I cleaned
 * up a real session" apart from "there was nothing to clean up" -- e.g. a
 * double-destroy from an overlapping wake-word/timeout race in a future
 * producer.
 *
 * Deletes the map entry BEFORE calling stop() (in a finally) so that a
 * throwing audioClient.stop() can never leave a session permanently stuck
 * in activeSessions -- without this, a retry would just look it up again
 * and throw again forever.
 */
export function destroyVoiceSession(sessionId: string): boolean {
  const session = activeSessions.get(sessionId);
  if (!session) return false;
  try {
    activeSessions.delete(sessionId);
  } finally {
    session.audioClient.stop();
  }
  return true;
}

/**
 * Closes every currently active session's daemon connection -- for a
 * clean process shutdown (see server.ts's SIGTERM handling), so a restart
 * doesn't leave orphaned daemon-side connections lingering until they time
 * out on their own.
 *
 * Each session is torn down inside its own try/catch: destroyAllVoiceSessions
 * sits first in server.ts's shutdown chain, so one session's stop() throwing
 * must never abort the loop and skip every other session's cleanup (or the
 * fsWatcher/liveAnalysis/shadowVerifier/voiceSession teardown steps that run
 * after this call returns).
 */
export function destroyAllVoiceSessions(): void {
  for (const sessionId of Array.from(activeSessions.keys())) {
    try {
      destroyVoiceSession(sessionId);
    } catch (err: any) {
      observation.logTelemetry(
        "error",
        "VoiceSessionManager",
        `Failed to cleanly destroy voice session ${sessionId} during shutdown, continuing with the rest: ${err?.message || err}`
      );
    }
  }
}
