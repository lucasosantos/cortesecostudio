// Picos da forma de onda: guardam só o maior valor de cada trecho, não o áudio.
// Um arquivo de uma hora cabe em alguns kilobytes, em vez de centenas de megabytes de amostras.

/** Estrutura vazia para uma mídia de `duration` segundos. */
export function createPeaks(duration, perSecond = 50, maxBuckets = 4000) {
  const n = Math.min(maxBuckets, Math.max(200, Math.ceil((duration || 0) * perSecond)));
  return { n, duration: Math.max(1e-6, duration || 0), data: new Float32Array(n) };
}

/**
 * Junta um pedaço de áudio que começa em `startTime` segundos.
 * @param stride lê uma amostra a cada `stride` (o desenho não precisa de todas)
 */
export function addSamples(peaks, samples, startTime, sampleRate, stride = 4) {
  const { n, duration, data } = peaks;
  const perSample = n / (duration * sampleRate);
  const base = (startTime / duration) * n;
  for (let i = 0; i < samples.length; i += stride) {
    const b = Math.floor(base + i * perSample);
    if (b < 0) continue;
    if (b >= n) break;
    const v = Math.abs(samples[i]);
    if (v > data[b]) data[b] = v;
  }
}

/**
 * Trecho de um clipe que cai dentro do bloco [b0, b1) da mixagem.
 * @returns { when, localFrom, mediaFrom, dur } (segundos) ou null se o clipe não toca nesse bloco
 *   when = início dentro do bloco; localFrom = tempo local do clipe; mediaFrom = ponto na mídia
 */
export function clipBlockRange(clip, b0, b1, mediaDuration = Infinity) {
  const start = Math.max(clip.start, b0);
  const end = Math.min(clip.start + clip.duration, b1, clip.start + (mediaDuration - (clip.inPoint || 0)));
  if (!(end - start > 1e-6)) return null;
  const localFrom = start - clip.start;
  return { when: start - b0, localFrom, mediaFrom: (clip.inPoint || 0) + localFrom, dur: end - start };
}
