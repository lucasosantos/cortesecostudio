// Mixagem offline de todas as tracks de áudio (e áudio dos vídeos) com automação de volume.
import { valueAt } from '../state/keyframes.js';
import { getAudioBuffer, AUDIO_RATE } from '../media/library.js';

/** Renderiza a mixagem do projeto num AudioBuffer estéreo (48 kHz). */
export async function mixProjectAudio(project, duration, onProgress) {
  const length = Math.max(1, Math.ceil(duration * AUDIO_RATE));
  const ctx = new OfflineAudioContext(2, length, AUDIO_RATE);
  const tracks = new Map(project.tracks.map((t) => [t.id, t]));
  const mediaById = new Map(project.media.map((m) => [m.id, m]));

  const audible = project.clips.filter((c) => {
    const tr = tracks.get(c.trackId);
    const m = mediaById.get(c.mediaId);
    if (!tr || tr.muted || !m || c.start >= duration) return false;
    if (c.type === 'audio') return true;
    return c.type === 'video' && m.hasAudio && !c.audioDetached;
  });

  let done = 0;
  for (const clip of audible) {
    const buffer = await getAudioBuffer(clip.mediaId);
    onProgress?.(++done / Math.max(1, audible.length));
    if (!buffer) continue;
    const dur = Math.min(clip.duration, duration - clip.start, buffer.duration - clip.inPoint);
    if (dur <= 0) continue;

    const src = ctx.createBufferSource();
    src.buffer = buffer;
    const gain = ctx.createGain();
    applyVolumeAutomation(gain.gain, clip, clip.start, dur);
    src.connect(gain).connect(ctx.destination);
    src.start(clip.start, clip.inPoint, dur);
  }
  return ctx.startRendering();
}

function applyVolumeAutomation(param, clip, when, dur) {
  const kfs = clip.keyframes?.volume;
  if (!kfs || kfs.length === 0) {
    param.value = Math.max(0, clip.props.volume ?? 1);
    return;
  }
  // amostra a curva a 200 Hz (cobre linear, ease e hold com precisão)
  const n = Math.max(2, Math.ceil(dur * 200));
  const curve = new Float32Array(n);
  for (let i = 0; i < n; i++) curve[i] = Math.max(0, valueAt(clip, 'volume', (i / (n - 1)) * dur));
  param.setValueAtTime(curve[0], 0);
  param.setValueCurveAtTime(curve, when, dur);
}

/** Fatia um AudioBuffer em pedaços menores. */
export function* sliceAudioBuffer(buffer, seconds) {
  const step = Math.floor(seconds * buffer.sampleRate);
  for (let off = 0; off < buffer.length; off += step) {
    const len = Math.min(step, buffer.length - off);
    const part = new AudioBuffer({ length: len, numberOfChannels: buffer.numberOfChannels, sampleRate: buffer.sampleRate });
    for (let c = 0; c < buffer.numberOfChannels; c++) {
      part.copyToChannel(buffer.getChannelData(c).subarray(off, off + len), c);
    }
    yield { buffer: part, start: off / buffer.sampleRate };
  }
}
