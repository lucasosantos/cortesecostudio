// Timeline: tracks ilimitadas, clipes arrastáveis/aparáveis, modo inserção, envelope de volume e keyframes.
import {
  state, emit, subscribe, checkpoint, getClip, getTrack, getMedia, orderedTracks, projectDuration,
  addTrack, removeTrack, moveTrack, overlaps, rippleRemove, rippleInsert, insertionTime, findFreeSlot,
  createClipFromMedia, createCompClip, trackKindFor, splitClip, removeClip, clipsOnTrack,
} from '../state/project.js';
import { getComp } from '../motion/model.js';
import { openComp } from './motion/actions.js';
import {
  valueAt, hasKeyframes, keyframeTimes, moveKeyframesAt, removeKeyframesAt, removeKeyframe, setKeyframe, shiftKeyframes,
} from '../state/keyframes.js';
import { runtime, importFiles, isMissing } from '../media/library.js';
import { seek } from '../engine/player.js';
import { h, toast, clamp, formatTime } from './util.js';
import { icons } from './icons.js';
import { saveSizes } from './layout.js';
import { buildTransitionIndex, TRANSITIONS } from '../engine/compositor.js';

const HEAD_W = 190;
const CLIP_H = { visual: 56, audio: 50 }; // altura interna do clipe (row - 8)
const MEDIA_MIME = 'application/x-mineeditor-media';
const COMP_MIME = 'application/x-mineeditor-comp';
const SVG_NS = 'http://www.w3.org/2000/svg';

let root, scrollEl, contentEl, playheadEl, snapBtn, insertBtn;
let snapOn = true;
let renderQueued = false;
let drag = null;
let dropHint = null; // { trackId | 'new' }
let lastDown = { time: 0, x: 0, y: 0 };

export function initTimeline(el) {
  root = el;
  scrollEl = h('div.tl-scroll');
  contentEl = h('div.tl-content');
  scrollEl.append(contentEl);
  playheadEl = h('div.playhead');
  root.append(resizer(), toolbar(), scrollEl);

  subscribe((reason) => {
    // no modo motion esta timeline fica oculta; ela é redesenhada ao voltar ('mode')
    if (reason.startsWith('motion') || state.mode !== 'edit') return;
    if (reason === 'time') updatePlayhead(true);
    else if (reason !== 'play') queueRender();
  });

  contentEl.addEventListener('pointerdown', onPointerDown);
  scrollEl.addEventListener('wheel', onWheel, { passive: false });
  contentEl.addEventListener('dragover', onDragOver);
  contentEl.addEventListener('dragleave', () => setDropHint(null));
  contentEl.addEventListener('drop', onDrop);
  new ResizeObserver(() => queueRender()).observe(scrollEl);
  render();
}

// ---------------------------------------------------------------- toolbar
function toolbar() {
  insertBtn = h('button', {
    title: 'Modo inserção: ao soltar um clipe ele é encaixado empurrando os demais (também segurando Alt)',
    on: { click: () => { state.insertMode = !state.insertMode; insertBtn.classList.toggle('active', state.insertMode); } },
  }, 'Modo inserção');
  snapBtn = h('button.active', {
    title: 'Ímã: encaixa nas bordas dos clipes e no playhead',
    on: { click: () => { snapOn = !snapOn; snapBtn.classList.toggle('active', snapOn); } },
  }, 'Ímã');
  return h('div.tl-toolbar', {},
    h('button', { on: { click: () => { checkpoint(); addTrack('visual'); emit('project'); } } }, '+ Track de vídeo'),
    h('button', { on: { click: () => { checkpoint(); addTrack('audio'); emit('project'); } } }, '+ Track de áudio'),
    h('div.sep'),
    h('button', { title: 'Dividir no playhead (S)', on: { click: splitAtPlayhead } }, 'Dividir'),
    h('button', { title: 'Excluir clipe (Delete)', on: { click: deleteSelected } }, 'Excluir'),
    h('div.sep'),
    insertBtn,
    snapBtn,
    h('div.sep'),
    h('button.icon', { title: 'Diminuir zoom (-)', on: { click: () => setZoom(state.zoom / 1.4) } }, '−'),
    h('button.icon', { title: 'Aumentar zoom (+)', on: { click: () => setZoom(state.zoom * 1.4) } }, '+'),
    h('button', { title: 'Ajustar projeto à largura', on: { click: zoomToFit } }, 'Ajustar'),
    h('span.hint', { title: 'Arraste mídias para as tracks · Alt+arrastar reordena · Ctrl+clique na linha de volume cria keyframe' }, 'Arraste mídias para as tracks · Alt+arrastar reordena · Ctrl+clique na linha de volume cria keyframe'),
  );
}

function resizer() {
  const el = h('div.tl-resizer');
  el.addEventListener('pointerdown', (e) => {
    const startY = e.clientY;
    const startH = root.getBoundingClientRect().height;
    const move = (ev) => {
      const hgt = clamp(startH - (ev.clientY - startY), 160, window.innerHeight - 260);
      document.body.style.setProperty('--tl-h', hgt + 'px');
    };
    const up = () => { window.removeEventListener('pointermove', move); window.removeEventListener('pointerup', up); saveSizes(); };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
  });
  return el;
}

// ---------------------------------------------------------------- ações
export function splitAtPlayhead() {
  const t = state.time;
  const sel = state.selection ? getClip(state.selection) : null;
  const targets = sel && t > sel.start && t < sel.start + sel.duration
    ? [sel]
    : state.project.clips.filter((c) => t > c.start && t < c.start + c.duration && !getTrack(c.trackId)?.locked);
  if (!targets.length) return toast('Posicione o playhead sobre um clipe para dividir');
  checkpoint();
  let last = null;
  for (const c of targets) last = splitClip(c, t) || last;
  if (last && sel) state.selection = last.id;
  emit('project');
}

export function deleteSelected(ripple = false) {
  const clip = state.selection ? getClip(state.selection) : null;
  if (!clip || getTrack(clip.trackId)?.locked) return;
  checkpoint();
  if (ripple) rippleRemove(clip);
  removeClip(clip.id);
  emit('project');
}

/** Coloca uma mídia na timeline (drop ou duplo clique na biblioteca). */
export function placeMedia(media, trackId, t) {
  const kind = trackKindFor(media.type);
  const dur = media.type === 'image' ? 5 : media.duration || 5;
  checkpoint();
  let track = trackId ? getTrack(trackId) : null;
  if (!track || track.kind !== kind || track.locked) {
    track = orderedTracks().find((tr) => tr.kind === kind && !tr.locked && !overlaps(tr.id, t, t + dur));
    if (!track) track = addTrack(kind);
  }
  const clip = createClipFromMedia(media, track.id, t);
  if (overlaps(track.id, clip.start, clip.start + clip.duration, clip.id)) {
    if (state.insertMode) rippleInsert(clip, track.id, t);
    else clip.start = findFreeSlot(track.id, t, clip.duration, clip.id);
  }
  state.selection = clip.id;
  emit('project');
  return clip;
}

/** Coloca uma composição de motion na timeline (drop, duplo clique na biblioteca ou botão do inspector). */
export function placeComp(comp, trackId, t) {
  checkpoint();
  let track = trackId ? getTrack(trackId) : null;
  if (!track || track.kind !== 'visual' || track.locked) {
    track = orderedTracks().find((tr) => tr.kind === 'visual' && !tr.locked && !overlaps(tr.id, t, t + comp.duration));
    // composições costumam ficar por cima do vídeo: a track nova entra no topo
    if (!track) track = addTrack('visual');
  }
  const clip = createCompClip(comp, track.id, t);
  if (overlaps(track.id, clip.start, clip.start + clip.duration, clip.id)) {
    if (state.insertMode) rippleInsert(clip, track.id, t);
    else clip.start = findFreeSlot(track.id, t, clip.duration, clip.id);
  }
  state.selection = clip.id;
  emit('project');
  return clip;
}

// ---------------------------------------------------------------- zoom
function setZoom(z, anchorClientX) {
  z = clamp(z, 4, 800);
  const rect = scrollEl.getBoundingClientRect();
  const ax = anchorClientX ?? rect.left + HEAD_W + (rect.width - HEAD_W) / 2;
  const tAnchor = (scrollEl.scrollLeft + ax - rect.left - HEAD_W) / state.zoom;
  state.zoom = z;
  render();
  scrollEl.scrollLeft = Math.max(0, tAnchor * z - (ax - rect.left - HEAD_W));
}

export function zoomIn() { setZoom(state.zoom * 1.4); }
export function zoomOut() { setZoom(state.zoom / 1.4); }

function zoomToFit() {
  const dur = Math.max(5, projectDuration());
  state.zoom = clamp((scrollEl.clientWidth - HEAD_W - 40) / dur, 4, 800);
  render();
  scrollEl.scrollLeft = 0;
}

function onWheel(e) {
  if (e.ctrlKey || e.metaKey) {
    e.preventDefault();
    setZoom(state.zoom * (e.deltaY < 0 ? 1.15 : 1 / 1.15), e.clientX);
  } else if (e.shiftKey && !e.deltaX) {
    e.preventDefault();
    scrollEl.scrollLeft += e.deltaY;
  }
}

// ---------------------------------------------------------------- render
function queueRender() {
  if (renderQueued) return;
  renderQueued = true;
  requestAnimationFrame(() => {
    renderQueued = false;
    render();
  });
}

function tickInterval(zoom) {
  const steps = [1 / 30, 0.1, 0.25, 0.5, 1, 2, 5, 10, 15, 30, 60, 120, 300, 600];
  return steps.find((s) => s * zoom >= 70) || 600;
}

function render() {
  if (!contentEl) return;
  const zoom = state.zoom;
  const dur = projectDuration();
  const visibleSec = Math.max(1, (scrollEl.clientWidth - HEAD_W) / zoom);
  const totalSec = Math.max(dur + 30, visibleSec + 2);
  const laneW = Math.ceil(totalSec * zoom);
  contentEl.style.width = HEAD_W + laneW + 'px';

  const major = tickInterval(zoom);
  const tIndex = buildTransitionIndex(state.project);
  const rows = orderedTracks().map((tr) => trackRow(tr, major, tIndex));
  const newZone = h(`div.tl-new-track-zone${dropHint === 'new' ? '.drop-target' : ''}`, { dataset: { newTrack: '1' } },
    'Solte aqui para criar uma nova track');
  contentEl.replaceChildren(ruler(totalSec, major), ...rows, newZone, playheadEl);

  if (drag?.type === 'move' && drag.started && drag.insert) {
    const lane = contentEl.querySelector(`.tl-row[data-track-id="${drag.clip.trackId}"] .tl-lane`);
    if (lane) lane.append(h('div.insert-marker', { style: { left: drag.insertAt * zoom + 'px' } }));
  }
  if (drag?.snapAt != null) {
    contentEl.append(h('div.snap-line', { style: { left: HEAD_W + drag.snapAt * zoom + 'px' } }));
  }
  updatePlayhead(false);
}

function ruler(totalSec, major) {
  const ticks = h('div.tl-ticks');
  const minor = major / (major >= 1 ? 5 : 2);
  const n = Math.ceil(totalSec / minor);
  for (let i = 0; i <= n; i++) {
    const t = i * minor;
    const isMajor = Math.abs(t / major - Math.round(t / major)) < 1e-6;
    const tick = h(`div.tick${isMajor ? '.major' : ''}`, { style: { left: t * state.zoom + 'px' } });
    if (isMajor) tick.append(h('span', {}, formatTime(t, major < 1 ? state.project.settings.fps : 0).replace(/\.00$/, '')));
    ticks.append(tick);
  }
  return h('div.tl-ruler', {}, h('div.tl-corner'), ticks);
}

function trackRow(track, major, tIndex) {
  const isAudio = track.kind === 'audio';
  const cls = `div.tl-row${isAudio ? '.audio' : ''}${track.locked ? '.locked' : ''}${track.hidden ? '.hidden-track' : ''}`;
  const lane = h(`div.tl-lane${dropHint === track.id ? '.drop-target' : ''}`, { style: { '--grid': major * state.zoom + 'px' } });
  const clips = clipsOnTrack(track.id);
  for (const clip of clips) lane.append(clipEl(clip, track, tIndex));
  if (!isAudio) {
    const zoom = state.zoom;
    for (const tr of tIndex.transitions) {
      if (tr.trackId !== track.id) continue;
      const name = TRANSITIONS[tr.spec.type];
      lane.append(h(`div.trans${tr.in.id === state.selection ? '.selected' : ''}`, {
        dataset: { clipId: tr.in.id },
        title: `Transição: ${name} (${tr.spec.duration}s) — clique para editar`,
        style: { left: tr.from * zoom + 'px', width: Math.max(8, (tr.to - tr.from) * zoom) + 'px' },
      }, h('span', {}, name)));
    }
    // botão para criar transição nos cortes entre clipes colados
    for (let i = 1; i < clips.length; i++) {
      const a = clips[i - 1];
      const b = clips[i];
      if (b.transition || Math.abs(a.start + a.duration - b.start) > 0.02) continue;
      lane.append(h('button.trans-add', { dataset: { clipId: b.id }, title: 'Adicionar transição neste corte', style: { left: b.start * zoom + 'px' } }, '⧓'));
    }
  }
  return h(cls, { dataset: { trackId: track.id } }, trackHead(track), lane);
}

function iconBtn(html, title, on, onClick) {
  const b = h(`button${on ? '.on' : ''}`, { title, on: { click: onClick } });
  b.innerHTML = html;
  return b;
}

function trackHead(track) {
  const toggle = (key) => () => { checkpoint(); track[key] = !track[key]; emit('project'); };
  const nameInput = h('input', {
    type: 'text', value: track.name,
    on: {
      change: (e) => { checkpoint(); track.name = e.target.value || track.name; emit('project'); },
      keydown: (e) => { if (e.key === 'Enter') e.target.blur(); },
    },
  });
  const btns = h('div.btns', {},
    iconBtn(icons.up, 'Subir track', false, () => { checkpoint(); moveTrack(track.id, -1); emit('project'); }),
    iconBtn(icons.down, 'Descer track', false, () => { checkpoint(); moveTrack(track.id, 1); emit('project'); }),
    track.kind === 'visual' ? iconBtn(track.hidden ? icons.eyeOff : icons.eye, 'Mostrar/ocultar', track.hidden, toggle('hidden')) : null,
    iconBtn(track.muted ? icons.volOff : icons.vol, 'Mudo', track.muted, toggle('muted')),
    iconBtn(track.locked ? icons.lock : icons.unlock, 'Travar', track.locked, toggle('locked')),
    iconBtn(icons.trash, 'Excluir track', false, () => {
      const n = state.project.clips.filter((c) => c.trackId === track.id).length;
      if (n && !confirm(`Excluir "${track.name}" e seus ${n} clipe(s)?`)) return;
      checkpoint();
      removeTrack(track.id);
      emit('project');
    }),
  );
  return h('div.tl-head', {}, h('div.name', {}, h('span.dot'), nameInput), btns);
}

function clipEl(clip, track, tIndex) {
  const zoom = state.zoom;
  const media = getMedia(clip.mediaId);
  const rt = runtime.get(clip.mediaId);
  const selected = clip.id === state.selection;
  const isDragging = drag?.clip?.id === clip.id && drag.started;
  const cls = `div.clip.type-${clip.type}${selected ? '.selected' : ''}${isDragging ? '.dragging' : ''}${isDragging && drag.invalid ? '.invalid' : ''}`;
  const w = Math.max(2, clip.duration * zoom);
  const el = h(cls, { dataset: { clipId: clip.id }, style: { left: clip.start * zoom + 'px', width: w + 'px' } });

  if (clip.type === 'video' && rt?.thumb) {
    el.append(h('div.thumbs', { style: { backgroundImage: `url(${rt.thumb})` } }));
  } else if (clip.type === 'image' && rt?.thumb) {
    el.append(h('div.thumbs', { style: { backgroundImage: `url(${rt.thumb})` } }));
  }
  if (clip.type === 'audio' && rt?.waveform && media?.duration) {
    el.append(h('div.wave', {
      style: {
        backgroundImage: `url(${rt.waveform})`,
        backgroundSize: `${media.duration * zoom}px 100%`,
        backgroundPosition: `${-clip.inPoint * zoom}px 0`,
      },
    }));
  }
  const label = clip.type === 'text' ? `T  ${String(clip.text || '').split('\n')[0]}`
    : clip.type === 'comp' ? `◆ ${getComp(clip.compId)?.name || clip.name || 'Composição'}`
    : clip.name || media?.name || clip.type;
  el.append(h('div.label', {}, label));
  if (clip.mediaId && isMissing(clip.mediaId)) el.append(h('div.missing-tag', {}, 'mídia ausente'));
  if (clip.type !== 'audio') {
    const both = (clip.animIn ? clip.animIn.duration : 0) + (clip.animOut ? clip.animOut.duration : 0);
    const k = both > clip.duration ? clip.duration / both : 1;
    for (const [key, cls] of [['animIn', 'in'], ['animOut', 'out']]) {
      const spec = clip[key];
      if (!spec || !TRANSITIONS[spec.type]) continue;
      const ignored = tIndex && (key === 'animIn' ? !tIndex.hasIn(clip) : !tIndex.hasOut(clip));
      el.append(h(`div.anim.${cls}${ignored ? '.ignored' : ''}`, { style: { width: Math.max(4, spec.duration * k * zoom) + 'px' } },
        h('span', {}, TRANSITIONS[spec.type] + (ignored ? ' (ignorada)' : ''))));
    }
  }

  const hasAudio = clip.type === 'audio' || (clip.type === 'video' && media?.hasAudio && !clip.audioDetached);
  if (hasAudio && (clip.type === 'audio' || selected)) el.append(envelope(clip, w, CLIP_H[track.kind]));

  if (selected) {
    const kfs = h('div.kfs');
    for (const t of keyframeTimes(clip)) {
      kfs.append(h('div.kf', { dataset: { t: String(t) }, title: `Keyframe em ${formatTime(clip.start + t)} (duplo clique remove)`, style: { left: t * zoom + 'px' } }));
    }
    el.append(kfs);
  }
  el.append(h('div.handle.l', { dataset: { side: 'l' } }), h('div.handle.r', { dataset: { side: 'r' } }));
  return el;
}

const volToY = (v, H) => 2 + (H - 4) * (1 - clamp(v, 0, 2) / 2);
const yToVol = (y, H) => clamp((1 - (y - 2) / (H - 4)) * 2, 0, 2);

function envelope(clip, w, H) {
  const zoom = state.zoom;
  const svg = document.createElementNS(SVG_NS, 'svg');
  svg.classList.add('env');
  const kfs = clip.keyframes?.volume || [];
  const pts = kfs.length
    ? [[0, valueAt(clip, 'volume', 0)], ...kfs.map((k) => [k.t * zoom, k.v]), [w, valueAt(clip, 'volume', clip.duration)]]
    : [[0, clip.props.volume], [w, clip.props.volume]];
  const str = pts.map(([x, v]) => `${x},${volToY(v, H)}`).join(' ');
  for (const cls of ['env-hit', 'env-line']) {
    const pl = document.createElementNS(SVG_NS, 'polyline');
    pl.setAttribute('points', str);
    pl.setAttribute('class', cls);
    if (cls === 'env-hit') {
      const t = document.createElementNS(SVG_NS, 'title');
      t.textContent = `Volume ${Math.round(valueAt(clip, 'volume', 0) * 100)}% — arraste para ajustar, Ctrl+clique cria keyframe`;
      pl.append(t);
    }
    svg.append(pl);
  }
  for (const k of kfs) {
    const c = document.createElementNS(SVG_NS, 'circle');
    c.setAttribute('cx', k.t * zoom);
    c.setAttribute('cy', volToY(k.v, H));
    c.setAttribute('r', 4.5);
    c.dataset.t = String(k.t);
    const t = document.createElementNS(SVG_NS, 'title');
    t.textContent = `Volume ${Math.round(k.v * 100)}% (duplo clique remove)`;
    c.append(t);
    svg.append(c);
  }
  return svg;
}

function updatePlayhead(follow) {
  const x = HEAD_W + state.time * state.zoom;
  playheadEl.style.left = x + 'px';
  if (follow && state.playing) {
    const viewR = scrollEl.scrollLeft + scrollEl.clientWidth;
    if (x > viewR - 40 || x < scrollEl.scrollLeft + HEAD_W) scrollEl.scrollLeft = x - HEAD_W - 40;
  }
}

// ---------------------------------------------------------------- interação
const timeAt = (clientX) => (clientX - contentEl.getBoundingClientRect().left - HEAD_W) / state.zoom;

function rowAt(clientY) {
  for (const row of contentEl.querySelectorAll('.tl-row')) {
    const r = row.getBoundingClientRect();
    if (clientY >= r.top && clientY < r.bottom) return getTrack(row.dataset.trackId);
  }
  return null;
}

function snapCandidates(ignoreId) {
  const c = [0, state.time];
  for (const clip of state.project.clips) {
    if (clip.id === ignoreId) continue;
    c.push(clip.start, clip.start + clip.duration);
  }
  return c;
}

function snap(value, candidates) {
  if (!snapOn) return { value, at: null };
  const thr = 8 / state.zoom;
  let best = null;
  for (const c of candidates) if (Math.abs(c - value) < thr && (best == null || Math.abs(c - value) < Math.abs(best - value))) best = c;
  return best == null ? { value, at: null } : { value: best, at: best };
}

function onPointerDown(e) {
  // duplo clique detectado aqui: a timeline é redesenhada ao soltar o botão, o elemento clicado
  // deixa de existir e o navegador não chega a disparar 'dblclick'
  const now = performance.now();
  const twice = e.button === 0 && now - lastDown.time < 400 && Math.hypot(e.clientX - lastDown.x, e.clientY - lastDown.y) < 5;
  lastDown = twice ? { time: 0, x: 0, y: 0 } : { time: now, x: e.clientX, y: e.clientY };
  if (twice && e.target.closest('.clip')) {
    // só vale como duplo clique se o botão for solto sem arrastar (senão é "selecionar e arrastar")
    const target = e.target;
    window.addEventListener('pointerup', (ev) => {
      if (Math.hypot(ev.clientX - e.clientX, ev.clientY - e.clientY) < 3) onDoubleClick({ target });
    }, { once: true });
  }
  if (e.button !== 0) return;
  const target = e.target;
  if (target.closest('.tl-head') || target.closest('.tl-corner')) return;

  if (target.closest('.tl-ticks')) {
    beginDrag(e, { type: 'scrub' });
    seek(Math.max(0, timeAt(e.clientX)));
    return;
  }

  const transNode = target.closest('.trans, .trans-add');
  if (transNode) {
    const clip = getClip(transNode.dataset.clipId);
    if (!clip) return;
    e.preventDefault();
    if (transNode.classList.contains('trans-add') && !getTrack(clip.trackId)?.locked) {
      checkpoint();
      clip.transition = { type: 'fade', duration: 1, direction: 'left', color: '#ffffff' };
    }
    state.selection = clip.id;
    emit('project');
    return;
  }

  const clipNode = target.closest('.clip');
  if (!clipNode) {
    if (target.closest('.tl-lane')) {
      if (state.selection) { state.selection = null; emit('selection'); }
      seek(Math.max(0, timeAt(e.clientX)));
    }
    return;
  }

  const clip = getClip(clipNode.dataset.clipId);
  if (!clip) return;
  if (state.selection !== clip.id) {
    state.selection = clip.id;
    emit('selection');
  }
  const track = getTrack(clip.trackId);
  if (track?.locked) return;
  const clipRect = clipNode.getBoundingClientRect();
  const H = CLIP_H[track.kind];
  const base = { clip, x0: e.clientX, y0: e.clientY, clipTop: clipRect.top, H };

  if (target.classList.contains('handle')) {
    return beginDrag(e, { ...base, type: 'trim', side: target.dataset.side, orig: { start: clip.start, duration: clip.duration, inPoint: clip.inPoint, keyframes: JSON.stringify(clip.keyframes || {}) } });
  }
  if (target.tagName === 'circle') {
    const t = Number(target.dataset.t);
    const kf = clip.keyframes.volume.find((k) => Math.abs(k.t - t) < 1e-6);
    return beginDrag(e, { ...base, type: 'env-point', kf, orig: { t: kf.t, v: kf.v } });
  }
  if (target.classList.contains('env-hit')) {
    const localT = clamp((e.clientX - clipRect.left) / state.zoom, 0, clip.duration);
    const v = yToVol(e.clientY - clipRect.top, H);
    if (e.ctrlKey || e.metaKey) {
      checkpoint();
      setKeyframe(clip, 'volume', localT, v);
      const kf = clip.keyframes.volume.find((k) => Math.abs(k.t - localT) < 1e-6);
      emit('project');
      return beginDrag(e, { ...base, type: 'env-point', kf, orig: { t: kf.t, v: kf.v }, started: true });
    }
    if (!hasKeyframes(clip, 'volume')) return beginDrag(e, { ...base, type: 'env-static', orig: { v: clip.props.volume } });
  }
  if (target.classList.contains('kf')) {
    const t = Number(target.dataset.t);
    return beginDrag(e, { ...base, type: 'kf', current: t, from: t });
  }
  beginDrag(e, { ...base, type: 'move', orig: { start: clip.start, trackId: clip.trackId } });
}

function beginDrag(e, d) {
  e.preventDefault();
  drag = { started: false, ...d };
  window.addEventListener('pointermove', onPointerMove);
  window.addEventListener('pointerup', onPointerUp, { once: true });
}

function onPointerMove(e) {
  if (!drag) return;
  const dx = e.clientX - (drag.x0 ?? e.clientX);
  const dy = e.clientY - (drag.y0 ?? e.clientY);
  if (drag.type === 'scrub') return seek(Math.max(0, timeAt(e.clientX)));
  if (!drag.started) {
    if (Math.abs(dx) < 3 && Math.abs(dy) < 3) return;
    drag.started = true;
    checkpoint();
  }
  const clip = drag.clip;
  const zoom = state.zoom;

  if (drag.type === 'move') {
    let start = Math.max(0, drag.orig.start + dx / zoom);
    const cands = snapCandidates(clip.id);
    const s1 = snap(start, cands);
    const s2 = snap(start + clip.duration, cands);
    drag.snapAt = null;
    if (s1.at != null) { start = s1.value; drag.snapAt = s1.at; }
    else if (s2.at != null) { start = s2.value - clip.duration; drag.snapAt = s2.at; }
    start = Math.max(0, start);
    const row = rowAt(e.clientY);
    if (row && row.kind === trackKindFor(clip.type) && !row.locked) clip.trackId = row.id;
    clip.start = start;
    drag.insert = state.insertMode || e.altKey;
    drag.insertAt = drag.insert ? insertionTime(clip.trackId, start, clip.id) : null;
    drag.invalid = !drag.insert && overlaps(clip.trackId, start, start + clip.duration, clip.id);
  } else if (drag.type === 'trim') {
    trimDrag(clip, dx / zoom);
  } else if (drag.type === 'env-point') {
    const kf = drag.kf;
    if (!e.shiftKey) kf.t = clamp(drag.orig.t + dx / zoom, 0, clip.duration);
    kf.v = yToVol(volToY(drag.orig.v, drag.H) + dy, drag.H);
    clip.keyframes.volume.sort((a, b) => a.t - b.t);
  } else if (drag.type === 'env-static') {
    clip.props.volume = yToVol(volToY(drag.orig.v, drag.H) + dy, drag.H);
  } else if (drag.type === 'kf') {
    const to = clamp(drag.from + dx / zoom, 0, clip.duration);
    moveKeyframesAt(clip, drag.current, to);
    drag.current = to;
  }
  emit('project');
}

function trimDrag(clip, dt) {
  const o = drag.orig;
  const media = getMedia(clip.mediaId);
  // vídeo, áudio e composição têm conteúdo com tempo próprio: aparar o início avança o ponto de entrada
  const av = clip.type === 'video' || clip.type === 'audio' || clip.type === 'comp';
  const mediaDur = av && media?.duration ? media.duration : Infinity;
  const neighbours = clipsOnTrack(clip.trackId).filter((c) => c.id !== clip.id);
  const MIN = 1 / state.project.settings.fps;
  drag.snapAt = null;

  if (drag.side === 'r') {
    let end = o.start + o.duration + dt;
    const s = snap(end, snapCandidates(clip.id));
    if (s.at != null) { end = s.value; drag.snapAt = s.at; }
    const next = neighbours.find((c) => c.start >= o.start + o.duration - 1e-6);
    const maxEnd = Math.min(next ? next.start : Infinity, o.start + (mediaDur - o.inPoint));
    clip.duration = clamp(end, o.start + MIN, maxEnd) - o.start;
  } else {
    let start = o.start + dt;
    const s = snap(start, snapCandidates(clip.id));
    if (s.at != null) { start = s.value; drag.snapAt = s.at; }
    const prev = [...neighbours].reverse().find((c) => c.start + c.duration <= o.start + 1e-6);
    const minStart = Math.max(0, prev ? prev.start + prev.duration : 0, av ? o.start - o.inPoint : -Infinity);
    start = clamp(start, minStart, o.start + o.duration - MIN);
    const d = start - o.start;
    clip.start = start;
    clip.duration = o.duration - d;
    clip.inPoint = av ? o.inPoint + d : 0;
    clip.keyframes = JSON.parse(o.keyframes);
    shiftKeyframes(clip, -d);
  }
}

function onPointerUp() {
  window.removeEventListener('pointermove', onPointerMove);
  const d = drag;
  drag = null;
  if (!d || !d.started) return render();
  if (d.type === 'move') {
    const clip = d.clip;
    if (d.insert) {
      const targetTrack = clip.trackId;
      let t = d.insertAt;
      clip.trackId = d.orig.trackId;
      clip.start = d.orig.start;
      rippleRemove(clip);
      if (targetTrack === d.orig.trackId && t > d.orig.start) t -= clip.duration;
      rippleInsert(clip, targetTrack, Math.max(0, t));
    } else if (d.invalid) {
      clip.trackId = d.orig.trackId;
      clip.start = d.orig.start;
      toast('Sobreposição: segure Alt (ou ative o Modo inserção) para encaixar e reordenar');
    }
  }
  emit('project');
}

function onDoubleClick(e) {
  const clipNode = e.target.closest('.clip');
  if (!clipNode) return;
  const clip = getClip(clipNode.dataset.clipId);
  if (!clip || getTrack(clip.trackId)?.locked) return;
  if (e.target.classList.contains('kf')) {
    checkpoint();
    removeKeyframesAt(clip, Number(e.target.dataset.t));
    emit('project');
  } else if (e.target.tagName === 'circle') {
    checkpoint();
    removeKeyframe(clip, 'volume', Number(e.target.dataset.t));
    emit('project');
  } else if (clip.type === 'comp' && !e.target.classList.contains('handle')) {
    // duplo clique num clipe de composição abre o workspace de motion
    state.selection = clip.id;
    openComp(clip.compId);
  }
}

// ---------------------------------------------------------------- drag & drop de mídia
function dropTargetAt(e) {
  if (e.target.closest('.tl-new-track-zone')) return 'new';
  return rowAt(e.clientY)?.id || null;
}

function setDropHint(v) {
  if (dropHint === v) return;
  dropHint = v;
  queueRender();
}

function onDragOver(e) {
  const types = [...e.dataTransfer.types];
  if (!types.includes(MEDIA_MIME) && !types.includes(COMP_MIME) && !types.includes('Files')) return;
  e.preventDefault();
  e.dataTransfer.dropEffect = 'copy';
  setDropHint(dropTargetAt(e));
}

async function onDrop(e) {
  e.preventDefault();
  e.stopPropagation();
  const target = dropTargetAt(e);
  setDropHint(null);
  const t = Math.max(0, timeAt(e.clientX));
  const comp = getComp(e.dataTransfer.getData(COMP_MIME));
  if (comp) {
    let trackId = target === 'new' ? null : target;
    if (target === 'new') {
      checkpoint();
      trackId = addTrack('visual').id;
    }
    placeComp(comp, trackId, t);
    return;
  }
  const mediaId = e.dataTransfer.getData(MEDIA_MIME);
  let list = [];
  if (mediaId) list = [getMedia(mediaId)].filter(Boolean);
  else if (e.dataTransfer.files.length) list = await importFiles([...e.dataTransfer.files]);
  let at = t;
  for (const media of list) {
    let trackId = target === 'new' ? null : target;
    if (target === 'new') {
      checkpoint();
      trackId = addTrack(trackKindFor(media.type)).id;
    }
    const clip = placeMedia(media, trackId, at);
    at = clip.start + clip.duration;
  }
}

export { MEDIA_MIME, COMP_MIME };
