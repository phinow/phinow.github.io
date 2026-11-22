// Playback: the tutorial audio pitch-shifted (Signalsmith Stretch), plus an optional synth of the
// transcribed notes. Falls back to tape-style playback (pitch and speed move together) when the
// AudioWorklet/WASM path is unavailable.
// SignalsmithStretch is loaded as a separate classic script (see build.mjs) so its worklet source
// survives minification untouched.
const SignalsmithStretch = (...args) => window.SignalsmithStretch(...args);
import { resampleMono } from './media.js';

export class Player {
  constructor() {
    this.ctx = null;
    this.audio = null;      // mono Float32Array of the part being studied
    this.sampleRate = 48000;
    this.tapeBuffer = null; // AudioBuffer, only built for tape playback
    this.notes = [];
    this.semis = 0;
    this.speed = 1;
    this.hearAudio = true;
    this.hearNotes = false;
    this.playing = false;
    this.anchorCtx = 0;
    this.anchorPos = 0;
    this.pausedPos = 0;
    this.loop = null; // {a, b}
    this.mode = null; // 'stretch' | 'tape'
    this.stretch = null;
    this.tapeSource = null;
    this.voices = new Set();
    this.nextNote = 0;
    this.timer = null;
    this.onEnded = null;
  }

  async ensureContext() {
    if (this.ctx) {
      if (this.ctx.state === 'suspended') await this.ctx.resume();
      return;
    }
    const AC = window.AudioContext || window.webkitAudioContext;
    this.ctx = new AC({ latencyHint: 'interactive' });
    this.master = this.ctx.createGain();
    this.master.connect(this.ctx.destination);
    this.audioGain = this.ctx.createGain();
    this.audioGain.connect(this.master);
    this.notesGain = this.ctx.createGain();
    this.notesGain.gain.value = 0.32;
    this.notesGain.connect(this.master);
    this.applyMix();
    try {
      this.stretch = await Promise.race([
        SignalsmithStretch(this.ctx, { numberOfInputs: 1, numberOfOutputs: 1, outputChannelCount: [1] }),
        new Promise((_, rej) => setTimeout(() => rej(new Error('timeout')), 6000)),
      ]);
      this.stretch.connect(this.audioGain);
      this.mode = 'stretch';
      if (this.audio) await this.loadIntoStretch();
    } catch (e) {
      console.warn('Stretch unavailable, using tape playback', e);
      this.stretch = null;
      this.mode = 'tape';
    }
    if (this.ctx.state === 'suspended') await this.ctx.resume();
  }

  // The worklet gets its own copy of the audio (moved, not duplicated, by transferring it).
  async loadIntoStretch() {
    if (!this.stretch || !this.audio) return;
    if (this.sampleRate !== this.ctx.sampleRate) {
      this.audio = await resampleMono(this.audio, this.sampleRate, this.ctx.sampleRate);
      this.sampleRate = this.ctx.sampleRate;
      this.tapeBuffer = null;
    }
    await this.stretch.dropBuffers();
    const copy = this.audio.slice();
    await this.stretch.addBuffers([copy], [copy.buffer]);
  }

  // audio: mono Float32Array at sampleRate (the AudioContext's rate).
  async setAudio(audio, sampleRate, notes) {
    this.stop();
    this.audio = audio;
    this.sampleRate = sampleRate;
    this.tapeBuffer = null;
    this.notes = notes || [];
    this.pausedPos = 0;
    this.loop = null;
    if (this.stretch) await this.loadIntoStretch();
  }

  getTapeBuffer() {
    if (!this.tapeBuffer && this.audio) {
      this.tapeBuffer = new AudioBuffer({ length: this.audio.length, numberOfChannels: 1, sampleRate: this.sampleRate });
      this.tapeBuffer.copyToChannel(this.audio, 0);
    }
    return this.tapeBuffer;
  }

  setNotes(notes) {
    this.notes = notes;
    if (this.playing) this.resetSynth();
  }

  get duration() {
    return this.audio ? this.audio.length / this.sampleRate : 0;
  }

  // How fast the input moves per second of real time.
  get rate() {
    return this.mode === 'tape' ? Math.pow(2, this.semis / 12) : this.speed;
  }

  get position() {
    if (!this.playing || !this.ctx) return this.pausedPos;
    const p = this.anchorPos + Math.max(0, this.ctx.currentTime - this.anchorCtx) * this.rate;
    return Math.min(p, this.duration);
  }

  applyMix() {
    if (!this.ctx) return;
    const t = this.ctx.currentTime;
    this.audioGain.gain.setTargetAtTime(this.hearAudio ? 1 : 0, t, 0.02);
    this.notesGain.gain.setTargetAtTime(this.hearNotes ? 0.32 : 0, t, 0.02);
  }

  setMix(audio, notes) {
    this.hearAudio = audio;
    this.hearNotes = notes;
    this.applyMix();
  }

  async play(from) {
    if (!this.audio) return;
    await this.ensureContext();
    const start = from ?? this.pausedPos;
    this.startAt(start >= this.duration - 0.05 ? 0 : start);
  }

  startAt(pos) {
    this.stopSources();
    const now = this.ctx.currentTime + 0.06;
    this.anchorCtx = now;
    this.anchorPos = pos;
    this.playing = true;
    if (this.mode === 'stretch') {
      this.stretch.schedule({
        active: true, output: now, input: pos, rate: this.speed, semitones: this.semis,
        formantCompensation: true, formantBaseHz: 0,
      });
    } else {
      const src = this.ctx.createBufferSource();
      src.buffer = this.getTapeBuffer();
      src.playbackRate.value = this.rate;
      src.connect(this.audioGain);
      src.start(now, pos);
      this.tapeSource = src;
    }
    this.resetSynth();
    clearInterval(this.timer);
    this.timer = setInterval(() => this.tick(), 40);
  }

  pause() {
    if (!this.playing) return;
    this.pausedPos = this.position;
    this.playing = false;
    this.stopSources();
    clearInterval(this.timer);
  }

  stop() {
    this.pause();
    this.pausedPos = 0;
  }

  stopSources() {
    if (this.stretch && this.ctx) this.stretch.schedule({ active: false, output: this.ctx.currentTime });
    if (this.tapeSource) {
      try { this.tapeSource.stop(); } catch (e) { /* already stopped */ }
      this.tapeSource.disconnect();
      this.tapeSource = null;
    }
    this.killVoices();
  }

  seek(pos) {
    pos = Math.max(0, Math.min(pos, this.duration));
    if (this.playing) this.startAt(pos);
    else this.pausedPos = pos;
  }

  setSemitones(n) {
    this.semis = n;
    if (this.playing) {
      if (this.mode === 'stretch') {
        this.stretch.schedule({ output: this.ctx.currentTime, semitones: n });
        this.resetSynth();
      } else {
        this.startAt(this.position);
      }
    }
  }

  setSpeed(s) {
    if (this.playing) {
      const pos = this.position;
      this.speed = s;
      this.startAt(pos);
    } else {
      this.speed = s;
    }
  }

  setLoop(loop) {
    this.loop = loop;
  }

  tick() {
    const pos = this.position;
    if (this.loop && pos >= this.loop.b) {
      this.startAt(this.loop.a);
      return;
    }
    if (pos >= this.duration - 0.01) {
      this.pause();
      this.pausedPos = this.duration;
      if (this.onEnded) this.onEnded();
      return;
    }
    this.scheduleNotes(pos);
  }

  resetSynth() {
    this.killVoices();
    const pos = this.position;
    let i = 0;
    while (i < this.notes.length && this.notes[i].t < pos - 0.001) i++;
    this.nextNote = i;
  }

  killVoices() {
    if (!this.ctx) return;
    const t = this.ctx.currentTime;
    for (const v of this.voices) {
      try {
        v.g.gain.cancelScheduledValues(t);
        v.g.gain.setTargetAtTime(0, t, 0.01);
        v.o1.stop(t + 0.08);
        v.o2.stop(t + 0.08);
      } catch (e) { /* voice already ended */ }
    }
    this.voices.clear();
  }

  scheduleNotes(pos) {
    if (!this.hearNotes) {
      // Keep the pointer moving so turning notes on later does not burst old notes.
      while (this.nextNote < this.notes.length && this.notes[this.nextNote].t < pos + 0.3 * this.rate) this.nextNote++;
      return;
    }
    const horizon = pos + 0.3 * this.rate;
    const ctxNow = this.ctx.currentTime;
    while (this.nextNote < this.notes.length && this.notes[this.nextNote].t < horizon) {
      const n = this.notes[this.nextNote++];
      if (this.loop && (n.t < this.loop.a || n.t >= this.loop.b)) continue;
      const when = this.anchorCtx + (n.t - this.anchorPos) / this.rate;
      if (when < ctxNow - 0.02) continue;
      this.voice(n.p + this.semis, Math.max(when, ctxNow), n.d / this.rate, n.a);
    }
  }

  voice(midi, when, dur, amp) {
    const ctx = this.ctx;
    const f = 440 * Math.pow(2, (midi - 69) / 12);
    const o1 = ctx.createOscillator();
    const o2 = ctx.createOscillator();
    o1.type = 'triangle';
    o2.type = 'sine';
    o1.frequency.value = f;
    o2.frequency.value = f * 2;
    const g = ctx.createGain();
    const g2 = ctx.createGain();
    g2.gain.value = 0.25;
    const lp = ctx.createBiquadFilter();
    lp.type = 'lowpass';
    lp.frequency.value = 1800 + amp * 3000;
    o1.connect(g);
    o2.connect(g2).connect(g);
    g.connect(lp).connect(this.notesGain);
    const peak = 0.12 + amp * 0.25;
    const end = when + Math.max(0.12, dur);
    g.gain.setValueAtTime(0, when);
    g.gain.linearRampToValueAtTime(peak, when + 0.006);
    g.gain.setTargetAtTime(peak * 0.25, when + 0.006, 0.9);
    g.gain.setTargetAtTime(0, end, 0.08);
    o1.start(when);
    o2.start(when);
    o1.stop(end + 0.5);
    o2.stop(end + 0.5);
    const v = { o1, o2, g };
    this.voices.add(v);
    o1.onended = () => { this.voices.delete(v); g.disconnect(); };
  }
}
