// Ambient wake-word listening: an on-device openWakeWord model ("hey
// jarvis") detects the wake word entirely locally (no network traffic)
// while enabled and idle -- see openwakeword-engine.js for the engine
// itself (a from-scratch port of openWakeWord's real streaming pipeline,
// since no official/well-maintained browser SDK exists; Picovoice
// Porcupine, the original choice, turned out to require a company email
// to even sign up for an AccessKey, which ruled it out for this personal
// project). On detection, opens a one-way WebSocket to /ws/voice-stream
// and streams raw mono 16-bit PCM at 16kHz -- the exact format
// daemon/models.py's STT expects (see src/core/audio-client.ts's
// transcribeOverSocket doc comment) -- until the server sends back a
// "turn_complete" (carrying the complete reply as one base64 WAV blob,
// already assembled server-side from the daemon's own synthesized audio
// -- see voice-stream-ws.ts) or "error" control message. Reply playback
// calls the SAME playAudioBase64 this page already uses elsewhere for a
// server-synthesized reply arriving over a different channel -- this
// module adds no new audio DECODING or raw-PCM playback code of its own.
//
// State machine, one turn at a time:
//   idle (wake-word listening) -> streaming (WS open, sending PCM)
//     -> idle again, either on a server "turn_complete"/"error" control
//        message, or on the WS closing for any other reason.
// A new wake-word detection while already "streaming" is ignored --
// guarded by the `streaming` flag below -- so a false re-trigger mid-turn
// can never open a second concurrent stream for the same tab. The same
// flag also gates the ambient mic-processing loop below, so the wake-word
// engine doesn't spend CPU/inference cycles on audio that's simultaneously
// being streamed to the server for the active turn.

const TARGET_SAMPLE_RATE = 16000;

let streaming = false;
let wakeWordEngine = null;
let ambientAudioContext = null;
let ambientMicStream = null;
let audioContext = null;
let micStream = null;
let ws = null;

async function fetchVoiceStreamTicket() {
  // Bare global, NOT window.CURRENT_API_KEY: index.html declares it with a
  // top-level `let` inside a classic <script>, which binds in that script's
  // own scope and never becomes a window property. This file is likewise a
  // classic script loaded after it, so the bare identifier resolves through
  // the shared global scope both scripts run in.
  const apiKey = CURRENT_API_KEY;
  // authFetch (index.html) wraps fetch and additionally clears the stale key
  // and prompts a re-login on a real 401 -- every other authenticated call in
  // the page goes through it, so this one does too. It does not add the key
  // header itself; that stays our job.
  const res = await authFetch("/api/voice-stream-ticket", {
    method: "POST",
    headers: { "X-API-Key": apiKey },
  });
  if (!res.ok) {
    throw new Error(`Failed to obtain a voice-stream ticket: HTTP ${res.status}`);
  }
  const body = await res.json();
  return body.ticket;
}

// Downsamples a Float32Array captured at the AudioContext's native sample
// rate down to TARGET_SAMPLE_RATE mono 16-bit PCM. Simple nearest-neighbor
// decimation (point sampling: each output sample is the nearest input
// sample, with no interpolation between adjacent samples) -- adequate for speech-to-text input (Whisper itself resamples
// internally for a lot of its own training data), not audiophile-grade,
// which this doesn't need to be. This is the OUTBOUND (mic-capture)
// direction only -- there is no corresponding downstream/decode step in
// this file, since the reply comes back as a complete, already-encoded
// WAV blob (see the "turn_complete" handling in ws.onmessage below), not
// raw PCM this module would need to decode itself.
function downsampleTo16kHzPcm16(float32Input, inputSampleRate) {
  const ratio = inputSampleRate / TARGET_SAMPLE_RATE;
  const outputLength = Math.floor(float32Input.length / ratio);
  const pcm16 = new Int16Array(outputLength);
  for (let i = 0; i < outputLength; i++) {
    const srcIndex = Math.floor(i * ratio);
    const sample = Math.max(-1, Math.min(1, float32Input[srcIndex]));
    pcm16[i] = sample < 0 ? sample * 0x8000 : sample * 0x7fff;
  }
  return pcm16;
}

async function startStreamingTurn() {
  if (streaming) return; // guard: ignore a re-trigger while a turn is already in progress
  streaming = true;

  try {
    const ticket = await fetchVoiceStreamTicket();
    const wsProtocol = window.location.protocol === "https:" ? "wss:" : "ws:";
    ws = new WebSocket(`${wsProtocol}//${window.location.host}/ws/voice-stream?ticket=${encodeURIComponent(ticket)}`);

    micStream = await navigator.mediaDevices.getUserMedia({ audio: true });
    audioContext = new (window.AudioContext || window.webkitAudioContext)();
    const source = audioContext.createMediaStreamSource(micStream);
    const processor = audioContext.createScriptProcessor(4096, 1, 1);

    processor.onaudioprocess = (event) => {
      if (!streaming || !ws || ws.readyState !== WebSocket.OPEN) return;
      const input = event.inputBuffer.getChannelData(0);
      const pcm16 = downsampleTo16kHzPcm16(input, audioContext.sampleRate);
      ws.send(pcm16.buffer);
    };

    source.connect(processor);
    // ScriptProcessorNode only fires onaudioprocess once it's connected to
    // some destination -- but connecting it straight to
    // audioContext.destination would route the live microphone signal
    // audibly out through the user's speakers (feedback/echo, and it could
    // also bleed into what the mic itself picks up next). Route through a
    // zero-gain node instead: keeps the graph "live" without making any of
    // it audible.
    const mutedSink = audioContext.createGain();
    mutedSink.gain.value = 0;
    processor.connect(mutedSink);
    mutedSink.connect(audioContext.destination);

    // The server never sends binary frames back on this connection -- only
    // these two JSON control messages -- so event.data is always a string
    // here; no ws.binaryType setting is needed.
    ws.onmessage = (event) => {
      let msg;
      try {
        msg = JSON.parse(event.data);
      } catch {
        return;
      }
      if (msg.type === "turn_complete") {
        if (msg.audio && typeof playAudioBase64 === "function") {
          playAudioBase64(msg.mimeType || "audio/wav", msg.audio);
        }
        // KNOWN, ACCEPTED DEVIATION from the original design intent, which
        // was to re-arm the wake-word engine only AFTER reply playback ends:
        // playAudioBase64 (index.html) is async but its promise settles on
        // `await currentAudioEl.play()`, i.e. when playback STARTS -- it
        // exposes no completion signal, and its own `onended` handler is
        // private to it. So endStreamingTurn() re-arms Porcupine immediately
        // and Jarvis's own spoken reply could in theory self-trigger a new
        // turn. Fixing it properly means changing playAudioBase64's contract
        // (a shared function several other callers depend on), which is out
        // of scope for this fix wave.
        endStreamingTurn();
      } else if (msg.type === "error") {
        console.warn("Ambient voice error:", msg.message);
        if (typeof addNotification === "function") {
          addNotification(`Ambient listening error: ${msg.message}`, "danger");
        }
        endStreamingTurn();
      }
    };

    ws.onclose = () => {
      endStreamingTurn();
    };
    ws.onerror = () => {
      if (typeof addNotification === "function") {
        addNotification("Ambient listening lost its connection to the server.", "danger");
      }
      endStreamingTurn();
    };
  } catch (err) {
    console.error("Failed to start ambient voice turn:", err);
    if (typeof addNotification === "function") {
      addNotification(`Ambient listening failed to start: ${err.message || err}`, "danger");
    }
    endStreamingTurn();
  }
}

function endStreamingTurn() {
  streaming = false;
  if (micStream) {
    micStream.getTracks().forEach((track) => track.stop());
    micStream = null;
  }
  if (audioContext) {
    audioContext.close();
    audioContext = null;
  }
  if (ws) {
    try { ws.close(); } catch {}
    ws = null;
  }
  // Nothing to explicitly "resume" -- unlike Porcupine's own pause/resume
  // protocol, this engine never pauses itself; the ambient mic-processing
  // loop below already keeps running the whole time listening is enabled,
  // gated only by the `streaming` flag (which is now false again).
}

// Guards enableAmbientListening against a second call landing while the
// first is still mid-flight (awaiting model load or a mic permission
// prompt) -- without this, two overlapping calls could each pass the
// `wakeWordEngine` check below (it's only set at the very end of a
// successful run) and create two engines, two getUserMedia captures, and
// two ScriptProcessorNodes, of which disableAmbientListening would only
// ever clean up the second, leaking the first mic capture (and its
// browser recording indicator) for the rest of the tab's life.
let ambientEnabling = false;

// Public entry points wired to the ambient-listening toggle in index.html.
async function enableAmbientListening() {
  if (wakeWordEngine || ambientEnabling) return; // already enabled, or enabling right now
  ambientEnabling = true;

  // Local until every step below succeeds -- module-level state
  // (wakeWordEngine/ambientMicStream/ambientAudioContext) is only ever
  // committed once the whole sequence completes, so a failure partway
  // through (e.g. the user denies the mic permission prompt AFTER the
  // engine already loaded) can't leave wakeWordEngine truthy with no
  // matching mic capture -- which would otherwise permanently block every
  // future retry via the early-return above, with no way to recover short
  // of reloading the page.
  let engine = null;
  let micStreamLocal = null;
  let audioContextLocal = null;

  try {
    // WakeWordEngine is defined in openwakeword-engine.js, loaded via a
    // <script type="module"> tag in index.html which also assigns it as a
    // window global for this classic script to use -- see that file's own
    // comment on why. Model files are the vendored, official openWakeWord
    // releases (see that file's own license note: CC BY-NC-SA 4.0,
    // personal/noncommercial use only).
    engine = new WakeWordEngine({
      modelBaseUrl: "vendor/openwakeword/models/",
      ortWasmPath: "vendor/onnxruntime-web/",
      detectionThreshold: 0.5,
    });
    await engine.load();
    engine.onDetection = () => {
      startStreamingTurn();
    };

    micStreamLocal = await navigator.mediaDevices.getUserMedia({ audio: true });

    // Build the AudioContext and graph on locals too -- if any of this
    // throws (e.g. createMediaStreamSource on a bad track), module state
    // must stay exactly as it was before this call, or a stuck
    // wakeWordEngine would permanently block every future retry via the
    // early-return above with no way to recover short of reloading the
    // page.
    audioContextLocal = new (window.AudioContext || window.webkitAudioContext)();
    const source = audioContextLocal.createMediaStreamSource(micStreamLocal);
    const processor = audioContextLocal.createScriptProcessor(4096, 1, 1);

    processor.onaudioprocess = (event) => {
      if (!wakeWordEngine || streaming) return; // streaming: skip -- see the state-machine comment at the top of this file
      const input = event.inputBuffer.getChannelData(0);
      const pcm16 = downsampleTo16kHzPcm16(input, audioContextLocal.sampleRate);
      wakeWordEngine.processSamples(pcm16).catch((err) => {
        console.error("Wake-word engine processing error:", err);
      });
    };

    source.connect(processor);
    // Same reasoning as startStreamingTurn's identical pattern below: keeps
    // the audio graph "live" (ScriptProcessorNode requires a destination
    // connection to fire its callback) without routing the live microphone
    // audibly out through the speakers.
    const mutedSink = audioContextLocal.createGain();
    mutedSink.gain.value = 0;
    processor.connect(mutedSink);
    mutedSink.connect(audioContextLocal.destination);

    // Everything succeeded -- commit state.
    wakeWordEngine = engine;
    ambientMicStream = micStreamLocal;
    ambientAudioContext = audioContextLocal;
  } catch (err) {
    // Release anything THIS call already acquired before state was
    // committed -- module-level variables were never set on this path, so
    // there's nothing for disableAmbientListening to find; clean up the
    // locals directly instead.
    if (engine) await engine.release().catch(() => {});
    if (micStreamLocal) micStreamLocal.getTracks().forEach((track) => track.stop());
    if (audioContextLocal) await audioContextLocal.close().catch(() => {});
    throw err; // propagates to toggleAmbientListening's own try/catch, which surfaces the notification
  } finally {
    ambientEnabling = false;
  }
}

async function disableAmbientListening() {
  if (!wakeWordEngine) return;
  const engine = wakeWordEngine;
  wakeWordEngine = null; // processor.onaudioprocess checks this and stops feeding samples
  await engine.release().catch((err) => {
    console.error("Failed to release wake-word engine sessions:", err);
  });
  if (ambientMicStream) {
    ambientMicStream.getTracks().forEach((track) => track.stop());
    ambientMicStream = null;
  }
  if (ambientAudioContext) {
    ambientAudioContext.close();
    ambientAudioContext = null;
  }
  if (streaming) endStreamingTurn();
}
