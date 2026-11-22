// Music theory helpers: key detection, chord detection, spelling, transposition.

export const SHARP_NAMES = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];
export const FLAT_NAMES = ['C', 'Db', 'D', 'Eb', 'E', 'F', 'Gb', 'G', 'Ab', 'A', 'Bb', 'B'];
// Pragmatic spelling for C and A minor: the black keys most often seen in gospel and pop charts.
const NEUTRAL_NAMES = ['C', 'C#', 'D', 'Eb', 'E', 'F', 'F#', 'G', 'Ab', 'A', 'Bb', 'B'];

// Key choices offered to the player. Each has a tonic pitch class and a spelling.
export const KEY_CHOICES = [
  { id: 'C', pc: 0 }, { id: 'C#', pc: 1 }, { id: 'Db', pc: 1 }, { id: 'D', pc: 2 },
  { id: 'Eb', pc: 3 }, { id: 'E', pc: 4 }, { id: 'F', pc: 5 }, { id: 'F#', pc: 6 },
  { id: 'Gb', pc: 6 }, { id: 'G', pc: 7 }, { id: 'Ab', pc: 8 }, { id: 'A', pc: 9 },
  { id: 'Bb', pc: 10 }, { id: 'B', pc: 11 },
];

const FLAT_MAJOR = new Set(['F', 'Bb', 'Eb', 'Ab', 'Db', 'Gb']);
const SHARP_MAJOR = new Set(['G', 'D', 'A', 'E', 'B', 'F#', 'C#']);

const FLAT_MINOR = new Set(['D', 'G', 'C', 'F', 'Bb', 'Eb', 'Ab']);
const SHARP_MINOR = new Set(['E', 'B', 'F#', 'C#']);

function spellingFor(keyId, mode) {
  if (mode === 'minor') {
    if (FLAT_MINOR.has(keyId) || keyId === 'Db' || keyId === 'Gb') return FLAT_NAMES;
    if (SHARP_MINOR.has(keyId)) return SHARP_NAMES;
    return NEUTRAL_NAMES;
  }
  if (FLAT_MAJOR.has(keyId)) return FLAT_NAMES;
  if (SHARP_MAJOR.has(keyId)) return SHARP_NAMES;
  return NEUTRAL_NAMES;
}

export function noteNamer(keyId, mode) {
  const names = spellingFor(keyId, mode);
  return pc => names[((pc % 12) + 12) % 12];
}

export function midiName(midi, namer) {
  return namer(midi % 12) + (Math.floor(midi / 12) - 1);
}

// Default display id for a detected tonic pitch class.
export function defaultKeyId(pc, mode) {
  const minor = ['C', 'C#', 'D', 'Eb', 'E', 'F', 'F#', 'G', 'Ab', 'A', 'Bb', 'B'];
  const major = ['C', 'Db', 'D', 'Eb', 'E', 'F', 'F#', 'G', 'Ab', 'A', 'Bb', 'B'];
  return (mode === 'minor' ? minor : major)[pc];
}

export function keyLabel(keyId, mode) {
  return keyId + (mode === 'minor' ? ' minor' : ' major');
}

// Krumhansl-Kessler key profiles.
const KK_MAJOR = [6.35, 2.23, 3.48, 2.33, 4.38, 4.09, 2.52, 5.19, 2.39, 3.66, 2.29, 2.88];
const KK_MINOR = [6.33, 2.68, 3.52, 5.38, 2.6, 3.53, 2.54, 4.75, 3.98, 2.69, 3.34, 3.17];

function pearson(a, b) {
  const n = a.length;
  const ma = a.reduce((s, v) => s + v, 0) / n;
  const mb = b.reduce((s, v) => s + v, 0) / n;
  let num = 0, da = 0, db = 0;
  for (let i = 0; i < n; i++) {
    num += (a[i] - ma) * (b[i] - mb);
    da += (a[i] - ma) ** 2;
    db += (b[i] - mb) ** 2;
  }
  return da && db ? num / Math.sqrt(da * db) : 0;
}

export function pitchHistogram(notes) {
  const h = new Array(12).fill(0);
  for (const n of notes) h[n.p % 12] += n.d * n.a;
  return h;
}

export function detectKey(notes) {
  const h = pitchHistogram(notes);
  const results = [];
  for (let tonic = 0; tonic < 12; tonic++) {
    const rot = h.slice(tonic).concat(h.slice(0, tonic));
    results.push({ pc: tonic, mode: 'major', r: pearson(rot, KK_MAJOR) });
    results.push({ pc: tonic, mode: 'minor', r: pearson(rot, KK_MINOR) });
  }
  results.sort((x, y) => y.r - x.r);
  const best = results[0];
  const gap = best.r - results[1].r;
  return { pc: best.pc, mode: best.mode, r: best.r, confident: best.r > 0.6 && gap > 0.03, ranked: results };
}

// Chord templates: intervals above the root, display suffix, and a small simplicity prior.
const CHORDS = [
  { s: '', iv: [0, 4, 7], prior: 0.015 },
  { s: 'm', iv: [0, 3, 7], prior: 0.015 },
  { s: '7', iv: [0, 4, 7, 10], prior: 0.008 },
  { s: 'maj7', iv: [0, 4, 7, 11], prior: 0.008 },
  { s: 'm7', iv: [0, 3, 7, 10], prior: 0.008 },
  { s: '6', iv: [0, 4, 7, 9], prior: 0.0 },
  { s: 'm6', iv: [0, 3, 7, 9], prior: 0.0 },
  { s: 'add9', iv: [0, 2, 4, 7], prior: 0.0 },
  { s: 'm(add9)', iv: [0, 2, 3, 7], prior: 0.0 },
  { s: '9', iv: [0, 2, 4, 7, 10], prior: 0.0 },
  { s: 'maj9', iv: [0, 2, 4, 7, 11], prior: 0.0 },
  { s: 'm9', iv: [0, 2, 3, 7, 10], prior: 0.0 },
  { s: 'm11', iv: [0, 2, 3, 5, 7, 10], prior: -0.01 },
  { s: '13', iv: [0, 4, 7, 9, 10], prior: -0.01 },
  { s: 'sus2', iv: [0, 2, 7], prior: 0.0 },
  { s: 'sus4', iv: [0, 5, 7], prior: 0.0 },
  { s: '7sus4', iv: [0, 5, 7, 10], prior: 0.0 },
  { s: '9sus4', iv: [0, 2, 5, 7, 10], prior: 0.0 },
  { s: 'dim', iv: [0, 3, 6], prior: 0.0 },
  { s: 'dim7', iv: [0, 3, 6, 9], prior: 0.0 },
  { s: 'm7b5', iv: [0, 3, 6, 10], prior: 0.0 },
  { s: 'aug', iv: [0, 4, 8], prior: -0.01 },
  { s: '7#9', iv: [0, 3, 4, 7, 10], prior: -0.02 },
];

// Build every chord candidate once: 12 roots x templates, each a unit vector over 12 pitch classes.
const CANDIDATES = [];
for (let root = 0; root < 12; root++) {
  for (const c of CHORDS) {
    const v = new Array(12).fill(0);
    for (const i of c.iv) v[(root + i) % 12] = 1;
    // The root and fifth carry the identity of a chord; weight them a little more.
    v[root] = 1.25;
    const norm = Math.hypot(...v);
    CANDIDATES.push({ root, suffix: c.s, iv: c.iv, v: v.map(x => x / norm), prior: c.prior });
  }
}

function cosine(a, b) {
  let s = 0;
  for (let i = 0; i < 12; i++) s += a[i] * b[i];
  return s;
}

// Detect chords over time. Returns segments [{start, end, root, suffix, bass}] in ORIGINAL pitch.
export function detectChords(notes, duration, opts = {}) {
  const hop = opts.hop ?? 0.2;
  const minSeg = opts.minSeg ?? 0.5;
  const switchPenalty = opts.switchPenalty ?? 0.12;
  const nWin = Math.max(1, Math.ceil(duration / hop));
  const sorted = notes.slice().sort((a, b) => a.t - b.t);

  // Chroma and bass per window.
  const windows = [];
  let startIdx = 0;
  for (let w = 0; w < nWin; w++) {
    const t0 = w * hop, t1 = t0 + hop;
    const chroma = new Array(12).fill(0);
    let lowest = null, energy = 0;
    while (startIdx < sorted.length && sorted[startIdx].t + sorted[startIdx].d < t0 - 8) startIdx++;
    for (let i = startIdx; i < sorted.length; i++) {
      const n = sorted[i];
      if (n.t >= t1) break;
      const ov = Math.min(t1, n.t + n.d) - Math.max(t0, n.t);
      if (ov <= 0) continue;
      // Piano notes fade; weight early part of each note more.
      const age = Math.max(0, t0 - n.t);
      const wgt = ov * n.a * Math.exp(-age * 0.35);
      chroma[n.p % 12] += wgt;
      energy += wgt;
      if (n.p < 60 && wgt > 0.02 && (lowest === null || n.p < lowest)) lowest = n.p;
    }
    if (lowest !== null) chroma[lowest % 12] += energy * 0.25;
    const norm = Math.hypot(...chroma);
    windows.push({ chroma: norm ? chroma.map(x => x / norm) : chroma, energy, bass: lowest === null ? null : lowest % 12 });
  }

  // Emission scores: candidates plus a "no chord" state (index = CANDIDATES.length).
  const K = CANDIDATES.length;
  const peak = Math.max(1e-9, ...windows.map(w => w.energy));
  const scores = windows.map(w => {
    const row = new Float32Array(K + 1);
    const quiet = w.energy < peak * 0.04;
    for (let k = 0; k < K; k++) {
      const c = CANDIDATES[k];
      let s = cosine(w.chroma, c.v) + c.prior;
      if (w.bass !== null && w.bass === c.root) s += 0.05;
      row[k] = quiet ? s - 0.5 : s;
    }
    row[K] = quiet ? 0.9 : 0.2;
    return row;
  });

  // Viterbi with a constant switch penalty: keeps chords from flickering.
  const N = scores.length;
  const back = new Array(N);
  let prev = Float32Array.from(scores[0]);
  for (let t = 1; t < N; t++) {
    let bestPrev = 0;
    for (let k = 1; k <= K; k++) if (prev[k] > prev[bestPrev]) bestPrev = k;
    const cur = new Float32Array(K + 1);
    const bk = new Int32Array(K + 1);
    for (let k = 0; k <= K; k++) {
      const stay = prev[k];
      const sw = prev[bestPrev] - switchPenalty;
      if (stay >= sw) { cur[k] = stay + scores[t][k]; bk[k] = k; }
      else { cur[k] = sw + scores[t][k]; bk[k] = bestPrev; }
    }
    back[t] = bk;
    prev = cur;
  }
  let state = 0;
  for (let k = 1; k <= K; k++) if (prev[k] > prev[state]) state = k;
  const path = new Array(N);
  for (let t = N - 1; t >= 0; t--) {
    path[t] = state;
    if (t > 0) state = back[t][state];
  }

  // Collapse into segments, collect bass votes.
  let segs = [];
  for (let t = 0; t < N; t++) {
    const k = path[t];
    const last = segs[segs.length - 1];
    if (last && last.k === k) { last.end = (t + 1) * hop; last.wins.push(t); }
    else segs.push({ k, start: t * hop, end: (t + 1) * hop, wins: [t] });
  }
  // Absorb very short segments into a neighbour.
  let changed = true;
  while (changed && segs.length > 1) {
    changed = false;
    for (let i = 0; i < segs.length; i++) {
      const s = segs[i];
      if (s.end - s.start >= minSeg) continue;
      const left = segs[i - 1], right = segs[i + 1];
      const target = !left ? right : !right ? left : (left.end - left.start >= right.end - right.start ? left : right);
      target.start = Math.min(target.start, s.start);
      target.end = Math.max(target.end, s.end);
      target.wins = target.wins.concat(s.wins);
      segs.splice(i, 1);
      changed = true;
      break;
    }
    // Merge neighbours that became identical.
    for (let i = segs.length - 1; i > 0; i--) {
      if (segs[i].k === segs[i - 1].k) {
        segs[i - 1].end = segs[i].end;
        segs[i - 1].wins = segs[i - 1].wins.concat(segs[i].wins);
        segs.splice(i, 1);
      }
    }
  }

  return segs.map(s => {
    if (s.k === K) return { start: s.start, end: Math.min(s.end, duration), root: null, suffix: 'N.C.', bass: null };
    const c = CANDIDATES[s.k];
    const votes = new Array(12).fill(0);
    for (const t of s.wins) if (windows[t].bass !== null) votes[windows[t].bass] += windows[t].energy;
    let bass = null, bv = 0;
    for (let i = 0; i < 12; i++) if (votes[i] > bv) { bv = votes[i]; bass = i; }
    // Only show a slash bass when it is not the root and is clearly the lowest voice.
    if (bass === c.root) bass = null;
    return { start: s.start, end: Math.min(s.end, duration), root: c.root, suffix: c.suffix, bass };
  });
}

export function chordName(seg, shift, namer) {
  if (seg.root === null) return 'N.C.';
  const r = (seg.root + shift + 120) % 12;
  // Gospel charts write a 9sus4 as a major triad over the bass a whole step up (Ab/Bb).
  if (seg.suffix === '9sus4' && seg.bass === null) return namer((r + 10) % 12) + '/' + namer(r);
  const bass = seg.bass === null ? '' : '/' + namer((seg.bass + shift + 120) % 12);
  return namer(r) + seg.suffix + bass;
}

// Remove overtone ghosts: quiet, short notes an octave, twelfth or two octaves above a louder note
// that started at the same moment.
export function cleanNotes(notes) {
  const ghostIntervals = new Set([12, 19, 24, 28, 31, 36]);
  const sorted = notes.slice().sort((a, b) => a.t - b.t);
  const keep = [];
  let lo = 0;
  for (let i = 0; i < sorted.length; i++) {
    const n = sorted[i];
    while (sorted[lo].t < n.t - 0.08) lo++;
    let ghost = false;
    for (let j = lo; j < sorted.length && sorted[j].t <= n.t + 0.08; j++) {
      const m = sorted[j];
      if (m === n) continue;
      if (ghostIntervals.has(n.p - m.p) && n.a < m.a * 0.85 && n.d < m.d * 0.5) { ghost = true; break; }
    }
    if (!ghost) keep.push(n);
  }
  return keep;
}

// Semitone shift from one tonic to another, in the requested direction.
export function shiftBetween(fromPc, toPc, direction) {
  const up = ((toPc - fromPc) % 12 + 12) % 12;
  if (direction === 'up') return up;
  if (direction === 'down') return up === 0 ? 0 : up - 12;
  return up > 6 ? up - 12 : up; // nearest; tritone goes up
}
