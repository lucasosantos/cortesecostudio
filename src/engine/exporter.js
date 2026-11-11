// Exportação: MP4 (H.264 + AAC) ou WebM (fallback) e MP3 somente áudio.
import {
  Output, BufferTarget, Mp4OutputFormat, WebMOutputFormat, Mp3OutputFormat,
  CanvasSource, AudioBufferSource, Input, BlobSource, ALL_FORMATS, CanvasSink,
  canEncodeVideo, canEncodeAudio, QUALITY_HIGH, QUALITY_MEDIUM, QUALITY_LOW, QUALITY_VERY_HIGH,
} from 'mediabunny';
import { registerMp3Encoder } from '@mediabunny/mp3-encoder';
import { registerAacEncoder } from '@mediabunny/aac-encoder';
import { drawFrame, visibleClipsAt, buildTransitionIndex } from './compositor.js';
import { mixProjectAudio, sliceAudioBuffer } from './audioMixer.js';
import { runtime } from '../media/library.js';
import { projectDuration } from '../state/project.js';

const QUALITIES = { low: QUALITY_LOW, medium: QUALITY_MEDIUM, high: QUALITY_HIGH, veryhigh: QUALITY_VERY_HIGH };

export class ExportCanceled extends Error {}

/**
 * Exporta o projeto.
 * @param opts { format: 'mp4'|'mp3', quality, onProgress(fraction, label), signal: { canceled } }
 * @returns { data: ArrayBuffer, extension, mimeType, note? }
 */
export async function exportProject(project, opts) {
  const duration = projectDuration(project);
  if (duration <= 0) throw new Error('A timeline está vazia.');
  // snapshot para que edições durante a exportação não afetem o resultado
  project = JSON.parse(JSON.stringify(project));
  return opts.format === 'mp3' ? exportMp3(project, duration, opts) : exportVideo(project, duration, opts);
}

function check(signal) {
  if (signal?.canceled) throw new ExportCanceled('Exportação cancelada');
}

async function exportMp3(project, duration, { quality = 'high', onProgress, signal }) {
  if (!(await canEncodeAudio('mp3'))) registerMp3Encoder();
  onProgress?.(0, 'Mixando áudio…');
  const mix = await mixProjectAudio(project, duration, (f) => onProgress?.(f * 0.4, 'Mixando áudio…'));
  check(signal);

  const output = new Output({ format: new Mp3OutputFormat(), target: new BufferTarget() });
  const bitrates = { low: 128000, medium: 160000, high: 192000, veryhigh: 320000 };
  const source = new AudioBufferSource({ codec: 'mp3', bitrate: bitrates[quality] || 192000 });
  output.addAudioTrack(source);
  await output.start();
  try {
    for (const { buffer, start } of sliceAudioBuffer(mix, 5)) {
      check(signal);
      await source.add(buffer);
      onProgress?.(0.4 + 0.6 * (start / duration), 'Codificando MP3…');
    }
    source.close();
    await output.finalize();
  } catch (e) {
    await output.cancel().catch(() => {});
    throw e;
  }
  onProgress?.(1, 'Concluído');
  return { data: output.target.buffer, extension: 'mp3', mimeType: 'audio/mpeg' };
}

let aacReady = null;
/** Garante AAC: usa o encoder nativo se houver, senão registra o encoder WASM. */
async function ensureAac() {
  aacReady ||= (async () => {
    if (!(await canEncodeAudio('aac'))) registerAacEncoder();
    return canEncodeAudio('aac');
  })();
  return aacReady;
}

async function pickVideoCodecs(width, height) {
  await ensureAac();
  if (await canEncodeVideo('avc', { width, height })) {
    const audio = (await canEncodeAudio('aac')) ? 'aac' : (await canEncodeAudio('opus')) ? 'opus' : null;
    return { container: 'mp4', video: 'avc', audio };
  }
  for (const v of ['hevc', 'av1']) {
    if (await canEncodeVideo(v, { width, height })) {
      const audio = (await canEncodeAudio('aac')) ? 'aac' : 'opus';
      return { container: 'mp4', video: v, audio };
    }
  }
  for (const v of ['vp9', 'vp8']) {
    if (await canEncodeVideo(v, { width, height })) {
      return { container: 'webm', video: v, audio: (await canEncodeAudio('opus')) ? 'opus' : null };
    }
  }
  throw new Error('Este ambiente não suporta codificação de vídeo (WebCodecs).');
}

async function exportVideo(project, duration, { quality = 'high', onProgress, signal }) {
  const { width: W, height: H, fps } = project.settings;
  const codecs = await pickVideoCodecs(W, H);
  const q = QUALITIES[quality] || QUALITY_HIGH;

  // 1) áudio
  onProgress?.(0, 'Mixando áudio…');
  const hasAudio = codecs.audio && project.clips.some((c) => c.type === 'audio' || c.type === 'video');
  const mix = hasAudio ? await mixProjectAudio(project, duration, (f) => onProgress?.(f * 0.1, 'Mixando áudio…')) : null;
  check(signal);

  // 2) saída
  const output = new Output({
    format: codecs.container === 'mp4' ? new Mp4OutputFormat({ fastStart: 'in-memory' }) : new WebMOutputFormat(),
    target: new BufferTarget(),
  });
  const canvas = new OffscreenCanvas(W, H);
  const ctx = canvas.getContext('2d', { alpha: false });
  const videoSource = new CanvasSource(canvas, { codec: codecs.video, quality: q, keyFrameInterval: 2 });
  output.addVideoTrack(videoSource, { frameRate: fps });
  let audioSource = null;
  if (mix) {
    audioSource = new AudioBufferSource({ codec: codecs.audio, quality: q });
    output.addAudioTrack(audioSource);
  }
  await output.start();

  // 3) decodificadores de frame por clipe de vídeo
  const decoders = new Map(); // clipId -> { iter, input, current }
  const inputs = [];
  const totalFrames = Math.max(1, Math.round(duration * fps));
  const index = buildTransitionIndex(project);
  const frameTimes = (clip) => {
    const list = [];
    // mesmo critério de drawFrame (intervalo estendido por transições) para manter o iterador alinhado
    const [a, b] = index.range(clip);
    const mediaDur = project.media.find((m) => m.id === clip.mediaId)?.duration || Infinity;
    const from = Math.max(0, Math.floor(a * fps) - 1);
    const to = Math.min(totalFrames - 1, Math.ceil(b * fps) + 1);
    for (let n = from; n <= to; n++) {
      const t = n / fps;
      // fora da mídia disponível a imagem congela na borda
      if (t >= a && t < b) list.push(Math.min(Math.max(clip.inPoint + (t - clip.start), 0), Math.max(0, mediaDur - 1e-3)));
    }
    return list;
  };
  async function decoderFor(clip) {
    let d = decoders.get(clip.id);
    if (d) return d;
    const rt = runtime.get(clip.mediaId);
    d = { iter: null, current: null };
    if (rt?.blob) {
      const input = new Input({ source: new BlobSource(rt.blob), formats: ALL_FORMATS });
      inputs.push(input);
      const vt = await input.getPrimaryVideoTrack();
      if (vt && (await vt.canDecode())) {
        const sink = new CanvasSink(vt, { poolSize: 3 });
        const first = await vt.getFirstTimestamp();
        d.iter = sink.canvasesAtTimestamps(frameTimes(clip).map((t) => t + first));
      }
    }
    decoders.set(clip.id, d);
    return d;
  }

  const audioChunks = mix ? sliceAudioBuffer(mix, 2) : null;
  let nextAudio = audioChunks?.next();

  try {
    for (let n = 0; n < totalFrames; n++) {
      check(signal);
      const t = n / fps;

      // avança os decodificadores dos clipes de vídeo visíveis neste frame
      for (const clip of visibleClipsAt(project, t, index)) {
        if (clip.type !== 'video') continue;
        const d = await decoderFor(clip);
        if (d.iter) {
          const r = await d.iter.next();
          d.current = r.done ? d.current : r.value?.canvas || d.current;
        }
      }
      drawFrame(ctx, project, t, (clip) => {
        if (clip.type === 'image') return runtime.get(clip.mediaId)?.image || null;
        if (clip.type === 'video') return decoders.get(clip.id)?.current || null;
        return null;
      }, index);
      await videoSource.add(t, 1 / fps);

      // intercala o áudio com o vídeo
      while (nextAudio && !nextAudio.done && nextAudio.value.start <= t + 1) {
        await audioSource.add(nextAudio.value.buffer);
        nextAudio = audioChunks.next();
      }
      // libera decodificadores de clipes que já terminaram
      for (const [id, d] of decoders) {
        const clip = project.clips.find((c) => c.id === id);
        if (clip && t >= index.range(clip)[1] && d.iter) {
          await d.iter.return?.();
          d.iter = null;
          d.current = null;
        }
      }
      onProgress?.(0.1 + 0.88 * ((n + 1) / totalFrames), `Renderizando frame ${n + 1} de ${totalFrames}`);
    }
    while (nextAudio && !nextAudio.done) {
      await audioSource.add(nextAudio.value.buffer);
      nextAudio = audioChunks.next();
    }
    videoSource.close();
    audioSource?.close();
    onProgress?.(0.99, 'Finalizando arquivo…');
    await output.finalize();
  } catch (e) {
    await output.cancel().catch(() => {});
    throw e;
  } finally {
    for (const d of decoders.values()) await d.iter?.return?.();
    for (const i of inputs) i.dispose?.();
  }

  onProgress?.(1, 'Concluído');
  const ext = codecs.container;
  return {
    data: output.target.buffer,
    extension: ext,
    mimeType: ext === 'mp4' ? 'video/mp4' : 'video/webm',
    note: ext !== 'mp4' ? 'H.264/MP4 não está disponível neste ambiente; o vídeo foi exportado em WebM.' : null,
  };
}
