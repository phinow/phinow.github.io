// Piano transcription with Sony's hFT-Transformer (ISMIR 2023, MIT licence), run as two ONNX
// graphs: "freq" (encoder + frequency decoder, one embedding per frame from a 65-frame log-mel
// window) and "time" (self-attention across 128 frames). Feature settings and note extraction
// follow the official inference code.

export const HFT = {
  SR: 16000,
  NFFT: 2048,
  HOP: 256,
  NMEL: 256,
  BLOCK: 128,   // frames per time-model window
  MARGIN: 32,   // context frames each side for the freq model
  LOG_OFFSET: 1e-8,
};
const FPS = HFT.SR / HFT.HOP; // 62.5 frames per second

/* ---------- Log-mel features (torchaudio MelSpectrogram, htk scale, slaney norm, centred) ---------- */

function hzToMel(f) { return 2595 * Math.log10(1 + f / 700); }
function melToHz(m) { return 700 * (Math.pow(10, m / 2595) - 1); }

let FB = null;      // sparse filterbank: for each mel band, [start bin, weights]
let WIN = null;
let FFT = null;

function setup() {
  if (FB) return;
  const nFreq = HFT.NFFT / 2 + 1;
  const mMin = hzToMel(0), mMax = hzToMel(HFT.SR / 2);
  const fPts = new Float64Array(HFT.NMEL + 2);
  for (let i = 0; i < HFT.NMEL + 2; i++) fPts[i] = melToHz(mMin + ((mMax - mMin) * i) / (HFT.NMEL + 1));
  FB = [];
  for (let m = 0; m < HFT.NMEL; m++) {
    const lo = fPts[m], mid = fPts[m + 1], hi = fPts[m + 2];
    const enorm = 2 / (hi - lo);
    let start = -1;
    const w = [];
    for (let k = 0; k < nFreq; k++) {
      const f = (k * (HFT.SR / 2)) / (nFreq - 1);
      const down = (f - lo) / (mid - lo);
      const up = (hi - f) / (hi - mid);
      const v = Math.max(0, Math.min(down, up)) * enorm;
      if (v > 0) { if (start < 0) start = k; w.push(v); }
      else if (start >= 0) break;
    }
    FB.push({ start: Math.max(0, start), w: Float32Array.from(w) });
  }
  WIN = new Float32Array(HFT.NFFT);
  for (let i = 0; i < HFT.NFFT; i++) WIN[i] = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / HFT.NFFT);
  FFT = makeFFT(HFT.NFFT);
}

// In-place radix-2 complex FFT of size n, used on a real frame.
function makeFFT(n) {
  const levels = Math.log2(n);
  const rev = new Uint32Array(n);
  for (let i = 0; i < n; i++) {
    let r = 0;
    for (let b = 0; b < levels; b++) r |= ((i >> b) & 1) << (levels - 1 - b);
    rev[i] = r;
  }
  const cos = new Float64Array(n / 2), sin = new Float64Array(n / 2);
  for (let i = 0; i < n / 2; i++) { cos[i] = Math.cos((2 * Math.PI * i) / n); sin[i] = -Math.sin((2 * Math.PI * i) / n); }
  const re = new Float64Array(n), im = new Float64Array(n);
  return function power(frame, out) {
    for (let i = 0; i < n; i++) { re[rev[i]] = frame[i]; im[rev[i]] = 0; }
    for (let size = 2; size <= n; size <<= 1) {
      const half = size >> 1, step = n / size;
      for (let i = 0; i < n; i += size) {
        for (let j = 0, k = 0; j < half; j++, k += step) {
          const a = i + j, b = a + half;
          const tr = re[b] * cos[k] - im[b] * sin[k];
          const ti = re[b] * sin[k] + im[b] * cos[k];
          re[b] = re[a] - tr; im[b] = im[a] - ti;
          re[a] += tr; im[a] += ti;
        }
      }
    }
    for (let k = 0; k <= n / 2; k++) out[k] = re[k] * re[k] + im[k] * im[k];
  };
}

// Log-mel frames [f0, f1) of a 16 kHz signal, frame k centred on sample k*HOP (zero padding at
// the edges, as torchaudio does with center=True, pad_mode="constant").
// Returns Float32Array of (f1 - f0) * NMEL, frame-major.
export function logMel(audio16k, f0, f1) {
  setup();
  const n = HFT.NFFT, half = n / 2;
  const out = new Float32Array((f1 - f0) * HFT.NMEL);
  const frame = new Float64Array(n);
  const pow = new Float64Array(n / 2 + 1);
  for (let f = f0; f < f1; f++) {
    const s0 = f * HFT.HOP - half;
    for (let i = 0; i < n; i++) {
      const s = s0 + i;
      frame[i] = s >= 0 && s < audio16k.length ? audio16k[s] * WIN[i] : 0;
    }
    FFT(frame, pow);
    const row = (f - f0) * HFT.NMEL;
    for (let m = 0; m < HFT.NMEL; m++) {
      const { start, w } = FB[m];
      let acc = 0;
      for (let j = 0; j < w.length; j++) acc += w[j] * pow[start + j];
      out[row + m] = Math.log(acc + HFT.LOG_OFFSET);
    }
  }
  return out;
}

export function frameCount(nSamples16k) {
  return 1 + Math.floor(nSamples16k / HFT.HOP);
}

/* ---------- Running the two graphs ---------- */

// Builds the freq-model input for block b (frames b*128 .. b*128+127) as the official code does:
// margins of log(1e-8) before frame 0 and after the padded end, zeros for frames between the
// real end and the next multiple of 128.
export function blockInput(audio16k, nFrames, block) {
  const { BLOCK, MARGIN, NMEL } = HFT;
  const nPad = Math.ceil(nFrames / BLOCK) * BLOCK;
  const first = block * BLOCK - MARGIN;
  const last = block * BLOCK + BLOCK + MARGIN; // exclusive
  const T = last - first;
  const lo = Math.max(0, first), hi = Math.min(nFrames, last);
  const real = hi > lo ? logMel(audio16k, lo, hi) : new Float32Array(0);
  const spec = new Float32Array(NMEL * T); // [1, 256, T], mel-major
  const floor = Math.log(HFT.LOG_OFFSET);
  for (let t = 0; t < T; t++) {
    const f = first + t;
    for (let m = 0; m < NMEL; m++) {
      let v;
      if (f < 0 || f >= nPad) v = floor;
      else if (f >= nFrames) v = 0;
      else v = real[(f - lo) * NMEL + m];
      spec[m * T + t] = v;
    }
  }
  return { spec, T };
}

/* ---------- Note extraction (port of hFT-Transformer's mpe2note) ---------- */

// Frame outputs are stored per frame as 88 values. onset/offset/mpe in 0..1, velocity 0..127.
function peaks(arr, nF, j, thr) {
  const hop = 1 / FPS;
  const out = [];
  for (let i = 0; i < nF; i++) {
    const v = arr[i * 88 + j];
    if (v < thr) continue;
    let left = true;
    for (let ii = i - 1; ii >= 0; ii--) {
      const u = arr[ii * 88 + j];
      if (v > u) { left = true; break; }
      if (v < u) { left = false; break; }
    }
    let right = true;
    for (let ii = i + 1; ii < nF; ii++) {
      const u = arr[ii * 88 + j];
      if (v > u) { right = true; break; }
      if (v < u) { right = false; break; }
    }
    if (!(left && right)) continue;
    let t;
    if (i === 0 || i === nF - 1) t = i * hop;
    else {
      const a = arr[(i - 1) * 88 + j], b = arr[(i + 1) * 88 + j];
      if (a === b) t = i * hop;
      else if (a > b) t = i * hop - (hop * 0.5 * (a - b)) / (v - b);
      else t = i * hop + (hop * 0.5 * (b - a)) / (v - a);
    }
    out.push({ loc: i, t });
  }
  return out;
}

// Returns notes [{t, d, p, a}] with a = velocity / 127.
export function extractNotes(onset, offset, mpe, velocity, nF, thr = { onset: 0.5, offset: 0.5, mpe: 0.5 }) {
  const hop = 1 / FPS;
  const notes = [];
  for (let j = 0; j < 88; j++) {
    const ons = peaks(onset, nF, j, thr.onset);
    if (!ons.length) continue;
    const offs = peaks(offset, nF, j, thr.offset);
    let oi = 0;
    for (let k = 0; k < ons.length; k++) {
      const { loc, t: tOn } = ons[k];
      let locNext, tNext;
      if (k + 1 < ons.length) { locNext = ons[k + 1].loc; tNext = ons[k + 1].t; }
      else { locNext = nF; tNext = (locNext - 1) * hop; }
      let locOff = loc + 1, tOff = 0, fOff = false;
      while (oi < offs.length && offs[oi].loc <= loc) oi++;
      if (oi < offs.length) { locOff = offs[oi].loc; tOff = offs[oi].t; fOff = true; }
      if (locOff > locNext) { locOff = locNext; tOff = tNext; }
      let fMpe = false, tMpe = 0;
      for (let ii = loc + 1; ii < locNext; ii++) {
        if (mpe[ii * 88 + j] < thr.mpe) { fMpe = true; tMpe = ii * hop; break; }
      }
      const v = velocity[loc * 88 + j];
      let end;
      if (!fOff && !fMpe) end = tNext;
      else if (fOff && !fMpe) end = tOff;
      else if (!fOff && fMpe) end = tMpe;
      else end = Math.min(tOff, tMpe);
      if (v > 0) notes.push({ t: tOn, d: Math.max(0.02, end - tOn), p: j + 21, a: v / 127 });
    }
  }
  notes.sort((x, y) => x.t - y.t || x.p - y.p);
  return notes;
}

export const HFT_SENSITIVITY = {
  low: { onset: 0.65, offset: 0.5, mpe: 0.5 },
  normal: { onset: 0.5, offset: 0.5, mpe: 0.5 },
  high: { onset: 0.35, offset: 0.5, mpe: 0.4 },
};
