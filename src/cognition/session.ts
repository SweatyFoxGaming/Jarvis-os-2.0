import { MindStateTracker, MindState } from "./kernel/state.js";
import { AttentionEngine } from "./kernel/attention.js";
import { ThoughtEngine } from "./kernel/thought.js";
import { ConfidenceModel } from "./kernel/confidence.js";
import { ExecutiveStateTracker, ExecutiveStatus } from "./kernel/executive_state.js";
import { InternalDialogue } from "./kernel/dialogue.js";
import { SynchronizationEngine } from "./kernel/synchronization.js";
import { CognitiveWorkspace } from "./workspace.js";
import { ObservationPlatform } from "../kernel/observation.js";
import * as sessionRepo from "../kernel/state/session-repo.js";

const observation = ObservationPlatform.getInstance();

/**
 * Per-user working state: the "what is Jarvis thinking about right now, for
 * this conversation" half of the old MindKernel/CognitiveWorkspace globals.
 * Everything here used to be a single process-wide singleton shared by every
 * authenticated caller — two people chatting at once would interleave into
 * the same thought/attention/dialogue state. This class is instantiated once
 * per username (see getSession below) instead.
 *
 * What deliberately stays global, not here: MindKernel's persisted settings
 * (which LLM backend to use — a deployment-wide choice, not a per-user one),
 * LongTermLearningEngine (Jarvis's own learned style/skills — one intelligence,
 * not split per user), and ObservationPlatform (system-wide operational
 * telemetry for admins).
 */
export class SessionState {
  public workspace = new CognitiveWorkspace();
  public stateTracker = new MindStateTracker();
  public attentionEngine = new AttentionEngine();
  public thoughtEngine = new ThoughtEngine();
  public confidenceModel = new ConfidenceModel();
  public executiveTracker = new ExecutiveStateTracker();
  public dialogue = new InternalDialogue();
  public synchronizer = new SynchronizationEngine();
  public lastActiveAt = Date.now();

  public getState(): MindState {
    return this.stateTracker.getState();
  }

  public updateState(changes: Partial<MindState>, observation: ObservationPlatform): MindState {
    this.lastActiveAt = Date.now();
    const prevState = this.stateTracker.getState();
    const newState = this.stateTracker.update(changes);

    if (changes.currentThought) {
      this.thoughtEngine.setStage(changes.currentThought);
    }
    if (changes.executiveStatus) {
      this.executiveTracker.setStatus(changes.executiveStatus as ExecutiveStatus);
    }

    observation.logAuditEvent(
      "MindKernel",
      "MindStateUpdated",
      "success",
      `Cognitive State transitioned from "${prevState.executiveStatus}" to "${newState.executiveStatus}"`
    );

    this.synchronizer.synchronize(newState, this.workspace, observation);
    return newState;
  }
}

// A restart still clears the "live" compartments (currentThought, plan,
// attention target, etc.) — those are a per-turn narration of what Jarvis is
// doing right now, not information a user would notice or want restored.
// Conversation history is different: losing it mid-conversation because the
// process happened to restart is a real, noticeable regression, so it's the
// one piece of session state persisted to Postgres and rehydrated below.
const SESSION_IDLE_TTL_MS = 1000 * 60 * 60 * 4; // 4 hours
const sessions = new Map<string, SessionState>();

export async function getSession(username: string): Promise<SessionState> {
  let session = sessions.get(username);
  if (!session) {
    session = new SessionState();
    sessions.set(username, session);
    try {
      const history = await sessionRepo.loadRecentHistory(username);
      if (history.length > 0) {
        session.workspace.userContext.history = history;
        observation.logTelemetry("info", "Session", `Rehydrated ${history.length} conversation message(s) for "${username}" from Postgres.`);
      }
    } catch (err: any) {
      observation.logTelemetry("warn", "Session", `Conversation history rehydration failed for "${username}": ${err.message}`);
    }
  }
  session.lastActiveAt = Date.now();
  return session;
}

export function pruneIdleSessions(): number {
  const now = Date.now();
  let pruned = 0;
  for (const [username, session] of sessions.entries()) {
    if (now - session.lastActiveAt > SESSION_IDLE_TTL_MS) {
      sessions.delete(username);
      pruned++;
    }
  }
  return pruned;
}

export function getActiveSessionCount(): number {
  return sessions.size;
}

export { ExecutiveStatus };
