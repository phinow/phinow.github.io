// Transcription engine: Spotify Basic Pitch running on TensorFlow.js in the browser.
import * as tf from '@tensorflow/tfjs';
import { BasicPitch, outputToNotesPoly, noteFramesToTime } from '@spotify/basic-pitch';

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
    })();
  }
  return modelPromise;
}

export function backendName() {
  return tf.getBackend();
}

// Sensitivity presets: onset threshold, frame threshold, minimum note length (frames at ~86 fps).
export const SENSITIVITY = {
  low: { onset: 0.6, frame: 0.4, minLen: 14 },
  normal: { onset: 0.5, frame: 0.3, minLen: 11 },
  high: { onset: 0.35, frame: 0.25, minLen: 8 },
};

// audio22k: mono Float32Array at 22050 Hz. Returns notes [{t, d, p, a}].
export async function transcribe(model, audio22k, sensitivity, onProgress) {
  const bp = new BasicPitch(Promise.resolve(model));
  const frames = [], onsets = [];
  await bp.evaluateModel(
    audio22k,
    (f, o) => { for (const r of f) frames.push(r); for (const r of o) onsets.push(r); },
    p => onProgress && onProgress(p),
  );
  const cfg = SENSITIVITY[sensitivity] || SENSITIVITY.normal;
  // Piano range only: A0 (27.5 Hz) to C8 (4186 Hz).
  const events = outputToNotesPoly(frames, onsets, cfg.onset, cfg.frame, cfg.minLen, true, 4200, 27, true, 11);
  const timed = noteFramesToTime(events);
  return timed
    .map(n => ({ t: n.startTimeSeconds, d: n.durationSeconds, p: n.pitchMidi, a: n.amplitude }))
    .filter(n => n.p >= 21 && n.p <= 108)
    .sort((x, y) => x.t - y.t || x.p - y.p);
}
