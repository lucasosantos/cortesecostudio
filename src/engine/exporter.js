// Exportação: MP4 (H.264 + AAC) ou WebM (fallback) e MP3 somente áudio.
import {
  Output, BufferTarget, StreamTarget, Mp4OutputFormat, WebMOutputFormat, Mp3OutputFormat,
  CanvasSource, AudioBufferSource, CanvasSink,
  canEncodeVideo, canEncodeAudio, QUALITY_HIGH, QUALITY_MEDIUM, QUALITY_LOW, QUALITY_VERY_HIGH,
} from 'mediabunny';
import { registerMp3Encoder } from '@mediabunny/mp3-encoder';
import { registerAacEncoder } from '@mediabunny/aac-encoder';
import { drawFrame, visibleClipsAt, buildTransitionIndex } from './compositor.js';
import { mixProjectAudioBlocks } from './audioMixer.js';
import { runtime, openInput } from '../media/library.js';
import { projectDuration, state, emit } from '../state/project.js';

const QUALITIES = { low: QUALITY_LOW, medium: QUALITY_MEDIUM, high: QUALITY_HIGH, veryhigh: QUALITY_VERY_HIGH };

export class ExportCanceled extends Error {}

/**
 * Exporta o projeto.
 * @param opts {
 *   format: 'mp4'|'mp3', quality, onProgress(fraction, label), signal: { canceled },
 *   writer   opcional { write(bytes, posição) }: grava o arquivo aos poucos (desktop) em vez de montá-lo na memória
 *   hardware opcional: pede o codificador de vídeo da placa (cai no de software se não houver)
 *   fast     opcional: codificação mais rápida, com um pouco menos de qualidade
 * }
 * @returns { data: ArrayBuffer | null (null quando gravou pelo writer), bytes, extension, mimeType, note? }
 */
export async function exportProject(project, opts) {
  const duration = projectDuration(project);
  if (duration <= 0) throw new Error('A timeline está vazia.');
  // snapshot para que edições durante a exportação não afetem o resultado
  project = JSON.parse(JSON.stringify(project));
  // o preview fica parado enquanto exporta, para não disputar processador e placa de vídeo
  state.exporting = true;
  try {
    return await (opts.format === 'mp3' ? exportMp3(project, duration, opts) : exportVideo(project, duration, opts));
  } finally {
    state.exporting = false;
    emit('time');
  }
}

/** Extensão do arquivo que a exportação vai gerar (para escolher o nome antes de começar). */
export async function exportExtension(project, format) {
  if (format === 'mp3') return 'mp3';
  const { width, height } = project.settings;
  return (await pickVideoCodecs(width, height)).container;
}

/** Destino da saída: o arquivo em disco (aos poucos) ou a memória. Conta os bytes gravados. */
function makeTarget(writer) {
  if (!writer) return { target: new BufferTarget(), size: (target) => target.buffer?.byteLength || 0 };
  let end = 0;
  const stream = new WritableStream({
    async write(chunk) {
      await writer.write(chunk.data, chunk.position);
      end = Math.max(end, chunk.position + chunk.data.byteLength);
    },
  });
  return { target: new StreamTarget(stream, { chunked: true, chunkSize: 4 * 1024 * 1024 }), size: () => end };
}

function check(signal) {
  if (signal?.canceled) throw new ExportCanceled('Exportação cancelada');
}

async function exportMp3(project, duration, { quality = 'high', onProgress, signal, writer }) {
  if (!(await canEncodeAudio('mp3'))) registerMp3Encoder();
  onProgress?.(0, 'Codificando MP3…');
  const out = makeTarget(writer);
  const output = new Output({ format: new Mp3OutputFormat(), target: out.target });
  const bitrates = { low: 128000, medium: 160000, high: 192000, veryhigh: 320000 };
  const source = new AudioBufferSource({ codec: 'mp3', bitrate: bitrates[quality] || 192000 });
  output.addAudioTrack(source);
  await output.start();
  try {
    for await (const { buffer, start } of mixProjectAudioBlocks(project, duration)) {
      check(signal);
      await source.add(buffer);
      onProgress?.(Math.min(0.99, (start + buffer.duration) / duration), 'Codificando MP3…');
    }
    source.close();
    await output.finalize();
  } catch (e) {
    await output.cancel().catch(() => {});
    throw e;
  }
  onProgress?.(1, 'Concluído');
  return { data: writer ? null : output.target.buffer, bytes: out.size(output.target), extension: 'mp3', mimeType: 'audio/mpeg' };
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

async function exportVideo(project, duration, { quality = 'high', onProgress, signal, writer, hardware = false, fast = false }) {
  const { width: W, height: H, fps } = project.settings;
  const codecs = await pickVideoCodecs(W, H);
  const q = QUALITIES[quality] || QUALITY_HIGH;

  // 1) áudio: mixado em blocos, à medida que o vídeo avança
  onProgress?.(0, 'Preparando…');
  const hasAudio = codecs.audio && project.clips.some((c) => c.type === 'audio' || c.type === 'video');
  const audioBlocks = hasAudio ? mixProjectAudioBlocks(project, duration, { blockSeconds: 2 }) : null;
  check(signal);

  // 2) saída (gravando em disco, o índice do MP4 vai no fim do arquivo para nada ficar retido na memória)
  const out = makeTarget(writer);
  const output = new Output({
    format: codecs.container === 'mp4' ? new Mp4OutputFormat({ fastStart: writer ? false : 'in-memory' }) : new WebMOutputFormat(),
    target: out.target,
  });
  const canvas = new OffscreenCanvas(W, H);
  const ctx = canvas.getContext('2d', { alpha: false });
  // o codificador da placa só é pedido se este ambiente confirmar que tem um
  const useHw = hardware && (await canEncodeVideo(codecs.video, { width: W, height: H, hardwareAcceleration: 'prefer-hardware' }).catch(() => false));
  const videoSource = new CanvasSource(canvas, {
    codec: codecs.video, quality: q, keyFrameInterval: 2,
    ...(fast ? { latencyMode: 'realtime' } : {}),
    ...(useHw ? { hardwareAcceleration: 'prefer-hardware' } : {}),
  });
  output.addVideoTrack(videoSource, { frameRate: fps });
  let audioSource = null;
  if (audioBlocks) {
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
    d = { iter: null, current: null };
    const input = openInput(clip.mediaId);
    if (input) {
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

  let nextAudio = audioBlocks ? await audioBlocks.next() : null;

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
        nextAudio = await audioBlocks.next();
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
      onProgress?.(0.98 * ((n + 1) / totalFrames), `Renderizando frame ${n + 1} de ${totalFrames}`);
    }
    while (nextAudio && !nextAudio.done) {
      await audioSource.add(nextAudio.value.buffer);
      nextAudio = await audioBlocks.next();
    }
    videoSource.close();
    audioSource?.close();
    onProgress?.(0.99, 'Finalizando arquivo…');
    await output.finalize();
  } catch (e) {
    await output.cancel().catch(() => {});
    throw e;
  } finally {
    await audioBlocks?.return?.();
    for (const d of decoders.values()) await d.iter?.return?.();
    for (const i of inputs) i.dispose?.();
  }

  onProgress?.(1, 'Concluído');
  const ext = codecs.container;
  return {
    data: writer ? null : output.target.buffer,
    bytes: out.size(output.target),
    extension: ext,
    mimeType: ext === 'mp4' ? 'video/mp4' : 'video/webm',
    note: ext !== 'mp4' ? 'H.264/MP4 não está disponível neste ambiente; o vídeo foi exportado em WebM.' : null,
  };
}
