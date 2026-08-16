// Hand-ported, client-side implementation of openWakeWord's real-time
// streaming inference pipeline (https://github.com/dscripka/openWakeWord,
// Apache 2.0 code license). No official or well-established browser/WASM
// port of this project exists, so this is a from-scratch reimplementation
// in JavaScript, run via onnxruntime-web -- NOT a translation of any
// existing browser wrapper's code. The streaming buffering/windowing logic
// below was ported directly from the real upstream Python source
// (openwakeword/utils.py's AudioFeatures class and openwakeword/model.py's
// streaming predict path, both read from source, not guessed) to match its
// exact numeric behavior: same chunk alignment, same look-back padding,
// same window/stride values. Getting any of these numbers wrong would
// silently produce a detector that never fires or fires on noise, with no
// error to catch it -- so this intentionally mirrors the reference
// implementation line-for-line rather than attempting to simplify it.
//
// Model files (melspectrogram.onnx, embedding_model.onnx,
// hey_jarvis_v0.1.onnx) are openWakeWord's own official releases
// (https://github.com/dscripka/openWakeWord/releases/tag/v0.5.1). Their
// CODE license is Apache 2.0; the pretrained MODEL FILES themselves are
// licensed CC BY-NC-SA 4.0 (noncommercial) -- fine for this personal
// assistant's own use, but the models specifically may not be used
// commercially.
//
// Pipeline shape (all constants below are load-bearing, copied from the
// real upstream source):
//   raw 16kHz int16 PCM
//     -> accumulated in exact 1280-sample (80ms) chunks
//     -> melspectrogram.onnx, called over the last (accumulated+480)
//        samples of raw history each time (480 = 160*3 samples of
//        look-back padding, matching upstream's `-160*3` slice) -- new
//        mel frames appended to a rolling buffer (32 mel bins/frame)
//     -> for each newly-completed 1280-sample chunk, the last 76
//        consecutive mel frames are windowed out and run through
//        embedding_model.onnx, producing one 96-dim embedding vector,
//        appended to a rolling feature buffer
//     -> the last 16 feature vectors ([1, 16, 96]) are run through the
//        wake-word classifier model (hey_jarvis_v0.1.onnx), producing a
//        single 0-1 score

const SAMPLE_RATE = 16000;
const CHUNK_SAMPLES = 1280; // 80ms @ 16kHz -- the unit the pipeline advances by
const MELSPEC_LOOKBACK_SAMPLES = 160 * 3; // 480: extra raw-sample context re-included on every melspectrogram call
const MEL_BINS = 32;
const MELSPEC_MAX_LEN = 10 * 97; // ~10s of mel frames (97 frames/sec @ this model's hop size)
const EMBEDDING_WINDOW_SIZE = 76; // mel frames consumed per embedding-model call
const EMBEDDING_DIM = 96;
const FEATURE_BUFFER_MAX_LEN = 120; // ~10s of embedding-feature history
const CLASSIFIER_WINDOW_SIZE = 16; // embedding vectors consumed per classifier call
const RAW_BUFFER_MAX_SAMPLES = SAMPLE_RATE * 10; // 10s of raw audio history

/**
 * Applies openWakeWord's fixed melspectrogram post-transform
 * (`spec/10 + 2` in the reference implementation) -- brings the ONNX
 * melspectrogram model's raw output into the range the embedding model
 * was actually trained on. Pure function, unit-testable without any
 * ONNX/audio dependency.
 */
function applyMelspecTransform(flatValues) {
  const out = new Float32Array(flatValues.length);
  for (let i = 0; i < flatValues.length; i++) {
    out[i] = flatValues[i] / 10 + 2;
  }
  return out;
}

/**
 * A minimal 2D row-buffer over a flat Float32Array, growable by
 * concatenation (mirrors numpy's `np.vstack`) and trimmable to a max row
 * count from the front (mirrors `buffer[-max_len:, :]`). Pure data
 * structure, no ONNX/audio dependency -- unit-testable directly.
 */
class RowBuffer {
  constructor(rowWidth) {
    this.rowWidth = rowWidth;
    this.rows = []; // array of Float32Array(rowWidth), oldest first
  }

  get length() {
    return this.rows.length;
  }

  /** Appends new rows (a flat Float32Array of length N*rowWidth, or an array of Float32Array rows). */
  push(rowsToAdd) {
    if (rowsToAdd instanceof Float32Array) {
      const n = rowsToAdd.length / this.rowWidth;
      for (let i = 0; i < n; i++) {
        this.rows.push(rowsToAdd.subarray(i * this.rowWidth, (i + 1) * this.rowWidth));
      }
    } else {
      for (const row of rowsToAdd) this.rows.push(row);
    }
  }

  /** Keeps only the last maxLen rows, dropping the oldest (matches numpy's tail-slice trim). */
  trimToMaxLen(maxLen) {
    if (this.rows.length > maxLen) {
      this.rows = this.rows.slice(this.rows.length - maxLen);
    }
  }

  /** Returns the last `count` rows, oldest-first, as a flat Float32Array ready for a model call -- or null if fewer than `count` rows exist. */
  lastRowsFlat(count) {
    if (this.rows.length < count) return null;
    const slice = this.rows.slice(this.rows.length - count);
    const flat = new Float32Array(count * this.rowWidth);
    for (let i = 0; i < count; i++) flat.set(slice[i], i * this.rowWidth);
    return flat;
  }

  /** Returns a window of `count` rows ending at index `endExclusive` (Python's `buffer[endExclusive-count:endExclusive]`), or null if short. Negative endExclusive counts from the end, matching Python slice semantics. */
  windowEndingAt(endExclusive, count) {
    const end = endExclusive < 0 ? this.rows.length + endExclusive : endExclusive;
    const start = end - count;
    if (start < 0 || end > this.rows.length || end - start !== count) return null;
    const slice = this.rows.slice(start, end);
    const flat = new Float32Array(count * this.rowWidth);
    for (let i = 0; i < count; i++) flat.set(slice[i], i * this.rowWidth);
    return flat;
  }
}

/**
 * The streaming feature-extraction state machine, ported from
 * openwakeword/utils.py's AudioFeatures._streaming_features/
 * _streaming_melspectrogram/_get_melspectrogram. Takes injectable
 * `melspecPredict`/`embeddingPredict` functions so this class's buffering/
 * windowing/offset arithmetic can be unit-tested with synthetic fake
 * predictors, independent of any real ONNX model or microphone --
 * something the reference Python implementation (and every existing
 * browser port) has no equivalent test seam for.
 *
 * melspecPredict(Float32Array of raw samples) => Promise<Float32Array> flat (frames*32), row-major
 * embeddingPredict(Float32Array flat, windowCount) => Promise<Float32Array> flat (windowCount*96), row-major
 */
/**
 * DELIBERATE DEVIATION from the upstream Python reference: that
 * implementation pre-seeds melspectrogramBuffer with 76 rows of `1`s and
 * featureBuffer with real embeddings computed from 4 seconds of random
 * noise, at construction time -- so the classifier can run immediately,
 * at the cost of scoring against noise-derived embeddings (mixed with
 * real ones) for roughly the first 16 chunks (~1.3s) after streaming
 * starts. This class does NOT pre-seed: getFeatures() returns null (no
 * classifier call at all) until enough REAL audio has produced a full
 * window, meaning ambient detection only becomes active roughly ~2s after
 * start() is called (mel-frame warm-up + classifier-window warm-up), but
 * can never score against synthetic/noise-derived data. A ~2s "arming"
 * delay after enabling ambient listening is unsurprising UX; a spurious
 * false-positive trigger from noise-seeded embeddings would not be.
 */
export class StreamingFeatureExtractor {
  constructor({ melspecPredict, embeddingPredict }) {
    this.melspecPredict = melspecPredict;
    this.embeddingPredict = embeddingPredict;
    this.rawDataBuffer = []; // plain array acting as the reference impl's bounded deque
    this.melspectrogramBuffer = new RowBuffer(MEL_BINS);
    this.featureBuffer = new RowBuffer(EMBEDDING_DIM);
    this.accumulatedSamples = 0;
    this.rawDataRemainder = new Int16Array(0);
  }

  _bufferRawData(samples) {
    for (let i = 0; i < samples.length; i++) this.rawDataBuffer.push(samples[i]);
    if (this.rawDataBuffer.length > RAW_BUFFER_MAX_SAMPLES) {
      this.rawDataBuffer.splice(0, this.rawDataBuffer.length - RAW_BUFFER_MAX_SAMPLES);
    }
  }

  async _getMelspectrogram(int16Samples) {
    const asFloat = new Float32Array(int16Samples.length);
    for (let i = 0; i < int16Samples.length; i++) asFloat[i] = int16Samples[i];
    const rawSpec = await this.melspecPredict(asFloat);
    return applyMelspecTransform(rawSpec);
  }

  async _streamingMelspectrogram(nSamples) {
    if (this.rawDataBuffer.length < 400) {
      throw new Error("StreamingFeatureExtractor: at least 400 samples (25ms @ 16kHz) are required before the first melspectrogram call");
    }
    const lookback = nSamples + MELSPEC_LOOKBACK_SAMPLES;
    const start = Math.max(0, this.rawDataBuffer.length - lookback);
    const window = Int16Array.from(this.rawDataBuffer.slice(start));
    const newFrames = await this._getMelspectrogram(window);
    this.melspectrogramBuffer.push(newFrames);
    this.melspectrogramBuffer.trimToMaxLen(MELSPEC_MAX_LEN);
  }

  /**
   * Feeds one arbitrarily-sized chunk of raw int16 PCM into the pipeline.
   * Returns true if this call completed at least one full embedding
   * update (i.e. the classifier's getFeatures() output may have changed).
   */
  async processSamples(int16Samples) {
    let x = int16Samples;
    if (this.rawDataRemainder.length !== 0) {
      const combined = new Int16Array(this.rawDataRemainder.length + x.length);
      combined.set(this.rawDataRemainder, 0);
      combined.set(x, this.rawDataRemainder.length);
      x = combined;
      this.rawDataRemainder = new Int16Array(0);
    }

    let processedSamples = 0;

    if (this.accumulatedSamples + x.length >= CHUNK_SAMPLES) {
      const remainder = (this.accumulatedSamples + x.length) % CHUNK_SAMPLES;
      if (remainder !== 0) {
        const evenChunks = x.subarray(0, x.length - remainder);
        this._bufferRawData(evenChunks);
        this.accumulatedSamples += evenChunks.length;
        this.rawDataRemainder = x.subarray(x.length - remainder);
      } else {
        this._bufferRawData(x);
        this.accumulatedSamples += x.length;
        this.rawDataRemainder = new Int16Array(0);
      }
    } else {
      this.accumulatedSamples += x.length;
      this._bufferRawData(x);
    }

    if (this.accumulatedSamples >= CHUNK_SAMPLES && this.accumulatedSamples % CHUNK_SAMPLES === 0) {
      await this._streamingMelspectrogram(this.accumulatedSamples);

      const chunksThisCall = this.accumulatedSamples / CHUNK_SAMPLES;
      for (let i = chunksThisCall - 1; i >= 0; i--) {
        const ndx = i === 0 ? this.melspectrogramBuffer.length : -8 * i;
        const window = this.melspectrogramBuffer.windowEndingAt(ndx, EMBEDDING_WINDOW_SIZE);
        if (window) {
          const embedding = await this.embeddingPredict(window);
          this.featureBuffer.push([embedding]);
        }
      }

      processedSamples = this.accumulatedSamples;
      this.accumulatedSamples = 0;
    }

    this.featureBuffer.trimToMaxLen(FEATURE_BUFFER_MAX_LEN);

    return processedSamples !== 0;
  }

  /** The last `n` embedding rows, ready for a classifier call -- or null if not enough history yet. */
  getFeatures(n = CLASSIFIER_WINDOW_SIZE) {
    return this.featureBuffer.lastRowsFlat(n);
  }
}

/**
 * Public wake-word engine: owns the three ONNX sessions, wraps
 * StreamingFeatureExtractor with real onnxruntime-web-backed predict
 * functions, and scores the wake-word classifier on every feature update.
 * Mirrors the shape of a typical wake-word SDK's lifecycle (load/start/
 * stop + a detection callback) so callers don't need to know any of the
 * above pipeline detail.
 */
export class WakeWordEngine {
  constructor({ modelBaseUrl, ortWasmPath, detectionThreshold = 0.5 }) {
    this.modelBaseUrl = modelBaseUrl;
    this.ortWasmPath = ortWasmPath;
    this.detectionThreshold = detectionThreshold;
    this.melspecSession = null;
    this.embeddingSession = null;
    this.classifierSession = null;
    this.extractor = null;
    this.onDetection = null;
  }

  async load() {
    if (typeof window === "undefined") {
      throw new Error("WakeWordEngine: no `window` global -- this class is browser-only and cannot run in this environment");
    }
    const ort = window.ort;
    if (!ort) {
      throw new Error("WakeWordEngine: onnxruntime-web (window.ort) is not loaded -- check the <script> tag pointing at vendor/onnxruntime-web/ort.wasm.min.js");
    }
    // Explicitly single-threaded: avoids requiring Cross-Origin-Opener-
    // Policy/Cross-Origin-Embedder-Policy headers (needed for
    // SharedArrayBuffer-based multi-threaded WASM), which would be a much
    // larger, riskier server change than this feature warrants.
    ort.env.wasm.numThreads = 1;
    ort.env.wasm.simd = true;
    if (this.ortWasmPath) {
      ort.env.wasm.wasmPaths = this.ortWasmPath;
    }

    const modelUrl = (name) => `${this.modelBaseUrl}${name}`;
    [this.melspecSession, this.embeddingSession, this.classifierSession] = await Promise.all([
      ort.InferenceSession.create(modelUrl("melspectrogram.onnx")),
      ort.InferenceSession.create(modelUrl("embedding_model.onnx")),
      ort.InferenceSession.create(modelUrl("hey_jarvis_v0.1.onnx")),
    ]);

    const ortModule = ort;
    this.extractor = new StreamingFeatureExtractor({
      melspecPredict: async (float32Samples) => {
        const tensor = new ortModule.Tensor("float32", float32Samples, [1, float32Samples.length]);
        const output = await this.melspecSession.run({ input: tensor });
        const outTensor = output[Object.keys(output)[0]];
        return outTensor.data; // flat (frames*32), row-major -- matches np.squeeze(outputs[0])
      },
      embeddingPredict: async (melspecWindowFlat) => {
        const tensor = new ortModule.Tensor("float32", melspecWindowFlat, [1, EMBEDDING_WINDOW_SIZE, MEL_BINS, 1]);
        const output = await this.embeddingSession.run({ input_1: tensor });
        const outTensor = output[Object.keys(output)[0]];
        return outTensor.data; // flat 96-dim vector
      },
    });
  }

  /**
   * Feeds one chunk of raw 16kHz mono int16 PCM into the pipeline. If the
   * chunk completes a full pipeline update, runs the wake-word classifier
   * on the latest feature window and fires onDetection when the score
   * crosses detectionThreshold.
   */
  async processSamples(int16Samples) {
    if (!this.extractor) return;
    const updated = await this.extractor.processSamples(int16Samples);
    if (!updated) return;

    const features = this.extractor.getFeatures(CLASSIFIER_WINDOW_SIZE);
    if (!features) return; // not enough history yet (first ~1.3s of audio)

    const ort = window.ort;
    const tensor = new ort.Tensor("float32", features, [1, CLASSIFIER_WINDOW_SIZE, EMBEDDING_DIM]);
    const inputName = this.classifierSession.inputNames[0];
    const output = await this.classifierSession.run({ [inputName]: tensor });
    const outTensor = output[Object.keys(output)[0]];
    const score = outTensor.data[0];

    if (score >= this.detectionThreshold && typeof this.onDetection === "function") {
      this.onDetection(score);
    }
  }
}

// This file is a real ES module (see the `export` keywords above) so the
// Node test suite can `import` it directly and unit-test the pure/
// injectable pieces. It's ALSO loaded via a classic <script type="module">
// in index.html, but wake-word.js -- the file that actually USES these
// classes -- is deliberately a classic (non-module) script, matching this
// codebase's existing unbundled static-JS convention and letting it keep
// calling other classic-script globals (authFetch, playAudioBase64,
// addNotification) directly. A classic script can't `import` an ES module,
// so this bridges the two: exposing the same classes as `window` globals
// as well, with no behavior difference from the named exports above.
if (typeof window !== "undefined") {
  window.StreamingFeatureExtractor = StreamingFeatureExtractor;
  window.WakeWordEngine = WakeWordEngine;
}
