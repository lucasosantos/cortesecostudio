// Reprodução em tempo real: relógio, elementos de mídia por clipe e ganho de volume.
import { state, emit, getMedia, getTrack, projectDuration } from '../state/project.js';
import { valueAt } from '../state/keyframes.js';
import { runtime } from '../media/library.js';
import { buildTransitionIndex } from './compositor.js';

const pool = new Map(); // clipId -> { el, gain, mediaId }
let audioCtx = null;
let host = null;
let wallStart = 0;
let timeStart = 0;

function ctx() {
  if (!audioCtx) audioCtx = new AudioContext();
  return audioCtx;
}

function hostEl() {
  if (!host) {
    host = document.createElement('div');
    host.style.cssText = 'position:fixed;left:-10px;top:-10px;width:1px;height:1px;overflow:hidden;opacity:0;pointer-events:none';
    document.body.appendChild(host);
  }
  return host;
}

function entryFor(clip) {
  let e = pool.get(clip.id);
  const rt = runtime.get(clip.mediaId);
  if (e && e.mediaId === clip.mediaId && e.url === rt?.url) return e;
  if (e) destroy(clip.id);
  if (!rt?.url) return null;
  const el = document.createElement(clip.type === 'video' ? 'video' : 'audio');
  el.preload = 'auto';
  el.playsInline = true;
  el.src = rt.url;
  el.addEventListener('seeked', () => {
    if (e.target != null && Math.abs(el.currentTime - e.target) > 0.02 && el.paused) el.currentTime = e.target;
  });
  hostEl().appendChild(el);
  const source = ctx().createMediaElementSource(el);
  const gain = ctx().createGain();
  source.connect(gain).connect(ctx().destination);
  e = { el, gain, mediaId: clip.mediaId, url: rt.url, target: null };
  pool.set(clip.id, e);
  return e;
}

function destroy(clipId) {
  const e = pool.get(clipId);
  if (!e) return;
  e.el.pause();
  e.el.removeAttribute('src');
  e.el.load();
  e.el.remove();
  e.gain.disconnect();
  pool.delete(clipId);
}

/** Fonte de imagem para o compositor no preview. */
export function previewSource(clip) {
  if (clip.type === 'image') return runtime.get(clip.mediaId)?.image || null;
  if (clip.type === 'video') {
    const e = pool.get(clip.id);
    return e && e.el.readyState >= 2 ? e.el : null;
  }
  return null;
}

/** Sincroniza todos os elementos de mídia com o tempo atual. */
export function syncMedia(index = buildTransitionIndex(state.project)) {
  const t = state.time;
  const playing = state.playing;
  const alive = new Set();
  for (const clip of state.project.clips) {
    if (clip.type !== 'video' && clip.type !== 'audio') continue;
    const media = getMedia(clip.mediaId);
    if (!media) continue;
    alive.add(clip.id);
    // intervalo desenhado (estendido por transições) e intervalo audível (o próprio clipe)
    const [from, to] = clip.type === 'video' ? index.range(clip) : [clip.start, clip.start + clip.duration];
    const visible = t >= from && t < to;
    const active = t >= clip.start && t < clip.start + clip.duration;
    // pré-carrega clipes que estão para começar
    if (!(t >= from - 2 && t < to)) {
      const e = pool.get(clip.id);
      if (e && !e.el.paused) e.el.pause();
      continue;
    }
    const e = entryFor(clip);
    if (!e) continue;
    const local = t - clip.start;
    const rawT = clip.inPoint + Math.max(local, from - clip.start);
    // fora da mídia disponível (transição sem sobra) a imagem congela na borda
    const maxT = Math.max(0, (media.duration || 0) - 0.04);
    const mediaT = Math.min(Math.max(rawT, 0), maxT);
    const frozen = mediaT !== rawT;
    const track = getTrack(clip.trackId);
    const audible = active && track && !track.muted && !(clip.type === 'video' && (clip.audioDetached || !media.hasAudio));
    e.gain.gain.value = audible ? Math.max(0, valueAt(clip, 'volume', local)) : 0;

    if (playing && visible && !frozen) {
      e.target = null;
      if (e.el.paused) {
        e.el.currentTime = mediaT;
        e.el.play().catch(() => {});
      } else if (Math.abs(e.el.currentTime - mediaT) > 0.3) {
        e.el.currentTime = mediaT;
      }
    } else {
      if (!e.el.paused) e.el.pause();
      e.target = mediaT;
      if (!e.el.seeking && Math.abs(e.el.currentTime - mediaT) > 0.02) e.el.currentTime = mediaT;
    }
  }
  for (const id of [...pool.keys()]) if (!alive.has(id)) destroy(id);
}

export function play() {
  if (state.playing) return;
  ctx().resume();
  const dur = projectDuration();
  if (state.time >= dur - 0.01) state.time = 0;
  state.playing = true;
  timeStart = state.time;
  wallStart = performance.now();
  emit('play');
}

export function pause() {
  if (!state.playing) return;
  state.playing = false;
  for (const e of pool.values()) e.el.pause();
  emit('play');
}

export function togglePlay() {
  state.playing ? pause() : play();
}

export function seek(t) {
  state.time = Math.max(0, t);
  if (state.playing) {
    timeStart = state.time;
    wallStart = performance.now();
  }
  emit('time');
}

/** Avança o relógio; chamado a cada frame de animação. */
export function tick() {
  if (!state.playing) return;
  const dur = projectDuration();
  const t = timeStart + (performance.now() - wallStart) / 1000;
  if (t >= dur) {
    state.time = dur;
    pause();
  } else {
    state.time = t;
  }
  emit('time');
}

export function releaseAll() {
  for (const id of [...pool.keys()]) destroy(id);
}
