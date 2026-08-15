// test-client.ts
import { startAudioClient } from "../src/core/audio-client.js";

console.log("Starting audio client test...");
startAudioClient("/tmp/jarvis-voice/voice.sock");

// Keep event loop alive
setInterval(() => {}, 1000);
