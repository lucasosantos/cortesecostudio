// Mixagem offline de todas as tracks de áudio (e áudio dos vídeos) com automação de volume.
// É feita em blocos curtos e só decodifica o trecho usado de cada clipe: a memória não cresce
// com a duração do projeto nem com o tamanho das mídias.
import { AudioBufferSink } from 'mediabunny';
import { valueAt } from '../state/keyframes.js';
import { openInput, decodeWholeAudio, AUDIO_RATE } from '../media/library.js';
import { clipBlockRange } from '../media/peaks.js';

const PAD = 0.05; // sobra decodificada de cada lado, para a reamostragem não estalar na emenda dos blocos

/** Abre o áudio de uma mídia para leitura por trechos. */
async function openAudio(mediaId) {
  const input = openInput(mediaId);
  if (!input) return null;
  try {
    const track = await input.getPrimaryAudioTrack();
    if (track && (await track.canDecode())) {
      return { input, sink: new AudioBufferSink(track), sampleRate: track.sampleRate, channels: Math.min(2, track.numberOfChannels) };
    }
  } catch {
    /* cai no caminho do navegador */
  }
  input.dispose?.();
  // formato que só o navegador decodifica: precisa do arquivo inteiro
  const whole = await decodeWholeAudio(mediaId);
  return whole ? { whole, sampleRate: whole.sampleRate, channels: Math.min(2, whole.numberOfChannels) } : null;
}

/** AudioBuffer com o trecho [from, to) da mídia, na taxa de amostragem original. */
async function decodeRange(audio, from, to) {
  const sr = audio.sampleRate;
  const length = Math.max(1, Math.ceil((to - from) * sr));
  const out = new AudioBuffer({ length, numberOfChannels: audio.channels, sampleRate: sr });
  const put = (buffer, timestamp) => {
    let offset = Math.round((timestamp - from) * sr);
    let skip = 0;
    if (offset < 0) {
      skip = -offset;
      offset = 0;
    }
    const n = Math.min(buffer.length - skip, length - offset);
    if (n <= 0) return;
    for (let c = 0; c < audio.channels; c++) {
      const data = buffer.getChannelData(Math.min(c, buffer.numberOfChannels - 1));
      out.copyToChannel(data.subarray(skip, skip + n), c, offset);
    }
  };
  if (audio.whole) put(audio.whole, 0);
  else for await (const { buffer, timestamp } of audio.sink.buffers(from, to)) put(buffer, timestamp);
  return out;
}

/**
 * Mixagem do projeto, entregue aos poucos: gera { buffer (estéreo, 48 kHz), start } a cada bloco.
 * @param opts { blockSeconds, onProgress(fração) }
 */
export async function* mixProjectAudioBlocks(project, duration, { blockSeconds = 5, onProgress } = {}) {
  const tracks = new Map(project.tracks.map((t) => [t.id, t]));
  const mediaById = new Map(project.media.map((m) => [m.id, m]));
  const audible = project.clips.filter((c) => {
    const tr = tracks.get(c.trackId);
    const m = mediaById.get(c.mediaId);
    if (!tr || tr.muted || !m || c.start >= duration) return false;
    if (c.type === 'audio') return true;
    return c.type === 'video' && m.hasAudio && !c.audioDetached;
  });

  const opened = new Map(); // mediaId → áudio aberto (ou null se não deu)
  const audioFor = async (mediaId) => {
    if (!opened.has(mediaId)) opened.set(mediaId, await openAudio(mediaId));
    return opened.get(mediaId);
  };

  try {
    for (let b0 = 0; b0 < duration; b0 += blockSeconds) {
      const b1 = Math.min(duration, b0 + blockSeconds);
      const ctx = new OfflineAudioContext(2, Math.max(1, Math.round((b1 - b0) * AUDIO_RATE)), AUDIO_RATE);
      for (const clip of audible) {
        const r = clipBlockRange(clip, b0, b1, mediaById.get(clip.mediaId)?.duration || Infinity);
        if (!r) continue;
        const audio = await audioFor(clip.mediaId);
        if (!audio) continue;
        const from = Math.max(0, r.mediaFrom - PAD);
        const src = ctx.createBufferSource();
        src.buffer = await decodeRange(audio, from, r.mediaFrom + r.dur + PAD);
        const gain = ctx.createGain();
        applyVolumeAutomation(gain.gain, clip, r.when, r.localFrom, r.dur);
        src.connect(gain).connect(ctx.destination);
        src.start(r.when, r.mediaFrom - from, r.dur);
      }
      const buffer = await ctx.startRendering();
      onProgress?.(b1 / duration);
      yield { buffer, start: b0 };
    }
  } finally {
    for (const a of opened.values()) a?.input?.dispose?.();
  }
}

/** Volume do clipe no trecho que começa em `localFrom` (tempo do clipe) e toca em `when` (tempo do bloco). */
function applyVolumeAutomation(param, clip, when, localFrom, dur) {
  const kfs = clip.keyframes?.volume;
  if (!kfs || kfs.length === 0) {
    param.value = Math.max(0, clip.props.volume ?? 1);
    return;
  }
  // amostra a curva a 200 Hz (cobre linear, ease e hold com precisão)
  const n = Math.max(2, Math.ceil(dur * 200));
  const curve = new Float32Array(n);
  for (let i = 0; i < n; i++) curve[i] = Math.max(0, valueAt(clip, 'volume', localFrom + (i / (n - 1)) * dur));
  param.setValueAtTime(curve[0], 0);
  param.setValueCurveAtTime(curve, when, dur);
}
