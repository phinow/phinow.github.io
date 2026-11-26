import { loadModel, transcribe, backendName, MODEL_RATE } from './engine.js';
import { HFT, blockInput, extractNotes, frameCount, HFT_SENSITIVITY } from './hft.js';
import { loadHftEngine, runBlock, engineInfo } from './hftEngine.js';
import { openMedia, resampleMono } from './media.js';
import { Player } from './player.js';
import {
  KEY_CHOICES, detectKey, detectChords, chordName, noteNamer, midiName, defaultKeyId, keyLabel,
  shiftBetween,
} from './theory.js';
import { buildMidi, saveFile, insideClaude } from './files.js';

/* global MODEL_JSON, MODEL_B64, DEMO_NOTES */

const $ = id => document.getElementById(id);
const ASSET_BASE = new URL('./', location.href).href;
const player = new Player(ASSET_BASE);

const S = {
  sourceName: 'Example: Eb gospel progression',
  fileBase: 'example',
  isDemo: true,
  mono: null,         // whole file, mono, at sr
  sr: 44100,
  fromManual: false,  // the viewer picked "Played in" themselves
  running: false,
  stopAsked: false,
  notes: [],          // transcribed notes, original pitch, section-relative times
  chords: [],         // chord segments, original pitch
  key: null,
  fromId: 'Eb',
  fromMode: 'major',
  toId: 'Db',
  dir: 'nearest',
  semis: -2,
  hear: 'audio',
  busy: false,
};

const store = {
  get(k, d) { try { const v = localStorage.getItem('keyshift.' + k); return v === null ? d : v; } catch (e) { return d; } },
  set(k, v) { try { localStorage.setItem('keyshift.' + k, v); } catch (e) { /* storage unavailable */ } },
};

function fmt(t) {
  t = Math.max(0, t);
  const m = Math.floor(t / 60);
  const s = Math.floor(t % 60);
  return m + ':' + String(s).padStart(2, '0');
}

function parseTime(str) {
  str = String(str).trim();
  if (!str) return NaN;
  const parts = str.split(':').map(Number);
  if (parts.some(isNaN)) return NaN;
  return parts.reduce((acc, v) => acc * 60 + v, 0);
}

function pcOf(id) {
  return KEY_CHOICES.find(k => k.id === id).pc;
}

const fromNamer = () => noteNamer(S.fromId, S.fromMode);
const toNamer = () => noteNamer(S.toId, S.fromMode);

/* ---------- Key panel ---------- */

function fillKeySelects() {
  for (const sel of [$('fromKey'), $('toKey')]) {
    sel.innerHTML = '';
    for (const k of KEY_CHOICES) {
      const o = document.createElement('option');
      o.value = k.id;
      o.textContent = k.id;
      sel.appendChild(o);
    }
  }
}

function setSeg(segId, value) {
  for (const b of $(segId).querySelectorAll('button')) {
    const on = b.dataset.v === value;
    b.classList.toggle('on', on);
    b.setAttribute('aria-pressed', on ? 'true' : 'false');
  }
}

function updateKeyUI() {
  $('fromKey').value = S.fromId;
  $('fromMode').value = S.fromMode;
  $('toKey').value = S.toId;
  setSeg('dirSeg', S.dir);
  const det = S.key ? keyLabel(defaultKeyId(S.key.pc, S.key.mode), S.key.mode) : '';
  $('keyDetected').textContent = S.key ? 'Detected: ' + det : 'No key yet';
  $('keyDetected').classList.toggle('warn', !!(S.key && !S.key.confident));
  $('keyHint').hidden = !(S.key && !S.key.confident);
  const n = Math.abs(S.semis);
  const word = n === 1 ? 'semitone' : 'semitones';
  $('shiftText').textContent = S.semis === 0
    ? 'Same key, no shift'
    : (S.semis < 0 ? 'Down ' : 'Up ') + n + ' ' + word;
  $('fromTo').textContent = keyLabel(S.fromId, S.fromMode) + ' to ' + keyLabel(S.toId, S.fromMode);
  $('chartKey').textContent = keyLabel(S.toId, S.fromMode);
}

function recompute() {
  S.semis = shiftBetween(pcOf(S.fromId), pcOf(S.toId), S.dir);
  player.setSemitones(S.semis);
  updateKeyUI();
  layoutKeyboard();
  renderChart();
  draw(true);
}

/* ---------- Analysis ---------- */

function analyze(notes, duration) {
  S.notes = notes;
  S.key = detectKey(notes);
  if (!S.fromManual) {
    S.fromId = defaultKeyId(S.key.pc, S.key.mode);
    S.fromMode = S.key.mode;
  }
  S.chords = detectChords(notes, duration);
  S.playChords = S.chords.filter(c => c.root !== null);
  recompute();
}

/* ---------- Chord chart ---------- */

function renderChart() {
  const ol = $('chart');
  ol.innerHTML = '';
  const nmTo = toNamer(), nmFrom = fromNamer();
  (S.playChords || []).forEach((c, i) => {
    const li = document.createElement('li');
    const b = document.createElement('button');
    b.type = 'button';
    b.dataset.i = i;
    b.innerHTML = '<span class="ct">' + fmt(c.start) + '</span><span class="cn"></span><span class="co"></span>';
    b.querySelector('.cn').textContent = chordName(c, S.semis, nmTo);
    b.querySelector('.co').textContent = chordName(c, 0, nmFrom);
    b.addEventListener('click', () => { player.seek(c.start); if (player.loop) setLoopTo(c); draw(true); });
    li.appendChild(b);
    ol.appendChild(li);
  });
  $('chartEmpty').hidden = (S.playChords || []).length > 0;
  lastChartIdx = -1;
}

let lastChartIdx = -1;
function chordIndexAt(pos) {
  const list = S.playChords || [];
  let lo = 0, hi = list.length - 1, ans = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (list[mid].start <= pos + 1e-6) { ans = mid; lo = mid + 1; } else hi = mid - 1;
  }
  return ans;
}

function updateNow(pos) {
  const list = S.playChords || [];
  const i = chordIndexAt(pos);
  const cur = i >= 0 && pos < list[i].end + 0.05 ? list[i] : null;
  const next = list[i + 1] || null;
  $('chordNow').textContent = cur ? chordName(cur, S.semis, toNamer()) : '·';
  $('chordWas').textContent = cur ? chordName(cur, 0, fromNamer()) + ' in the original' : '';
  $('chordNext').textContent = next ? chordName(next, S.semis, toNamer()) : '·';
  if (i !== lastChartIdx) {
    const items = $('chart').querySelectorAll('button');
    if (items[lastChartIdx]) items[lastChartIdx].classList.remove('now');
    if (items[i]) items[i].classList.add('now');
    lastChartIdx = i;
  }
  $('time').textContent = fmt(pos) + ' / ' + fmt(player.duration);
}

/* ---------- Keyboard + falling notes ---------- */

const BLACK = new Set([1, 3, 6, 8, 10]);
const BLACK_NUDGE = { 1: -0.1, 3: 0.1, 6: -0.12, 8: 0, 10: 0.12 };
const KB = { lo: 36, hi: 84, keys: new Map(), whiteW: 20, width: 0 };
const PX_PER_SEC = 72;
const SPLIT = 60; // below middle C counts as left hand

let colors = {};
function readColors() {
  const cs = getComputedStyle(document.documentElement);
  const g = n => cs.getPropertyValue(n).trim();
  colors = {
    paper: g('--stage'), line: g('--line'), ink: g('--ink'), muted: g('--muted'),
    rh: g('--accent'), lh: g('--lh'), white: '#fbfbfa', black: '#151515', keyLine: '#8a8a86',
  };
}

function layoutKeyboard() {
  // Fit the keyboard to the notes actually played, ignoring the odd stray note at either end.
  const pitches = S.notes.map(n => n.p + S.semis).sort((a, b) => a - b);
  let lo = 48, hi = 72;
  if (pitches.length) {
    const cut = Math.floor(pitches.length * 0.005);
    lo = pitches[cut];
    hi = pitches[pitches.length - 1 - cut];
  }
  lo = Math.max(21, lo - 1);
  hi = Math.min(108, hi + 1);
  while (hi - lo < 24 && (lo > 21 || hi < 108)) {
    if (lo > 21) lo--;
    if (hi < 108) hi++;
  }
  if (BLACK.has(lo % 12)) lo--;
  if (BLACK.has(hi % 12)) hi++;
  KB.lo = lo;
  KB.hi = hi;
  const stage = $('stage');
  const avail = stage.clientWidth;
  let whites = 0;
  for (let m = lo; m <= hi; m++) if (!BLACK.has(m % 12)) whites++;
  KB.whiteW = Math.max(9, avail / whites);
  KB.width = Math.round(KB.whiteW * whites);
  KB.keys.clear();
  let wi = 0;
  for (let m = lo; m <= hi; m++) {
    const pc = m % 12;
    if (!BLACK.has(pc)) {
      KB.keys.set(m, { x: wi * KB.whiteW, w: KB.whiteW, black: false });
      wi++;
    }
  }
  for (let m = lo; m <= hi; m++) {
    const pc = m % 12;
    if (BLACK.has(pc)) {
      const bw = KB.whiteW * 0.62;
      const boundary = (KB.keys.get(m + 1) || { x: KB.width }).x;
      const cx = boundary + BLACK_NUDGE[pc] * KB.whiteW;
      KB.keys.set(m, { x: cx - bw / 2, w: bw, black: true });
    }
  }
  sizeCanvases();
  // On a narrow screen the keyboard may be wider than the stage: centre it on the notes in use.
  if (KB.width > avail && pitches.length) {
    const mid = KB.keys.get(pitches[Math.floor(pitches.length / 2)]) || KB.keys.get(lo);
    stage.scrollLeft = Math.max(0, mid.x - avail / 2);
  }
}

function sizeCanvases() {
  const dpr = window.devicePixelRatio || 1;
  const rollH = Math.round(Math.min(340, Math.max(220, window.innerHeight * 0.36)));
  const kbH = Math.round(Math.min(120, Math.max(78, KB.whiteW * 4.6)));
  for (const [id, h] of [['roll', rollH], ['kbd', kbH]]) {
    const c = $(id);
    c.style.width = KB.width + 'px';
    c.style.height = h + 'px';
    c.width = Math.round(KB.width * dpr);
    c.height = Math.round(h * dpr);
    c.getContext('2d').setTransform(dpr, 0, 0, dpr, 0, 0);
  }
}

function firstNoteIndex(t) {
  const ns = S.notes;
  let lo = 0, hi = ns.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (ns[mid].t < t) lo = mid + 1; else hi = mid;
  }
  return lo;
}

function roundRect(ctx, x, y, w, h, r) {
  r = Math.min(r, w / 2, h / 2);
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}

function drawRoll(pos) {
  const c = $('roll');
  const ctx = c.getContext('2d');
  const W = KB.width, H = parseFloat(c.style.height);
  const visible = H / PX_PER_SEC;
  const yOf = t => H - (t - pos) * PX_PER_SEC;
  ctx.fillStyle = colors.paper;
  ctx.fillRect(0, 0, W, H);

  // Octave guides at every C, and lanes behind black keys.
  for (const [m, k] of KB.keys) {
    if (k.black) {
      ctx.fillStyle = colors.line;
      ctx.globalAlpha = 0.35;
      ctx.fillRect(k.x, 0, k.w, H);
      ctx.globalAlpha = 1;
    } else if (m % 12 === 0) {
      ctx.fillStyle = colors.line;
      ctx.fillRect(Math.round(k.x), 0, 1, H);
    }
  }

  // Chord change lines (labels go on top of the notes, below).
  for (const ch of S.playChords || []) {
    if (ch.start > pos + visible || ch.start < pos - 0.6) continue;
    ctx.fillStyle = colors.muted;
    ctx.globalAlpha = 0.5;
    ctx.fillRect(0, Math.round(yOf(ch.start)), W, 1);
    ctx.globalAlpha = 1;
  }

  // Notes.
  const nm = toNamer();
  ctx.textBaseline = 'alphabetic';
  ctx.font = '600 10px ' + getComputedStyle(document.body).getPropertyValue('--mono');
  const start = firstNoteIndex(pos - 12);
  for (let i = start; i < S.notes.length; i++) {
    const n = S.notes[i];
    if (n.t > pos + visible) break;
    if (n.t + n.d < pos - 0.05) continue;
    const p = n.p + S.semis;
    const k = KB.keys.get(p);
    if (!k) continue;
    const yTop = Math.max(-4, yOf(n.t + n.d));
    const yBot = Math.min(H + 4, yOf(n.t));
    const active = n.t <= pos && pos < n.t + n.d;
    const pad = k.black ? 1 : 2;
    ctx.fillStyle = p < SPLIT ? colors.lh : colors.rh;
    ctx.globalAlpha = active ? 1 : 0.82;
    roundRect(ctx, k.x + pad, yTop, k.w - pad * 2, Math.max(3, yBot - yTop), 3);
    ctx.fill();
    ctx.globalAlpha = 1;
    if (yBot - yTop > 15 && yBot > 16) {
      const label = nm(p % 12);
      const tw = ctx.measureText(label).width;
      const bw = Math.max(k.w - pad * 2, tw + 6);
      const bx = k.x + k.w / 2 - bw / 2;
      const by = Math.min(H - 4, yBot) - 14;
      if (bw > k.w - pad * 2) {
        ctx.fillStyle = p < SPLIT ? colors.lh : colors.rh;
        roundRect(ctx, bx, by, bw, 13, 3);
        ctx.fill();
      }
      ctx.fillStyle = '#ffffff';
      ctx.fillText(label, k.x + (k.w - tw) / 2, by + 10);
    }
  }
  // Chord names, drawn last so notes never cover them.
  const nmTo = toNamer();
  ctx.font = '600 12px ' + getComputedStyle(document.body).getPropertyValue('--mono');
  ctx.textBaseline = 'bottom';
  for (const ch of S.playChords || []) {
    if (ch.start > pos + visible || ch.start < pos - 0.6) continue;
    const y = Math.round(yOf(ch.start));
    const label = chordName(ch, S.semis, nmTo);
    const tw = ctx.measureText(label).width;
    const lx = KB.width > $('stage').clientWidth ? $('stage').scrollLeft + 4 : 4;
    ctx.fillStyle = colors.paper;
    ctx.globalAlpha = 0.92;
    ctx.fillRect(lx, y - 18, tw + 10, 17);
    ctx.globalAlpha = 1;
    ctx.fillStyle = colors.ink;
    ctx.fillText(label, lx + 5, y - 4);
  }
  ctx.textBaseline = 'alphabetic';
  // Hit line.
  ctx.fillStyle = colors.ink;
  ctx.fillRect(0, H - 2, W, 2);
}

function drawKeyboard(pos) {
  const c = $('kbd');
  const ctx = c.getContext('2d');
  const W = KB.width, H = parseFloat(c.style.height);
  const active = new Map();
  const start = firstNoteIndex(pos - 12);
  for (let i = start; i < S.notes.length; i++) {
    const n = S.notes[i];
    if (n.t > pos) break;
    if (pos < n.t + n.d) active.set(n.p + S.semis, n.p + S.semis < SPLIT ? 'lh' : 'rh');
  }
  ctx.clearRect(0, 0, W, H);
  const blackH = H * 0.62;
  const nm = toNamer();
  ctx.font = '600 10px ' + getComputedStyle(document.body).getPropertyValue('--mono');
  for (const [m, k] of KB.keys) {
    if (k.black) continue;
    const a = active.get(m);
    ctx.fillStyle = a ? colors[a] : colors.white;
    ctx.fillRect(k.x, 0, k.w, H);
    ctx.fillStyle = colors.keyLine;
    ctx.fillRect(Math.round(k.x), 0, 1, H);
    const label = a ? nm(m % 12) : (m % 12 === 0 ? 'C' + (Math.floor(m / 12) - 1) : '');
    if (label && k.w >= 11) {
      ctx.fillStyle = a ? '#ffffff' : (m === 60 ? '#151515' : '#8a8a86');
      const tw = ctx.measureText(label).width;
      if (tw < k.w) ctx.fillText(label, k.x + (k.w - tw) / 2, H - 6);
    }
  }
  for (const [m, k] of KB.keys) {
    if (!k.black) continue;
    const a = active.get(m);
    ctx.fillStyle = a ? colors[a] : colors.black;
    roundRect(ctx, k.x, -3, k.w, blackH + 3, 2);
    ctx.fill();
    if (a && k.w >= 9) {
      ctx.fillStyle = '#ffffff';
      const label = nm(m % 12);
      ctx.save();
      ctx.font = '600 9px ' + getComputedStyle(document.body).getPropertyValue('--mono');
      const tw = ctx.measureText(label).width;
      if (tw < k.w + 4) ctx.fillText(label, k.x + (k.w - tw) / 2, blackH - 5);
      ctx.restore();
    }
  }
  ctx.fillStyle = colors.keyLine;
  ctx.fillRect(0, 0, W, 1);
  const names = [...active.keys()].sort((a, b) => a - b).map(m => midiName(m, nm));
  $('kbdLive').textContent = names.length ? 'Keys down: ' + names.join(' ') : '';
}

let dirty = true;
function draw(force) {
  if (force) dirty = true;
}

function frame() {
  if (dirty || player.playing) {
    const pos = player.position;
    drawRoll(pos);
    drawKeyboard(pos);
    updateNow(pos);
    $('playBtn').classList.toggle('on', player.playing);
    $('playBtn').setAttribute('aria-label', player.playing ? 'Pause' : 'Play');
    $('playIcon').toggleAttribute('hidden', player.playing);
    $('pauseIcon').toggleAttribute('hidden', !player.playing);
    dirty = false;
  }
  requestAnimationFrame(frame);
}

/* ---------- Transport ---------- */

async function togglePlay() {
  if (!player.audio) return;
  if (player.playing) player.pause();
  else {
    await player.play();
    showModeNote();
  }
  draw(true);
}

function showModeNote() {
  if (player.mode === 'tape') {
    $('modeNote').hidden = false;
    $('modeNote').textContent = 'This browser cannot change pitch and speed separately, so the audio plays slower or faster along with the key change. The notes and chords are still correct.';
    $('speed').disabled = true;
  }
}

function currentChord() {
  const list = S.playChords || [];
  const i = chordIndexAt(player.position);
  return { i, list };
}

function setLoopTo(ch) {
  player.setLoop({ a: ch.start, b: ch.end });
  $('loopBtn').classList.add('on');
  $('loopBtn').setAttribute('aria-pressed', 'true');
}

function clearLoop() {
  player.setLoop(null);
  $('loopBtn').classList.remove('on');
  $('loopBtn').setAttribute('aria-pressed', 'false');
}

function prevChord() {
  const { i, list } = currentChord();
  if (!list.length) return;
  let target = i < 0 ? 0 : i;
  if (i >= 0 && player.position - list[i].start < 0.6) target = Math.max(0, i - 1);
  player.seek(list[target].start);
  if (player.loop) setLoopTo(list[target]);
  draw(true);
}

function nextChord() {
  const { i, list } = currentChord();
  if (!list.length) return;
  const target = Math.min(list.length - 1, i + 1);
  player.seek(list[target].start);
  if (player.loop) setLoopTo(list[target]);
  draw(true);
}

function toggleLoop() {
  if (player.loop) { clearLoop(); return; }
  const { i, list } = currentChord();
  if (!list.length) return;
  const ch = list[Math.max(0, i)];
  setLoopTo(ch);
  if (player.position < ch.start || player.position >= ch.end) player.seek(ch.start);
  draw(true);
}

function setHear(v) {
  S.hear = v;
  setSeg('hearSeg', v);
  player.setMix(v !== 'notes', v !== 'audio');
}

/* ---------- Scrubbing the falling notes ---------- */

function bindScrub() {
  const roll = $('roll');
  let drag = null;
  roll.addEventListener('pointerdown', e => {
    if (!player.audio) return;
    drag = { y: e.clientY, pos: player.position, wasPlaying: player.playing };
    if (player.playing) player.pause();
    roll.setPointerCapture(e.pointerId);
  });
  roll.addEventListener('pointermove', e => {
    if (!drag) return;
    const pos = drag.pos + (e.clientY - drag.y) / PX_PER_SEC;
    player.seek(pos);
    draw(true);
  });
  const end = () => {
    if (!drag) return;
    const resume = drag.wasPlaying;
    drag = null;
    if (resume) player.play();
    draw(true);
  };
  roll.addEventListener('pointerup', end);
  roll.addEventListener('pointercancel', end);
}

/* ---------- Loading audio ---------- */

function setProgress(p, text) {
  $('progress').hidden = false;
  $('progressBar').style.width = Math.round(p * 100) + '%';
  $('progressText').textContent = text;
}

function hideProgress() {
  $('progress').hidden = true;
}

function setBusy(b) {
  S.busy = b;
  for (const id of ['fileLabel', 'secStart', 'secEnd', 'sens', 'recordBtn']) {
    const el = $(id);
    if (el.tagName === 'LABEL') el.classList.toggle('disabled', b);
    else el.disabled = b;
  }
  $('fileInput').disabled = b;
  $('transcribeBtn').disabled = b && !S.running;
  $('transcribeBtn').textContent = S.running ? 'Stop' : 'Transcribe';
  $('transcribeBtn').classList.toggle('stop', S.running);
}

function showError(msg) {
  $('sourceError').textContent = msg;
  $('sourceError').hidden = !msg;
}

const MAX_SECTION = 20 * 60;

async function loadMedia(file, name) {
  if (S.busy) return;
  showError('');
  setBusy(true);
  setProgress(0.02, 'Opening ' + name + '…');
  try {
    await player.ensureContext();
    showModeNote();
    player.pause();
    const { mono, sampleRate } = await openMedia(file, player.ctx, p => setProgress(p, 'Reading the sound from ' + name + '… ' + Math.round(p * 100) + '%'));
    S.mono = mono;
    S.sr = sampleRate;
    S.isDemo = false;
    S.fromManual = false;
    S.sourceName = name;
    S.fileBase = name.replace(/\.[^.]+$/, '').replace(/[^\w\- ]+/g, '').trim().slice(0, 60) || 'tutorial';
    const dur = mono.length / sampleRate;
    $('sourceName').textContent = name;
    $('secStart').value = '0:00';
    $('secEnd').value = fmt(Math.min(dur, MAX_SECTION));
    $('sourceNote').textContent = 'Length ' + fmt(dur) + '.' + (dur > MAX_SECTION ? ' Up to 20 minutes can be done at once.' : '');
    hideProgress();
    setBusy(false);
    await runTranscribe();
  } catch (e) {
    console.error(e);
    hideProgress();
    setBusy(false);
    showError(e && e.message && !/decode|Unable|EncodingError/i.test(e.message) ? e.message : 'This file could not be read. Try an MP4, M4A, MP3 or WAV file.');
  }
}

const CHUNK = 30;   // seconds of audio per pass of the quick model
const CONTEXT = 1;  // extra second either side so notes at the edges are not cut
const HFT_CHUNK_BLOCKS = 8; // piano model: refresh notes and chords every 8 blocks (about 16 s)

async function runTranscribe() {
  if (S.running) { S.stopAsked = true; $('transcribeBtn').textContent = 'Stopping…'; return; }
  if (S.busy || !S.mono) return;
  showError('');
  const total = S.mono.length / S.sr;
  const a = parseTime($('secStart').value);
  let b = parseTime($('secEnd').value);
  if (isNaN(a) || isNaN(b)) { showError('Write start and end like 1:05.'); return; }
  b = Math.min(b, total);
  if (b - a < 2) { showError('The end needs to be at least 2 seconds after the start.'); return; }
  if (b - a > MAX_SECTION + 0.5) { showError('Pick a part of 20 minutes or less.'); return; }

  S.running = true;
  S.stopAsked = false;
  setBusy(true);
  player.pause();
  clearLoop();
  const sr = S.sr;
  const section = S.mono.subarray(Math.floor(a * sr), Math.floor(b * sr));
  const dur = section.length / sr;
  const notes = [];
  const ctx = { a, b, dur, t0: 0, done: 0 };
  try {
    await player.setAudio(section, sr, notes);
    S.notes = notes;
    S.chords = [];
    S.playChords = [];
    renderChart();
    draw(true);
    let engine = $('engine').value;
    if (engine === 'piano') {
      try {
        await transcribePiano(section, sr, notes, ctx);
      } catch (e) {
        if (notes.length || S.stopAsked) throw e;
        console.warn('Piano model unavailable', e);
        showError('The piano model could not run in this browser (' + (e.message || 'unknown error') + '). Using the quick model instead.');
        engine = 'quick';
      }
    }
    if (engine === 'quick') await transcribeQuick(section, sr, notes, ctx);
    hideProgress();
    if (!notes.length) {
      showError('No piano notes were found in this part. Try High sensitivity, or pick a part where the piano plays.');
    } else {
      analyze(notes, dur);
      const stopped = S.stopAsked;
      const end = stopped ? a + Math.min(dur, ctx.done) : b;
      $('sourceNote').textContent = (stopped ? 'Stopped. ' : '') + 'Transcribed ' + fmt(a) + ' to ' + fmt(end) + ': ' + notes.length + ' notes, ' + S.playChords.length + ' chord changes.';
      $('engineInfo').textContent = engineLine(engine);
    }
  } catch (e) {
    console.error(e);
    hideProgress();
    showError('Transcription stopped: ' + (e && e.message ? e.message : 'unknown error') + '. What was done so far is kept.');
  }
  S.running = false;
  S.stopAsked = false;
  setBusy(false);
  draw(true);
}

function engineLine(engine) {
  if (engine === 'piano') {
    const info = engineInfo();
    if (!info) return '';
    return 'Notes by the piano model (hFT-Transformer), running on ' + (info.gpu ? 'the graphics chip.' : 'the processor' + (info.threads > 1 ? ' with ' + info.threads + ' threads.' : '.'));
  }
  return 'Notes by the quick model (Basic Pitch), running on ' + (backendName() === 'webgl' ? 'the graphics chip.' : 'the processor.');
}

function reportProgress(ctx, doneSec, label) {
  const done = Math.min(1, doneSec / ctx.dur);
  const el = (performance.now() - ctx.t0) / 1000;
  const eta = done > 0.02 && el > 3 ? Math.max(0, el / done - el) : null;
  setProgress(0.02 + done * 0.98, label + ': ' + fmt(ctx.a + doneSec) + ' of ' + fmt(ctx.b) + (eta !== null ? ' · about ' + fmtEta(eta) + ' left' : ''));
  return { el, eta };
}

function publish(notes, uptoSec, ctx) {
  player.setNotes(notes);
  if (notes.length) {
    analyze(notes, uptoSec);
    $('sourceNote').textContent = 'Done up to ' + fmt(ctx.a + uptoSec) + ' of ' + fmt(ctx.b) + '. You can play what is ready while the rest is written out.';
  }
}

// Piano model: 128-frame blocks (2.05 s) with real neighbouring audio as context, exactly as the
// model's own inference code walks a file, so splitting the work changes nothing in the result.
async function transcribePiano(section, sr, notes, ctx) {
  setProgress(0.01, 'Loading the piano model…');
  await loadHftEngine(ASSET_BASE, msg => setProgress(0.01, msg));
  setProgress(0.015, 'Preparing audio…');
  const audio16 = await resampleMono(section, sr, HFT.SR);
  const nF = frameCount(audio16.length);
  const nB = Math.ceil(nF / HFT.BLOCK);
  const size = nB * HFT.BLOCK * 88;
  const on = new Float32Array(size), off = new Float32Array(size), mpe = new Float32Array(size);
  const vel = new Uint8Array(size);
  const thr = HFT_SENSITIVITY[$('sens').value] || HFT_SENSITIVITY.normal;
  const fps = HFT.SR / HFT.HOP;
  ctx.t0 = performance.now();
  let slowHint = false;
  for (let blk = 0; blk < nB; blk++) {
    if (S.stopAsked) break;
    const { spec, T } = blockInput(audio16, nF, blk);
    const out = await runBlock(spec, T);
    const at = blk * HFT.BLOCK * 88;
    on.set(out.onset, at);
    off.set(out.offset, at);
    mpe.set(out.mpe, at);
    vel.set(out.velocity, at);
    const framesDone = Math.min(nF, (blk + 1) * HFT.BLOCK);
    ctx.done = framesDone / fps;
    const { el, eta } = reportProgress(ctx, ctx.done, 'Writing out the notes');
    if (!slowHint && eta !== null && el > 20 && eta > 10 * 60) {
      slowHint = true;
      $('sourceNote').textContent = 'This computer is slow with the piano model. For a faster rough result, set Accuracy to Quick and press Transcribe again.';
    }
    if ((blk + 1) % HFT_CHUNK_BLOCKS === 0 || blk === nB - 1) {
      const fresh = extractNotes(on, off, mpe, vel, framesDone, thr);
      notes.length = 0;
      for (const n of fresh) if (n.t < ctx.dur) notes.push(n);
      publish(notes, ctx.done, ctx);
      await new Promise(r => setTimeout(r, 0));
    }
  }
  if (S.stopAsked) {
    const fresh = extractNotes(on, off, mpe, vel, Math.min(nF, Math.round(ctx.done * fps)), thr);
    notes.length = 0;
    for (const n of fresh) notes.push(n);
  }
}

async function transcribeQuick(section, sr, notes, ctx) {
  setProgress(0.01, 'Loading the quick model…');
  const model = await loadModel(MODEL_JSON, MODEL_B64);
  const dur = ctx.dur;
  ctx.t0 = performance.now();
  for (let c0 = 0; c0 < dur - 0.05; c0 += CHUNK) {
    if (S.stopAsked) break;
    const c1 = Math.min(dur, c0 + CHUNK);
    const s0 = Math.max(0, c0 - CONTEXT);
    const s1 = Math.min(dur, c1 + CONTEXT);
    const piece = await resampleMono(section.subarray(Math.floor(s0 * sr), Math.floor(s1 * sr)), sr, MODEL_RATE);
    const raw = await transcribe(model, piece, $('sens').value, p => {
      reportProgress(ctx, c0 + p * (c1 - c0), 'Writing out the notes (quick)');
    }, () => S.stopAsked);
    if (raw === null) break;
    const last = c1 >= dur - 0.05;
    const fresh = raw
      .map(n => ({ t: n.t + s0, d: n.d, p: n.p, a: n.a }))
      .filter(n => n.t >= c0 && (n.t < c1 || last));
    for (const n of fresh) notes.push(n);
    notes.sort((x, y) => x.t - y.t || x.p - y.p);
    ctx.done = c1;
    publish(notes, c1, ctx);
    await new Promise(r => setTimeout(r, 0));
  }
}

function fmtEta(sec) {
  if (sec < 60) return Math.ceil(sec / 5) * 5 + ' s';
  return Math.ceil(sec / 60) + ' min';
}

/* ---------- Tab recording (works on a normal website in desktop Chrome or Edge) ---------- */

let rec = null;
function setupRecording() {
  const btn = $('recordBtn');
  const canRecord = !insideClaude() && navigator.mediaDevices && typeof navigator.mediaDevices.getDisplayMedia === 'function' && typeof MediaRecorder !== 'undefined';
  if (!canRecord) { btn.hidden = true; return; }
  btn.hidden = false;
  btn.addEventListener('click', async () => {
    if (rec) { rec.recorder.stop(); return; }
    showError('');
    let stream;
    try {
      stream = await navigator.mediaDevices.getDisplayMedia({
        video: true,
        audio: { echoCancellation: false, noiseSuppression: false, autoGainControl: false },
        selfBrowserSurface: 'exclude',
      });
    } catch (e) {
      return; // the viewer cancelled the share dialog
    }
    const tracks = stream.getAudioTracks();
    if (!tracks.length) {
      stream.getTracks().forEach(t => t.stop());
      showError('No sound was shared. Pick the YouTube tab and turn on "Also share tab audio".');
      return;
    }
    const type = ['audio/webm;codecs=opus', 'audio/webm', 'audio/mp4'].find(t => MediaRecorder.isTypeSupported(t)) || '';
    const recorder = new MediaRecorder(new MediaStream(tracks), type ? { mimeType: type } : undefined);
    const chunks = [];
    const startedAt = Date.now();
    recorder.ondataavailable = e => { if (e.data.size) chunks.push(e.data); };
    recorder.onstop = async () => {
      clearInterval(rec.timer);
      stream.getTracks().forEach(t => t.stop());
      rec = null;
      btn.classList.remove('rec');
      btn.textContent = 'Record a tab';
      const blob = new Blob(chunks, { type: recorder.mimeType || 'audio/webm' });
      if (blob.size < 2000) { showError('The recording was empty.'); return; }
      await loadMedia(blob, 'Tab recording ' + new Date().toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' }));
    };
    tracks[0].addEventListener('ended', () => { if (recorder.state !== 'inactive') recorder.stop(); });
    stream.getVideoTracks().forEach(t => t.addEventListener('ended', () => { if (recorder.state !== 'inactive') recorder.stop(); }));
    recorder.start(1000);
    rec = { recorder, timer: setInterval(() => { btn.textContent = 'Stop recording ' + fmt((Date.now() - startedAt) / 1000); }, 500) };
    btn.classList.add('rec');
    btn.textContent = 'Stop recording 0:00';
    $('sourceNote').textContent = 'Recording. Play the part of the video you want, then press Stop recording.';
  });
}

/* ---------- Saving ---------- */

async function save(kind) {
  const el = $('saveNote');
  el.textContent = '';
  if (!S.notes.length) return;
  const keyTag = S.toId.replace('#', 'sharp');
  try {
    let name;
    if (kind === 'midi') {
      const data = buildMidi(S.notes, S.semis, S.fileBase + ' in ' + S.toId);
      name = await saveFile(S.fileBase + ' in ' + keyTag + '.mid', data, 'audio/midi');
    } else {
      const nmTo = toNamer(), nmFrom = fromNamer();
      const lines = [
        S.sourceName,
        'Key: ' + keyLabel(S.toId, S.fromMode) + ' (original ' + keyLabel(S.fromId, S.fromMode) + ', ' + $('shiftText').textContent.toLowerCase() + ')',
        '',
        'Time   ' + S.toId.padEnd(14) + 'Original',
      ];
      for (const c of S.playChords) lines.push(fmt(c.start).padEnd(7) + chordName(c, S.semis, nmTo).padEnd(14) + chordName(c, 0, nmFrom));
      lines.push('', 'Made with KeyShift. Chords are detected automatically; check them against the video.');
      name = await saveFile(S.fileBase + ' chords in ' + keyTag + '.txt', lines.join('\n'), 'text/plain');
    }
    if (name) el.textContent = 'Saved ' + name + '.';
  } catch (e) {
    el.textContent = e.message;
  }
}

/* ---------- Start ---------- */

async function loadDemo() {
  // The example is a real grand-piano recording (Salamander samples); its notes were written out
  // by the same piano model the app uses.
  const notes = DEMO_NOTES.map(([t, d, p, a]) => ({ t, d, p, a }));
  const sr = 44100;
  let data;
  try {
    const r = await fetch(new URL('demo.mp3', ASSET_BASE).href);
    const decoded = await new OfflineAudioContext(1, 1, sr).decodeAudioData(await r.arrayBuffer());
    data = decoded.getChannelData(0).slice();
  } catch (e) {
    console.warn('Example recording unavailable', e);
    data = new Float32Array(Math.ceil((notes[notes.length - 1].t + 3) * sr));
  }
  S.mono = data;
  S.sr = sr;
  player.audio = data;
  player.sampleRate = sr;
  player.notes = notes;
  const buf = { duration: data.length / sr };
  $('secStart').value = '0:00';
  $('secEnd').value = fmt(buf.duration);
  analyze(notes, buf.duration);
  // Prefer the viewer's last target key once the example is analysed.
  const savedTo = store.get('toKey', 'Db');
  if (KEY_CHOICES.some(k => k.id === savedTo)) S.toId = savedTo;
  S.dir = store.get('dir', 'nearest');
  recompute();
  // Rest just inside the first chord so the keyboard shows its full shape.
  if (S.notes.length) player.pausedPos = S.notes[0].t + 0.5;
  draw(true);
}

// Read-only hook for automated tests.
window.__keyshift = { notes: () => S.notes.map(n => ({ ...n })), chords: () => (S.playChords || []).length, player };

function init() {
  fillKeySelects();
  readColors();
  $('sens').value = store.get('sens', 'normal');

  $('fileInput').addEventListener('change', async e => {
    const f = e.target.files[0];
    e.target.value = '';
    if (!f) return;
    await loadMedia(f, f.name);
  });
  const drop = $('source');
  drop.addEventListener('dragover', e => { e.preventDefault(); drop.classList.add('drop'); });
  drop.addEventListener('dragleave', () => drop.classList.remove('drop'));
  drop.addEventListener('drop', async e => {
    e.preventDefault();
    drop.classList.remove('drop');
    const f = e.dataTransfer.files[0];
    if (f && !S.busy) await loadMedia(f, f.name);
  });
  $('transcribeBtn').addEventListener('click', async () => {
    await player.ensureContext();
    showModeNote();
    runTranscribe();
  });
  $('sens').addEventListener('change', () => store.set('sens', $('sens').value));
  $('engine').value = store.get('engine', 'piano');
  if (insideClaude()) {
    // Claude's page host cannot serve the piano model's files, so only the quick model runs here.
    const opt = $('engine').querySelector('option[value="piano"]');
    opt.disabled = true;
    opt.textContent = 'Best: piano model (on phinow.github.io/keyshift)';
    $('engine').value = 'quick';
  }
  $('engine').addEventListener('change', () => store.set('engine', $('engine').value));

  $('fromKey').addEventListener('change', () => { S.fromId = $('fromKey').value; S.fromManual = true; recompute(); });
  $('fromMode').addEventListener('change', () => { S.fromMode = $('fromMode').value; S.fromManual = true; recompute(); });
  $('toKey').addEventListener('change', () => { S.toId = $('toKey').value; store.set('toKey', S.toId); recompute(); });
  for (const b of $('dirSeg').querySelectorAll('button')) {
    b.addEventListener('click', () => { S.dir = b.dataset.v; store.set('dir', S.dir); recompute(); });
  }
  for (const b of $('hearSeg').querySelectorAll('button')) b.addEventListener('click', () => setHear(b.dataset.v));

  $('playBtn').addEventListener('click', togglePlay);
  $('prevBtn').addEventListener('click', prevChord);
  $('nextBtn').addEventListener('click', nextChord);
  $('loopBtn').addEventListener('click', toggleLoop);
  $('speed').addEventListener('input', () => {
    const v = Number($('speed').value);
    $('speedOut').textContent = v + '%';
    player.setSpeed(v / 100);
    draw(true);
  });
  $('midiBtn').addEventListener('click', () => save('midi'));
  $('sheetBtn').addEventListener('click', () => save('sheet'));
  player.onEnded = () => draw(true);

  document.addEventListener('keydown', e => {
    if (e.target.closest('input, select, textarea')) return;
    if (e.code === 'Space') { e.preventDefault(); togglePlay(); }
    else if (e.key === 'ArrowLeft') { e.preventDefault(); prevChord(); }
    else if (e.key === 'ArrowRight') { e.preventDefault(); nextChord(); }
    else if (e.key === 'l' || e.key === 'L') toggleLoop();
  });

  const mq = window.matchMedia('(prefers-color-scheme: dark)');
  const retheme = () => { readColors(); draw(true); };
  if (mq.addEventListener) mq.addEventListener('change', retheme);
  new MutationObserver(retheme).observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] });
  new ResizeObserver(() => { layoutKeyboard(); draw(true); }).observe($('stage'));
  document.fonts && document.fonts.ready.then(() => draw(true));

  if (insideClaude()) $('saveNote').textContent = 'Both are saved in the new key. Here the MIDI file comes inside a .zip.';
  bindScrub();
  setupRecording();
  setHear('audio');
  requestAnimationFrame(frame);
  loadDemo();
}

init();
