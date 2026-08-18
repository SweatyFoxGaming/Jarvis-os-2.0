import type { GoogleGenAI } from "@google/genai";
import { EventBus } from "../core/event-bus.js";
import { ObservationPlatform } from "../kernel/observation.js";
import { getAi, getCognitionRouter } from "../runtime/clients.js";
import type { CognitionRouter } from "../runtime/cognition-router.js";
import { executeTool as realExecuteTool, getAllToolDeclarations as realGetAllToolDeclarations } from "../capabilities/tools.js";
import { toGroqTools as realToGroqTools } from "../runtime/groq-client.js";
import { MindKernel } from "../self/kernel.js";
import * as sessionRepo from "../kernel/state/session-repo.js";
import * as memoryStore from "../cognition/memory-store.js";
import { reflectAndLearn as realReflectAndLearn } from "../adaptation/reflection.js";
import * as knowledgeGraph from "../cognition/knowledge-graph.js";
import * as identity from "../self/identity.js";
import * as rapport from "../self/rapport.js";
import { LongTermLearningEngine } from "../adaptation/long_term_learning.js";

const observation = ObservationPlatform.getInstance();
// Same singleton /api/chat reads its style preferences off (server.ts) —
// not injected via VoiceSessionDeps like buildIdentityContext/
// buildRapportContext below, because it's a synchronous in-memory getter
// with no DB round trip, matching chat's own direct (non-DI'd) use of it.
const learningEngine = LongTermLearningEngine.getInstance();

// One-turn text pipeline for the local voice daemon. Deliberately reuses
// /api/chat's Groq/CognitionRouter tool-calling shape exactly (server.ts,
// the "Groq" branch of its execution chain) rather than inventing a new
// one — same message-building, same executeTool dispatch, same bounded
// tool-call retry loop, same final-text extraction. It does NOT reuse
// Gemini Live's bespoke functionResponse/thought_signature handling; that
// pattern belonged to the old voice path this daemon replaces and is out
// of scope here.
//
// Also mirrors /api/chat's per-turn memory/session-history/learning side
// effects (I4 fix): sessionRepo.appendMessage for both the user's
// transcript and the final spoken reply, memoryStore.recall to pull
// relevant memory into context, and — on a genuine successful reply —
// memoryStore.remember/reflectAndLearn/knowledgeGraph.extractAndStore/
// identity.extractSelfReflection/rapport.extractRapportSignal. Without
// these, a spoken conversation would leave zero trace anywhere text
// chat's memory/learning draws from, making voice and text two
// disconnected personas — see handleTranscript() below and the now-
// deleted src/interaction/live-voice.ts's flushTurn() (git history, commit
// e97ab96^) for the original version of this same pattern.
//
// As of this pass, the READ side is also fully unified, not just memory:
// handleTranscript() builds styleContext/identityContext/
// personalityContext/rapportContext the same way server.ts does for
// /api/chat, same template strings and same source functions (see
// VISION.md's "one consistent intelligence" checklist — this was the one
// concrete gap it named: voice recalled memory but didn't yet read learned
// style/self-reflection/personality/tone the way chat does). The write
// side above (extractSelfReflection/extractRapportSignal) was already
// unified; this closes the matching read side.

// Mirrors /api/chat's Groq branch's tool-attached model order exactly
// (server.ts) — the heavier, more reliably tool-capable model first since
// voice input is always attached with tools (no "fast path" trivial-message
// skip here; a spoken utterance is short enough that the token savings
// aren't worth the added complexity for a first version of this handler).
const GROQ_MODELS = ["groq:llama-3.3-70b-versatile", "groq:llama-3.1-8b-instant"];

// Same bound as /api/chat's Groq/Gemini branches' `guard < 3`.
const MAX_TOOL_CALL_ROUNDS = 3;

const VOICE_SYSTEM_INSTRUCTION =
  "You are JARVIS, styled after Tony Stark's AI in the Iron Man films: composed, dryly witty, unfailingly polite, and quietly confident rather than warm or effusive. Address the user as \"sir\" where it reads naturally. Keep responses concise and precise — this reply will be spoken aloud by a text-to-speech engine, so favor short, natural sentences over lists, bullet points, or anything that reads awkwardly out loud." +
  "\n\nIf the user asks for something you have no tool for, say so plainly rather than inventing a plausible-sounding result. Never fabricate an answer you don't actually have.";

// Never a fabricated-sounding "answer" — deliberately generic and
// obviously an apology/error, so it can never be mistaken for a real
// response to what the user asked, matching this module's core honesty
// requirement.
const HONEST_PIPELINE_ERROR_REPLY =
  "I'm sorry, sir — something went wrong on my end processing that, and I don't have a reliable answer for you right now. Please try again in a moment.";
const HONEST_NO_ROUTER_REPLY =
  "I'm sorry, sir — I don't have a language model available right now, so I can't answer that.";
const HONEST_NO_TEXT_REPLY =
  "I'm sorry, sir — I wasn't able to come up with an answer for that.";

export interface VoiceSessionDeps {
  // Left undefined (as opposed to explicitly null) means "read the live
  // shared instance fresh on every turn" — see resolveRouter/resolveAi
  // below. clients.ts's getCognitionRouter()/getAi() are getters
  // specifically so a router constructed after this module loaded (e.g.
  // server.ts's setSharedRouter() call at boot) is still seen; capturing
  // them once at startVoiceSession() call time would defeat that.
  router?: CognitionRouter | null;
  ai?: GoogleGenAI | null;
  localLlmEndpoint?: string | null;
  executeTool: typeof realExecuteTool;
  getAllToolDeclarations: typeof realGetAllToolDeclarations;
  toGroqTools: typeof realToGroqTools;
  // Write/read-side memory & session-history hooks (I4) -- mirror
  // /api/chat's real per-turn side effects (server.ts) so a spoken
  // conversation leaves the same trace a typed one does, instead of being
  // invisible to everything downstream that draws on memory/session
  // history/learning. Injectable for the same DI/testability reason as
  // executeTool/getAllToolDeclarations/toGroqTools above.
  appendMessage: typeof sessionRepo.appendMessage;
  recall: typeof memoryStore.recall;
  remember: typeof memoryStore.remember;
  reflectAndLearn: typeof realReflectAndLearn;
  extractAndStore: typeof knowledgeGraph.extractAndStore;
  extractSelfReflection: typeof identity.extractSelfReflection;
  extractRapportSignal: typeof rapport.extractRapportSignal;
  // Read side of the same identity/rapport context /api/chat builds every
  // turn (server.ts) — until now voice only had memory's read side
  // (recall above), leaving voice and text as two personas sharing a name
  // rather than one identity reachable through two interfaces (VISION.md's
  // "one consistent intelligence" gap). Injectable for the same
  // DI/testability reason as recall/remember above.
  buildIdentityContext: typeof identity.buildIdentityContext;
  buildRapportContext: typeof rapport.buildRapportContext;
}

const defaultInjectableDeps: Pick<
  VoiceSessionDeps,
  | "executeTool"
  | "getAllToolDeclarations"
  | "toGroqTools"
  | "appendMessage"
  | "recall"
  | "remember"
  | "reflectAndLearn"
  | "extractAndStore"
  | "extractSelfReflection"
  | "extractRapportSignal"
  | "buildIdentityContext"
  | "buildRapportContext"
> = {
  executeTool: realExecuteTool,
  getAllToolDeclarations: realGetAllToolDeclarations,
  toGroqTools: realToGroqTools,
  appendMessage: sessionRepo.appendMessage,
  recall: memoryStore.recall,
  remember: memoryStore.remember,
  reflectAndLearn: realReflectAndLearn,
  extractAndStore: knowledgeGraph.extractAndStore,
  extractSelfReflection: identity.extractSelfReflection,
  extractRapportSignal: rapport.extractRapportSignal,
  buildIdentityContext: identity.buildIdentityContext,
  buildRapportContext: rapport.buildRapportContext,
};

/**
 * Subscribes to voice:transcript and, for each non-empty transcript, runs
 * exactly one turn through the existing local tool-calling pipeline before
 * publishing voice:reply with the final text. Never fabricates a plausible
 * answer on failure — every failure path below publishes an honest,
 * clearly-spoken error/decline instead.
 */
export function startVoiceSession(overrides: Partial<VoiceSessionDeps> = {}): { stop: () => void } {
  const deps: VoiceSessionDeps = { ...defaultInjectableDeps, ...overrides };
  const bus = EventBus.getInstance();

  // Per-call, not module-level: startVoiceSession() returns an independent
  // { stop } handle, so each call (e.g. a fresh instance in tests) must get
  // its own turn-queue registry rather than sharing one across every call
  // this process ever makes.
  //
  // Keyed by sessionId, not shared: two DIFFERENT sessions' turns now run
  // fully concurrently -- a slow LLM call for one user must never delay
  // another user's reply (this is the fix for the head-of-line-blocking
  // finding both the sub-project A final review and CodeRabbit raised).
  // Turns WITHIN one session still run strictly in order (a session's own
  // queue is still a promise chain), matching the original single-queue's
  // per-session guarantee -- only the cross-session sharing is removed.
  // Entries are deleted once a session's chain goes idle so this map never
  // grows unbounded across the lifetime of a long-running process serving
  // many short-lived ambient sessions.
  const turnQueues = new Map<string, Promise<void>>();

  const unsubscribe = bus.subscribe<{ text?: string; sessionId?: string; username?: string }>("voice:transcript", (payload) => {
    const text = typeof payload?.text === "string" ? payload.text.trim() : "";
    if (!text) return; // empty/no-op transcript: do nothing, never publish

    const sessionId = typeof payload?.sessionId === "string" ? payload.sessionId : "";
    const username = typeof payload?.username === "string" ? payload.username : "";
    if (!sessionId || !username) {
      // A real producer (Task 3's voice-session-manager and beyond) always
      // stamps both -- this only fires for a malformed/legacy publisher,
      // and must fail loudly rather than silently misattributing a turn to
      // a fixed identity the way the old DEFAULT_USERNAME fallback did.
      observation.logTelemetry(
        "warn",
        "VoiceSession",
        `Dropping a voice:transcript event missing sessionId/username (sessionId=${sessionId || "<empty>"}, username=${username || "<empty>"}) -- refusing to guess who this turn belongs to.`
      );
      return;
    }

    // Queue this session's turns sequentially (so its own tool loops never
    // race), independently of every other session's queue.
    const priorTurn = turnQueues.get(sessionId) ?? Promise.resolve();
    const thisTurn = priorTurn
      .then(() => handleTranscript(text, sessionId, username, deps, bus))
      .catch((err: any) => {
        // handleTranscript already catches every failure internally and
        // always publishes an honest reply rather than throwing — this is
        // only a last-resort net so a truly unexpected bug in this handler
        // itself can never silently leave the user with no reply at all.
        observation.logTelemetry(
          "error",
          "VoiceSession",
          `Unexpected voice-session failure outside the normal error handling, publishing an honest error reply: ${err?.message || err}`
        );
        // Matches publishReply's own append-then-publish pattern (below,
        // inside handleTranscript) so this truly-last-resort path doesn't
        // leave conversation history missing the reply the user actually
        // heard/saw -- every other reply path already does this.
        deps.appendMessage(username, "assistant", HONEST_PIPELINE_ERROR_REPLY).catch(() => {});
        bus.publish("voice:reply", { text: HONEST_PIPELINE_ERROR_REPLY, sessionId, username });
      });
    turnQueues.set(sessionId, thisTurn);
    thisTurn.then(() => {
      // Only clear this session's entry if nothing queued a NEWER turn
      // behind it while it was running -- otherwise a fast second turn
      // for the same session would lose its place in line.
      if (turnQueues.get(sessionId) === thisTurn) turnQueues.delete(sessionId);
    });
  });

  return {
    stop: () => {
      unsubscribe();
    },
  };
}

async function handleTranscript(text: string, sessionId: string, username: string, deps: VoiceSessionDeps, bus: EventBus): Promise<void> {
  const router = deps.router !== undefined ? deps.router : getCognitionRouter();

  // Session-history write side — every spoken turn is persisted the same
  // way a typed one is (see /api/chat's sessionRepo.appendMessage call in
  // server.ts), regardless of whether the pipeline below actually
  // succeeds; a restart mid-conversation shouldn't lose it. Fire-and-
  // forget, matching /api/chat's own .catch(() => {}) on this exact call —
  // must never block or fail the actual voice reply.
  deps.appendMessage(username, "user", text).catch(() => {});

  // Every branch below publishes voice:reply exactly once and, whatever
  // text that turns out to be (a real answer or an honest decline/error),
  // persists it the same way /api/chat persists fullReply regardless of
  // whether it came from a real backend or a fallback.
  const publishReply = (replyText: string) => {
    bus.publish("voice:reply", { text: replyText, sessionId, username });
    deps.appendMessage(username, "assistant", replyText).catch(() => {});
  };

  if (!router) {
    observation.logTelemetry("warn", "VoiceSession", "No cognition router configured; publishing an honest decline instead of fabricating an answer.");
    publishReply(HONEST_NO_ROUTER_REPLY);
    return;
  }

  const ai = deps.ai !== undefined ? deps.ai : getAi();
  const localLlmEndpoint = deps.localLlmEndpoint !== undefined ? deps.localLlmEndpoint : MindKernel.getInstance().localLlmEndpoint;

  try {
    // Read side of the same memory chat already draws on every turn (see
    // memoryStore.recall in /api/chat) — best-effort: recall() itself
    // never throws, degrading to [] internally on any failure (no vector
    // store configured, embedding failure, DB error), so this never blocks
    // the voice reply.
    const memoryHits = await deps.recall(username, text, ai, localLlmEndpoint);
    const memoryContext = memoryHits.length > 0
      ? `\n\nRelevant things you remember about this user from past conversations:\n${memoryHits.map(m => `- ${m}`).join("\n")}`
      : "";

    // Read side of the identity/personality/rapport context /api/chat
    // builds every turn (server.ts) — same functions, same template
    // strings, so a preference/self-reflection/tone observation learned in
    // one interface actually informs the other, not just memory recall.
    const stylePrefs = learningEngine.getStylePreferences();
    const styleContext = `\n\nWhen writing or discussing code, prefer ${stylePrefs.namingConvention} naming, ${stylePrefs.tabSize}-space indentation, and a ${stylePrefs.architecturePattern} architecture, unless the user asks otherwise.`;
    const identityContext = await deps.buildIdentityContext(username);
    const kernel = MindKernel.getInstance();
    const personalityContext = identity.buildPersonalityPromptFragment({
      personality_formality: kernel.personalityFormality,
      personality_humor: kernel.personalityHumor,
      personality_verbosity: kernel.personalityVerbosity,
    });
    const rapportContext = await deps.buildRapportContext(username);

    const tools = deps.toGroqTools(deps.getAllToolDeclarations());
    const messages: any[] = [
      { role: "system", content: VOICE_SYSTEM_INSTRUCTION + memoryContext + styleContext + identityContext + personalityContext + rapportContext },
      { role: "user", content: text },
    ];

    let response = await router.generateWithFallback(username, { messages, tools }, GROQ_MODELS);
    let toolCalls = response?.choices?.[0]?.message?.tool_calls || [];
    let guard = 0;

    while (toolCalls.length > 0 && guard < MAX_TOOL_CALL_ROUNDS) {
      guard++;
      const assistantMessage = response.choices[0].message;
      messages.push({
        role: "assistant",
        content: assistantMessage.content,
        tool_calls: assistantMessage.tool_calls,
      });

      const toolResponseMessages: any[] = [];
      for (const call of toolCalls) {
        let args: Record<string, any> = {};
        try {
          args = JSON.parse(call.function?.arguments || "{}");
        } catch {
          // Malformed arguments from the model — deps.executeTool below
          // fails cleanly on whatever this leaves args as, same as a
          // genuinely empty-args call would (mirrors /api/chat exactly).
        }

        const result = await deps.executeTool(
          call.function?.name || "",
          args,
          username,
          ai,
          localLlmEndpoint,
          // No connected video/display client on the voice path — a tool
          // that needs one (e.g. capture_screen) simply can't be fulfilled
          // over voice, so both flags are false rather than claiming
          // support that doesn't exist here.
          { alreadyAttached: false, supportsRoundTrip: false }
        );

        toolResponseMessages.push({
          role: "tool",
          tool_call_id: call.id,
          content: JSON.stringify(result.ok ? { output: result.output } : { error: result.error }),
        });
      }
      messages.push(...toolResponseMessages);

      response = await router.generateWithFallback(username, { messages, tools }, GROQ_MODELS);
      toolCalls = response?.choices?.[0]?.message?.tool_calls || [];
    }

    const finalText = typeof response?.choices?.[0]?.message?.content === "string"
      ? response.choices[0].message.content.trim()
      : "";

    if (finalText) {
      publishReply(finalText);

      // Write side of the same continuous-learning pipeline /api/chat
      // triggers on every real (non-fallback) exchange (server.ts):
      // semantic memory, style/mistake reflection, the knowledge graph,
      // continuity-of-self, and rapport/tone modeling. All fire-and-forget
      // — matching /api/chat's own .catch(() => {}) on each of these exact
      // calls — so a slow or failing write can never delay or break the
      // reply already published above. Only fires for a genuine answer
      // (finalText truthy), not for the honest decline/error replies
      // below, mirroring /api/chat gating these on a real
      // (non-"Simulated") reply.
      deps.remember(
        username,
        `User said (voice): "${text}" — Jarvis replied: "${finalText.slice(0, 500)}"`,
        ai,
        localLlmEndpoint
      ).catch(() => {});
      deps.reflectAndLearn(router, username, text, finalText).catch(() => {});
      deps.extractAndStore(username, router, text, finalText).catch(() => {});
      deps.extractSelfReflection(username, router, text, finalText).catch(() => {});
      deps.extractRapportSignal(username, router, text).catch(() => {});
    } else {
      observation.logTelemetry("warn", "VoiceSession", `Pipeline produced no final text for "${username}"; publishing an honest empty-result reply instead of fabricating an answer.`);
      publishReply(HONEST_NO_TEXT_REPLY);
    }
  } catch (err: any) {
    observation.logTelemetry("warn", "VoiceSession", `Voice pipeline failed for "${username}": ${err?.message || err}`);
    publishReply(HONEST_PIPELINE_ERROR_REPLY);
  }
}
