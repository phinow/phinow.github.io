/* Loopadicious loop stretcher.
   Renders a whole loop at a new tempo, keeping the pitch.
   - Circular: the end of the rendered loop runs straight into its start, so the loop point is seamless.
   - Hits stay intact: every detected hit is played back untouched at its exact new place on the grid,
     so slowing down never doubles a hit and speeding up never chops one.
   - The sound between hits is stretched with WSOLA (overlapping windows, each one lined up with the last).
   Works in a Web Worker, the page, or Node. */

function stretchOnsets(m, sr) {
  // Short-frame energy in two views: the first difference (bright attacks: snares, hats, clicks)
  // and the plain signal (deep hits: kicks, bass). A hit is a sharp rise in either.
  const h = Math.max(32, Math.round(sr * 0.0025)), frames = Math.floor(m.length / h), n = m.length;
  const hi = new Float32Array(frames), lo = new Float32Array(frames);
  let topHi = -200, topLo = -200;
  for (let f = 0; f < frames; f++) {
    let e = 0, p = 0; const s = f * h;
    for (let i = 0; i < 2 * h; i++) { const j = (s + i) % n, v = m[j], d = v - m[(j + n - 1) % n]; e += d * d; p += v * v; }
    hi[f] = 10 * Math.log10(e / (2 * h) + 1e-12); lo[f] = 10 * Math.log10(p / (2 * h) + 1e-12);
    if (hi[f] > topHi) topHi = hi[f]; if (lo[f] > topLo) topLo = lo[f];
  }
  // Mean power of the loop: a deep hit has to stand above it (a slow swell or two tones beating does not count)
  let mp = 0; for (let f = 0; f < frames; f++) mp += Math.pow(10, lo[f] / 10); const meanLo = 10 * Math.log10(mp / Math.max(1, frames) + 1e-12);
  const riseOf = (le, f) => { let base = 0; for (let b = 2; b <= 6; b++) base += le[(f - b + frames) % frames]; return Math.max(0, le[f] - base / 5); };
  const rise = new Float32Array(frames), strength = new Float32Array(frames);
  for (let f = 0; f < frames; f++) {
    const rh = hi[f] >= topHi - 40 && riseOf(hi, f) >= 6 ? riseOf(hi, f) : 0;
    const rl = lo[f] >= meanLo && riseOf(lo, f) >= 9 ? riseOf(lo, f) : 0;
    rise[f] = Math.max(rh, rl);
    strength[f] = rise[f] + 0.25 * Math.max(hi[f] - topHi + 40, lo[f] - topLo + 40);
  }
  const out = [], span = Math.round(0.03 * sr / h);
  for (let f = 0; f < frames; f++) {
    if (!rise[f]) continue;
    let peak = true;
    for (let d = -span; d <= span && peak; d++) if (d && rise[(f + d + frames) % frames] > rise[f] || (d < 0 && rise[(f + d + frames) % frames] === rise[f])) peak = false;
    if (peak) out.push({ at: attackStart(m, (f - 2) * h, (f + 2) * h, sr), strength: strength[f] });
  }
  return out;
}

// The exact sample where a hit starts: first sample that clearly rises out of what came before it
function attackStart(m, from, to, sr) {
  const n = m.length, at = (i) => m[((i % n) + n) % n];
  let pk = 0; for (let i = from; i < to + Math.round(sr * 0.01); i++) pk = Math.max(pk, Math.abs(at(i)));
  let floor = 0; for (let i = from - Math.round(sr * 0.004); i < from; i++) floor = Math.max(floor, Math.abs(at(i)));
  const th = Math.max(floor * 1.5, pk * 0.1);
  for (let i = from; i < to; i++) if (Math.abs(at(i)) > th) {
    // step back to where the rise begins
    let j = i; while (j > from && Math.abs(at(j - 1)) < Math.abs(at(j)) && Math.abs(at(j - 1)) > floor) j--;
    return ((j % n) + n) % n;
  }
  return ((from + 2 * Math.round(sr * 0.0025)) % n + n) % n;
}

function stretchLoop(L, R, sr, ratio, opt = {}) {
  const len = L.length;
  if (ratio === 1) return { L: Float32Array.from(L), R: Float32Array.from(R), anchors: 0 };
  const N = Math.max(1, Math.round(len / ratio));
  const W = 2 * Math.round(sr * (opt.win || 0.042) / 2), H = W / 2;        // ~42 ms windows, half overlap
  const D = Math.round(sr * (opt.seek || 0.012));                        // alignment search: plus or minus 12 ms
  const P = Math.round(sr * 0.012), pre = Math.round(sr * 0.002);   // untouched zone: 2 ms before a hit to 12 ms after
  const E = W + D + 64;                                    // padding so reads can run past either end
  const ext = (x) => { const y = new Float32Array(len + 2 * E); for (let i = -E; i < len + E; i++) y[i + E] = x[((i % len) + len) % len]; return y; };
  const m = new Float32Array(len);
  for (let i = 0; i < len; i++) m[i] = 0.5 * (L[i] + R[i]);
  const XL = ext(L), XR = ext(R), XM = ext(m);

  // Anchors: the strongest hits that leave room to stretch between them
  const cand = len > 4 * W ? stretchOnsets(m, sr).sort((a, b) => b.strength - a.strength) : [];
  // Two hits can both be anchored when no window has to hold both untouched zones
  const gapOut = W + P + pre + 4, gapIn = W + P + pre + 4;
  const anchors = [];
  const cdist = (a, b, n) => { const d = Math.abs(a - b) % n; return Math.min(d, n - d); };
  for (const c of cand) {
    const o = Math.round(c.at / ratio) % N;
    if (anchors.every((a) => cdist(a.o, o, N) >= gapOut && cdist(a.a, c.at, len) >= gapIn)) anchors.push({ a: c.at, o, real: true });
  }
  // A quiet anchor at the loop point keeps the seam exact even when the loop has no hit there
  if (anchors.every((a) => cdist(a.o, 0, N) >= gapOut && cdist(a.a, 0, len) >= gapIn)) anchors.push({ a: 0, o: 0, real: false });
  anchors.sort((x, y) => x.o - y.o);

  // Time map from output frame to input frame: slope 1 around every anchor, straight lines between
  const knots = [];
  for (const an of anchors) { knots.push([an.o - W - pre, an.a - W - pre]); knots.push([an.o + P, an.a + P]); }
  const K0 = knots.length;
  for (let i = 0; i < K0; i++) knots.push([knots[i][0] + N, knots[i][1] + len]);
  for (let i = 0; i < K0; i++) knots.push([knots[i][0] - N, knots[i][1] - len]);
  knots.sort((x, y) => x[0] - y[0]);
  const tau = (p) => {
    let lo = 0, hi = knots.length - 1;
    while (hi - lo > 1) { const mid = (lo + hi) >> 1; if (knots[mid][0] <= p) lo = mid; else hi = mid; }
    const [x0, y0] = knots[lo], [x1, y1] = knots[hi];
    return x1 === x0 ? y0 : y0 + (p - x0) * (y1 - y0) / (x1 - x0);
  };
  // A frame is protected when its window touches an anchor's untouched zone
  const near = (o) => { for (const an of anchors) { const d = ((o - an.o) % N + N) % N; const dd = d > N / 2 ? d - N : d; if (dd > -W - pre && dd <= P) return { an, dd }; } return null; };

  // Frames
  const K = Math.max(2, Math.round(N / H));
  const win = new Float32Array(W);
  for (let i = 0; i < W; i++) win[i] = 0.5 - 0.5 * Math.cos(2 * Math.PI * i / W);
  const oL = new Float32Array(N), oR = new Float32Array(N), ws = new Float32Array(N);
  const wrap = (s) => ((s % len) + len) % len;
  const realAnchors = anchors.filter((a) => a.real);
  const frameStarts = [];
  for (let k = 0; k < K; k++) frameStarts.push(Math.round(k * N / K));
  let prevS = 0, prevP = 0;
  for (let k = 0; k < K; k++) {
    const p = frameStarts[k];
    const hit = near(p);
    let s;
    if (hit) {
      s = wrap(hit.an.a + hit.dd);                          // played exactly as recorded, on the exact grid spot
    } else {
      const base = Math.round(tau(p));
      // Never read a hit outside its protected frames: no doubled or chopped hits
      let lo = base - D, hi = base + D;
      for (const an of realAnchors) {
        for (const a of [an.a - len, an.a, an.a + len]) {
          if (a - pre - W < hi && a + P + 1 > lo) {           // window [s, s+W) would touch the hit's untouched zone
            if (base >= a) lo = Math.max(lo, a + P + 1); else hi = Math.min(hi, a - pre - W);
          }
        }
      }
      if (hi < lo) { const c = Math.min(Math.max(base, lo), hi); lo = hi = c; }
      if (k === 0) s = Math.min(Math.max(base, lo), hi);
      else {
        // WSOLA: pick the candidate that best matches the natural continuation of the previous frame
        const c = prevS + (p - prevP), Lc = W - (p - prevP) > 0 ? W - (p - prevP) : H;
        const ci = wrap(c) + E;
        let best = -Infinity, bs = Math.min(Math.max(base, lo), hi);
        const off = wrap(base) - base;                       // shift so reads stay inside the padded buffer
        const sc = (cand, step) => { const si = cand + off + E; let xy = 0, yy = 1e-9; for (let i = 0; i < Lc; i += step) { const v = XM[si + i]; xy += v * XM[ci + i]; yy += v * v; } return xy / Math.sqrt(yy); };
        for (let cand = lo; cand <= hi; cand += 4) { const v = sc(cand, 4); if (v > best) { best = v; bs = cand; } }
        const f0 = Math.max(lo, bs - 4), f1 = Math.min(hi, bs + 4);
        best = -Infinity;
        for (let cand = f0; cand <= f1; cand++) { const v = sc(cand, 1); if (v > best) { best = v; bs = cand; } }
        s = wrap(bs);
      }
    }
    // Overlap-add the frame, wrapping round the end of the output
    const si = s + E;
    for (let i = 0; i < W; i++) {
      const o = (p + i) % N, w = win[i];
      oL[o] += w * XL[si + i]; oR[o] += w * XR[si + i]; ws[o] += w;
    }
    prevS = s; prevP = p;
  }
  for (let i = 0; i < N; i++) { const g = ws[i] > 1e-6 ? 1 / ws[i] : 0; oL[i] *= g; oR[i] *= g; }
  return { L: oL, R: oR, anchors: realAnchors.length };
}

if (typeof module !== "undefined") module.exports = { stretchLoop, stretchOnsets };
