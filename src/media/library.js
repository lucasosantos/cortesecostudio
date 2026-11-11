// Biblioteca de mídia: importação, metadados, thumbnails, waveforms e decodificação de áudio.
import { Input, BlobSource, ALL_FORMATS, CanvasSink, AudioBufferSink } from 'mediabunny';
import { state, uid, emit } from '../state/project.js';
import { pathForFile } from '../platform/index.js';
import { removeLayersUsingMedia } from '../motion/model.js';

/** Dados de runtime (não serializados), por id de mídia. */
export const runtime = new Map();

const AUDIO_EXT = ['mp3', 'wav', 'ogg', 'oga', 'm4a', 'aac', 'flac', 'opus', 'weba'];
const VIDEO_EXT = ['mp4', 'm4v', 'mov', 'webm', 'mkv', 'avi', 'ogv'];
const IMAGE_EXT = ['png', 'jpg', 'jpeg', 'webp', 'gif', 'bmp', 'svg'];

export const MEDIA_ACCEPT = [...AUDIO_EXT, ...VIDEO_EXT, ...IMAGE_EXT].map((e) => '.' + e).join(',') + ',video/*,audio/*,image/*';

function guessType(name, mime = '') {
  const ext = name.split('.').pop().toLowerCase();
  if (mime.startsWith('image/') || IMAGE_EXT.includes(ext)) return 'image';
  if (mime.startsWith('audio/') || AUDIO_EXT.includes(ext)) return 'audio';
  if (mime.startsWith('video/') || VIDEO_EXT.includes(ext)) return 'video';
  return null;
}

export const isMissing = (mediaId) => !runtime.get(mediaId)?.blob;

/** Importa arquivos (File[]) para a biblioteca do projeto. */
export async function importFiles(files) {
  const added = [];
  for (const file of files) {
    let type = guessType(file.name, file.type);
    if (!type) continue;
    const media = { id: uid('m'), name: file.name, type, path: pathForFile(file), duration: 0, width: 0, height: 0, hasAudio: false, size: file.size };
    try {
      await attachBlob(media, file);
    } catch (err) {
      console.error('Falha ao importar', file.name, err);
      alert(`Não foi possível importar "${file.name}": ${err.message}`);
      continue;
    }
    state.project.media.push(media);
    added.push(media);
  }
  if (added.length) emit('media');
  return added;
}

/** Associa um Blob a uma entrada de mídia, lendo metadados e gerando prévias. */
export async function attachBlob(media, blob) {
  const old = runtime.get(media.id);
  if (old?.url) URL.revokeObjectURL(old.url);
  const rt = { blob, url: URL.createObjectURL(blob), thumb: null, waveform: null, image: null, audioBuffer: null, audioPromise: null };
  runtime.set(media.id, rt);

  if (media.type === 'image') {
    const img = await loadImage(rt.url);
    rt.image = img;
    media.width = img.naturalWidth;
    media.height = img.naturalHeight;
    rt.thumb = rt.url;
    return;
  }

  await probeAV(media, rt);
  if (media.type === 'audio' || media.hasAudio) {
    // decodifica em segundo plano para gerar a waveform
    getAudioBuffer(media.id).then(() => emit('media')).catch((e) => console.warn('Sem áudio decodificável em', media.name, e));
  }
}

async function probeAV(media, rt) {
  const input = new Input({ source: new BlobSource(rt.blob), formats: ALL_FORMATS });
  try {
    media.duration = await input.computeDuration();
    const vt = await input.getPrimaryVideoTrack();
    const at = await input.getPrimaryAudioTrack();
    media.hasAudio = !!at;
    if (vt) {
      media.type = 'video';
      media.width = vt.displayWidth;
      media.height = vt.displayHeight;
      if (await vt.canDecode()) {
        const sink = new CanvasSink(vt, { width: 192 });
        const first = await vt.getFirstTimestamp();
        const frame = await sink.getCanvas(first + Math.min(1, media.duration / 3));
        if (frame) rt.thumb = canvasToDataUrl(frame.canvas);
      }
    } else if (media.type === 'video') {
      media.type = 'audio';
    }
    if (!vt && !at) throw new Error('nenhuma faixa de áudio ou vídeo encontrada');
  } catch (err) {
    // fallback: metadados via elemento de mídia do navegador
    const meta = await probeWithElement(rt.url, media.type);
    if (!meta) throw err;
    Object.assign(media, meta);
  } finally {
    input.dispose?.();
  }
}

function probeWithElement(url, type) {
  return new Promise((resolve) => {
    const el = document.createElement(type === 'audio' ? 'audio' : 'video');
    el.preload = 'metadata';
    el.onloadedmetadata = () =>
      resolve({ duration: el.duration, width: el.videoWidth || 0, height: el.videoHeight || 0, hasAudio: true, type: el.videoWidth ? 'video' : 'audio' });
    el.onerror = () => resolve(null);
    el.src = url;
  });
}

function canvasToDataUrl(src) {
  const c = document.createElement('canvas');
  c.width = src.width;
  c.height = src.height;
  c.getContext('2d').drawImage(src, 0, 0);
  return c.toDataURL('image/jpeg', 0.8);
}

function loadImage(url) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error('imagem inválida'));
    img.src = url;
  });
}

export const AUDIO_RATE = 48000;

/** AudioBuffer decodificado (48 kHz) da mídia, com cache. */
export function getAudioBuffer(mediaId) {
  const rt = runtime.get(mediaId);
  if (!rt) return Promise.resolve(null);
  if (rt.audioBuffer) return Promise.resolve(rt.audioBuffer);
  if (rt.audioPromise) return rt.audioPromise;
  rt.audioPromise = (async () => {
    let buffer;
    try {
      const ctx = new OfflineAudioContext(2, 1, AUDIO_RATE);
      buffer = await ctx.decodeAudioData(await rt.blob.arrayBuffer());
    } catch {
      buffer = await decodeWithMediabunny(rt.blob);
    }
    rt.audioBuffer = buffer;
    if (buffer) rt.waveform = makeWaveform(buffer);
    return buffer;
  })();
  return rt.audioPromise;
}

async function decodeWithMediabunny(blob) {
  const input = new Input({ source: new BlobSource(blob), formats: ALL_FORMATS });
  try {
    const at = await input.getPrimaryAudioTrack();
    if (!at || !(await at.canDecode())) return null;
    const duration = await input.computeDuration();
    const sr = at.sampleRate;
    const ch = Math.min(2, at.numberOfChannels);
    const out = new AudioBuffer({ length: Math.ceil(duration * sr) + 1, numberOfChannels: ch, sampleRate: sr });
    const sink = new AudioBufferSink(at);
    for await (const { buffer, timestamp } of sink.buffers()) {
      const offset = Math.round(timestamp * sr);
      if (offset < 0 || offset >= out.length) continue;
      for (let c = 0; c < ch; c++) {
        const data = buffer.getChannelData(Math.min(c, buffer.numberOfChannels - 1));
        out.copyToChannel(data.subarray(0, out.length - offset), c, offset);
      }
    }
    return out;
  } finally {
    input.dispose?.();
  }
}

function makeWaveform(buffer) {
  const W = Math.min(4000, Math.max(200, Math.ceil(buffer.duration * 50)));
  const H = 64;
  const c = document.createElement('canvas');
  c.width = W;
  c.height = H;
  const ctx = c.getContext('2d');
  const data = buffer.getChannelData(0);
  const step = Math.max(1, Math.floor(data.length / W));
  ctx.fillStyle = 'rgba(255,255,255,0.55)';
  for (let x = 0; x < W; x++) {
    let max = 0;
    const s = x * step;
    for (let i = 0; i < step; i += 4) {
      const v = Math.abs(data[s + i] || 0);
      if (v > max) max = v;
    }
    const h = Math.max(1, max * H);
    ctx.fillRect(x, (H - h) / 2, 1, h);
  }
  return c.toDataURL('image/png');
}

export function removeMedia(mediaId) {
  const rt = runtime.get(mediaId);
  if (rt?.url) URL.revokeObjectURL(rt.url);
  runtime.delete(mediaId);
  state.project.media = state.project.media.filter((m) => m.id !== mediaId);
  state.project.clips = state.project.clips.filter((c) => c.mediaId !== mediaId);
  removeLayersUsingMedia(mediaId);
  if (state.selection && !state.project.clips.some((c) => c.id === state.selection)) state.selection = null;
}

export function clearRuntime() {
  for (const rt of runtime.values()) if (rt.url) URL.revokeObjectURL(rt.url);
  runtime.clear();
}
