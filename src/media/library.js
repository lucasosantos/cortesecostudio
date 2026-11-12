// Biblioteca de mídia: importação, metadados, thumbnails, waveforms e decodificação de áudio.
import { Input, BlobSource, UrlSource, ALL_FORMATS, CanvasSink, AudioBufferSink } from 'mediabunny';
import { state, uid, emit } from '../state/project.js';
import { pathForFile, mediaUrlFor, readFileByPath } from '../platform/index.js';
import { createPeaks, addSamples } from './peaks.js';
import { removeLayersUsingMedia, createComp } from '../motion/model.js';
import { clearFieldMedia } from '../motion/fields.js';
import { importSvg } from '../motion/svgImport.js';
import { COMP_EXT, importCompText } from '../motion/compFile.js';

/** Dados de runtime (não serializados), por id de mídia. */
export const runtime = new Map();

const AUDIO_EXT = ['mp3', 'wav', 'ogg', 'oga', 'm4a', 'aac', 'flac', 'opus', 'weba'];
const VIDEO_EXT = ['mp4', 'm4v', 'mov', 'webm', 'mkv', 'avi', 'ogv'];
const IMAGE_EXT = ['png', 'jpg', 'jpeg', 'webp', 'gif', 'bmp'];
// SVG não entra como imagem: vira uma composição com camadas vetoriais editáveis
const VECTOR_EXT = ['svg'];

export const MEDIA_ACCEPT = [...AUDIO_EXT, ...VIDEO_EXT, ...IMAGE_EXT, ...VECTOR_EXT, COMP_EXT].map((e) => '.' + e).join(',') + ',video/*,audio/*,image/*';

/** Arquivo que vira composição (SVG vetorial ou composição exportada), ou null. */
function compKind(name, mime = '') {
  const ext = name.split('.').pop().toLowerCase();
  if (ext === COMP_EXT) return 'comp';
  if (VECTOR_EXT.includes(ext) || mime === 'image/svg+xml') return 'svg';
  return null;
}

/**
 * Cria uma composição a partir do texto de um SVG (cada forma vira uma camada de caminho).
 * @returns { comp, warnings }
 */
export function importSvgText(text, name = 'SVG') {
  const comp = createComp({ name: name.replace(/\.svg$/i, '') || 'SVG' });
  try {
    const result = importSvg(comp, text, name);
    return { comp, warnings: result.warnings };
  } catch (err) {
    state.project.comps = state.project.comps.filter((c) => c !== comp);
    throw err;
  }
}

/** Importa um arquivo que vira composição. @returns { comp, warnings } */
async function importCompSource(kind, name, text) {
  if (kind === 'comp') return { comp: await importCompText(text), warnings: [] };
  return importSvgText(text, name);
}

function guessType(name, mime = '') {
  const ext = name.split('.').pop().toLowerCase();
  if (mime.startsWith('image/') || IMAGE_EXT.includes(ext)) return 'image';
  if (mime.startsWith('audio/') || AUDIO_EXT.includes(ext)) return 'audio';
  if (mime.startsWith('video/') || VIDEO_EXT.includes(ext)) return 'video';
  return null;
}

/** A mídia não tem arquivo associado (precisa ser localizada de novo)? */
export const isMissing = (mediaId) => {
  const rt = runtime.get(mediaId);
  return !rt || !(rt.blob || rt.remote);
};

/** Fonte de leitura do Mediabunny para a mídia: o arquivo em memória/disco (Blob) ou a URL (lida aos pedaços). */
export function inputSource(rt) {
  return rt.blob ? new BlobSource(rt.blob) : new UrlSource(rt.url);
}

/** Abre a mídia para leitura (quem chama faz dispose()). Retorna null se ela está ausente. */
export function openInput(mediaId) {
  const rt = runtime.get(mediaId);
  if (!rt || !(rt.blob || rt.remote)) return null;
  return new Input({ source: inputSource(rt), formats: ALL_FORMATS });
}

/**
 * Importa arquivos (File[]) para a biblioteca do projeto.
 * @returns { media: media[], comps: comp[], warnings: string[] } — SVGs e .csmotion viram composições
 */
export async function importFiles(files) {
  const added = [];
  const comps = [];
  const warnings = [];
  for (const file of files) {
    const kind = compKind(file.name, file.type);
    if (kind) {
      try {
        const r = await importCompSource(kind, file.name, await file.text());
        comps.push(r.comp);
        warnings.push(...r.warnings);
      } catch (err) {
        console.error('Falha ao importar', file.name, err);
        alert(`Não foi possível importar "${file.name}": ${err.message}`);
      }
      continue;
    }
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
  if (comps.length) emit('project');
  return { media: added, comps, warnings };
}

/** Associa um Blob a uma entrada de mídia, lendo metadados e gerando prévias. */
export function attachBlob(media, blob) {
  return attachSource(media, { blob, url: URL.createObjectURL(blob), remote: false });
}

/**
 * Associa uma URL (protocolo media:// do app desktop) a uma entrada de mídia.
 * O arquivo fica no disco e é lido aos pedaços: nada é carregado inteiro na memória.
 */
export function attachUrl(media, url) {
  return attachSource(media, { blob: null, url, remote: true });
}

/**
 * Associa o arquivo de um caminho absoluto (desktop). Prefere a leitura direta do disco;
 * se o protocolo não estiver disponível ou falhar, lê o arquivo inteiro como antes.
 * @returns false se o arquivo não existe ou não pôde ser lido
 */
export async function attachPath(media, filePath) {
  const url = await mediaUrlFor(filePath);
  if (url) {
    try {
      await attachUrl(media, url);
      return true;
    } catch (err) {
      console.warn('Leitura direta falhou para', filePath, '— carregando o arquivo inteiro.', err);
    }
  }
  const bytes = await readFileByPath(filePath);
  if (!bytes) return false;
  await attachBlob(media, new Blob([bytes]));
  return true;
}

/** Importa arquivos pelos caminhos absolutos (desktop). @returns { added: media[], failed: [{ path, error }] } */
export async function importPaths(paths) {
  const added = [];
  const failed = [];
  for (const p of paths) {
    const filePath = String(p);
    const name = filePath.split(/[\\/]/).pop();
    const kind = compKind(name);
    if (kind) {
      try {
        const bytes = await readFileByPath(filePath);
        if (!bytes) { failed.push({ path: filePath, error: 'file not found or unreadable' }); continue; }
        await importCompSource(kind, name, new TextDecoder().decode(bytes));
        emit('project');
      } catch (err) {
        failed.push({ path: filePath, error: err.message });
      }
      continue;
    }
    const type = guessType(name);
    if (!type) { failed.push({ path: filePath, error: 'unsupported file type' }); continue; }
    const media = { id: uid('m'), name, type, path: filePath, duration: 0, width: 0, height: 0, hasAudio: false, size: 0 };
    try {
      if (!(await attachPath(media, filePath))) { failed.push({ path: filePath, error: 'file not found or unreadable' }); continue; }
    } catch (err) {
      releaseRuntime(media.id);
      failed.push({ path: filePath, error: 'unsupported or corrupt media file' });
      continue;
    }
    state.project.media.push(media);
    added.push(media);
  }
  if (added.length) emit('media');
  return { added, failed };
}

function releaseRuntime(mediaId) {
  const rt = runtime.get(mediaId);
  if (rt?.url && !rt.remote) URL.revokeObjectURL(rt.url);
  runtime.delete(mediaId);
}

// avisado depois que uma mídia ganha um arquivo (o módulo de proxy usa para entrar na fila)
let attachHook = null;
export function setAttachHook(fn) {
  attachHook = fn;
}

async function attachSource(media, source) {
  releaseRuntime(media.id);
  // proxyUrl: cópia leve usada no preview; proxy: '' | 'NN%' (gerando) | 'ready'
  const rt = { ...source, thumb: null, waveform: null, image: null, proxyUrl: null, proxy: '' };
  runtime.set(media.id, rt);

  if (media.type === 'image') {
    const img = await loadImage(rt.url, rt.remote);
    rt.image = img;
    media.width = img.naturalWidth;
    media.height = img.naturalHeight;
    rt.thumb = rt.url;
    return;
  }

  await probeAV(media, rt);
  if (media.type === 'audio' || media.hasAudio) queueWaveform(media, rt);
  // o caminho só é conhecido por quem chamou: espera a volta para o módulo de proxy enxergá-lo
  if (media.type === 'video') setTimeout(() => runtime.get(media.id) === rt && attachHook?.(media), 0);
}

async function probeAV(media, rt) {
  const input = new Input({ source: inputSource(rt), formats: ALL_FORMATS });
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
    const meta = await probeWithElement(rt.url, media.type, rt.remote);
    if (!meta) throw err;
    Object.assign(media, meta);
  } finally {
    input.dispose?.();
  }
}

function probeWithElement(url, type, remote = false) {
  return new Promise((resolve) => {
    const el = document.createElement(type === 'audio' ? 'audio' : 'video');
    if (remote) el.crossOrigin = 'anonymous';
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

function loadImage(url, remote = false) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    // sem isto, uma imagem vinda do protocolo media:// "suja" o canvas e impede efeitos e exportação
    if (remote) img.crossOrigin = 'anonymous';
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error('imagem inválida'));
    img.src = url;
  });
}

export const AUDIO_RATE = 48000;

// ---------------------------------------------------------------- forma de onda
// Uma mídia por vez: decodificar várias ao mesmo tempo trava máquinas fracas.
let waveChain = Promise.resolve();
function queueWaveform(media, rt) {
  waveChain = waveChain.then(async () => {
    if (runtime.get(media.id) !== rt) return; // removida ou trocada enquanto esperava
    try {
      rt.waveform = await buildWaveform(media, rt);
      if (rt.waveform && runtime.get(media.id) === rt) emit('media');
    } catch (e) {
      console.warn('Sem áudio decodificável em', media.name, e);
    }
  });
}

/** Lê o áudio aos pedaços e guarda só os picos: o áudio decodificado nunca fica inteiro na memória. */
async function buildWaveform(media, rt) {
  const input = new Input({ source: inputSource(rt), formats: ALL_FORMATS });
  try {
    const at = await input.getPrimaryAudioTrack();
    if (at && (await at.canDecode())) {
      const peaks = createPeaks(media.duration || (await input.computeDuration()));
      const sink = new AudioBufferSink(at);
      for await (const { buffer, timestamp } of sink.buffers()) {
        if (runtime.get(media.id) !== rt) return null;
        addSamples(peaks, buffer.getChannelData(0), timestamp, buffer.sampleRate);
      }
      return drawWaveform(peaks);
    }
  } finally {
    input.dispose?.();
  }
  // formato que só o navegador decodifica: decodifica inteiro, tira os picos e descarta
  const buffer = await decodeWholeAudio(media.id);
  if (!buffer) return null;
  const peaks = createPeaks(buffer.duration);
  addSamples(peaks, buffer.getChannelData(0), 0, buffer.sampleRate);
  return drawWaveform(peaks);
}

function drawWaveform(peaks) {
  const H = 64;
  const c = document.createElement('canvas');
  c.width = peaks.n;
  c.height = H;
  const ctx = c.getContext('2d');
  ctx.fillStyle = 'rgba(255,255,255,0.55)';
  for (let x = 0; x < peaks.n; x++) {
    const h = Math.max(1, Math.min(1, peaks.data[x]) * H);
    ctx.fillRect(x, (H - h) / 2, 1, h);
  }
  return c.toDataURL('image/png');
}

/**
 * Áudio inteiro da mídia decodificado pelo navegador (sem cache: pode ser grande).
 * Só é usado quando o Mediabunny não consegue ler o áudio aos pedaços.
 */
export async function decodeWholeAudio(mediaId) {
  const rt = runtime.get(mediaId);
  if (!rt || !(rt.blob || rt.remote)) return null;
  try {
    const bytes = rt.blob ? await rt.blob.arrayBuffer() : await (await fetch(rt.url)).arrayBuffer();
    return await new OfflineAudioContext(2, 1, AUDIO_RATE).decodeAudioData(bytes);
  } catch {
    return null;
  }
}

export function removeMedia(mediaId) {
  releaseRuntime(mediaId);
  state.project.media = state.project.media.filter((m) => m.id !== mediaId);
  state.project.clips = state.project.clips.filter((c) => c.mediaId !== mediaId);
  removeLayersUsingMedia(mediaId);
  clearFieldMedia(state.project, mediaId);
  if (state.selection && !state.project.clips.some((c) => c.id === state.selection)) state.selection = null;
}

export function clearRuntime() {
  for (const rt of runtime.values()) if (rt.url && !rt.remote) URL.revokeObjectURL(rt.url);
  runtime.clear();
}
