// Voice-native mode: a continuous WebSocket audio stream to/from Gemini's
// Live API (src/cognition/live-voice.ts on the server side) — mic audio in,
// spoken audio back, as it's generated, instead of the record -> transcribe
// -> reply -> synthesize round trip /api/voice-input uses.

const INPUT_SAMPLE_RATE = 16000; // what Gemini's Live API expects on input
const OUTPUT_SAMPLE_RATE = 24000; // what Gemini's Live API returns on output

let ws = null;
let micStream = null;
let inputAudioContext = null;
let outputAudioContext = null;
let scriptProcessor = null;
let nextPlayTime = 0;
let active = false;

function getApiKey() {
  // Same key the main console (index.html) stores after login/API-key entry.
  return sessionStorage.getItem("admin_api_key") || "";
}

function setStatus(text, cls) {
  const el = document.getElementById("voice-status");
  if (!el) return;
  el.textContent = text;
  el.className = "status " + (cls || "");
}

// Naive linear-interpolation resampler — audio quality isn't the point here,
// getting real speech recognized reliably is. A production build would use
// a proper resampling library or an AudioWorklet-based resampler.
function downsampleTo16k(float32Samples, inputSampleRate) {
  if (inputSampleRate === INPUT_SAMPLE_RATE) {
    return float32Samples;
  }
  const ratio = inputSampleRate / INPUT_SAMPLE_RATE;
  const outLength = Math.floor(float32Samples.length / ratio);
  const result = new Float32Array(outLength);
  for (let i = 0; i < outLength; i++) {
    result[i] = float32Samples[Math.floor(i * ratio)];
  }
  return result;
}

function floatTo16BitPCM(float32Samples) {
  const buffer = new ArrayBuffer(float32Samples.length * 2);
  const view = new DataView(buffer);
  for (let i = 0; i < float32Samples.length; i++) {
    const s = Math.max(-1, Math.min(1, float32Samples[i]));
    view.setInt16(i * 2, s < 0 ? s * 0x8000 : s * 0x7fff, true);
  }
  return buffer;
}

// Schedules each incoming chunk back-to-back on the output AudioContext's
// timeline so playback stays gapless even though chunks arrive at irregular
// network intervals.
function playAudioChunk(arrayBuffer) {
  const int16 = new Int16Array(arrayBuffer);
  const float32 = new Float32Array(int16.length);
  for (let i = 0; i < int16.length; i++) {
    float32[i] = int16[i] / 32768;
  }

  const audioBuffer = outputAudioContext.createBuffer(1, float32.length, OUTPUT_SAMPLE_RATE);
  audioBuffer.copyToChannel(float32, 0);

  const source = outputAudioContext.createBufferSource();
  source.buffer = audioBuffer;
  source.connect(outputAudioContext.destination);

  const now = outputAudioContext.currentTime;
  const startAt = Math.max(now, nextPlayTime);
  source.start(startAt);
  nextPlayTime = startAt + audioBuffer.duration;
}

export async function startVoiceSession() {
  if (active) return;
  const apiKey = getApiKey();
  if (!apiKey) {
    setStatus("No API key found — log in on the main console first.", "error");
    return;
  }

  setStatus("Requesting microphone access…", "connecting");
  try {
    micStream = await navigator.mediaDevices.getUserMedia({ audio: true });
  } catch (err) {
    setStatus("Microphone access denied: " + err.message, "error");
    return;
  }

  inputAudioContext = new (window.AudioContext || window.webkitAudioContext)();
  outputAudioContext = new (window.AudioContext || window.webkitAudioContext)();
  nextPlayTime = 0;

  const protocol = location.protocol === "https:" ? "wss:" : "ws:";
  ws = new WebSocket(`${protocol}//${location.host}/ws/voice?apiKey=${encodeURIComponent(apiKey)}`);
  ws.binaryType = "arraybuffer";

  ws.onopen = () => {
    setStatus("Connected — listening…", "live");
    active = true;

    const source = inputAudioContext.createMediaStreamSource(micStream);
    // ScriptProcessorNode is deprecated in favor of AudioWorklet, but needs
    // no separate module file to load and works everywhere — the right
    // tradeoff for this scope.
    scriptProcessor = inputAudioContext.createScriptProcessor(4096, 1, 1);
    source.connect(scriptProcessor);
    scriptProcessor.connect(inputAudioContext.destination);

    scriptProcessor.onaudioprocess = (event) => {
      if (!active || ws.readyState !== WebSocket.OPEN) return;
      const inputData = event.inputBuffer.getChannelData(0);
      const downsampled = downsampleTo16k(inputData, inputAudioContext.sampleRate);
      const pcm16 = floatTo16BitPCM(downsampled);
      ws.send(pcm16);
    };
  };

  ws.onmessage = (event) => {
    if (event.data instanceof ArrayBuffer) {
      playAudioChunk(event.data);
      return;
    }
    try {
      const msg = JSON.parse(event.data);
      if (msg.type === "turnComplete") {
        setStatus("Connected — listening…", "live");
      } else if (msg.type === "interrupted") {
        // The model was interrupted mid-reply (the user started talking
        // again) — drop anything still queued so playback doesn't lag behind.
        nextPlayTime = 0;
      } else if (msg.type === "error") {
        setStatus("Error: " + msg.message, "error");
      }
    } catch {
      // Ignore anything that isn't valid JSON control data.
    }
  };

  ws.onerror = () => {
    setStatus("Connection error.", "error");
  };

  ws.onclose = () => {
    setStatus("Disconnected.", "");
    stopVoiceSession();
  };
}

export function stopVoiceSession() {
  active = false;
  if (ws && ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify({ type: "end" }));
    ws.close();
  }
  ws = null;
  if (scriptProcessor) {
    scriptProcessor.disconnect();
    scriptProcessor = null;
  }
  if (micStream) {
    micStream.getTracks().forEach(t => t.stop());
    micStream = null;
  }
  if (inputAudioContext) {
    inputAudioContext.close();
    inputAudioContext = null;
  }
  if (outputAudioContext) {
    outputAudioContext.close();
    outputAudioContext = null;
  }
}
