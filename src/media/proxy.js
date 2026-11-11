// Arquivos proxy: cópias leves dos vídeos, usadas só no preview (a exportação sempre lê o original).
// Somente no app desktop: o proxy é gravado aos poucos na pasta de dados do app e reaproveitado entre sessões.
import { Input, Output, Conversion, Mp4OutputFormat, StreamTarget, ALL_FORMATS, canEncodeAudio } from 'mediabunny';
import { state, emit } from '../state/project.js';
import { proxyStore, openFileWriter } from '../platform/index.js';
import { getPref } from '../prefs.js';
import { runtime, inputSource, setAttachHook } from './library.js';

/** Este vídeo deve ter proxy? (mode: 'auto' | 'always' | 'never'; height: altura do proxy) */
export function needsProxy(media, mode, height) {
  if (!media || media.type !== 'video' || mode === 'never' || !media.path) return false;
  // um proxy do mesmo tamanho (ou maior) que o original não ajuda
  if (!(media.height > height)) return false;
  return mode === 'always' || media.height > 720;
}

/** Taxa de bits do proxy para a altura pedida (proporcional à área, ~1,5 Mbps em 540). */
export const proxyBitrate = (height) => Math.round(1_500_000 * (height / 540) ** 2);

const wait = (ms) => new Promise((r) => setTimeout(r, ms));
/** Espera enquanto o usuário está reproduzindo ou exportando: a conversão não disputa a máquina com isso. */
async function whileBusy() {
  while (state.playing || state.exporting) await wait(400);
}

let chain = Promise.resolve();
const queued = new Set();

function setState(rt, value) {
  if (rt.proxy === value) return;
  rt.proxy = value;
  emit('media');
}

/** Põe a mídia na fila de geração de proxy (se ela precisar e ainda não tiver). */
export function queueProxy(media) {
  const rt = runtime.get(media.id);
  if (!proxyStore || !rt || rt.proxyUrl || queued.has(media.id)) return;
  const height = getPref('proxyHeight');
  if (!needsProxy(media, getPref('proxyMode'), height)) return;
  queued.add(media.id);
  chain = chain.then(() => build(media, rt, height)).catch((err) => {
    console.warn('Não foi possível gerar o proxy de', media.name, err);
    setState(rt, '');
  }).finally(() => queued.delete(media.id));
}

async function build(media, rt, height) {
  const gone = () => runtime.get(media.id) !== rt;
  if (gone() || !needsProxy(media, getPref('proxyMode'), height)) return;
  const loc = await proxyStore.locate(media.path, height);
  if (!loc || gone()) return;
  if (loc.url) {
    // já existe de uma sessão anterior
    rt.proxyUrl = loc.url;
    return setState(rt, 'ready');
  }
  setState(rt, '0%');
  await whileBusy();
  if (gone()) return;

  // áudio: copiado quando o formato permite; senão é recodificado em AAC (o Chromium no Linux precisa do codificador extra)
  if (!(await canEncodeAudio('aac'))) (await import('@mediabunny/aac-encoder')).registerAacEncoder();

  const writer = await openFileWriter(loc.partPath);
  const input = new Input({ source: inputSource(rt), formats: ALL_FORMATS });
  let conversion = null;
  try {
    const stream = new WritableStream({
      async write(chunk) {
        // pausa natural: enquanto o usuário reproduz ou exporta, a gravação espera e os codificadores param
        await whileBusy();
        if (gone()) throw new Error('mídia removida');
        await writer.write(chunk.data, chunk.position);
      },
    });
    const output = new Output({
      format: new Mp4OutputFormat({ fastStart: false }),
      target: new StreamTarget(stream, { chunked: true, chunkSize: 512 * 1024 }),
    });
    conversion = await Conversion.init({
      input, output, tracks: 'primary', showWarnings: false,
      // um quadro-chave por segundo: buscar um ponto qualquer do vídeo fica rápido
      video: { height, fit: 'contain', codec: 'avc', bitrate: proxyBitrate(height), keyFrameInterval: 1 },
      audio: { codec: 'aac', bitrate: 96_000 },
    });
    if (!conversion.isValid) throw new Error('este vídeo não pode ser convertido neste ambiente');
    let shown = 0;
    conversion.onProgress = (p) => {
      const pct = Math.floor(p * 20) * 5;
      if (pct !== shown) setState(rt, `${(shown = pct)}%`);
    };
    await conversion.execute();
    await writer.close();
  } catch (err) {
    await conversion?.cancel().catch(() => {});
    await writer.abort().catch(() => {});
    throw err;
  } finally {
    input.dispose?.();
  }
  if (gone()) return;
  const url = await proxyStore.commit(loc.key);
  if (!url) throw new Error('o proxy não pôde ser guardado');
  rt.proxyUrl = url;
  setState(rt, 'ready');
}

/**
 * Reavalia todas as mídias depois de mudar as preferências ou limpar a pasta.
 * @param opts { dropped: os arquivos foram apagados (volta tudo para o original) }
 */
export function refreshProxies({ dropped = false } = {}) {
  const mode = getPref('proxyMode');
  const height = getPref('proxyHeight');
  let changed = false;
  for (const media of state.project.media) {
    const rt = runtime.get(media.id);
    if (!rt) continue;
    if (rt.proxyUrl && (dropped || !needsProxy(media, mode, height) || rt.proxyHeight !== height)) {
      rt.proxyUrl = null;
      rt.proxy = '';
      changed = true;
    }
    rt.proxyHeight = height;
    queueProxy(media);
  }
  if (changed) emit('media');
}

/** Liga a geração automática: toda mídia associada a um arquivo entra na fila. */
export function initProxies() {
  if (!proxyStore) return;
  setAttachHook((media) => {
    const rt = runtime.get(media.id);
    if (rt) rt.proxyHeight = getPref('proxyHeight');
    queueProxy(media);
  });
}
