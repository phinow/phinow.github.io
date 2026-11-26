// Transcription engine: Spotify Basic Pitch on TensorFlow.js.
//
// Basic Pitch's own evaluateModel() keeps every tensor it makes and uploads the whole recording to
// the graphics chip at once, which runs out of memory on long files. This file runs the same model
// with the same windowing, a few windows at a time, and frees each tensor as soon as it is read.
import * as tf from '@tensorflow/tfjs';
import { outputToNotesPoly, noteFramesToTime } from '@spotify/basic-pitch';

// Same constants as Basic Pitch.
const SR = 22050;
const FFT_HOP = 256;
const N_SAMPLES = SR * 2 - FFT_HOP;          // 43844 samples per model window
const N_OVERLAP_FRAMES = 30;
const OVERLAP_SAMPLES = N_OVERLAP_FRAMES * FFT_HOP;
const HOP = N_SAMPLES - OVERLAP_SAMPLES;    // 36164
const HALF_OVERLAP = N_OVERLAP_FRAMES / 2;
const FPS = Math.floor(SR / FFT_HOP);        // 86
const OUT_FRAMES = 'Identity_1';
const OUT_ONSETS = 'Identity_2';
export const MODEL_RATE = SR;

let modelPromise = null;

function base64ToArrayBuffer(b64) {
  if (typeof atob === 'function') {
    const bin = atob(b64);
    const out = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
    return out.buffer;
  }
  const buf = Buffer.from(b64, 'base64');
  return buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);
}

export function loadModel(modelJSON, weightsB64) {
  if (!modelPromise) {
    modelPromise = (async () => {
      // Free graphics memory once the texture cache passes 256 MB instead of keeping it all.
      tf.env().set('WEBGL_DELETE_TEXTURE_THRESHOLD', 256 * 1024 * 1024);
      try { await tf.setBackend('webgl'); } catch (e) { /* falls back below */ }
      if (tf.getBackend() !== 'webgl') await tf.setBackend('cpu');
      await tf.ready();
      const handler = tf.io.fromMemory({
        modelTopology: modelJSON.modelTopology,
        weightSpecs: modelJSON.weightsManifest[0].weights,
        weightData: base64ToArrayBuffer(weightsB64),
        format: modelJSON.format,
        generatedBy: modelJSON.generatedBy,
        convertedBy: modelJSON.convertedBy,
        signature: modelJSON.signature,
        userDefinedMetadata: modelJSON.userDefinedMetadata,
      });
      return tf.loadGraphModel(handler);
    })().catch(e => { modelPromise = null; throw e; });
  }
  return modelPromise;
}

export function backendName() {
  return tf.getBackend();
}

export function tensorCount() {
  return tf.memory().numTensors;
}

// Sensitivity presets: onset threshold, frame threshold, minimum note length (frames at ~86 fps).
export const SENSITIVITY = {
  low: { onset: 0.6, frame: 0.4, minLen: 14 },
  normal: { onset: 0.5, frame: 0.3, minLen: 11 },
  high: { onset: 0.35, frame: 0.25, minLen: 8 },
};

// Run the model over mono audio at 22050 Hz. Returns { frames, onsets } as arrays of rows.
async function evaluate(model, audio, batch, onWindow, shouldStop) {
  const padded = new Float32Array(OVERLAP_SAMPLES / 2 + audio.length);
  padded.set(audio, OVERLAP_SAMPLES / 2);
  const nWindows = Math.ceil(padded.length / HOP);
  const nOut = Math.floor(audio.length * (FPS / SR));
  const frames = [], onsets = [];
  const perWindow = 172 - 2 * HALF_OVERLAP;
  for (let w0 = 0; w0 < nWindows && frames.length < nOut; w0 += batch) {
    if (shouldStop && shouldStop()) return null;
    const b = Math.min(batch, nWindows - w0);
    const input = new Float32Array(b * N_SAMPLES);
    for (let k = 0; k < b; k++) {
      const start = (w0 + k) * HOP;
      input.set(padded.subarray(start, Math.min(padded.length, start + N_SAMPLES)), k * N_SAMPLES);
    }
    const [f, o] = tf.tidy(() => {
      const x = tf.tensor3d(input, [b, N_SAMPLES, 1]);
      const out = model.execute(x, [OUT_FRAMES, OUT_ONSETS]);
      return out.map(t => t.slice([0, HALF_OVERLAP, 0], [-1, t.shape[1] - 2 * HALF_OVERLAP, -1]));
    });
    const [fd, od] = await Promise.all([f.data(), o.data()]);
    const rows = f.shape[1];
    const bins = f.shape[2];
    f.dispose();
    o.dispose();
    for (let k = 0; k < b; k++) {
      for (let r = 0; r < rows && frames.length < nOut; r++) {
        const at = (k * rows + r) * bins;
        frames.push(Array.from(fd.subarray(at, at + bins)));
        onsets.push(Array.from(od.subarray(at, at + bins)));
      }
    }
    onWindow && onWindow(Math.min(1, (w0 + b) / nWindows));
    if (rows !== perWindow) { /* model shape differs from the expected 172 frames; rows used as given */ }
  }
  return { frames, onsets };
}

// For testing and tuning: the raw model output.
export async function evaluateRaw(model, audio22k, batch = 2) {
  return evaluate(model, audio22k, batch);
}

// audio22k: mono Float32Array at 22050 Hz (keep it to a minute or less per call).
// Returns notes [{t, d, p, a}] with times relative to the start of audio22k.
// Returns null if shouldStop() turned true part way.
export async function transcribe(model, audio22k, sensitivity, onProgress, shouldStop, batch = 2) {
  const out = await evaluate(model, audio22k, batch, onProgress, shouldStop);
  if (!out) return null;
  const { frames, onsets } = out;
  if (!frames.length) return [];
  const cfg = SENSITIVITY[sensitivity] || SENSITIVITY.normal;
  // Piano range only: A0 (27.5 Hz) to C8 (4186 Hz).
  // Melodia trick off: on piano tests it added more wrong notes than it found (F1 0.80 -> 0.82).
  const events = outputToNotesPoly(frames, onsets, cfg.onset, cfg.frame, cfg.minLen, true, 4200, 27, false, 11);
  return noteFramesToTime(events)
    .map(n => ({ t: n.startTimeSeconds, d: n.durationSeconds, p: n.pitchMidi, a: n.amplitude }))
    .filter(n => n.p >= 21 && n.p <= 108)
    .sort((x, y) => x.t - y.t || x.p - y.p);
}
