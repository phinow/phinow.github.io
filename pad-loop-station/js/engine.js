if (typeof module !== "undefined" && typeof stretchOnsets === "undefined") { var { stretchOnsets } = require("./stretch.js"); }
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

function loopMeta(loop) {
  const bpb = loop.bpb || 4;   // beats per bar: 3 for 3/4, 4 for 4/4
  loop.beats = Math.max(1, Math.round(loop.dur * loop.bpm / 60));
  loop.bars = loop.beats >= bpb ? Math.max(1, Math.round(loop.beats / bpb)) : 1;
  loop.barLen = loop.len / loop.bars;
  return loop;
}

/* ----- Loop engine -----
   Each loop is rendered once at the chosen tempo (by stretch.js, in a background worker), then played by the
   browser's own looping buffer player on the audio thread. Nothing on the page (drawing, loading a file,
   a busy computer) can interrupt it, and the loop point is exact to the sample.
   At the loop's own tempo the original recording plays untouched. */
const LEAD = 0.06;     // seconds ahead that every change is scheduled
const COMMIT = 0.35;   // a queued change is locked in once its moment is this close
const XFADE = 0.01;    // a tempo change cross-fades over the 10 ms before a beat
const CUT = 0.003;     // switching loops: the old loop fades over its last 3 ms

class LoopEngine {
  constructor(ctx, dest, render) {
    this.ctx = ctx; this.sr = ctx.sampleRate; this.render = render;
    this.out = ctx.createGain(); this.out.gain.value = 0.81; this.out.connect(dest);
    this.cache = new WeakMap();   // loop -> Map(ratio -> AudioBuffer)
    this.jobs = new WeakMap();    // loop -> Map(ratio -> Promise)
    this.known = [];
    this.loop = null; this.pending = null; this.segs = [];
    this.target = 96; this.ratio = 1; this.vol = 0.9;
    this._playing = false; this.timer = 0; this.prepTimer = 0;
    this.onError = null;
    this.tempoFor = null;   // (loop) => the tempo saved for that loop's slot, or null
    this.onTarget = null;   // called when a switch brings in a loop's saved tempo
  }
  get playing() { return this._playing; }
  ratioFor(loop) { return this.ratioAt(loop, this.target); }
  ratioAt(loop, bpm) { return clamp(bpm / loop.bpm, 0.5, 2); }
  savedTempo(loop) { const t = this.tempoFor && this.tempoFor(loop); return t > 0 ? t : null; }
  // Every tempo this loop may be asked to play at soon: now, its saved tempo, or the tempo it is queued at
  wanted(loop, ratio) {
    if (ratio === this.ratioFor(loop)) return true;
    const t = this.savedTempo(loop); if (t && ratio === this.ratioAt(loop, t)) return true;
    const p = this.pending; if (p && p.loop === loop && p.tempo && ratio === this.ratioAt(loop, p.tempo)) return true;
    return this.segs.some((s) => s.loop === loop && s.ratio === ratio);
  }
  applyRatio() { if (this.loop) this.ratio = this.ratioFor(this.loop); this.prepareSoon(); this.tick(); }
  setTarget(bpm) { this.target = bpm; this.applyRatio(); }
  setVolume(v) { this.vol = v; this.out.gain.setTargetAtTime(v * v, this.ctx.currentTime, 0.03); }
  prepare(list) { this.known = list.filter(Boolean); this.prepareSoon(); }

  /* Rendered buffers */
  bufferFor(loop, ratio) { const m = this.cache.get(loop); return (m && m.get(ratio)) || null; }
  want(loop, ratio, urgent) {
    let m = this.cache.get(loop); if (!m) { m = new Map(); this.cache.set(loop, m); }
    if (m.has(ratio)) return Promise.resolve(m.get(ratio));
    let jm = this.jobs.get(loop); if (!jm) { jm = new Map(); this.jobs.set(loop, jm); }
    if (jm.has(ratio)) return jm.get(ratio);
    const stale = () => !this.wanted(loop, ratio);
    const job = (ratio === 1 ? Promise.resolve({ L: loop.L, R: loop.R }) : this.render(loop.L, loop.R, this.sr, ratio, { urgent, stale }))
      .then(({ L, R }) => {
        const b = this.ctx.createBuffer(2, L.length, this.sr);
        b.copyToChannel(L, 0); b.copyToChannel(R, 1);
        m.set(ratio, b); jm.delete(ratio);
        // keep the original and the tempos in use or most recently asked for
        for (const r of [...m.keys()]) if (m.size > 3 && r !== 1 && r !== ratio && !this.segs.some((s) => s.loop === loop && s.ratio === r)) m.delete(r);
        this.tick();
        return b;
      }, (err) => { jm.delete(ratio); if (String(err && err.message) !== "stale" && this.onError) this.onError(err); throw err; });
    jm.set(ratio, job);
    return job;
  }
  prepareSoon() {
    clearTimeout(this.prepTimer);
    this.prepTimer = setTimeout(() => {
      const order = [this.loop, this.pending && this.pending.loop, ...this.known].filter(Boolean);
      const seen = new Set();
      for (const l of order) {
        if (seen.has(l)) continue; seen.add(l);
        const t = l === this.loop ? this.target : (this.pending && this.pending.loop === l && this.pending.tempo) || this.savedTempo(l) || this.target;
        this.want(l, this.ratioAt(l, t), l === this.loop).catch(() => {});
      }
    }, 150);
  }

  /* Transport */
  play(loop) {
    if (this._playing) this.stopNow();
    this.loop = loop; this.ratio = this.ratioFor(loop); this.pending = null;
    this._playing = true;
    if (!this.timer) this.timer = setInterval(() => this.tick(), 25);
    this.want(loop, this.ratio, true).catch(() => {});
    this.tick();
  }
  stop() {
    if (!this._playing) return;
    this._playing = false; this.pending = null;
    clearInterval(this.timer); this.timer = 0;
    const t = this.ctx.currentTime, old = this.segs; this.segs = [];
    for (const s of old) {
      holdParam(s.g.gain, t); s.g.gain.linearRampToValueAtTime(0, t + 0.06);
      try { s.src.stop(t + 0.07); } catch (e) { /* already stopped */ }
    }
    setTimeout(() => old.forEach((s) => this.drop(s)), 250);
  }
  stopNow() {
    this._playing = false; this.pending = null;
    clearInterval(this.timer); this.timer = 0;
    for (const s of this.segs) { try { s.src.stop(); } catch (e) { /* already stopped */ } this.drop(s); }
    this.segs = [];
  }
  drop(s) { try { s.src.disconnect(); s.g.disconnect(); } catch (e) { /* gone */ } }

  // mode: "bar" | "loop" | "now". tempo: the BPM the new loop comes in at (the current tempo carries on until then)
  queue(loop, mode, tempo) {
    if (!this._playing) { this.loop = loop; this.ratio = this.ratioFor(loop); this.prepareSoon(); return "selected"; }
    if (loop === this.loop) { this.pending = null; return "same"; }
    this.pending = { loop, mode, tempo: tempo > 0 ? tempo : null };
    this.want(loop, this.ratioAt(loop, this.pending.tempo || this.target), true).catch(() => {});
    this.tick();
    return mode === "now" ? "now" : "queued";
  }

  /* Scheduler: runs every 25 ms while playing; the audio itself never depends on it */
  tick() {
    if (!this._playing) return;
    const sr = this.sr, nowF = Math.round(this.ctx.currentTime * sr), leadF = Math.round(LEAD * sr), commitF = Math.round(COMMIT * sr);
    while (this.segs.length > 1 && this.segs[1].startF + sr < nowF) this.drop(this.segs.shift());
    const cur = this.segs[this.segs.length - 1];
    if (!cur) {
      const b = this.bufferFor(this.loop, this.ratio);
      if (b) {
        const B = nowF + leadF, seg = this.makeSeg(this.loop, this.ratio, b, B, B);
        seg.g.gain.setValueAtTime(0, B / sr); seg.g.gain.linearRampToValueAtTime(1, (B + Math.round(0.003 * sr)) / sr);
      } else this.want(this.loop, this.ratio, true).catch(() => {});
      return;
    }
    if (cur.startF > nowF) return;   // a change is locked in and has not started yet
    if (this.pending) {
      const p = this.pending, r = this.ratioAt(p.loop, p.tempo || this.target), b = this.bufferFor(p.loop, r);
      if (!b) { this.want(p.loop, r, true).catch(() => {}); return; }   // still rendering; it will catch the next boundary
      const B = p.mode === "now" ? nowF + leadF : this.nextBoundary(cur, nowF + leadF, p.mode === "bar" ? cur.loop.bars : 1).at;
      if (B - nowF > commitF) return;
      this.switchTo(cur, p.loop, r, b, B);
      this.pending = null; this.loop = p.loop; this.ratio = r;
      if (p.tempo && p.tempo !== this.target) { this.target = p.tempo; if (this.onTarget) this.onTarget(p.tempo); }
      return;
    }
    const r = this.ratioFor(cur.loop);
    if (r !== cur.ratio) {
      const b = this.bufferFor(cur.loop, r);
      if (!b) { this.want(cur.loop, r, true).catch(() => {}); return; }
      const nb = this.nextBoundary(cur, nowF + leadF + Math.round(XFADE * sr), cur.loop.beats);
      if (nb.at - nowF > commitF) return;
      this.retime(cur, r, b, nb);
      this.ratio = r;
    }
  }

  // Next spot at or after frame minF that falls on one of `count` equal divisions of the loop (bars, beats, or the loop end)
  nextBoundary(seg, minF, count) {
    const unit = seg.loop.len / count, N = seg.N, base = Math.floor((minF - seg.t0F) / N) * N;
    for (let it = 0; it < 3; it++) for (let k = 0; k < count; k++) {
      const at = seg.t0F + base + it * N + Math.round(k * unit / seg.ratio);
      if (at >= minF) return { at, k };
    }
    return { at: seg.t0F + base + 3 * N, k: 0 };
  }

  makeSeg(loop, ratio, buf, startF, t0F) {
    const ctx = this.ctx, sr = this.sr, N = buf.length;
    const src = ctx.createBufferSource(); src.buffer = buf; src.loop = true;
    const g = ctx.createGain(); src.connect(g); g.connect(this.out);
    const offF = ((startF - t0F) % N + N) % N;
    src.start(startF / sr, offF / sr);
    const seg = { loop, ratio, buf, N, startF, t0F, src, g };
    this.segs.push(seg);
    return seg;
  }

  // A different loop: it starts on its first sample exactly at frame B; the old one fades over its last 3 ms
  switchTo(cur, loop, ratio, buf, B) {
    const sr = this.sr, c = Math.round(CUT * sr);
    cur.g.gain.setValueAtTime(1, (B - c) / sr); cur.g.gain.linearRampToValueAtTime(0, B / sr);
    cur.src.stop((B + 128) / sr);
    const seg = this.makeSeg(loop, ratio, buf, B, B);
    seg.g.gain.setValueAtTime(0, B / sr); seg.g.gain.linearRampToValueAtTime(1, (B + Math.round(0.0015 * sr)) / sr);
  }

  // Same loop at a new tempo: the new render takes over on a beat, keeping the place in the loop
  retime(cur, ratio, buf, nb) {
    const sr = this.sr, x = Math.round(XFADE * sr), B = nb.at;
    const u = Math.round(nb.k * (cur.loop.len / cur.loop.beats) / ratio);   // that beat's frame in the new render
    cur.g.gain.setValueAtTime(1, (B - x) / sr); cur.g.gain.linearRampToValueAtTime(0, B / sr);
    cur.src.stop((B + 128) / sr);
    const seg = this.makeSeg(cur.loop, ratio, buf, B - x, B - u);
    seg.g.gain.setValueAtTime(0, (B - x) / sr); seg.g.gain.linearRampToValueAtTime(1, B / sr);
  }

  // What the listener hears right now: which loop and where in it (in frames of the original)
  heardState() {
    if (!this._playing || !this.segs.length) return null;
    const ctx = this.ctx;
    let t = ctx.currentTime - (ctx.outputLatency || ctx.baseLatency || 0);
    if (ctx.getOutputTimestamp) {
      const ts = ctx.getOutputTimestamp();
      if (ts && ts.contextTime > 0 && typeof performance !== "undefined") t = ts.contextTime + Math.max(0, (performance.now() - ts.performanceTime) / 1000);
    }
    const tF = Math.round(t * this.sr);
    let seg = null;
    for (const s of this.segs) if (s.startF <= tF) seg = s;
    if (!seg) return { loop: this.segs[0].loop, pos: 0 };
    const q = ((tF - seg.t0F) % seg.N + seg.N) % seg.N;
    return { loop: seg.loop, pos: q * seg.loop.len / seg.N };
  }
}

/* ----- Loop file helpers ----- */
// AIFF / AIFC (uncompressed) reader, resampled to the device rate
async function decodeAiff(ab, ctx) {
  const v = new DataView(ab);
  const id = (o) => String.fromCharCode(v.getUint8(o), v.getUint8(o + 1), v.getUint8(o + 2), v.getUint8(o + 3));
  if (v.byteLength < 12 || id(0) !== "FORM" || !/^AIF[FC]$/.test(id(8))) return null;
  const ext80 = (o) => {
    const se = v.getUint16(o), exp = se & 0x7fff, hi = v.getUint32(o + 2), lo = v.getUint32(o + 6);
    if (!exp && !hi && !lo) return 0;
    return (se & 0x8000 ? -1 : 1) * (hi * 4294967296 + lo) * Math.pow(2, exp - 16383 - 63);
  };
  let o = 12, ch = 0, frames = 0, bits = 0, sr = 0, data = -1, comp = "NONE";
  while (o + 8 <= v.byteLength) {
    const ck = id(o), sz = v.getUint32(o + 4), d = o + 8;
    if (ck === "COMM") { ch = v.getInt16(d); frames = v.getUint32(d + 2); bits = v.getInt16(d + 6); sr = ext80(d + 8); if (id(8) === "AIFC") comp = id(d + 18); }
    else if (ck === "SSND") data = d + 8 + v.getUint32(d);
    o = d + sz + (sz & 1);
  }
  if (data < 0 || !ch || !frames || !sr || !["NONE", "sowt", "twos"].includes(comp) || bits < 8 || bits > 32) return null;
  const bytes = Math.ceil(bits / 8), le = comp === "sowt", full = Math.pow(2, bytes * 8 - 1);
  frames = Math.min(frames, Math.floor((v.byteLength - data) / (bytes * ch)));
  const src = ctx.createBuffer(ch, frames, sr);
  const outs = []; for (let c = 0; c < ch; c++) outs.push(src.getChannelData(c));
  let p = data;
  for (let i = 0; i < frames; i++) {
    for (let c = 0; c < ch; c++) {
      let x = 0;
      for (let b = 0; b < bytes; b++) x = x * 256 + v.getUint8(p + (le ? bytes - 1 - b : b));
      if (x >= full) x -= full * 2;
      outs[c][i] = x / full; p += bytes;
    }
  }
  if (sr === ctx.sampleRate) return src;
  const OAC = window.OfflineAudioContext || window.webkitOfflineAudioContext;
  const oc = new OAC(ch, Math.ceil(frames * ctx.sampleRate / sr), ctx.sampleRate);
  const s = oc.createBufferSource(); s.buffer = src; s.connect(oc.destination); s.start();
  return oc.startRendering();
}

// MP3 and AAC files can carry a little silence at each end that the encoder added. Chrome removes it when the
// file says how much there is (most MP3s and M4As do). When silence is still there, it is cut only if cutting it
// makes the loop a whole number of beats, so a loop whose last hit really does fade to silence keeps its length.
function trimLossyPadding(buffer, name, bytes) {
  const lossy = !/\.(wav|wave|aif|aiff|flac)$/i.test(name);
  const chs = [];
  for (let c = 0; c < Math.min(2, buffer.numberOfChannels); c++) chs.push(buffer.getChannelData(c));
  if (chs.length === 1) chs.push(chs[0]);
  const n = chs[0].length, sr = buffer.sampleRate;
  let start = 0, end = n;
  if (lossy) {
    const maxTrim = Math.floor(sr * 0.06), th = 1e-4;
    const loud = (i) => Math.abs(chs[0][i]) > th || Math.abs(chs[1][i]) > th;
    const bare = bareMp3(bytes);
    if (bare) {
      // An MP3 with no gapless header: the decoder leaves the encoder's 1105-sample start-up in, plus padding at the end
      const lead = Math.round(1105 * sr / bare.rate), beat = beatPeriod(chs, sr, lead, n, name);
      let len = n - lead;
      if (beat) { const whole = Math.round(Math.round(len / beat) * beat); if (len - whole >= 0 && len - whole < 2 * 1152 * sr / bare.rate + 64) len = whole; }
      else { while (len > 1 && !loud(lead + len - 1) && n - lead - len < maxTrim) len--; }
      start = lead; end = lead + len;
      return { L: chs[0].slice(start, end), R: chs[1] === chs[0] ? null : chs[1].slice(start, end), trimmedMs: Math.round((n - len) / sr * 1000) };
    }
    let lead = 0, tail = 0;
    while (lead < maxTrim && lead < n - 1 && !loud(lead)) lead++;
    while (tail < maxTrim && n - tail > lead + 1 && !loud(n - 1 - tail)) tail++;
    if (lead || tail) {
      const beat = beatPeriod(chs, sr, lead, n - tail, name);
      if (!beat) { start = lead; end = n - tail; }          // no clear beat (a pad or a drone): the silence is padding
      else {
        const off = (len) => { const b = len / beat; return Math.abs(b - Math.round(b)) * beat; };
        let best = { s: 0, e: 0, err: off(n) };
        for (const [s, e] of [[lead, 0], [0, tail], [lead, tail]]) {
          const err = off(n - s - e);
          if (err < best.err - sr * 0.003) best = { s, e, err };
        }
        if (off(n) > sr * 0.003) { start = best.s; end = n - best.e; }
      }
    }
  }
  return {
    L: chs[0].slice(start, end),
    R: chs[1] === chs[0] ? null : chs[1].slice(start, end),
    trimmedMs: Math.round((start + (n - end)) / sr * 1000)
  };
}

// An MP3 whose first frame has no Xing/Info header carries no gapless information. Returns its sample rate, else null.
function bareMp3(bytes) {
  if (!bytes || bytes.byteLength < 400) return null;
  const b = new Uint8Array(bytes, 0, Math.min(bytes.byteLength, 1 << 20));
  let i = 0;
  if (b[0] === 0x49 && b[1] === 0x44 && b[2] === 0x33) i = 10 + ((b[6] & 127) << 21 | (b[7] & 127) << 14 | (b[8] & 127) << 7 | (b[9] & 127)) + (b[5] & 0x10 ? 10 : 0);
  while (i < b.length - 4 && b[i] === 0) i++;
  if (i > b.length - 200 || b[i] !== 0xFF || (b[i + 1] & 0xE0) !== 0xE0) return null;
  const ver = (b[i + 1] >> 3) & 3, layer = (b[i + 1] >> 1) & 3, sri = (b[i + 2] >> 2) & 3;
  if (layer !== 1 || ver === 1 || sri === 3) return null;          // not MPEG layer III
  const rate = [44100, 48000, 32000][sri] / (ver === 3 ? 1 : ver === 2 ? 2 : 4);
  for (let j = i + 4; j < i + 200; j++) {
    const t = String.fromCharCode(b[j], b[j + 1], b[j + 2], b[j + 3]);
    if (t === "Xing" || t === "Info" || t === "VBRI") return null;
  }
  return { rate };
}

// Checks a loop for the two things that make a loop sound wrong where it repeats:
// a jump where its end meets its start (a click), and a length that is not a whole number of the groove's beats
// (every pass would land early or late). Returns plain facts; the app words them.
function checkLoop(loop) {
  const L = loop.L, R = loop.R || loop.L, n = loop.len, sr = loop.sr;
  // How far each sample is from where the two before it were heading; a click is a large miss at the loop point
  const at = (x, i) => x[((i % n) + n) % n];
  const miss = (i) => Math.max(Math.abs(at(L, i) - 2 * at(L, i - 1) + at(L, i - 2)), Math.abs(at(R, i) - 2 * at(R, i - 1) + at(R, i - 2)));
  const around = (c) => { let v = 0; for (let k = -3; k <= 3; k++) v = Math.max(v, miss(c + k)); return v; };
  const local = [];
  for (let i = 4; i < Math.round(sr * 0.005); i++) local.push(miss(i), miss(n - i));
  local.sort((a, b) => a - b);
  const typical = local[Math.floor(local.length * 0.95)] || 0;
  const beat = beatPeriod([L, R], sr, 0, n, "");
  // The loop point is compared with the loop's own bar lines, where the music carries on uncut
  const bpb = loop.bpb || 4, lineAt = [];
  if (beat) { const nb = Math.round(n / beat); for (let j = bpb; j < nb; j += bpb) lineAt.push(j * beat); if (!lineAt.length) for (let j = 1; j < nb; j++) lineAt.push(j * beat); }
  else { const div = loop.bars >= 2 ? loop.bars : 2; for (let k = 1; k < div; k++) lineAt.push(k * n / div); }
  let lines = 0;
  for (const c of lineAt) lines = Math.max(lines, around(Math.round(c)));
  const seam = around(0);
  const click = seam > 0.01 && seam > 3 * Math.max(lines, typical);
  let offMs = null, grooveBpm = null, beats = null;
  if (beat) {
    beats = Math.max(1, Math.round(n / beat));
    offMs = (n - beats * beat) / sr * 1000;          // + means the file runs long, so each pass lands late
    grooveBpm = 60 * sr / beat;
  }
  return { click, seam, typical: Math.max(lines, typical), offMs, grooveBpm, beats };
}

// Beat length in samples, measured from where the hits fall (or from "96 BPM" in the file name)
function beatPeriod(chs, sr, from, to, name) {
  const nm = name && (name.match(/(\d{2,3}(?:\.\d+)?)\s*[-_ ]?\s*bpm/i) || name.match(/bpm\s*[-_ ]?\s*(\d{2,3}(?:\.\d+)?)/i));
  if (nm) { const v = parseFloat(nm[1]); if (v >= 40 && v <= 240) return 60 / v * sr; }
  const m = new Float32Array(to - from);
  for (let i = 0; i < m.length; i++) m[i] = 0.5 * (chs[0][from + i] + chs[1][from + i]);
  if (m.length < sr * 1.5 || typeof stretchOnsets === "undefined") return null;
  const approx = autocorrBpm(m, sr);
  if (!approx) return null;
  let on = stretchOnsets(m, sr).filter((o) => o.at > sr * 0.005 && o.at < m.length - sr * 0.005);
  if (on.length < 4) return null;
  const top = Math.max(...on.map((o) => o.strength));
  on = on.filter((o) => o.strength >= top * 0.5).map((o) => o.at).sort((a, b) => a - b);
  if (on.length < 4) return null;
  // Fit the hits to a half-beat grid, then refine the grid spacing by least squares
  let u = 30 / approx * sr;
  for (let pass = 0; pass < 3; pass++) {
    const pts = [];
    for (const t of on) { const k = Math.round((t - on[0]) / u), r = t - on[0] - k * u; if (Math.abs(r) < u * 0.2) pts.push([k, t]); }
    if (pts.length < 4) return null;
    const mk = pts.reduce((s, p) => s + p[0], 0) / pts.length, mt = pts.reduce((s, p) => s + p[1], 0) / pts.length;
    let num = 0, den = 0; for (const [k, t] of pts) { num += (k - mk) * (t - mt); den += (k - mk) * (k - mk); }
    if (!den) return null;
    u = num / den;
  }
  // Only trust it when most of the strong hits sit on that grid
  let fit = 0;
  for (const t of on) { const k = Math.round((t - on[0]) / u), r = Math.abs(t - on[0] - k * u); if (r < Math.max(sr * 0.003, u * 0.04)) fit++; }
  return fit >= Math.max(4, on.length * 0.7) ? 2 * u : null;
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

if (typeof module !== "undefined") module.exports = { LoopEngine, loopMeta, holdParam, checkLoop, trimLossyPadding, beatPeriod, guessBpm, autocorrBpm, onsetTimes, KEYS, VOICINGS, STYLES };
