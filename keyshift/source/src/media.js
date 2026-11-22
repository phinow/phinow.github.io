// Opening tutorial files without loading the whole file into memory.
//
// MP4, MOV and M4A files: read only the box headers and the 'moov' index, then read just the audio
// samples from disk and decode them with WebCodecs. A 600 MB screen recording costs about as much
// memory as its audio. Everything else (MP3, WAV, WebM, OGG, FLAC) goes through decodeAudioData.
//
// Result: { mono: Float32Array, sampleRate } at the AudioContext's rate, one channel.
import { createFile, MP4BoxBuffer } from 'mp4box';

const MAX_SECONDS = 40 * 60;

async function readSlice(file, start, end) {
  return file.slice(start, end).arrayBuffer();
}

// Walk the top-level boxes. Returns [{type, start, size}] or null when this is not an ISO BMFF file.
async function topLevelBoxes(file) {
  const boxes = [];
  let pos = 0;
  while (pos + 8 <= file.size) {
    const head = new DataView(await readSlice(file, pos, Math.min(file.size, pos + 16)));
    let size = head.getUint32(0);
    const type = String.fromCharCode(head.getUint8(4), head.getUint8(5), head.getUint8(6), head.getUint8(7));
    if (!/^[\x20-\x7e]{4}$/.test(type)) return boxes.length ? boxes : null;
    if (size === 1) {
      if (head.byteLength < 16) return null;
      size = Number(head.getBigUint64(8));
    } else if (size === 0) {
      size = file.size - pos;
    }
    if (size < 8) return null;
    boxes.push({ type, start: pos, size });
    pos += size;
    if (boxes.length > 10000) break;
  }
  return boxes;
}

function decoderDescription(entry) {
  const esds = entry.esds || (entry.wave && entry.wave.esds) || (entry.esdss && entry.esdss[0]);
  if (!esds || !esds.esd) return undefined;
  const dcd = esds.esd.findDescriptor(4);
  const dsi = dcd && dcd.findDescriptor(5);
  return dsi && dsi.data ? new Uint8Array(dsi.data) : undefined;
}

async function decodeIsoAudio(file, ctxRate, onProgress) {
  if (typeof AudioDecoder === 'undefined') return null;
  const boxes = await topLevelBoxes(file);
  if (!boxes) return null;
  const moov = boxes.find(b => b.type === 'moov');
  if (!moov || boxes.some(b => b.type === 'moof') || moov.size > 200 * 1024 * 1024) return null;

  // Parse ftyp + moov only. They are joined into one buffer: sample positions in the index are
  // absolute file offsets, so where the index sits in the buffer does not matter.
  const mp4 = createFile();
  let info = null;
  mp4.onReady = i => { info = i; };
  mp4.onError = () => {};
  const parts = [];
  const ftyp = boxes.find(b => b.type === 'ftyp');
  if (ftyp) parts.push(new Uint8Array(await readSlice(file, ftyp.start, ftyp.start + ftyp.size)));
  parts.push(new Uint8Array(await readSlice(file, moov.start, moov.start + moov.size)));
  const joined = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let o = 0;
  for (const p of parts) { joined.set(p, o); o += p.length; }
  mp4.appendBuffer(MP4BoxBuffer.fromArrayBuffer(joined.buffer, 0));
  mp4.flush();
  if (!info || !info.audioTracks.length) return { error: 'This file has no sound track.' };

  const track = info.audioTracks[0];
  const trak = mp4.getTrackById(track.id);
  const entry = trak.mdia.minf.stbl.stsd.entries[0];
  const samples = mp4.getTrackSamplesInfo(track.id);
  if (!samples || !samples.length) return null;

  const srcRate = track.audio.sample_rate;
  const channels = track.audio.channel_count;
  const config = { codec: track.codec, sampleRate: srcRate, numberOfChannels: channels };
  const description = decoderDescription(entry);
  if (description) config.description = description;
  let support;
  try { support = await AudioDecoder.isConfigSupported(config); } catch (e) { support = null; }
  if (!support || !support.supported) return null;

  const timescale = samples[0].timescale;
  const last = samples[samples.length - 1];
  const seconds = (last.dts + last.duration) / timescale;
  if (seconds > MAX_SECONDS) return { error: 'This file is longer than 40 minutes. Trim it to the part you need first.' };

  // Decoded audio is written straight into one mono buffer. HE-AAC can decode at twice the rate the
  // file states, so the buffer is sized from the first decoded block.
  let outRate = 0, total = 0, mono = null;
  let written = 0;
  let decodeError = null;
  let plane = new Float32Array(4096);
  const decoder = new AudioDecoder({
    output: data => {
      if (!mono) {
        outRate = data.sampleRate;
        total = Math.ceil(seconds * outRate) + outRate;
        mono = new Float32Array(total);
      }
      const n = data.numberOfFrames;
      const at = Math.max(0, Math.round((data.timestamp / 1e6) * outRate));
      if (plane.length < n) plane = new Float32Array(n);
      const ch = data.numberOfChannels;
      const end = Math.min(total, at + n);
      const g = 1 / ch;
      for (let c = 0; c < ch; c++) {
        data.copyTo(plane, { planeIndex: c, format: 'f32-planar' });
        for (let i = at, j = 0; i < end; i++, j++) mono[i] += plane[j] * g;
      }
      written = Math.max(written, end);
      data.close();
    },
    error: e => { decodeError = e; },
  });
  decoder.configure(config);

  // Read the file in large spans and pick the audio samples out of each one. In a video, audio is
  // stored in small runs between video data; reading a few MB at a time (video included) is far
  // quicker than thousands of tiny reads, and each span is let go as soon as it is used.
  const order = samples.map((s, k) => k).sort((x, y) => samples[x].offset - samples[y].offset);
  const SPAN = 8 * 1024 * 1024;
  const GAP = 2 * 1024 * 1024;
  let idx = 0;
  while (idx < order.length) {
    if (decodeError) break;
    const first = samples[order[idx]];
    const spanStart = first.offset;
    let spanEnd = first.offset + first.size;
    let j = idx + 1;
    while (j < order.length) {
      const s = samples[order[j]];
      if (s.offset - spanEnd > GAP || s.offset + s.size - spanStart > SPAN) break;
      spanEnd = Math.max(spanEnd, s.offset + s.size);
      j++;
    }
    const buf = new Uint8Array(await readSlice(file, spanStart, spanEnd));
    // Decode in time order within the span.
    const batch = order.slice(idx, j).sort((x, y) => x - y);
    for (const k of batch) {
      const s = samples[k];
      decoder.decode(new EncodedAudioChunk({
        type: 'key',
        timestamp: Math.round((s.dts / timescale) * 1e6),
        duration: Math.round((s.duration / timescale) * 1e6),
        data: buf.subarray(s.offset - spanStart, s.offset - spanStart + s.size),
      }));
    }
    idx = j;
    if (decoder.decodeQueueSize > 200) {
      await new Promise(r => {
        const check = () => (decoder.decodeQueueSize < 50 || decodeError ? r() : setTimeout(check, 5));
        check();
      });
    }
    onProgress && onProgress(0.9 * (idx / order.length));
  }
  if (!decodeError) await decoder.flush().catch(e => { decodeError = e; });
  decoder.close();
  if (decodeError || !mono || written === 0) return null;
  onProgress && onProgress(0.92);
  return { mono: await resampleMono(mono.subarray(0, written), outRate, ctxRate), sampleRate: ctxRate };
}

// Resample a mono signal with the browser's own resampler, in pieces so memory stays flat.
export async function resampleMono(input, fromRate, toRate) {
  if (fromRate === toRate) return input;
  const outLen = Math.floor((input.length * toRate) / fromRate);
  const out = new Float32Array(outLen);
  const piece = fromRate * 60; // one minute at a time
  const pad = Math.ceil(fromRate * 0.05); // a little overlap hides any edge clicks
  for (let s = 0; s < input.length; s += piece) {
    const a = Math.max(0, s - pad);
    const b = Math.min(input.length, s + piece + pad);
    const len = b - a;
    const buf = new AudioBuffer({ length: len, numberOfChannels: 1, sampleRate: fromRate });
    buf.copyToChannel(input.subarray(a, b), 0);
    const off = new OfflineAudioContext(1, Math.ceil((len * toRate) / fromRate), toRate);
    const src = off.createBufferSource();
    src.buffer = buf;
    src.connect(off.destination);
    src.start();
    const r = (await off.startRendering()).getChannelData(0);
    const skip = Math.round(((s - a) * toRate) / fromRate);
    const outStart = Math.round((s * toRate) / fromRate);
    const want = Math.min(outLen - outStart, Math.round((Math.min(piece, input.length - s) * toRate) / fromRate));
    out.set(r.subarray(skip, skip + want), outStart);
  }
  return out;
}

async function decodeWhole(file, ctx, onProgress) {
  if (file.size > 400 * 1024 * 1024) {
    return { error: 'This file is too big to open here. Save it as audio (M4A or MP3) or as an MP4, or trim it, then try again.' };
  }
  onProgress && onProgress(0.1);
  const buf = await ctx.decodeAudioData(await file.arrayBuffer());
  if (buf.duration > MAX_SECONDS) return { error: 'This file is longer than 40 minutes. Trim it to the part you need first.' };
  onProgress && onProgress(0.8);
  const len = buf.length;
  const mono = new Float32Array(len);
  const ch = buf.numberOfChannels;
  for (let c = 0; c < ch; c++) {
    const d = buf.getChannelData(c);
    for (let i = 0; i < len; i++) mono[i] += d[i] / ch;
  }
  return { mono, sampleRate: buf.sampleRate };
}

// Open a File (or Blob with a name) and return mono audio at the context's rate.
export async function openMedia(file, ctx, onProgress) {
  let result = null;
  try {
    result = await decodeIsoAudio(file, ctx.sampleRate, onProgress);
  } catch (e) {
    console.warn('Direct audio read failed, using the browser decoder', e);
    result = null;
  }
  if (result && result.error) throw new Error(result.error);
  if (!result) {
    result = await decodeWhole(file, ctx, onProgress);
    if (result.error) throw new Error(result.error);
  }
  onProgress && onProgress(1);
  return result;
}
