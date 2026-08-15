import * as crypto from "crypto";
import { startAudioClient } from "../core/audio-client.js";

interface ManagedSession {
  username: string;
  audioClient: { stop: () => void };
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
 * Closes a session's daemon connection and forgets it. Returns whether a
 * session with that id actually existed, so a caller can tell "I cleaned
 * up a real session" apart from "there was nothing to clean up" -- e.g. a
 * double-destroy from an overlapping wake-word/timeout race in a future
 * producer.
 */
export function destroyVoiceSession(sessionId: string): boolean {
  const session = activeSessions.get(sessionId);
  if (!session) return false;
  session.audioClient.stop();
  activeSessions.delete(sessionId);
  return true;
}

/**
 * Closes every currently active session's daemon connection -- for a
 * clean process shutdown (see server.ts's SIGTERM handling), so a restart
 * doesn't leave orphaned daemon-side connections lingering until they time
 * out on their own.
 */
export function destroyAllVoiceSessions(): void {
  for (const sessionId of Array.from(activeSessions.keys())) {
    destroyVoiceSession(sessionId);
  }
}
