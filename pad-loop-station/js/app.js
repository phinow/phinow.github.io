/* ===== Page wiring ===== */
const $ = (s) => document.querySelector(s);
const SETTINGS_KEY = "pad-loop-station:v1";
const DEFAULTS = {
  target: 96, mode: "bar", loopVol: 0.85, master: 0.9, selected: null, hideDemo: false,
  pad: { style: "warm", voicing: "open", tone: 0.45, fade: 3, space: 0.55, vol: 0.8 }
};
let S = JSON.parse(JSON.stringify(DEFAULTS));
try {
  const raw = localStorage.getItem(SETTINGS_KEY);
  if (raw) { const saved = JSON.parse(raw); S = { ...S, ...saved, pad: { ...S.pad, ...(saved.pad || {}) } }; }
} catch (e) { /* storage not available */ }
function saveSettings() { try { localStorage.setItem(SETTINGS_KEY, JSON.stringify(S)); } catch (e) { /* ignore */ } }

/* ----- Audio graph ----- */
let ctx = null, master = null, pads = null, loops = null;
function audio() {
  if (ctx) return ctx;
  const AC = window.AudioContext || window.webkitAudioContext;
  ctx = new AC();
  master = ctx.createGain();
  master.gain.value = S.master * S.master;
  const comp = ctx.createDynamicsCompressor();
  comp.threshold.value = -8; comp.knee.value = 6; comp.ratio.value = 6; comp.attack.value = 0.003; comp.release.value = 0.25;
  master.connect(comp); comp.connect(ctx.destination);
  pads = new PadEngine(ctx, master);
  pads.setSpace(S.pad.space); pads.setVolume(S.pad.vol);
  loops = new LoopEngine(ctx, master, ST);
  loops.setTarget(S.target); loops.setVolume(S.loopVol);
  if (ctx.addEventListener) ctx.addEventListener("statechange", updatePill);
  return ctx;
}
async function wake() {
  audio();
  if (ctx.state !== "running") { try { await ctx.resume(); } catch (e) { /* blocked until a tap */ } }
  updatePill();
}
function updatePill() {
  const p = $("#audio-pill");
  const on = ctx && ctx.state === "running";
  p.textContent = on ? "Sound on" : "Sound starts on your first tap";
  p.classList.toggle("on", on);
}

/* ----- Loop library (kept in this browser with IndexedDB) ----- */
const DB = {
  db: null,
  async open() {
    try {
      this.db = await new Promise((res, rej) => {
        const r = indexedDB.open("pad-loop-station", 1);
        r.onupgradeneeded = () => r.result.createObjectStore("loops", { keyPath: "id" });
        r.onsuccess = () => res(r.result);
        r.onerror = () => rej(r.error);
      });
    } catch (e) { this.db = null; }
    return !!this.db;
  },
  tx(mode, fn) {
    if (!this.db) return Promise.resolve(null);
    return new Promise((res) => {
      try {
        const t = this.db.transaction("loops", mode), st = t.objectStore("loops");
        const r = fn(st);
        t.oncomplete = () => res(r && r.result !== undefined ? r.result : null);
        t.onerror = () => res(null);
      } catch (e) { res(null); }
    });
  },
  all() { return this.tx("readonly", (s) => s.getAll()); },
  put(rec) { return this.tx("readwrite", (s) => s.put(rec)); },
  del(id) { return this.tx("readwrite", (s) => s.delete(id)); }
};

let lib = [];
const uid = () => (crypto.randomUUID ? crypto.randomUUID() : String(Date.now()) + Math.random().toString(16).slice(2));

function decodeNative(ab) {
  return new Promise((res, rej) => {
    const p = ctx.decodeAudioData(ab, res, rej);
    if (p && p.then) p.then(res, rej);
  });
}

// AIFF / AIFC (uncompressed) reader, resampled to the device rate
async function decodeAiff(ab) {
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

async function decode(ab) {
  try { return await decodeNative(ab.slice(0)); }
  catch (e) {
    const aiff = await decodeAiff(ab);
    if (aiff) return aiff;
    throw e;
  }
}

async function loopFromData(rec) {
  const buf = await decode(rec.data);
  const t = trimLossyPadding(buf, rec.name);
  const len = t.L.length;
  const loop = { id: rec.id, name: rec.name, L: t.L, R: t.R || t.L, len, dur: len / buf.sampleRate, sr: buf.sampleRate };
  if (rec.bpm) { loop.bpm = rec.bpm; loop.how = rec.how || "set by you"; }
  else { const g = guessBpm(rec.name, t.L, buf.sampleRate, loop.dur); loop.bpm = g.bpm; loop.how = g.how; rec.bpm = g.bpm; rec.how = g.how; }
  return loopMeta(loop);
}

const AUDIO_EXT = /\.(mp3|wav|wave|m4a|aac|aif|aiff|aifc|flac|ogg|oga|opus|caf)$/i;
async function addFiles(files) {
  audio();
  if (ctx.state !== "running") ctx.resume().catch(() => {});   // never wait on this: decoding works with sound still off
  const all = [...files].filter((f) => f && !f.name.startsWith("."));
  const list = all.filter((f) => /^audio\//.test(f.type) || AUDIO_EXT.test(f.name));
  if (!list.length) {
    toast(all.length ? "Those aren't audio files. Use MP3, WAV, M4A or AIFF." : "Nothing came through. Drag the files from Finder, or use Add loop files.");
    return;
  }
  toast(`Adding ${list.length} loop${list.length > 1 ? "s" : ""}...`, 60000);
  let added = 0; const failed = [];
  for (const f of list) {
    try {
      const data = await f.arrayBuffer();
      const rec = { id: uid(), name: f.name, data, added: Date.now() };
      const loop = await loopFromData(rec);
      loop.name = f.name.replace(/\.[^.]+$/, "");
      lib = lib.filter((l) => !l.builtin);
      lib.push(loop);
      DB.put(rec);
      if (navigator.storage && navigator.storage.persist) navigator.storage.persist().catch(() => {});
      if (!S.selected || !lib.some((l) => l.id === S.selected)) select(loop.id, true);
      added++;
      renderLoops();
    } catch (e) {
      failed.push(f.name);
    }
  }
  renderLoops(); renderTempo();
  const parts = [];
  if (added) parts.push(`Added ${added} loop${added > 1 ? "s" : ""}.`);
  if (failed.length) parts.push(`Couldn't open ${failed.join(", ")}. Save ${failed.length > 1 ? "them" : "it"} as WAV or MP3 and try again.`);
  toast(parts.join(" "), failed.length ? 9000 : 4000);
}

// Files from a drop, including whole folders. Entries must be read during the drop event itself.
function dropEntries(dt) {
  const entries = [];
  if (dt.items) for (const it of dt.items) {
    if (it.kind !== "file") continue;
    const en = it.webkitGetAsEntry ? it.webkitGetAsEntry() : null;
    if (en) entries.push(en);
  }
  return { entries, files: [...(dt.files || [])] };
}
async function filesFromEntries({ entries, files }) {
  if (!entries.length) return files;
  const out = [];
  const walk = async (en) => {
    if (en.isFile) out.push(await new Promise((res, rej) => en.file(res, rej)));
    else if (en.isDirectory) {
      const reader = en.createReader();
      for (;;) {
        const batch = await new Promise((res, rej) => reader.readEntries(res, rej));
        if (!batch.length) break;
        for (const b of batch) await walk(b);
      }
    }
  };
  for (const en of entries) { try { await walk(en); } catch (e) { /* unreadable item */ } }
  return out.length ? out : files;
}

/* Built-in example so the page works before any files are added */
async function makeDemo() {
  const bpm = 96, beats = 8, sr = ctx.sampleRate;
  const dur = beats * 60 / bpm, len = Math.round(dur * sr);
  const OAC = window.OfflineAudioContext || window.webkitOfflineAudioContext;
  const oc = new OAC(2, len, sr);
  const noise = makeNoise(oc, 1);
  const step = 60 / bpm / 4;
  const env = (g, t, peak, d) => { g.gain.setValueAtTime(peak, t); g.gain.exponentialRampToValueAtTime(0.0008, t + d); };
  const kick = (t) => { const o = oc.createOscillator(), g = oc.createGain(); o.frequency.setValueAtTime(110, t); o.frequency.exponentialRampToValueAtTime(42, t + 0.15); env(g, t, 0.9, 0.4); o.connect(g); g.connect(oc.destination); o.start(t); o.stop(t + 0.45); };
  const hitNoise = (t, type, f, q, peak, d, pan) => {
    const s = oc.createBufferSource(); s.buffer = noise;
    const fl = oc.createBiquadFilter(); fl.type = type; fl.frequency.value = f; fl.Q.value = q;
    const g = oc.createGain(); env(g, t, peak, d);
    s.connect(fl); fl.connect(g);
    if (oc.createStereoPanner) { const p = oc.createStereoPanner(); p.pan.value = pan; g.connect(p); p.connect(oc.destination); } else g.connect(oc.destination);
    s.start(t, Math.random() * 0.5); s.stop(t + d + 0.05);
  };
  const tone = (t, f1, f2, peak, d) => { const o = oc.createOscillator(), g = oc.createGain(); o.type = "triangle"; o.frequency.setValueAtTime(f1, t); o.frequency.exponentialRampToValueAtTime(f2, t + d); env(g, t, peak, d); o.connect(g); g.connect(oc.destination); o.start(t); o.stop(t + d + 0.05); };
  for (let i = 0; i < beats * 4; i++) {
    const t = i * step;
    if ([0, 6, 10, 16, 22, 26].includes(i)) kick(t);
    if (i % 8 === 4) { hitNoise(t, "highpass", 1800, 0.7, 0.32, 0.16, 0); tone(t, 210, 180, 0.2, 0.08); }
    hitNoise(t, "bandpass", 7000, 1.1, i % 4 === 2 ? 0.13 : 0.055, 0.05, 0.35);
    if (i === 14 || i === 30) tone(t, 190, 140, 0.35, 0.25);
    if (i === 15 || i === 31) tone(t, 150, 115, 0.3, 0.25);
  }
  const buf = await oc.startRendering();
  return loopMeta({ id: "demo", name: "Example groove 96 BPM", L: buf.getChannelData(0), R: buf.getChannelData(1), len, dur, sr, bpm, how: "set", builtin: true });
}

function select(id, quiet) {
  S.selected = id; saveSettings();
  const loop = lib.find((l) => l.id === id);
  if (!loop) return;
  if (loops && loops.playing) {
    const r = loops.queue(loop, S.mode);
    if (r === "queued" && !quiet) toast(S.mode === "bar" ? "Switching at the next bar" : "Switching at the end of this loop");
  } else if (loops) { loops.loop = loop; loops.applyRatio(); }
  renderLoops(); renderTempo();
}

function removeLoop(id) {
  const loop = lib.find((l) => l.id === id);
  if (!loop) return;
  if (loops && loops.playing && (loops.loop === loop || (loops.heardState() || {}).loop === loop)) togglePlay(false);
  lib = lib.filter((l) => l !== loop);
  if (loop.builtin) S.hideDemo = true; else DB.del(id);
  if (S.selected === id) S.selected = lib[0] ? lib[0].id : null;
  if (loops) loops.loop = lib.find((l) => l.id === S.selected) || null;
  saveSettings(); renderLoops(); renderTempo();
}

function setLoopBpm(id, v) {
  const loop = lib.find((l) => l.id === id);
  if (!loop || !(v >= 30 && v <= 300)) { renderLoops(); return; }
  loop.bpm = v; loop.how = "set by you"; loopMeta(loop);
  if (!loop.builtin && DB.db) {
    DB.tx("readwrite", (s) => {
      const r = s.get(id);
      r.onsuccess = () => { if (r.result) { r.result.bpm = v; r.result.how = "set by you"; s.put(r.result); } };
      return r;
    });
  }
  if (loops) loops.applyRatio();
  renderLoops(); renderTempo();
}

const fmt = (n) => (Math.abs(n - Math.round(n)) < 0.05 ? String(Math.round(n)) : n.toFixed(1));

function renderLoops() {
  const ul = $("#loop-list");
  ul.textContent = "";
  $("#loop-empty").hidden = lib.length > 0;
  const heard = loops && loops.heardState();
  for (const loop of lib) {
    const li = document.createElement("li");
    li.className = "loop";
    if (loop.id === S.selected) li.setAttribute("aria-current", "true");
    if (loops && loops.pending && loops.pending.loop === loop) li.classList.add("queued");
    if (heard && heard.loop === loop) li.classList.add("heard");
    const pick = document.createElement("button");
    pick.className = "loop-pick";
    pick.innerHTML = '<span class="dot"></span><span class="loop-text"><span class="loop-name"></span><span class="loop-sub"></span></span>';
    pick.querySelector(".loop-name").textContent = loop.name;
    const queued = loops && loops.pending && loops.pending.loop === loop ? " · up next" : "";
    pick.querySelector(".loop-sub").textContent = `${loop.dur.toFixed(1)} s · ${loop.bars} bar${loop.bars > 1 ? "s" : ""} · tempo ${loop.how}${queued}`;
    pick.addEventListener("click", () => select(loop.id));
    const field = document.createElement("label");
    field.className = "bpm-field";
    const inp = document.createElement("input");
    inp.type = "number"; inp.step = "0.1"; inp.min = "30"; inp.max = "300"; inp.value = fmt(loop.bpm);
    inp.id = "bpm-" + loop.id;
    inp.setAttribute("aria-label", `Original tempo of ${loop.name} in BPM`);
    inp.addEventListener("change", () => setLoopBpm(loop.id, parseFloat(inp.value)));
    field.append(inp, document.createTextNode("BPM"));
    const rm = document.createElement("button");
    rm.className = "loop-remove"; rm.textContent = "×";
    rm.setAttribute("aria-label", `Remove ${loop.name}`);
    rm.addEventListener("click", () => removeLoop(loop.id));
    li.append(pick, field, rm);
    ul.append(li);
  }
  $("#play").disabled = !lib.length;
}

/* ----- Transport and tempo ----- */
function togglePlay(force) {
  const want = typeof force === "boolean" ? force : !(loops && loops.playing);
  if (want) {
    const loop = lib.find((l) => l.id === S.selected) || lib[0];
    if (!loop) return;
    wake().then(() => { loops.setTarget(S.target); loops.play(loop); renderLoops(); renderTempo(); tick(); });
  } else if (loops) {
    loops.stop();
  }
  $("#play").setAttribute("aria-pressed", String(want));
  $("#play").textContent = want ? "Stop" : "Play";
  if (!want) { renderLoops(); $("#bar-count").textContent = "Stopped"; $("#progress").style.width = "0"; [...$("#beats").children].forEach((d) => d.className = ""); }
}

function setTarget(v) {
  S.target = Math.round(clamp(v, 40, 200) * 10) / 10;
  saveSettings();
  if (loops) loops.setTarget(S.target);
  renderTempo();
}

function renderTempo() {
  $("#bpm-num").textContent = fmt(S.target);
  $("#tempo").value = S.target;
  const loop = (loops && loops.loop) || lib.find((l) => l.id === S.selected);
  const note = $("#tempo-note");
  if (!loop) { note.textContent = "Add a loop to set its tempo."; note.classList.remove("warn"); return; }
  const raw = S.target / loop.bpm, r = clamp(raw, 0.5, 2);
  if (raw !== r) {
    note.textContent = `Too far from this loop's ${fmt(loop.bpm)} BPM. Playing at ${fmt(loop.bpm * r)} BPM, the limit.`;
    note.classList.add("warn");
  } else {
    const pct = Math.round(r * 100);
    note.textContent = `Loop's own tempo ${fmt(loop.bpm)} BPM · playing at ${pct}% speed` + (Math.abs(pct - 100) > 25 ? " (sounds best within about 20%)" : "");
    note.classList.toggle("warn", Math.abs(pct - 100) > 25);
  }
}

let taps = [];
function tap() {
  const now = performance.now();
  taps = taps.filter((t) => now - t < 2500);
  taps.push(now);
  if (taps.length >= 2) {
    const gaps = taps.slice(1).map((t, i) => t - taps[i]);
    const avg = gaps.reduce((a, b) => a + b, 0) / gaps.length;
    setTarget(Math.round(60000 / avg));
  }
}

let raf = 0, lastHeardId = null;
function tick() {
  cancelAnimationFrame(raf);
  if (!loops || !loops.playing) return;
  const h = loops.heardState();
  if (h) {
    const beatLen = h.loop.len / h.loop.beats;
    const beat = Math.floor(h.pos / beatLen);
    const inBar = beat % 4, bar = Math.floor(beat / 4) + 1;
    [...$("#beats").children].forEach((d, i) => { d.className = i === inBar ? (i === 0 ? "lit one" : "lit") : ""; });
    $("#bar-count").textContent = `Bar ${Math.min(bar, h.loop.bars)} of ${h.loop.bars}`;
    $("#progress").style.width = (h.pos / h.loop.len * 100).toFixed(1) + "%";
    if (h.loop.id !== lastHeardId) {
      lastHeardId = h.loop.id;
      if (S.selected !== h.loop.id && !loops.pending) { S.selected = h.loop.id; saveSettings(); }
      renderLoops(); renderTempo();
    }
  }
  raf = requestAnimationFrame(tick);
}

/* ----- Pads ----- */
function renderPadControls() {
  const keys = $("#keys");
  const alts = { Db: "C#", Eb: "D#", "F#": "Gb", Ab: "G#", Bb: "A#" };
  keys.textContent = "";
  KEYS.forEach((k, i) => {
    const b = document.createElement("button");
    b.className = "key"; b.dataset.key = i;
    b.setAttribute("aria-pressed", "false");
    b.setAttribute("aria-label", `Pad in ${k}`);
    b.innerHTML = '<span class="main"></span><span class="alt"></span>';
    b.querySelector(".main").textContent = k;
    b.querySelector(".alt").textContent = alts[k] || "";
    b.addEventListener("click", () => playPad(i));
    keys.append(b);
  });
  const seg = (el, items, cur, onPick) => {
    el.textContent = "";
    Object.entries(items).forEach(([id, label]) => {
      const b = document.createElement("button");
      b.textContent = typeof label === "string" ? label : label.label;
      b.dataset.id = id;
      b.setAttribute("aria-pressed", String(id === cur));
      b.addEventListener("click", () => { [...el.children].forEach((c) => c.setAttribute("aria-pressed", String(c === b))); onPick(id); });
      el.append(b);
    });
  };
  seg($("#style"), STYLES, S.pad.style, (id) => { S.pad.style = id; saveSettings(); refreshPad(); });
  seg($("#voicing"), VOICINGS, S.pad.voicing, (id) => { S.pad.voicing = id; saveSettings(); refreshPad(); });
}

async function playPad(i) {
  await wake();
  const cur = pads.current;
  if (cur && cur.key === i && cur.style === S.pad.style && cur.voicing === S.pad.voicing) { stopPad(); return; }
  pads.play(i, S.pad.style, S.pad.voicing, S.pad.tone, S.pad.fade);
  renderPadState();
}
function refreshPad() {
  if (pads && pads.current) pads.play(pads.current.key, S.pad.style, S.pad.voicing, S.pad.tone, Math.min(S.pad.fade, 2.5));
  renderPadState();
}
function stopPad() { if (pads) pads.stopNow(); renderPadState(); }
function renderPadState() {
  const cur = pads && pads.current;
  [...$("#keys").children].forEach((b) => b.setAttribute("aria-pressed", String(!!cur && Number(b.dataset.key) === cur.key)));
  $("#pad-status").innerHTML = cur
    ? `Playing <strong></strong>`
    : "Pad is off";
  if (cur) $("#pad-status strong").textContent = `${KEYS[cur.key]} · ${STYLES[cur.style]} · ${VOICINGS[cur.voicing].label}`;
}

/* ----- Small helpers ----- */
function applyTheme() {
  document.documentElement.dataset.theme = S.invert ? "light" : "dark";
  const m = document.querySelector('meta[name="theme-color"]');
  if (m) m.content = S.invert ? "#f7f7f7" : "#0b0b0b";
}
let toastTimer = 0;
function toast(msg, ms) {
  const n = $("#toast");
  n.textContent = msg; n.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { n.hidden = true; }, ms || 3500);
}
function bindSlider(id, get, set, show) {
  const el = $("#" + id), out = $("#" + id + "-out");
  el.value = get();
  out.textContent = show(get());
  el.addEventListener("input", () => { const v = parseFloat(el.value); set(v); out.textContent = show(v); saveSettings(); });
}

/* ----- Start up ----- */
async function init() {
  applyTheme();
  renderPadControls();
  renderPadState();
  [...$("#mode").children].forEach((b) => {
    b.setAttribute("aria-pressed", String(b.dataset.mode === S.mode));
    b.addEventListener("click", () => { S.mode = b.dataset.mode; saveSettings(); [...$("#mode").children].forEach((c) => c.setAttribute("aria-pressed", String(c === b))); });
  });
  bindSlider("master", () => S.master, (v) => { S.master = v; if (master) master.gain.setTargetAtTime(v * v, ctx.currentTime, 0.03); }, (v) => Math.round(v * 100));
  bindSlider("loop-vol", () => S.loopVol, (v) => { S.loopVol = v; if (loops) loops.setVolume(v); }, (v) => Math.round(v * 100) + "%");
  bindSlider("tone", () => S.pad.tone, (v) => { S.pad.tone = v; if (pads) pads.setTone(v); }, (v) => (v < 0.34 ? "Dark" : v < 0.67 ? "Warm" : "Bright"));
  bindSlider("fade", () => S.pad.fade, (v) => { S.pad.fade = v; }, (v) => v.toFixed(1) + " s");
  bindSlider("space", () => S.pad.space, (v) => { S.pad.space = v; if (pads) pads.setSpace(v); }, (v) => Math.round(v * 100) + "%");
  bindSlider("pad-vol", () => S.pad.vol, (v) => { S.pad.vol = v; if (pads) pads.setVolume(v); }, (v) => Math.round(v * 100) + "%");

  $("#tempo").addEventListener("input", (e) => setTarget(parseFloat(e.target.value)));
  $("#tempo-down").addEventListener("click", () => setTarget(Math.round(S.target) - 1));
  $("#tempo-up").addEventListener("click", () => setTarget(Math.round(S.target) + 1));
  $("#tap").addEventListener("click", tap);
  $("#tempo-reset").addEventListener("click", () => {
    const loop = (loops && loops.loop) || lib.find((l) => l.id === S.selected);
    if (loop) setTarget(loop.bpm);
  });
  $("#play").addEventListener("click", () => togglePlay());
  const inv = $("#invert");
  inv.setAttribute("aria-pressed", String(!!S.invert));
  inv.addEventListener("click", () => { S.invert = !S.invert; saveSettings(); applyTheme(); inv.setAttribute("aria-pressed", String(S.invert)); });
  $("#stop-pads").addEventListener("click", stopPad);
  $("#file-in").addEventListener("change", (e) => { addFiles(e.target.files); e.target.value = ""; });
  const overlay = $("#drop-overlay");
  let dragDepth = 0;
  const hasFiles = (e) => e.dataTransfer && [...(e.dataTransfer.types || [])].includes("Files");
  window.addEventListener("dragenter", (e) => { if (!hasFiles(e)) return; e.preventDefault(); dragDepth++; overlay.hidden = false; });
  window.addEventListener("dragover", (e) => { if (!hasFiles(e)) return; e.preventDefault(); e.dataTransfer.dropEffect = "copy"; overlay.hidden = false; });
  window.addEventListener("dragleave", (e) => { if (!hasFiles(e)) return; dragDepth = Math.max(0, dragDepth - 1); if (!dragDepth) overlay.hidden = true; });
  window.addEventListener("drop", (e) => {
    e.preventDefault(); dragDepth = 0; overlay.hidden = true;
    if (!e.dataTransfer) return;
    const got = dropEntries(e.dataTransfer);
    filesFromEntries(got).then(addFiles);
  });
  document.addEventListener("keydown", (e) => {
    const tag = (e.target.tagName || "").toLowerCase();
    if (tag === "input" || tag === "textarea" || tag === "select") return;
    if (e.code === "Space") { e.preventDefault(); if (!e.repeat && lib.length) togglePlay(); }
    if (e.key === "Escape") stopPad();
  });
  // Stop Space from also clicking whichever button has focus
  document.addEventListener("keyup", (e) => {
    const tag = (e.target.tagName || "").toLowerCase();
    if (e.code === "Space" && tag === "button") e.preventDefault();
  });
  document.addEventListener("visibilitychange", () => { if (!document.hidden && loops && loops.playing) tick(); });

  audio();
  updatePill();
  renderTempo();
  if (await DB.open()) {
    const recs = (await DB.all()) || [];
    recs.sort((a, b) => (a.added || 0) - (b.added || 0));
    for (const rec of recs) {
      try { const loop = await loopFromData(rec); loop.name = rec.name.replace(/\.[^.]+$/, ""); lib.push(loop); } catch (e) { /* skip unreadable file */ }
    }
  }
  // The example groove only shows until you add loops of your own
  if (!lib.length && !S.hideDemo) { try { lib.push(await makeDemo()); } catch (e) { /* example could not be made */ } }
  if (!lib.some((l) => l.id === S.selected)) S.selected = lib[0] ? lib[0].id : null;
  if (loops) loops.loop = lib.find((l) => l.id === S.selected) || null;
  if (loops) loops.applyRatio();
  renderLoops();
  renderTempo();
}
init();

/* ----- Installable web app: works offline once opened ----- */
if ("serviceWorker" in navigator && /^https?:$/.test(location.protocol)) {
  const hadController = !!navigator.serviceWorker.controller;
  navigator.serviceWorker.addEventListener("controllerchange", () => {
    if (hadController) toast("Update installed. Close and reopen the app to use it.", 10000);
  });
  window.addEventListener("load", () => navigator.serviceWorker.register("sw.js").catch(() => {}));
}
let installEvt = null;
window.addEventListener("beforeinstallprompt", (e) => {
  e.preventDefault(); installEvt = e;
  $("#install").hidden = false;
});
$("#install").addEventListener("click", async () => {
  if (!installEvt) return;
  installEvt.prompt();
  try { await installEvt.userChoice; } catch (e) { /* closed */ }
  installEvt = null; $("#install").hidden = true;
});
window.addEventListener("appinstalled", () => { $("#install").hidden = true; });
