// A small sampled grand piano (Salamander Grand Piano by Alexander Holm, CC BY 3.0): one sample
// every three semitones from A0 to C8, re-pitched to the notes in between. Used to play back the
// transcribed notes so they sound like a piano.

const NAMES = ['A0', 'C1', 'Ds1', 'Fs1', 'A1', 'C2', 'Ds2', 'Fs2', 'A2', 'C3', 'Ds3', 'Fs3', 'A3', 'C4', 'Ds4', 'Fs4',
  'A4', 'C5', 'Ds5', 'Fs5', 'A5', 'C6', 'Ds6', 'Fs6', 'A6', 'C7', 'Ds7', 'Fs7', 'A7', 'C8'];

function midiOf(name) {
  const pc = { C: 0, Ds: 3, Fs: 6, A: 9 }[name.slice(0, -1)];
  return 12 * (Number(name.slice(-1)) + 1) + pc;
}

export class PianoSampler {
  constructor(ctx, destination, base) {
    this.ctx = ctx;
    this.dest = destination;
    this.base = base;
    this.buffers = new Map();
    this.ready = false;
  }

  async load() {
    const dir = new URL('piano/', this.base).href;
    await Promise.all(NAMES.map(async n => {
      const r = await fetch(dir + n + '.mp3');
      if (!r.ok) throw new Error('missing sample ' + n);
      this.buffers.set(midiOf(n), await this.ctx.decodeAudioData(await r.arrayBuffer()));
    }));
    this.keys = [...this.buffers.keys()].sort((a, b) => a - b);
    this.ready = true;
  }

  // amp: 0..1 (velocity / 127). Returns a voice handle for stopping early.
  play(midi, when, dur, amp) {
    if (!this.ready) return null;
    let base = this.keys[0];
    for (const k of this.keys) if (Math.abs(k - midi) < Math.abs(base - midi)) base = k;
    const ctx = this.ctx;
    const src = ctx.createBufferSource();
    src.buffer = this.buffers.get(base);
    src.playbackRate.value = Math.pow(2, (midi - base) / 12);
    const v = Math.max(0.05, Math.min(1, amp));
    const lp = ctx.createBiquadFilter();
    lp.type = 'lowpass';
    lp.frequency.value = 1200 + v * v * 12000; // soft notes are darker, as on a real piano
    const g = ctx.createGain();
    const level = 0.12 + 0.55 * Math.pow(v, 1.5);
    const end = when + Math.max(0.08, dur);
    g.gain.setValueAtTime(level, when);
    g.gain.setTargetAtTime(0, end, 0.11); // damper
    src.connect(lp).connect(g).connect(this.dest);
    src.start(when);
    src.stop(end + 0.8);
    const voice = { src, g, onEnd: null };
    src.onended = () => { g.disconnect(); if (voice.onEnd) voice.onEnd(); };
    return voice;
  }
}
