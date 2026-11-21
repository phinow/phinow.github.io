/* ===== Audio engine: pads (synthesized) and loops (time-stretched) ===== */

const KEYS = ["C", "Db", "D", "Eb", "E", "F", "F#", "G", "Ab", "A", "Bb", "B"];
const VOICINGS = {
  open: { label: "Open (1 + 5)", semis: [0, 7, 12] },
  major: { label: "Major", semis: [0, 4, 7, 12] },
  minor: { label: "Minor", semis: [0, 3, 7, 12] }
};
const STYLES = { warm: "Warm", shimmer: "Shimmer", strings: "Strings", air: "Air" };
// Loudness trim per style so switching sounds does not jump in level (set by offline RMS test)
const STYLE_GAIN = { warm: 1.1, shimmer: 0.85, strings: 1, air: 0.88 };

const hz = (m) => 440 * Math.pow(2, (m - 69) / 12);
const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));

function holdParam(param, t) {
  let v = param.value;
  if (param.cancelAndHoldAtTime) { param.cancelAndHoldAtTime(t); }
  else { param.cancelScheduledValues(t); param.setValueAtTime(v, t); }
  return v;
}

// Equal-power fade between two levels, built from short linear segments (works in every browser)
function fadeParam(param, from, to, t0, dur) {
  const N = 24;
  param.setValueAtTime(from, t0);
  for (let i = 1; i <= N; i++) {
    const x = i / N;
    const v = to > from
      ? from + (to - from) * Math.sin(x * Math.PI / 2)
      : to + (from - to) * Math.cos(x * Math.PI / 2);
    param.linearRampToValueAtTime(v, t0 + dur * x);
  }
}

function makeIR(ctx, seconds) {
  const sr = ctx.sampleRate, len = Math.floor(sr * seconds);
  const buf = ctx.createBuffer(2, len, sr);
  const pre = Math.floor(sr * 0.02);
  for (let ch = 0; ch < 2; ch++) {
    const d = buf.getChannelData(ch);
    let y = 0;
    for (let i = 0; i < len; i++) {
      if (i < pre) { d[i] = 0; continue; }
      const t = (i - pre) / (len - pre);
      const env = Math.pow(1 - t, 2.0) * Math.exp(-t * 2.2);
      const k = 0.8 - 0.68 * t;                 // tail gets darker as it decays
      y += k * ((Math.random() * 2 - 1) - y);
      const fadeIn = Math.min(1, (i - pre) / (sr * 0.04));
      d[i] = y * env * fadeIn / Math.sqrt(k);
    }
  }
  return buf;
}

function makeNoise(ctx, seconds) {
  const len = Math.floor(ctx.sampleRate * seconds);
  const buf = ctx.createBuffer(1, len, ctx.sampleRate);
  const d = buf.getChannelData(0);
  for (let i = 0; i < len; i++) d[i] = Math.random() * 2 - 1;
  return buf;
}

class PadEngine {
  constructor(ctx, dest) {
    this.ctx = ctx;
    this.input = ctx.createGain();
    const chOut = ctx.createGain();
    this.input.connect(chOut);
    // Stereo chorus: two slowly moving delays panned apart
    [[-1, 0.011, 0.21], [1, 0.017, 0.29]].forEach(([side, base, rate]) => {
      const d = ctx.createDelay(0.05); d.delayTime.value = base;
      const lfo = ctx.createOscillator(); lfo.frequency.value = rate;
      const depth = ctx.createGain(); depth.gain.value = 0.0022;
      lfo.connect(depth); depth.connect(d.delayTime); lfo.start();
      const g = ctx.createGain(); g.gain.value = 0.42;
      this.input.connect(d); d.connect(g);
      if (ctx.createStereoPanner) {
        const p = ctx.createStereoPanner(); p.pan.value = side * 0.85;
        g.connect(p); p.connect(chOut);
      } else { g.connect(chOut); }
    });
    this.dry = ctx.createGain();
    this.send = ctx.createGain();
    this.extraWet = ctx.createGain();
    this.reverb = ctx.createConvolver();
    this.reverb.buffer = makeIR(ctx, 5.5);
    this.out = ctx.createGain();
    chOut.connect(this.dry); chOut.connect(this.send);
    this.send.connect(this.reverb); this.extraWet.connect(this.reverb);
    this.dry.connect(this.out); this.reverb.connect(this.out);
    this.out.connect(dest);
    this.noiseBuf = makeNoise(ctx, 2);
    this.waves = {};
    this.current = null;
    this.space = 0.55;
    this.vol = 0.8;
    this.tailTimer = 0;
    this.setSpace(0.55);
    this.setVolume(0.8);
  }

  setSpace(s) {
    this.space = s;
    const t = this.ctx.currentTime;
    this.send.gain.setTargetAtTime(s * 1.3, t, 0.08);
    this.extraWet.gain.setTargetAtTime(0.3 + s * 0.9, t, 0.08);
    this.dry.gain.setTargetAtTime(1 - s * 0.4, t, 0.08);
  }
  setVolume(v) { this.vol = v; this.out.gain.setTargetAtTime(v * v, this.ctx.currentTime, 0.05); }
  setTone(t) { if (this.current) this.current.voice.toneSet(t); }

  wave(name, fn, count) {
    if (this.waves[name]) return this.waves[name];
    const real = new Float32Array(count + 1), imag = new Float32Array(count + 1);
    for (let n = 1; n <= count; n++) imag[n] = fn(n);
    return (this.waves[name] = this.ctx.createPeriodicWave(real, imag));
  }

  makeVoice(key, style, voicing, tone) {
    const ctx = this.ctx;
    const v = { oscs: [], env: ctx.createGain(), wet: ctx.createGain(), wetLevel: 0, toneSet: () => {} };
    v.env.gain.value = 0; v.wet.gain.value = 0;
    v.env.connect(this.input); v.wet.connect(this.extraWet);
    const O = (type, f, cents) => {
      const o = ctx.createOscillator();
      if (typeof type === "string") o.type = type; else o.setPeriodicWave(type);
      o.frequency.value = f; o.detune.value = cents || 0;
      v.oscs.push(o); return o;
    };
    const G = (g) => { const n = ctx.createGain(); n.gain.value = g; return n; };
    const F = (type, f, q) => { const n = ctx.createBiquadFilter(); n.type = type; n.frequency.value = f; n.Q.value = q; return n; };
    const P = (x) => {
      if (!ctx.createStereoPanner) return G(1);
      const n = ctx.createStereoPanner(); n.pan.value = x; return n;
    };
    const rnd = (a) => (Math.random() * 2 - 1) * a;
    const root = 48 + key;               // C3 .. B3
    const notes = VOICINGS[voicing].semis.map((s) => root + s);
    const pre = G(1);
    pre.connect(v.env);
    const k = Math.sqrt(notes.length);

    if (style === "warm") {
      const cut = (t) => 380 * Math.pow(12, t);
      const sum = G(1), hp = F("highpass", 70, 0.5), lp1 = F("lowpass", cut(tone), 0.35), lp2 = F("lowpass", cut(tone) * 1.4, 0.5);
      sum.connect(hp); hp.connect(lp1); lp1.connect(lp2); lp2.connect(pre);
      const lfo = O("sine", 0.045); const lg = G(cut(tone) * 0.22);
      lfo.connect(lg); lg.connect(lp1.frequency);
      notes.forEach((m) => [-11, 0, 11].forEach((ct, j) => {
        const o = O("sawtooth", hz(m), ct + rnd(3)), g = G(0.2), p = P((j - 1) * 0.65);
        o.connect(g); g.connect(p); p.connect(sum);
      }));
      const tri = O("triangle", hz(root + 12), 4), tg = G(0.06); tri.connect(tg); tg.connect(sum);
      const sub = O("sine", hz(root - 12)), sg = G(0.22); sub.connect(sg); sg.connect(pre);
      pre.gain.value = 0.5 / k;
      v.toneSet = (t) => {
        const now = ctx.currentTime, c = cut(t);
        lp1.frequency.setTargetAtTime(c, now, 0.15); lp2.frequency.setTargetAtTime(c * 1.4, now, 0.15);
        lg.gain.setTargetAtTime(c * 0.22, now, 0.15);
      };
    } else if (style === "shimmer") {
      const cut = (t) => 700 * Math.pow(8, t);
      const sum = G(1), lp = F("lowpass", cut(tone), 0.4);
      sum.connect(lp); lp.connect(pre);
      notes.forEach((m) => [-6, 6].forEach((ct, j) => {
        const o = O("triangle", hz(m), ct + rnd(2)), g = G(0.3), p = P(j ? 0.5 : -0.5);
        o.connect(g); g.connect(p); p.connect(sum);
      }));
      const shim = G(1);
      shim.connect(pre); shim.connect(v.wet);
      [[24, 0.11], [31, 0.17], [36, 0.13]].forEach(([semi, rate], i) => {
        const o = O("sine", hz(root + semi), rnd(4)), g = G(0.5);
        const lfo = O("sine", rate), dg = G(0.5);
        lfo.connect(dg); dg.connect(g.gain);
        const lvl = G([0.09, 0.06, 0.04][i]), p = P([-0.6, 0.6, 0][i]);
        o.connect(g); g.connect(lvl); lvl.connect(p); p.connect(shim);
      });
      v.wetLevel = 1;
      pre.gain.value = 0.55 / k;
      v.toneSet = (t) => lp.frequency.setTargetAtTime(cut(t), ctx.currentTime, 0.15);
    } else if (style === "strings") {
      const cut = (t) => 600 * Math.pow(10, t);
      const wave = this.wave("strings", (n) => Math.exp(-n / 16) / n, 48);
      const sum = G(1), hp = F("highpass", 140, 0.5), lp = F("lowpass", cut(tone), 0.4);
      sum.connect(hp); hp.connect(lp); lp.connect(pre);
      const vib = O("sine", 4.7), vg = G(5); vib.connect(vg);
      const ens = O("sine", 0.23), eg = G(7); ens.connect(eg);
      notes.forEach((m) => [-14, -5, 5, 14].forEach((ct, j) => {
        const o = O(wave, hz(m), ct + rnd(2)), g = G(0.17), p = P(j % 2 ? 0.5 : -0.5);
        vg.connect(o.detune); if (j % 2) eg.connect(o.detune);
        o.connect(g); g.connect(p); p.connect(sum);
      }));
      const low = O(wave, hz(root - 12), 3), lgn = G(0.3); low.connect(lgn); lgn.connect(sum);
      pre.gain.value = 0.42 / k;
      v.toneSet = (t) => lp.frequency.setTargetAtTime(cut(t), ctx.currentTime, 0.15);
    } else { // air: soft "ooh" choir texture
      const cut = (t) => 1200 * Math.pow(6, t);
      const src = G(1), fsum = G(1), lp = F("lowpass", cut(tone), 0.5);
      [[350, 6, 1], [900, 7, 0.42], [2600, 9, 0.12]].forEach(([f, q, g]) => {
        const bp = F("bandpass", f, q), bg = G(g); src.connect(bp); bp.connect(bg); bg.connect(fsum);
      });
      fsum.connect(lp); lp.connect(pre);
      const vib = O("sine", 5.1), vg = G(4); vib.connect(vg);
      notes.forEach((m) => [-7, 7].forEach((ct, j) => {
        const o = O("sawtooth", hz(m), ct + rnd(2)), g = G(0.3), p = P(j ? 0.45 : -0.45);
        vg.connect(o.detune); o.connect(g); g.connect(p); p.connect(src);
        if (!j) { const s = O("sine", hz(m)), sg = G(0.06); s.connect(sg); sg.connect(pre); }
      }));
      const nz = ctx.createBufferSource(); nz.buffer = this.noiseBuf; nz.loop = true; v.oscs.push(nz);
      const nbp = F("bandpass", 5000, 0.7), ng = G(0.012); nz.connect(nbp); nbp.connect(ng); ng.connect(pre);
      v.wetLevel = 0.3;
      pre.gain.value = 1.2 / k;
      v.toneSet = (t) => lp.frequency.setTargetAtTime(cut(t), ctx.currentTime, 0.15);
    }
    pre.gain.value *= STYLE_GAIN[style];
    return v;
  }

  startVoice(v, fade) {
    const t = this.ctx.currentTime + 0.02;
    v.oscs.forEach((o) => o.start(t));
    fadeParam(v.env.gain, 0, 1, t, fade);
    if (v.wetLevel) fadeParam(v.wet.gain, 0, v.wetLevel, t, fade);
  }

  stopVoice(v, fade) {
    const t = this.ctx.currentTime;
    const e = holdParam(v.env.gain, t), w = holdParam(v.wet.gain, t);
    fadeParam(v.env.gain, e, 0, t, fade);
    if (v.wetLevel) fadeParam(v.wet.gain, w, 0, t, fade);
    const end = t + fade + 0.1;
    v.oscs.forEach((o) => { try { o.stop(end); } catch (err) { /* already stopped */ } });
    setTimeout(() => { try { v.env.disconnect(); v.wet.disconnect(); } catch (err) { /* gone */ } }, (fade + 0.5) * 1000);
  }

  play(key, style, voicing, tone, fade) {
    const v = this.makeVoice(key, style, voicing, tone);
    this.startVoice(v, fade);
    if (this.current) this.stopVoice(this.current.voice, fade);
    this.current = { key, style, voicing, voice: v };
  }

  // Pad off: silent within about a tenth of a second, reverb tail included
  stopNow() {
    if (this.current) { this.stopVoice(this.current.voice, 0.06); this.current = null; }
    const ctx = this.ctx, t = ctx.currentTime, g = this.out.gain;
    holdParam(g, t);
    g.linearRampToValueAtTime(0, t + 0.06);
    clearTimeout(this.tailTimer);
    this.tailTimer = setTimeout(() => {
      // A fresh reverb has no tail left in it
      const old = this.reverb, fresh = ctx.createConvolver();
      fresh.buffer = old.buffer;
      try { this.send.disconnect(old); this.extraWet.disconnect(old); old.disconnect(); } catch (err) { /* already gone */ }
      this.send.connect(fresh); this.extraWet.connect(fresh); fresh.connect(this.out);
      this.reverb = fresh;
      const now = ctx.currentTime;
      g.cancelScheduledValues(now);
      g.setValueAtTime(0, now);
      g.setTargetAtTime(this.vol * this.vol, now, 0.02);
    }, 90);
  }
}

/* ----- Loops: gapless looping through SoundTouch, so tempo changes keep the pitch ----- */
const LOOP_BUF = 4096;

function loopMeta(loop) {
  const bpb = loop.bpb || 4;   // beats per bar: 3 for 3/4, 4 for 4/4
  loop.beats = Math.max(1, Math.round(loop.dur * loop.bpm / 60));
  loop.bars = loop.beats >= bpb ? Math.max(1, Math.round(loop.beats / bpb)) : 1;
  loop.barLen = loop.len / loop.bars;
  return loop;
}

class LoopEngine {
  constructor(ctx, dest, ST) {
    this.ctx = ctx;
    this.out = ctx.createGain();
    this.out.connect(dest);
    this.st = new ST.SoundTouch();
    this.st.stretch.setParameters(ctx.sampleRate, 0, 0, 8);
    this.filter = new ST.SimpleFilter({ extract: (t, n) => this.pull(t, n) }, this.st);
    this.samples = new Float32Array(LOOP_BUF * 2);
    this.node = null;
    this.loop = null;
    this.pending = null;
    this.pos = 0; this.srcTotal = 0; this.heard = 0; this.events = [];
    this.target = 96; this.ratio = 1; this.vol = 0.9;
  }
  get playing() { return !!this.node; }
  ratioFor(loop) { return clamp(this.target / loop.bpm, 0.5, 2); }
  applyRatio() { if (this.loop) { this.ratio = this.ratioFor(this.loop); this.st.tempo = this.ratio; } }
  setTarget(bpm) { this.target = bpm; this.applyRatio(); }
  setVolume(v) {
    this.vol = v;
    if (this.playing) this.out.gain.setTargetAtTime(v * v, this.ctx.currentTime, 0.03);
  }

  reset(loop) {
    this.loop = loop; this.pos = 0; this.pending = null;
    this.filter.clear(); this.st.clear();
    this.events = [{ at: this.srcTotal, loop }];
    this.heard = this.srcTotal;
    this.applyRatio();
  }

  play(loop) {
    if (this.node) this.stopNow();
    this.srcTotal = 0;
    this.reset(loop);
    const n = this.ctx.createScriptProcessor(LOOP_BUF, 1, 2);
    n.onaudioprocess = (e) => this.process(e);
    const t = this.ctx.currentTime;
    this.out.gain.cancelScheduledValues(t);
    this.out.gain.setValueAtTime(0, t);
    this.out.gain.linearRampToValueAtTime(this.vol * this.vol, t + 0.02);
    n.connect(this.out);
    this.node = n;
  }

  stopNow() {
    if (!this.node) return;
    this.node.onaudioprocess = null;
    try { this.node.disconnect(); } catch (e) { /* gone */ }
    this.node = null;
  }

  stop() {
    if (!this.node) return;
    const node = this.node, t = this.ctx.currentTime;
    this.node = null; this.pending = null;
    const g = holdParam(this.out.gain, t);
    this.out.gain.linearRampToValueAtTime(0, t + 0.06);
    void g;
    setTimeout(() => { node.onaudioprocess = null; try { node.disconnect(); } catch (e) { /* gone */ } }, 120);
  }

  // mode: "bar" | "loop" | "now"
  queue(loop, mode) {
    if (!this.playing) { this.loop = loop; return "selected"; }
    if (loop === this.loop) { this.pending = null; return "same"; }
    if (mode === "now") { this.reset(loop); return "now"; }
    let boundary = Infinity;
    if (mode === "bar") {
      const cur = this.loop;
      const next = Math.floor(Math.ceil((this.pos + 1) / cur.barLen) * cur.barLen);
      if (next < cur.len) boundary = next;
    }
    this.pending = { loop, boundary };
    return "queued";
  }

  switchNow(at) {
    const p = this.pending; this.pending = null;
    this.loop = p.loop;
    this.events.push({ at, loop: p.loop });
    this.applyRatio();
  }

  pull(target, n) {
    let loop = this.loop;
    if (!loop) { target.fill(0, 0, n * 2); this.srcTotal += n; return n; }
    let L = loop.L, R = loop.R, len = loop.len, pos = this.pos;
    for (let i = 0; i < n; i++) {
      if (pos >= len) {
        if (this.pending) { this.switchNow(this.srcTotal + i); loop = this.loop; L = loop.L; R = loop.R; len = loop.len; }
        pos = 0;
      } else if (this.pending && pos >= this.pending.boundary) {
        this.switchNow(this.srcTotal + i); loop = this.loop; L = loop.L; R = loop.R; len = loop.len;
        pos = 0;
      }
      target[2 * i] = L[pos]; target[2 * i + 1] = R[pos];
      pos++;
    }
    this.pos = pos; this.srcTotal += n;
    return n;
  }

  process(e) {
    const L = e.outputBuffer.getChannelData(0), R = e.outputBuffer.getChannelData(1);
    const s = this.samples;
    const n = this.filter.extract(s, LOOP_BUF);
    for (let i = 0; i < n; i++) { L[i] = s[2 * i]; R[i] = s[2 * i + 1]; }
    for (let i = n; i < LOOP_BUF; i++) { L[i] = 0; R[i] = 0; }
    this.heard += n * this.ratio;
    while (this.events.length > 1 && this.events[1].at <= this.heard) this.events.shift();
  }

  // What the listener hears right now: which loop and where in it (in source frames)
  heardState() {
    if (!this.playing || !this.events.length) return null;
    const lat = (LOOP_BUF + (this.ctx.baseLatency || 0) * this.ctx.sampleRate) * this.ratio;
    const h = Math.max(0, this.heard - lat);
    let ev = this.events[0];
    for (const e of this.events) if (e.at <= h) ev = e;
    const pos = ((h - ev.at) % ev.loop.len + ev.loop.len) % ev.loop.len;
    return { loop: ev.loop, pos };
  }
}

/* ----- Loop file helpers ----- */
function trimLossyPadding(buffer, name) {
  const lossy = !/\.(wav|wave|aif|aiff|flac)$/i.test(name);
  const chs = [];
  for (let c = 0; c < Math.min(2, buffer.numberOfChannels); c++) chs.push(buffer.getChannelData(c));
  if (chs.length === 1) chs.push(chs[0]);
  let start = 0, end = chs[0].length;
  if (lossy) {
    const maxTrim = Math.floor(buffer.sampleRate * 0.06), th = 1e-4;
    const loud = (i) => Math.abs(chs[0][i]) > th || Math.abs(chs[1][i]) > th;
    while (start < maxTrim && start < end - 1 && !loud(start)) start++;
    while (end > chs[0].length - maxTrim && end > start + 1 && !loud(end - 1)) end--;
  }
  return {
    L: chs[0].slice(start, end),
    R: chs[1] === chs[0] ? null : chs[1].slice(start, end),
    trimmedMs: Math.round((start + (chs[0].length - end)) / buffer.sampleRate * 1000)
  };
}

function autocorrBpm(L, sr) {
  const hop = Math.round(sr * 0.01);
  const frames = Math.min(Math.floor(L.length / hop) - 1, 3000);
  if (frames < 120) return null;
  const env = new Float32Array(frames);
  for (let f = 0; f < frames; f++) {
    let e = 0; const s = f * hop;
    for (let i = 0; i < hop * 2 && s + i < L.length; i++) e += L[s + i] * L[s + i];
    env[f] = Math.log(1e-9 + e);
  }
  const on = new Float32Array(frames);
  for (let f = 1; f < frames; f++) on[f] = Math.max(0, env[f] - env[f - 1]);
  let mean = 0; for (const x of on) mean += x; mean /= frames;
  for (let f = 0; f < frames; f++) on[f] -= mean;
  let best = -Infinity, bestLag = 0;
  const ac = [];
  for (let lag = 33; lag <= 100; lag++) {
    let s = 0; for (let f = 0; f + lag < frames; f++) s += on[f] * on[f + lag];
    ac[lag] = s / (frames - lag);
    if (ac[lag] > best) { best = ac[lag]; bestLag = lag; }
  }
  let lag = bestLag;
  if (bestLag > 33 && bestLag < 100) {
    const a = ac[bestLag - 1], b = ac[bestLag], c = ac[bestLag + 1];
    const d = a - 2 * b + c; if (d !== 0) lag = bestLag + 0.5 * (a - c) / d;
  }
  let bpm = 60 / (lag * 0.01);
  while (bpm < 70) bpm *= 2;
  while (bpm > 165) bpm /= 2;
  return bpm;
}

function guessBpm(name, L, sr, dur, bpb) {
  bpb = bpb || 4;
  const m = name.match(/(\d{2,3}(?:\.\d+)?)\s*[-_ ]?\s*bpm/i) || name.match(/bpm\s*[-_ ]?\s*(\d{2,3}(?:\.\d+)?)/i);
  if (m) { const v = parseFloat(m[1]); if (v >= 40 && v <= 240) return { bpm: v, how: "from file name" }; }
  const ac = autocorrBpm(L, sr);
  const cands = [];
  // A loop's length is a whole number of beats; skip this when dur is not a loop length (long files in the trimmer)
  if (dur) for (const beats of [2, 3, 4, 6, 8, 12, 16, 24, 32, 48, 64]) {
    const b = 60 * beats / dur;
    if (b >= 60 && b <= 180) cands.push({ b, beats });
  }
  if (cands.length) {
    const score = (c) => {
      const ref = ac || 100;
      const d = Math.min(
        Math.abs(Math.log2(c.b / ref)),
        Math.abs(Math.log2(c.b / (ref * 2))) + 0.35,
        Math.abs(Math.log2(c.b / (ref / 2))) + 0.35);
      const range = c.b < 70 || c.b > 165 ? 0.3 : 0;
      return d + range + (c.beats % bpb ? 0.15 : 0) + (ac ? 0 : Math.abs(Math.log2(c.b / 100)) * 0.1);
    };
    cands.sort((a, b) => score(a) - score(b));
    return { bpm: Math.round(cands[0].b * 10) / 10, how: "detected" };
  }
  if (ac) return { bpm: Math.round(ac), how: "detected" };
  return { bpm: 120, how: "guess" };
}

// Times (seconds) of clear hits in the audio, for snapping a loop start onto a beat
function onsetTimes(L, sr) {
  const hop = Math.round(sr * 0.01), frames = Math.floor(L.length / hop) - 1;
  if (frames < 3) return [0];
  const env = new Float32Array(frames);
  for (let f = 0; f < frames; f++) {
    let e = 0; const s = f * hop;
    for (let i = 0; i < hop * 2 && s + i < L.length; i++) e += L[s + i] * L[s + i];
    env[f] = Math.log(1e-9 + e);
  }
  const on = new Float32Array(frames);
  let mean = 0, sq = 0;
  for (let f = 1; f < frames; f++) { on[f] = Math.max(0, env[f] - env[f - 1]); mean += on[f]; sq += on[f] * on[f]; }
  mean /= frames; const sd = Math.sqrt(Math.max(0, sq / frames - mean * mean));
  const th = mean + 1.5 * sd, out = [];
  for (let f = 1; f < frames - 1; f++) {
    if (on[f] > th && on[f] >= on[f - 1] && on[f] >= on[f + 1] && env[f] > -12) {
      const t = f * 0.01;
      if (!out.length || t - out[out.length - 1] > 0.06) out.push(t);
    }
  }
  return out.length ? out : [0];
}

if (typeof module !== "undefined") module.exports = { LoopEngine, loopMeta, guessBpm, autocorrBpm, onsetTimes, KEYS, VOICINGS, STYLES };
