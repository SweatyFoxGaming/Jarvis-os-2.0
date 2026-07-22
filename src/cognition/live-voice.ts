import { GoogleGenAI, Modality } from "@google/genai";
import Groq from "groq-sdk";
import type WebSocket from "ws";
import { ObservationPlatform } from "../kernel/observation.js";
import { buildIdentityContext } from "./identity.js";
import * as identity from "./identity.js";
import { LongTermLearningEngine } from "./long_term_learning.js";
import * as sessionRepo from "../kernel/state/session-repo.js";
import * as memoryStore from "./memory-store.js";
import { reflectAndLearn } from "./reflection.js";
import * as knowledgeGraph from "./knowledge-graph.js";
import { getAllToolDeclarations, executeTool } from "../execution/tools.js";

const observation = ObservationPlatform.getInstance();

// The SDK's own doc comment on Live.connect() suggests
// "gemini-live-2.5-flash-preview", but that model isn't actually available
// for this API version/key (live-verified: 404 "not found ... or is not
// supported for bidiGenerateContent"). Queried the real models list
// (GET /v1beta/models) for whichever model actually supports
// bidiGenerateContent and used that instead of trusting the doc comment.
const LIVE_MODEL = "gemini-2.5-flash-native-audio-latest";

const VOICE_SYSTEM_INSTRUCTION_BASE =
  "You are JARVIS, styled after Tony Stark's AI in the Iron Man films: composed, " +
  "dryly witty, and quietly confident rather than warm or effusive. Address the " +
  "user as \"sir\" where it reads naturally, not in every sentence. This is a live " +
  "spoken conversation — keep replies brief and precise, as real speech is, with " +
  "the occasional understated dry remark rather than gushing enthusiasm or " +
  "exclamation points. Report your own state or system metrics plainly and " +
  "matter-of-factly, composed even when the news is bad. " +
  "If the user's camera is on, you're also receiving a live video feed of them — " +
  "reference what you genuinely see naturally when it's relevant, but don't narrate " +
  "the video feed itself or mention it unprompted when it isn't.";

// Builds the same identity/style personalization chat gets (see
// baseSystemInstruction in src/server.ts), so voice isn't a second, generic
// persona wearing the same name. Semantic memory recall() still can't run
// here at connection time — recall() searches against one specific
// message's text, and there's no discrete message yet on a continuous
// audio stream — but it's not skipped entirely: see flushTurn() below,
// which recalls against each completed utterance and prefills the result
// into the session for the *next* turn onward, the only point a query
// actually exists to search against.
async function buildVoiceSystemInstruction(): Promise<string> {
  const identityContext = await buildIdentityContext();
  const stylePrefs = LongTermLearningEngine.getInstance().getStylePreferences();
  const styleContext = `\n\nWhen writing or discussing code, prefer ${stylePrefs.namingConvention} naming, ${stylePrefs.tabSize}-space indentation, and a ${stylePrefs.architecturePattern} architecture, unless the user asks otherwise.`;
  return VOICE_SYSTEM_INSTRUCTION_BASE + styleContext + identityContext;
}

/**
 * Bridges one browser WebSocket connection to one Gemini Live API session —
 * the voice-native counterpart to the request/response voice loop
 * (/api/voice-input + TTS), which requires a full record -> transcribe ->
 * generate -> synthesize round trip per utterance. This instead holds a
 * single continuous bidirectional stream: raw PCM audio in, raw PCM audio
 * out, as it's generated.
 *
 * Client -> server: raw 16-bit PCM binary WebSocket frames (16kHz mono, the
 * rate Gemini's Live API expects), a JSON text frame {"type":"end"} when the
 * user stops talking, a JSON text frame {"type":"video","data":"<base64
 * jpeg>"} — a live camera frame sent periodically (~1/sec) for the whole
 * duration of the session, not a one-off snapshot — or {"type":"ambient",
 * "hint":"..."}, a silent synthetic prompt for client-detected presence
 * changes (see the ambient-awareness client logic). Gemini's Live API
 * accepts video the same way as audio (sendRealtimeInput({video: ...})),
 * giving Jarvis genuine continuous visual context as a standing part of the
 * same real-time conversation, for as long as the session and camera stay on.
 * Server -> client: raw 24kHz PCM binary frames (the rate Gemini's Live API
 * returns) for playback; JSON text frames {"type":"turnComplete"} /
 * {"type":"interrupted"} / {"type":"error", message} for control signals; or
 * {"type":"transcript","role":"user"|"assistant","text":"..."} once a turn's
 * transcription completes — the same transcript is persisted to
 * conversation_history and run through memory/reflection/knowledge-graph/
 * identity, so a spoken exchange leaves the same trace a typed one does.
 * Tool calls (GitHub, email, TTS, planning, etc.) are dispatched
 * server-side via the same executeTool() /api/chat uses — the client never
 * sees a raw toolCall message, only its eventual effect on the conversation.
 */
export async function bridgeVoiceSession(ai: GoogleGenAI, groq: Groq | null, clientSocket: WebSocket, username: string): Promise<void> {
  let liveSession: Awaited<ReturnType<typeof ai.live.connect>> | null = null;

  // Accumulates each turn's transcription (arrives as incremental chunks,
  // independent of modelTurn's own audio parts per the SDK's own doc
  // comment) so it can be persisted and forwarded to the client as one
  // complete line once turnComplete fires, instead of a stream of fragments.
  let inputTranscriptBuffer = "";
  let outputTranscriptBuffer = "";

  // Flushes the current turn's transcript into the same write-side pipeline
  // /api/chat uses (session history, semantic memory, style/mistake
  // learning, knowledge graph, continuity-of-self) — without this, a spoken
  // conversation would leave zero trace anywhere text chat's memory/learning
  // draws from, making voice and text two disconnected personas again.
  const flushTurn = async () => {
    const userText = inputTranscriptBuffer.trim();
    const replyText = outputTranscriptBuffer.trim();
    inputTranscriptBuffer = "";
    outputTranscriptBuffer = "";
    if (!userText && !replyText) return;

    if (clientSocket.readyState === clientSocket.OPEN) {
      if (userText) clientSocket.send(JSON.stringify({ type: "transcript", role: "user", text: userText }));
      if (replyText) clientSocket.send(JSON.stringify({ type: "transcript", role: "assistant", text: replyText }));
    }

    if (userText) sessionRepo.appendMessage(username, "user", userText).catch(() => {});
    if (replyText) {
      sessionRepo.appendMessage(username, "assistant", replyText).catch(() => {});
      if (userText) {
        memoryStore
          .remember(username, `User said (voice): "${userText}" — Jarvis replied: "${replyText.slice(0, 500)}"`, ai, null)
          .catch(() => {});
        reflectAndLearn(groq, userText, replyText).catch(() => {});
        knowledgeGraph.extractAndStore(groq, userText, replyText).catch(() => {});
        identity.extractSelfReflection(groq, userText, replyText).catch(() => {});
      }
    }

    // Read side of the same memory chat already draws on every turn — see
    // the comment above buildVoiceSystemInstruction() for why this can't
    // run before Gemini answers THIS utterance (no query exists until the
    // utterance is transcribed), only from here onward. Prefilled with
    // turnComplete: false so it's silently added to context rather than
    // spoken as a reply — it becomes available the moment the user's next
    // utterance actually needs it, the same way a typed follow-up question
    // already benefits from memory recall() run on the message before it.
    if (userText && liveSession) {
      try {
        const hits = await memoryStore.recall(username, userText, ai, null);
        if (hits.length > 0) {
          const memoryContext = `Relevant things you remember about this user from past conversations:\n${hits.map(m => `- ${m}`).join("\n")}`;
          liveSession.sendClientContent({ turns: memoryContext, turnComplete: false });
        }
      } catch {
        // Best-effort — memory recall failing should never break the live session.
      }
    }
  };

  // ai.live.connect() is a real network round trip (opens a WebSocket to
  // Google, does the setup handshake) — a client that starts streaming
  // audio the instant its own WebSocket opens can easily win that race.
  // Attaching the listener now and queueing anything that arrives before
  // liveSession exists (rather than attaching it after the await below)
  // is what actually fixes that — live-verified this was a real bug: audio
  // sent immediately on open was silently dropped, no error, no response.
  const pendingMessages: { data: Buffer; isBinary: boolean }[] = [];
  const handleClientMessage = (data: Buffer, isBinary: boolean) => {
    if (!liveSession) {
      pendingMessages.push({ data, isBinary });
      return;
    }
    if (isBinary) {
      liveSession.sendRealtimeInput({
        audio: { data: data.toString("base64"), mimeType: "audio/pcm;rate=16000" },
      });
    } else {
      try {
        const msg = JSON.parse(data.toString());
        if (msg.type === "end") {
          liveSession.sendRealtimeInput({ audioStreamEnd: true });
        } else if (msg.type === "video" && typeof msg.data === "string") {
          liveSession.sendRealtimeInput({
            video: { data: msg.data, mimeType: "image/jpeg" },
          });
        } else if (msg.type === "ambient" && typeof msg.hint === "string") {
          // A silent synthetic turn — client-side motion detection noticed a
          // presence change (someone entered/left frame) and asks Jarvis to
          // react the way a present assistant naturally would, without the
          // user having said anything. Real conversational turn, not a
          // separate notification channel, so it can reference what's on
          // screen via the same continuous video stream.
          liveSession.sendClientContent({ turns: msg.hint, turnComplete: true });
        }
      } catch {
        // Ignore malformed control messages rather than tearing down the session.
      }
    }
  };
  clientSocket.on("message", handleClientMessage);

  const systemInstruction = await buildVoiceSystemInstruction();

  try {
    liveSession = await ai.live.connect({
      model: LIVE_MODEL,
      config: {
        responseModalities: [Modality.AUDIO],
        systemInstruction,
        // "Charon" — documented by Google as an "Informative" voice; one of
        // the original prebuilt set, chosen for a composed, authoritative
        // tone matching the JARVIS persona over the SDK's unspecified default.
        speechConfig: { voiceConfig: { prebuiltVoiceConfig: { voiceName: "Charon" } } },
        // Gives spoken turns real text, the same way /api/chat's request
        // body already is text — without this, a voice conversation leaves
        // no transcript for the dashboard or for the memory/learning write
        // path below to work from.
        inputAudioTranscription: {},
        outputAudioTranscription: {},
        // Same capability set text chat gets (src/server.ts) — spoken
        // requests can invoke GitHub/email/TTS/planning/etc. exactly like a
        // typed one, dispatched through the identical executeTool().
        tools: [{ functionDeclarations: getAllToolDeclarations() }],
      },
      callbacks: {
        onopen: () => {
          observation.logTelemetry("info", "LiveVoice", `Live session opened for "${username}".`);
        },
        onmessage: async (message) => {
          if (message.serverContent?.inputTranscription?.text) {
            inputTranscriptBuffer += message.serverContent.inputTranscription.text;
          }
          if (message.serverContent?.outputTranscription?.text) {
            outputTranscriptBuffer += message.serverContent.outputTranscription.text;
          }

          if (message.toolCall?.functionCalls?.length) {
            for (const call of message.toolCall.functionCalls) {
              const result = await executeTool(call.name || "", call.args || {}, username, ai, null);
              liveSession?.sendToolResponse({
                functionResponses: [{
                  id: call.id,
                  name: call.name,
                  response: result.ok ? { output: result.output ?? null } : { error: result.error },
                }],
              });
            }
          }

          if (clientSocket.readyState !== clientSocket.OPEN) return;
          const parts = message.serverContent?.modelTurn?.parts || [];
          for (const part of parts) {
            if (part.inlineData?.data && part.inlineData.mimeType?.startsWith("audio/")) {
              clientSocket.send(Buffer.from(part.inlineData.data, "base64"));
            }
          }
          if (message.serverContent?.turnComplete) {
            flushTurn();
            clientSocket.send(JSON.stringify({ type: "turnComplete" }));
          }
          if (message.serverContent?.interrupted) {
            clientSocket.send(JSON.stringify({ type: "interrupted" }));
          }
        },
        onerror: (e: any) => {
          observation.logTelemetry("warn", "LiveVoice", `Live session error for "${username}": ${e?.message || e}`);
          if (clientSocket.readyState === clientSocket.OPEN) {
            clientSocket.send(JSON.stringify({ type: "error", message: "Live voice session error." }));
          }
        },
        onclose: () => {
          observation.logTelemetry("info", "LiveVoice", `Live session closed for "${username}".`);
          if (clientSocket.readyState === clientSocket.OPEN) clientSocket.close();
        },
      },
    });
  } catch (err: any) {
    observation.logTelemetry("error", "LiveVoice", `Failed to open live session for "${username}": ${err.message}`);
    clientSocket.send(JSON.stringify({ type: "error", message: `Could not start voice session: ${err.message}` }));
    clientSocket.off("message", handleClientMessage);
    clientSocket.close();
    return;
  }

  // Flush anything that arrived while we were awaiting the connection above.
  while (pendingMessages.length > 0) {
    const { data, isBinary } = pendingMessages.shift()!;
    handleClientMessage(data, isBinary);
  }

  clientSocket.on("close", () => {
    liveSession?.close();
  });

  clientSocket.on("error", () => {
    liveSession?.close();
  });
}
