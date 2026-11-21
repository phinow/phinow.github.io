/* ===== Page wiring ===== */
const $ = (s) => document.querySelector(s);
const SETTINGS_KEY = "pad-loop-station:v1";
const DEFAULTS = {
  target: 96, mode: "bar", loopVol: 0.85, master: 0.9, selected: null, invert: false,
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

let hideOverlay = () => {};

// Files from a drop, including whole folders. Entries must be read during the drop event itself.
function dropEntries(dt) {
  const entries = [];
  if (dt && dt.items) for (const it of dt.items) {
    if (it.kind !== "file") continue;
    const en = it.webkitGetAsEntry ? it.webkitGetAsEntry() : null;
    if (en) entries.push(en);
  }
  return { entries, files: [...((dt && dt.files) || [])] };
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

/* ----- Loop slots: labelled places for loops, grouped into Worship and Praise ----- */
const GROUPS = [{ id: "worship", name: "Worship" }, { id: "praise", name: "Praise" }, { id: "more", name: "More" }];
const DEFAULT_SLOTS = [
  { id: "w1", group: "worship", label: "3/4", bpb: 3 },
  { id: "w2", group: "worship", label: "4/4", bpb: 4 },
  { id: "w3", group: "worship", label: "Finger snap", bpb: 4 },
  { id: "p1", group: "praise", label: "Woro", bpb: 4 },
  { id: "p2", group: "praise", label: "Highlife", bpb: 4 },
  { id: "p3", group: "praise", label: "Praise", bpb: 4 },
  { id: "x1", group: "more", label: "Extra 1", bpb: 4 },
  { id: "x2", group: "more", label: "Extra 2", bpb: 4 },
  { id: "x3", group: "more", label: "Extra 3", bpb: 4 }
];
const LONG_FILE = 30;   // seconds; longer files go through the trimmer
if (!Array.isArray(S.slots)) S.slots = DEFAULT_SLOTS.map((s) => ({ ...s, loopId: null }));
// A third row of spare slots, so the loops make a 3 by 3 box
if (!S.slots.some((s) => s.group === "more")) S.slots.push(...DEFAULT_SLOTS.filter((s) => s.group === "more").map((s) => ({ ...s, loopId: null })));

const slotById = (id) => S.slots.find((s) => s.id === id);
const loopById = (id) => lib.find((l) => l.id === id);
const loopOf = (slot) => (slot && slot.loopId ? loopById(slot.loopId) : null);
const slotOfLoop = (loop) => (loop ? S.slots.find((s) => s.loopId === loop.id) : null);
const orderedSlots = () => GROUPS.flatMap((g) => S.slots.filter((s) => s.group === g.id));
const displayName = (n) => n.replace(/\.[^.]+$/, "");
const bpbFromLabel = (label) => (/\b3\s*\/\s*4\b|\b6\s*\/\s*8\b|waltz/i.test(label) ? 3 : 4);

function loopFromBuffer(rec, buf) {
  let L, R;
  if (rec.exact) { L = buf.getChannelData(0).slice(); R = buf.numberOfChannels > 1 ? buf.getChannelData(1).slice() : null; }
  else { const t = trimLossyPadding(buf, rec.name); L = t.L; R = t.R; }
  const loop = { id: rec.id, name: displayName(rec.name), L, R: R || L, len: L.length, dur: L.length / buf.sampleRate, sr: buf.sampleRate, bpb: rec.bpb || 4 };
  if (rec.bpm) { loop.bpm = rec.bpm; loop.how = rec.how || "set by you"; }
  else { const g = guessBpm(rec.name, L, buf.sampleRate, loop.dur, loop.bpb); loop.bpm = g.bpm; loop.how = g.how; rec.bpm = g.bpm; rec.how = g.how; }
  return loopMeta(loop);
}
async function loopFromData(rec) { return loopFromBuffer(rec, await decode(rec.data)); }

// 16-bit WAV of just the chosen part, so a long file is stored as one small loop
function encodeWav(buf, startSec, endSec) {
  const sr = buf.sampleRate, ch = Math.min(2, buf.numberOfChannels);
  const a = Math.max(0, Math.round(startSec * sr)), b = Math.min(buf.length, Math.round(endSec * sr)), n = b - a;
  const out = new ArrayBuffer(44 + n * ch * 2), v = new DataView(out);
  const w = (o, s) => { for (let i = 0; i < s.length; i++) v.setUint8(o + i, s.charCodeAt(i)); };
  w(0, "RIFF"); v.setUint32(4, 36 + n * ch * 2, true); w(8, "WAVE"); w(12, "fmt ");
  v.setUint32(16, 16, true); v.setUint16(20, 1, true); v.setUint16(22, ch, true); v.setUint32(24, sr, true);
  v.setUint32(28, sr * ch * 2, true); v.setUint16(32, ch * 2, true); v.setUint16(34, 16, true);
  w(36, "data"); v.setUint32(40, n * ch * 2, true);
  const chans = []; for (let c = 0; c < ch; c++) chans.push(buf.getChannelData(c));
  const fadeIn = Math.round(sr * 0.0005), fadeOut = Math.round(sr * 0.002);
  let p = 44;
  for (let i = 0; i < n; i++) {
    const g = Math.min(1, i < fadeIn ? i / fadeIn : 1, n - 1 - i < fadeOut ? (n - 1 - i) / fadeOut : 1);
    for (let c = 0; c < ch; c++) {
      const x = Math.max(-1, Math.min(1, chans[c][a + i] * g));
      v.setInt16(p, x < 0 ? x * 32768 : x * 32767, true); p += 2;
    }
  }
  return out;
}

function bufferFromLoop(loop) {
  const buf = ctx.createBuffer(2, loop.len, loop.sr);
  buf.copyToChannel(loop.L, 0); buf.copyToChannel(loop.R, 1);
  return buf;
}

function newSlot(group, label) {
  const slot = { id: uid(), group, label: label || "New loop", bpb: bpbFromLabel(label || ""), loopId: null };
  S.slots.push(slot); saveSettings();
  return slot;
}

const AUDIO_EXT = /\.(mp3|wav|wave|m4a|aac|aif|aiff|aifc|flac|ogg|oga|opus|caf)$/i;

// Put files into slots: the first into slotId (if given), the rest into empty slots in order
async function addFiles(files, slotId) {
  audio();
  if (ctx.state !== "running") ctx.resume().catch(() => {});   // never wait on this: decoding works with sound still off
  const all = [...files].filter((f) => f && !f.name.startsWith("."));
  const list = all.filter((f) => /^audio\//.test(f.type) || AUDIO_EXT.test(f.name));
  if (!list.length) {
    toast(all.length ? "Those aren't audio files. Use MP3, WAV, M4A or AIFF." : "Nothing came through. Drag the files from Finder, or use Add loop files.");
    return;
  }
  let added = 0; const failed = [];
  let lastGroup = (slotById(slotId) || slotById(S.selected) || { group: "worship" }).group;
  for (let i = 0; i < list.length; i++) {
    const f = list[i];
    let slot = i === 0 && slotId ? slotById(slotId) : orderedSlots().find((s) => !s.loopId);
    if (!slot) slot = newSlot(lastGroup, displayName(f.name));
    lastGroup = slot.group;
    toast(`Opening ${f.name}...`, 60000);
    try {
      const r = await loadIntoSlot(f, slot);
      if (r === "added") added++;
    } catch (e) { failed.push(f.name); }
  }
  renderSlots(); renderTempo();
  const parts = [];
  if (added) parts.push(`Added ${added} loop${added > 1 ? "s" : ""}.`);
  if (failed.length) parts.push(`Couldn't open ${failed.join(", ")}. Save ${failed.length > 1 ? "them" : "it"} as WAV or MP3 and try again.`);
  if (parts.length) toast(parts.join(" "), failed.length ? 9000 : 4000); else $("#toast").hidden = true;
}

async function loadIntoSlot(file, slot) {
  const data = await file.arrayBuffer();
  const buf = await decode(data);
  let rec;
  if (buf.duration > LONG_FILE) {
    $("#toast").hidden = true;
    const pick = await openTrimmer({ name: file.name, buffer: buf, bpb: slot.bpb || 4, label: slot.label });
    if (!pick) return "cancelled";
    rec = { id: uid(), name: file.name, data: encodeWav(buf, pick.start, pick.end), added: Date.now(), bpm: pick.bpm, how: "set when trimmed", exact: true, bpb: pick.bpb };
  } else {
    rec = { id: uid(), name: file.name, data, added: Date.now(), bpb: slot.bpb || 4 };
  }
  const loop = rec.exact ? await loopFromData(rec) : loopFromBuffer(rec, buf);
  placeLoop(slot, loop, rec);
  return "added";
}

function placeLoop(slot, loop, rec) {
  const old = loopOf(slot);
  lib.push(loop);
  slot.loopId = loop.id;
  DB.put(rec);
  if (navigator.storage && navigator.storage.persist) navigator.storage.persist().catch(() => {});
  if (old) {
    if (loops && loops.playing && (loops.loop === old || (loops.pending && loops.pending.loop === old))) loops.queue(loop, S.mode === "now" ? "now" : "loop");
    lib = lib.filter((l) => l !== old);
    if (old.id !== rec.id) DB.del(old.id);
  }
  if (!loopOf(slotById(S.selected))) S.selected = slot.id;
  if (S.selected === slot.id && loops && !loops.playing) { loops.loop = loop; loops.applyRatio(); }
  saveSettings();
}

async function trimSlot(slot) {
  const loop = loopOf(slot);
  if (!loop) return;
  audio();
  const pick = await openTrimmer({ name: loop.name, buffer: bufferFromLoop(loop), bpb: loop.bpb, bpm: loop.bpm, label: slot.label });
  if (!pick) return;
  const rec = { id: uid(), name: loop.name + ".wav", data: encodeWav(bufferFromLoop(loop), pick.start, pick.end), added: Date.now(), bpm: pick.bpm, how: "set when trimmed", exact: true, bpb: pick.bpb };
  const fresh = await loopFromData(rec);
  fresh.name = loop.name;
  placeLoop(slot, fresh, rec);
  renderSlots(); renderTempo();
  toast("Loop trimmed.");
}

function select(slotId, quiet) {
  const slot = slotById(slotId);
  if (!slot) return;
  const loop = loopOf(slot);
  if (!loop) { pickFileFor(slot.id); return; }
  S.selected = slot.id; saveSettings();
  if (loops && loops.playing) {
    const r = loops.queue(loop, S.mode);
    if (r === "queued" && !quiet) toast(S.mode === "bar" ? `${slot.label}: starts at the next bar` : `${slot.label}: starts at the end of this loop`);
  } else if (loops) { loops.loop = loop; loops.applyRatio(); }
  renderSlots(); renderTempo();
}

function clearSlot(slotId) {
  const slot = slotById(slotId), loop = loopOf(slot);
  if (!slot) return;
  if (!loop) {   // an empty slot: remove the slot itself
    S.slots = S.slots.filter((s) => s !== slot);
    if (S.selected === slot.id) S.selected = (orderedSlots().find((s) => s.loopId) || {}).id || null;
    saveSettings(); renderSlots(); return;
  }
  const heard = loops && loops.heardState();
  if (loops && loops.playing && (loops.loop === loop || (heard && heard.loop === loop))) togglePlay(false);
  if (loops && loops.pending && loops.pending.loop === loop) loops.pending = null;
  lib = lib.filter((l) => l !== loop);
  DB.del(loop.id);
  slot.loopId = null;
  if (S.selected === slot.id) {
    const next = orderedSlots().find((s) => s.loopId);
    if (next) S.selected = next.id;
  }
  if (loops && !loops.playing) loops.loop = loopOf(slotById(S.selected));
  saveSettings(); renderSlots(); renderTempo();
}

function setLoopBpm(loop, v) {
  if (!loop || !(v >= 30 && v <= 300)) { renderSlots(); return; }
  loop.bpm = v; loop.how = "set by you"; loopMeta(loop);
  if (DB.db) {
    DB.tx("readwrite", (s) => {
      const r = s.get(loop.id);
      r.onsuccess = () => { if (r.result) { r.result.bpm = v; r.result.how = "set by you"; s.put(r.result); } };
      return r;
    });
  }
  if (loops) loops.applyRatio();
  renderSlots(); renderTempo();
}

const fmt = (n) => (Math.abs(n - Math.round(n)) < 0.05 ? String(Math.round(n)) : n.toFixed(1));

let pickSlot = null;
function pickFileFor(slotId) { pickSlot = slotId; $("#slot-file-in").click(); }

function renderSlots() {
  closeMenu();
  const wrap = $("#slots");
  wrap.textContent = "";
  const heard = loops && loops.heardState();
  const order = orderedSlots();
  for (const g of GROUPS) {
    const list = S.slots.filter((s) => s.group === g.id);
    if (!list.length) continue;
    const row = document.createElement("section");
    row.className = "group-row";
    row.setAttribute("aria-label", g.name + " loops");
    const h = document.createElement("h3");
    h.textContent = g.name;
    h.style.gridRow = `1 / span ${Math.ceil(list.length / 3)}`;
    row.append(h);
    for (const slot of list) row.append(slotCard(slot, order.indexOf(slot) + 1, heard));
    wrap.append(row);
  }
  $("#play").disabled = !lib.length;
  const head = $("#add-slot-wrap");
  if (head && !head.querySelector("form")) { head.textContent = ""; head.append(addSlotButton(GROUPS[2])); }
}

function slotCard(slot, num, heard) {
  const loop = loopOf(slot);
  const li = document.createElement("div");
  li.className = "slot" + (loop ? "" : " empty");
  li.dataset.slot = slot.id;
  if (loop && slot.id === S.selected) li.setAttribute("aria-current", "true");
  if (loop && loops && loops.pending && loops.pending.loop === loop) li.classList.add("queued");
  if (loop && heard && heard.loop === loop) li.classList.add("heard");

  const main = document.createElement("button");
  main.className = "slot-main";
  main.innerHTML = '<span class="slot-top"><span class="slot-num"></span><span class="slot-label"></span></span><span class="slot-file"></span><span class="slot-meta"></span>';
  main.querySelector(".slot-num").textContent = num <= 9 ? num : "";
  main.querySelector(".slot-label").textContent = slot.label;
  if (loop) {
    const queued = loops && loops.pending && loops.pending.loop === loop ? " · up next" : "";
    main.querySelector(".slot-file").textContent = loop.name;
    main.querySelector(".slot-meta").textContent = `${fmt(loop.bpm)} BPM · ${loop.bars} bar${loop.bars > 1 ? "s" : ""} of ${loop.bpb}/4${queued}`;
    main.title = `${loop.name}: ${loop.dur.toFixed(1)} s, tempo ${loop.how}`;
    main.setAttribute("aria-label", `${slot.label}: ${loop.name}, ${fmt(loop.bpm)} BPM`);
  } else {
    main.querySelector(".slot-file").textContent = "Empty";
    main.querySelector(".slot-meta").textContent = "Drop a file, or tap";
    main.setAttribute("aria-label", `Choose a file for ${slot.label}`);
  }
  main.addEventListener("click", () => select(slot.id));

  const more = document.createElement("button");
  more.className = "more"; more.textContent = "•••";
  more.setAttribute("aria-label", `Options for ${slot.label}`);
  more.setAttribute("aria-expanded", "false");
  more.addEventListener("click", (e) => { e.stopPropagation(); openMenu(li, slot, more); });
  li.append(main, more);

  // Drop a file straight onto this slot
  li.addEventListener("dragover", (e) => { if (e.dataTransfer && [...e.dataTransfer.types].includes("Files")) { e.preventDefault(); li.classList.add("over"); } });
  li.addEventListener("dragleave", () => li.classList.remove("over"));
  li.addEventListener("drop", (e) => {
    e.preventDefault(); e.stopPropagation(); li.classList.remove("over");
    hideOverlay();
    const got = dropEntries(e.dataTransfer);
    filesFromEntries(got).then((files) => addFiles(files, slot.id));
  });
  return li;
}

let openMenuEl = null;
function closeMenu() {
  if (!openMenuEl) return;
  const btn = openMenuEl.parentElement && openMenuEl.parentElement.querySelector(".more");
  if (btn) btn.setAttribute("aria-expanded", "false");
  openMenuEl.remove(); openMenuEl = null;
}
function openMenu(li, slot, btn) {
  const was = openMenuEl && openMenuEl.parentElement === li;
  closeMenu();
  if (was) return;
  const loop = loopOf(slot);
  const m = document.createElement("div");
  m.className = "menu";
  m.setAttribute("role", "menu");
  m.addEventListener("click", (e) => e.stopPropagation());
  if (loop) {
    const field = document.createElement("label");
    field.className = "bpm-field";
    const inp = document.createElement("input");
    inp.type = "number"; inp.step = "0.1"; inp.min = "30"; inp.max = "300"; inp.value = fmt(loop.bpm);
    inp.id = "bpm-" + slot.id;
    inp.addEventListener("change", () => setLoopBpm(loop, parseFloat(inp.value)));
    inp.addEventListener("keydown", (e) => { if (e.key === "Enter") inp.blur(); });
    field.append(document.createTextNode("Own tempo"), inp);
    m.append(field);
    m.append(toolBtn("Trim", `Trim ${slot.label}`, () => { closeMenu(); trimSlot(slot); }));
    m.append(toolBtn("Replace file", `Replace the file in ${slot.label}`, () => { closeMenu(); pickFileFor(slot.id); }));
  }
  m.append(toolBtn("Rename", `Rename ${slot.label}`, () => { closeMenu(); renameSlot(li, slot); }));
  m.append(toolBtn(loop ? "Clear this slot" : "Remove this slot", loop ? `Clear ${slot.label}` : `Remove the ${slot.label} slot`, () => { closeMenu(); clearSlot(slot.id); }));
  li.append(m);
  openMenuEl = m;
  btn.setAttribute("aria-expanded", "true");
  const first = m.querySelector("input, button"); if (first) first.focus();
}
document.addEventListener("click", closeMenu);
document.addEventListener("keydown", (e) => { if (e.key === "Escape" && openMenuEl) { e.stopPropagation(); closeMenu(); } }, true);

function toolBtn(text, label, fn) {
  const b = document.createElement("button");
  b.className = "tool"; b.textContent = text;
  b.setAttribute("aria-label", label);
  b.addEventListener("click", fn);
  return b;
}

function renameSlot(li, slot) {
  const main = li.querySelector(".slot-main");
  const form = document.createElement("form");
  form.className = "rename";
  const inp = document.createElement("input");
  inp.value = slot.label; inp.maxLength = 24; inp.id = "rename-" + slot.id;
  inp.setAttribute("aria-label", "Slot name");
  const ok = document.createElement("button"); ok.className = "tool"; ok.textContent = "Save"; ok.type = "submit";
  form.append(inp, ok);
  form.addEventListener("submit", (e) => {
    e.preventDefault();
    const v = inp.value.trim();
    if (v) { slot.label = v; if (!loopOf(slot)) slot.bpb = bpbFromLabel(v); saveSettings(); }
    renderSlots();
  });
  inp.addEventListener("keydown", (e) => { if (e.key === "Escape") { e.stopPropagation(); renderSlots(); } });
  main.replaceWith(form);
  const more = li.querySelector(".more"); if (more) more.hidden = true;
  inp.focus(); inp.select();
}

function addSlotButton(g) {
  const btn = document.createElement("button");
  btn.className = "tool add"; btn.textContent = "+ Slot";
  btn.setAttribute("aria-label", "Add another loop slot");
  btn.addEventListener("click", () => {
    const form = document.createElement("form");
    form.className = "rename";
    const inp = document.createElement("input");
    inp.placeholder = "Name, like Makossa";
    inp.maxLength = 24; inp.id = "new-" + g.id;
    inp.setAttribute("aria-label", `Name for the new ${g.name.toLowerCase()} loop`);
    const ok = document.createElement("button"); ok.className = "tool"; ok.textContent = "Add"; ok.type = "submit";
    form.append(inp, ok);
    const done = () => { form.replaceWith(addSlotButton(g)); renderSlots(); };
    form.addEventListener("submit", (e) => { e.preventDefault(); const v = inp.value.trim(); if (v) newSlot(g.id, v); done(); });
    inp.addEventListener("keydown", (e) => { if (e.key === "Escape") { e.stopPropagation(); done(); } });
    btn.replaceWith(form);
    inp.focus();
  });
  return btn;
}

/* ----- Trimmer: keep one loop's worth of a long file ----- */
function openTrimmer({ name, buffer, bpb, bpm, label }) {
  return new Promise((resolve) => {
    const dlg = $("#trimmer");
    const sr = buffer.sampleRate, dur = buffer.duration;
    const mono = buffer.getChannelData(0);
    const hits = onsetTimes(mono, sr);
    const st = {
      bpb: bpb || 4,
      bpm: bpm || guessBpm(name, mono.subarray(0, Math.min(mono.length, sr * 30)), sr, 0, bpb || 4).bpm,
      bars: 4,
      start: 0
    };
    const len = () => st.bars * st.bpb * 60 / st.bpm;
    const fit = () => { while (st.bars > 1 && len() > dur) st.bars /= 2; st.start = clamp(st.start, 0, Math.max(0, dur - len())); };
    st.start = hits.find((t) => t < dur) || 0;
    fit();
    const snap = (t) => {
      let best = t, bd = 0.12;
      for (const h of hits) { const d = Math.abs(h - t); if (d < bd) { bd = d; best = h; } }
      return best;
    };

    $("#trim-title").textContent = label ? `Trim for ${label}` : "Trim loop";
    $("#trim-name").textContent = `${displayName(name)} is ${Math.floor(dur / 60)}:${String(Math.floor(dur % 60)).padStart(2, "0")} long. Keep one loop of it so it opens fast and takes little space.`;
    const bpmIn = $("#trim-bpm"); bpmIn.value = fmt(st.bpm);
    const canvas = $("#trim-wave");

    let preview = null;
    const stopPreview = () => { if (preview) { try { preview.stop(); } catch (e) { /* done */ } preview = null; } $("#trim-play").textContent = "Preview"; };
    const startPreview = () => {
      stopPreview();
      audio(); ctx.resume().catch(() => {});
      const s = ctx.createBufferSource(); s.buffer = buffer; s.loop = true;
      s.loopStart = st.start; s.loopEnd = st.start + len();
      const g = ctx.createGain(); g.gain.value = 0.9; s.connect(g); g.connect(master);
      s.start(0, st.start); preview = s;
      $("#trim-play").textContent = "Stop preview";
    };

    const draw = () => {
      const dpr = window.devicePixelRatio || 1, w = canvas.clientWidth, h = canvas.clientHeight;
      canvas.width = Math.round(w * dpr); canvas.height = Math.round(h * dpr);
      const c = canvas.getContext("2d"); c.scale(dpr, dpr);
      const css = getComputedStyle(document.documentElement);
      const ink = css.getPropertyValue("--ink").trim(), muted = css.getPropertyValue("--muted").trim(), line = css.getPropertyValue("--line").trim();
      c.clearRect(0, 0, w, h);
      const x0 = st.start / dur * w, x1 = (st.start + len()) / dur * w;
      c.fillStyle = line; c.fillRect(x0, 0, Math.max(2, x1 - x0), h);
      const step = mono.length / w;
      for (let x = 0; x < w; x++) {
        let m = 0; const a = Math.floor(x * step), b = Math.min(mono.length, Math.floor((x + 1) * step));
        for (let i = a; i < b; i += 4) { const v = Math.abs(mono[i]); if (v > m) m = v; }
        const bh = Math.max(1, m * (h - 8));
        c.fillStyle = x >= x0 && x <= x1 ? ink : muted;
        c.fillRect(x, (h - bh) / 2, 1, bh);
      }
      c.fillStyle = ink; c.fillRect(x0, 0, 2, h); c.fillRect(Math.min(w - 2, x1), 0, 2, h);
      const mins = Math.floor(st.start / 60), secs = (st.start % 60).toFixed(2).padStart(5, "0");
      $("#trim-start").textContent = `${mins}:${secs}`;
      const kb = Math.round(len() * sr * Math.min(2, buffer.numberOfChannels) * 2 / 1024);
      $("#trim-info").textContent = `${st.bars} bar${st.bars > 1 ? "s" : ""} of ${st.bpb}/4 = ${len().toFixed(1)} s · saves about ${kb > 1024 ? (kb / 1024).toFixed(1) + " MB" : kb + " KB"}`;
      [...$("#trim-bars").children].forEach((b) => b.setAttribute("aria-pressed", String(Number(b.dataset.bars) === st.bars)));
      [...$("#trim-bpb").children].forEach((b) => b.setAttribute("aria-pressed", String(Number(b.dataset.bpb) === st.bpb)));
      if (preview) { preview.loopStart = st.start; preview.loopEnd = st.start + len(); }
    };
    const update = () => { fit(); draw(); };

    const ctl = new AbortController(), on = (el, ev, fn, cap) => el.addEventListener(ev, fn, { signal: ctl.signal, capture: !!cap });
    const close = (result) => { stopPreview(); ctl.abort(); dlg.hidden = true; resolve(result); };
    on(bpmIn, "change", () => { const v = parseFloat(bpmIn.value); if (v >= 30 && v <= 300) st.bpm = v; bpmIn.value = fmt(st.bpm); update(); });
    [...$("#trim-bars").children].forEach((b) => on(b, "click", () => { st.bars = Number(b.dataset.bars); update(); }));
    [...$("#trim-bpb").children].forEach((b) => on(b, "click", () => { st.bpb = Number(b.dataset.bpb); update(); }));
    const beat = () => 60 / st.bpm;
    on($("#trim-back-beat"), "click", () => { st.start -= beat(); update(); });
    on($("#trim-fwd-beat"), "click", () => { st.start += beat(); update(); });
    on($("#trim-back"), "click", () => { st.start -= 0.01; update(); });
    on($("#trim-fwd"), "click", () => { st.start += 0.01; update(); });
    let dragging = false;
    const at = (e) => { const r = canvas.getBoundingClientRect(); return clamp((e.clientX - r.left) / r.width, 0, 1) * dur; };
    on(canvas, "pointerdown", (e) => { dragging = true; canvas.setPointerCapture(e.pointerId); st.start = at(e); update(); });
    on(canvas, "pointermove", (e) => { if (dragging) { st.start = at(e); update(); } });
    on(canvas, "pointerup", () => { if (dragging) { dragging = false; st.start = snap(st.start); update(); } });
    on($("#trim-play"), "click", () => (preview ? stopPreview() : startPreview()));
    on($("#trim-cancel"), "click", () => close(null));
    on($("#trim-save"), "click", () => close({ start: st.start, end: st.start + len(), bpm: st.bpm, bpb: st.bpb }));
    on(window, "resize", draw);
    on(document, "keydown", (e) => { if (e.key === "Escape") { e.stopPropagation(); close(null); } }, true);

    dlg.hidden = false;
    draw();
    $("#trim-save").focus();
  });
}

/* ----- Transport and tempo ----- */
function togglePlay(force) {
  const want = typeof force === "boolean" ? force : !(loops && loops.playing);
  if (want) {
    let slot = slotById(S.selected);
    if (!loopOf(slot)) slot = orderedSlots().find((s) => s.loopId && loopOf(s));
    const loop = loopOf(slot);
    if (!loop) { toast("Add a loop first: drop a file on one of the slots."); return; }
    S.selected = slot.id; saveSettings();
    wake().then(() => { loops.setTarget(S.target); loops.play(loop); renderSlots(); renderTempo(); tick(); });
  } else if (loops) {
    loops.stop();
  }
  $("#play").setAttribute("aria-pressed", String(want));
  $("#play").textContent = want ? "Stop" : "Play";
  if (!want) { renderSlots(); $("#bar-count").textContent = "Stopped"; $("#progress").style.width = "0"; [...$("#beats").children].forEach((d) => d.className = ""); }
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
  const loop = (loops && loops.loop) || loopOf(slotById(S.selected));
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
    const beatLen = h.loop.len / h.loop.beats, bpb = h.loop.bpb || 4;
    const beat = Math.floor(h.pos / beatLen);
    const inBar = beat % bpb, bar = Math.floor(beat / bpb) + 1;
    const dots = $("#beats");
    while (dots.children.length < bpb) dots.append(document.createElement("span"));
    while (dots.children.length > bpb) dots.lastChild.remove();
    [...dots.children].forEach((d, i) => { d.className = i === inBar ? (i === 0 ? "lit one" : "lit") : ""; });
    $("#bar-count").textContent = `Bar ${Math.min(bar, h.loop.bars)} of ${h.loop.bars}`;
    $("#progress").style.width = (h.pos / h.loop.len * 100).toFixed(1) + "%";
    if (h.loop.id !== lastHeardId) {
      lastHeardId = h.loop.id;
      const hs = slotOfLoop(h.loop);
      if (hs && S.selected !== hs.id && !loops.pending) { S.selected = hs.id; saveSettings(); }
      renderSlots(); renderTempo();
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
    const loop = (loops && loops.loop) || loopOf(slotById(S.selected));
    if (loop) setTarget(loop.bpm);
  });
  $("#play").addEventListener("click", () => togglePlay());
  const inv = $("#invert");
  inv.setAttribute("aria-pressed", String(!!S.invert));
  inv.addEventListener("click", () => { S.invert = !S.invert; saveSettings(); applyTheme(); inv.setAttribute("aria-pressed", String(S.invert)); });
  $("#stop-pads").addEventListener("click", stopPad);
  $("#file-in").addEventListener("change", (e) => { const f = [...e.target.files]; e.target.value = ""; addFiles(f); });
  $("#slot-file-in").addEventListener("change", (e) => { const f = [...e.target.files]; e.target.value = ""; addFiles(f, pickSlot); });
  const overlay = $("#drop-overlay");
  let dragDepth = 0;
  hideOverlay = () => { dragDepth = 0; overlay.hidden = true; };
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
    if (tag === "input" || tag === "textarea" || tag === "select" || !$("#trimmer").hidden) return;
    if (e.code === "Space") { e.preventDefault(); if (!e.repeat && lib.length) togglePlay(); }
    if (e.key === "Escape") stopPad();
    if (/^[1-9]$/.test(e.key) && !e.metaKey && !e.ctrlKey && !e.altKey) {
      const slot = orderedSlots()[Number(e.key) - 1];
      if (slot && loopOf(slot)) select(slot.id);
    }
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
  renderSlots();
  if (await DB.open()) {
    const recs = (await DB.all()) || [];
    recs.sort((a, b) => (a.added || 0) - (b.added || 0));
    for (const rec of recs) {
      try { lib.push(await loopFromData(rec)); } catch (e) { /* skip unreadable file */ }
    }
  }
  // Slots that point at a missing loop become empty; loops from before slots existed fill empty slots
  for (const s of S.slots) if (s.loopId && !loopById(s.loopId)) s.loopId = null;
  for (const loop of lib) {
    if (slotOfLoop(loop)) continue;
    const empty = orderedSlots().find((s) => !s.loopId);
    (empty || newSlot("praise", loop.name)).loopId = loop.id;
  }
  if (!slotById(S.selected)) {
    const bySelectedLoop = S.slots.find((s) => s.loopId === S.selected);
    S.selected = (bySelectedLoop || orderedSlots().find((s) => s.loopId) || {}).id || null;
  }
  saveSettings();
  if (loops) { loops.loop = loopOf(slotById(S.selected)); loops.applyRatio(); }
  renderSlots();
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
