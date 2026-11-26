// Loads onnxruntime-web and the two hFT-Transformer graphs, and runs one 128-frame block.
// WebGPU when the browser has it; otherwise WebAssembly on the processor (several threads when
// the page is cross-origin isolated, in a worker so the page stays responsive).
//
// Files live next to the page:
//   ort/ort.webgpu.min.mjs, ort/ort.wasm.min.mjs, ort/ort-wasm-simd-threaded[.asyncify].mjs
//   ort/ort-wasm-simd-threaded[.asyncify].wasm.gz   (gzip; unpacked here and handed to the runtime)
//   models/hft-freq.onnx, models/hft-time.onnx
import { HFT } from './hft.js';

let state = null;

async function fetchBytes(url, gz) {
  const r = await fetch(url);
  if (!r.ok) throw new Error('Could not load ' + url.split('/').pop() + ' (' + r.status + ')');
  if (!gz) return r.arrayBuffer();
  if (typeof DecompressionStream === 'undefined') throw new Error('This browser is too old to unpack the piano model.');
  return new Response(r.body.pipeThrough(new DecompressionStream('gzip'))).arrayBuffer();
}

async function hasWebGPU() {
  try {
    if (!navigator.gpu) return false;
    const adapter = await navigator.gpu.requestAdapter();
    return !!adapter;
  } catch (e) {
    return false;
  }
}

export async function loadHftEngine(base, onStatus, opts = {}) {
  if (state) return state;
  const gpu = opts.forceCpu ? false : await hasWebGPU();
  onStatus && onStatus(gpu ? 'Loading the piano model for the graphics chip…' : 'Loading the piano model…');
  const ortDir = new URL('ort/', base).href;
  const bundle = gpu ? 'ort.webgpu.min.mjs' : 'ort.wasm.min.mjs';
  const ort = await import(ortDir + bundle);
  ort.env.wasm.wasmPaths = ortDir;
  ort.env.wasm.wasmBinary = await fetchBytes(ortDir + (gpu ? 'ort-wasm-simd-threaded.asyncify.wasm.gz' : 'ort-wasm-simd-threaded.wasm.gz'), true);
  const cores = navigator.hardwareConcurrency || 4;
  const threads = self.crossOriginIsolated ? Math.max(1, Math.min(8, cores - 1)) : 1;
  ort.env.wasm.numThreads = threads;
  ort.env.wasm.proxy = !gpu;
  ort.env.logLevel = 'error';
  const [freqBuf, timeBuf] = await Promise.all([
    fetchBytes(new URL('models/hft-freq.onnx', base).href),
    fetchBytes(new URL('models/hft-time.onnx', base).href),
  ]);
  const common = { executionProviders: [gpu ? 'webgpu' : 'wasm'], graphOptimizationLevel: 'all' };
  const freq = await ort.InferenceSession.create(new Uint8Array(freqBuf), gpu ? { ...common, preferredOutputLocation: { h: 'gpu-buffer' } } : common);
  const time = await ort.InferenceSession.create(new Uint8Array(timeBuf), common);
  state = { ort, freq, time, gpu, threads };
  return state;
}

export function engineInfo() {
  if (!state) return null;
  return { gpu: state.gpu, threads: state.threads };
}

// spec: Float32Array [1, 256, T] from blockInput(). Returns 128x88 frame outputs.
export async function runBlock(spec, T) {
  const { ort, freq, time } = state;
  const x = new ort.Tensor('float32', spec, [1, HFT.NMEL, T]);
  const { h } = await freq.run({ spec: x });
  const out = await time.run({ h });
  if (typeof h.dispose === 'function') h.dispose();
  return { onset: out.onset.data, offset: out.offset.data, mpe: out.mpe.data, velocity: out.velocity.data };
}
