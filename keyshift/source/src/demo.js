// Built-in example: a short gospel-style progression in Eb, synthesized in the browser.
// Ebmaj9 | Cm9 | Abmaj7 | Ab/Bb | Ebmaj9
export const DEMO_CHORDS = [
  [39, 51, 67, 70, 74, 77],
  [36, 48, 63, 67, 70, 74],
  [44, 56, 67, 72, 75],
  [46, 58, 68, 72, 75],
  [39, 51, 67, 70, 74, 77],
];
export const DEMO_CHORD_SECONDS = 2;

export function renderDemo(sr) {
  const tail = 1.5;
  const total = Math.ceil(sr * (DEMO_CHORD_SECONDS * DEMO_CHORDS.length + tail));
  const out = new Float32Array(total);
  DEMO_CHORDS.forEach((chord, i) => {
    const start = Math.floor(i * DEMO_CHORD_SECONDS * sr);
    const len = Math.floor((DEMO_CHORD_SECONDS + 0.6) * sr);
    chord.forEach((m, j) => {
      // Bass on the beat, right hand a touch later, like a player rolling into the chord.
      const offset = m < 60 ? 0 : Math.floor((0.012 * j) * sr);
      const f = 440 * Math.pow(2, (m - 69) / 12);
      const gain = m < 50 ? 0.22 : 0.15;
      for (let n = 0; n < len && start + offset + n < total; n++) {
        const t = n / sr;
        const env = Math.exp(-t * 1.6) * Math.min(1, t / 0.004);
        let s = 0;
        for (let k = 0; k < 6; k++) s += Math.pow(0.55, k) * Math.sin(2 * Math.PI * f * (k + 1) * t) * Math.exp(-t * k * 0.9);
        out[start + offset + n] += s * env * gain;
      }
    });
  });
  let peak = 0;
  for (let i = 0; i < total; i++) peak = Math.max(peak, Math.abs(out[i]));
  for (let i = 0; i < total; i++) out[i] = (out[i] / peak) * 0.8;
  return out;
}
