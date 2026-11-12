// Timeline: tracks ilimitadas, clipes arrastáveis/aparáveis, modo inserção, envelope de volume e keyframes.
import {
  state, emit, subscribe, checkpoint, getClip, getTrack, getMedia, orderedTracks, projectDuration,
  addTrack, removeTrack, moveTrack, overlaps, rippleRemove, rippleInsert, insertionTime, findFreeSlot,
  createClipFromMedia, createCompClip, trackKindFor, splitClip, removeClip, clipsOnTrack, snapshotKeyframes, restoreKeyframes,
  selectedClipIds,
} from '../state/project.js';
import { getComp } from '../motion/model.js';
import { openComp } from './motion/actions.js';
import {
  valueAt, hasKeyframes, keyframeTimes, moveKeyframesAt, removeKeyframesAt, removeKeyframe, setKeyframe, shiftKeyframes,
} from '../state/keyframes.js';
import { runtime, importFiles, isMissing } from '../media/library.js';
import { seek } from '../engine/player.js';
import { h, toast, clamp, formatTime, visibleWindow } from './util.js';
import { icons } from './icons.js';
import { saveSizes } from './layout.js';
import { openShortcuts } from './shortcuts.js';
import { transitionIndexFor } from '../engine/compositor.js';
import { transitionKnown, transitionLabel } from '../fx/registry.js';
import { timed } from '../perf.js';

const HEAD_W = 190;
// altura da linha de cada track (ajustável arrastando a borda de baixo do cabeçalho; guardada em track.height)
const ROW_H = { visual: 64, audio: 58 };
export const ROW_MIN = 28;
export const ROW_MAX = 260;
export const rowHeight = (track) => clamp(Math.round(track?.height || ROW_H[track?.kind] || 64), ROW_MIN, ROW_MAX);
const clipHeight = (track) => rowHeight(track) - 8; // altura interna do clipe
const MEDIA_MIME = 'application/x-mineeditor-media';
const COMP_MIME = 'application/x-mineeditor-comp';
const SVG_NS = 'http://www.w3.org/2000/svg';

let root, scrollEl, contentEl, playheadEl, snapBtn, insertBtn, selectToolBtn, bladeToolBtn, bladeLine;
let snapOn = true;
let tool = 'select'; // 'select' (A) ou 'blade' (B: clicar num clipe corta ali)
let bladeAt = null; // tempo sob o mouse com a ferramenta de corte
let renderQueued = false;
let drag = null;
let dropHint = null; // { trackId | 'new' }
let lastDown = { time: 0, x: 0, y: 0 };
// faixa de tempo que tem elementos criados (o resto da timeline fica vazio até rolar para lá)
let win = { t0: 0, t1: Infinity, x0: 0, x1: Infinity };
// arrasto simples de um clipe na mesma track: só o elemento dele é atualizado, sem refazer a timeline
let fastMove = false;

export function initTimeline(el) {
  root = el;
  scrollEl = h('div.tl-scroll');
  contentEl = h('div.tl-content');
  scrollEl.append(contentEl);
  playheadEl = h('div.playhead');
  bladeLine = h('div.blade-line');
  root.append(resizer(), toolbar(), scrollEl);

  subscribe((reason) => {
    // no modo motion esta timeline fica oculta; ela é redesenhada ao voltar ('mode')
    if (reason.startsWith('motion') || state.mode !== 'edit') return;
    if (reason === 'time') updatePlayhead(true);
    else if (reason !== 'play') {
      // qualquer outra mudança pede o redesenho completo (o arrasto religa o atalho depois do emit)
      fastMove = false;
      queueRender();
    }
  });

  contentEl.addEventListener('pointerdown', onPointerDown);
  contentEl.addEventListener('pointermove', onBladeHover);
  contentEl.addEventListener('pointerleave', () => { bladeAt = null; bladeLine.remove(); });
  scrollEl.addEventListener('wheel', onWheel, { passive: false });
  scrollEl.addEventListener('scroll', () => {
    const x = scrollEl.scrollLeft;
    if (x < win.x0 || x > win.x1) queueRender();
  }, { passive: true });
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
    title: 'Ímã: encaixa nas bordas dos clipes e no playhead (N)',
    on: { click: toggleSnap },
  }, 'Ímã');
  selectToolBtn = h('button.active', { title: 'Seleção: arrastar, aparar e selecionar clipes (A)', on: { click: () => setTool('select') } }, 'Seleção');
  bladeToolBtn = h('button', { title: 'Corte: clique num clipe para dividi-lo ali; Shift+clique corta todas as tracks (B)', on: { click: () => setTool('blade') } }, 'Corte');
  return h('div.tl-toolbar', {},
    selectToolBtn,
    bladeToolBtn,
    h('div.sep'),
    h('button', { on: { click: () => { checkpoint(); addTrack('visual'); emit('project'); } } }, '+ Track de vídeo'),
    h('button', { on: { click: () => { checkpoint(); addTrack('audio'); emit('project'); } } }, '+ Track de áudio'),
    h('div.sep'),
    h('button', { title: 'Dividir no playhead (S ou Ctrl+B)', on: { click: splitAtPlayhead } }, 'Dividir'),
    h('button', { title: 'Excluir clipe (Delete)', on: { click: () => deleteSelected() } }, 'Excluir'),
    h('div.sep'),
    insertBtn,
    snapBtn,
    h('div.sep'),
    h('button.icon', { title: 'Diminuir zoom (-)', on: { click: () => setZoom(state.zoom / 1.4) } }, '−'),
    h('button.icon', { title: 'Aumentar zoom (+)', on: { click: () => setZoom(state.zoom * 1.4) } }, '+'),
    h('button', { title: 'Ajustar projeto à largura (Shift+Z)', on: { click: zoomToFit } }, 'Ajustar'),
    h('button', { title: 'Lista de atalhos do teclado (?)', on: { click: openShortcuts } }, 'Atalhos'),
    h('span.hint', { title: 'Arraste mídias para as tracks · Alt+arrastar reordena · Ctrl+clique na linha de volume cria keyframe' }, 'Arraste mídias para as tracks · Alt+arrastar reordena · Ctrl+clique na linha de volume cria keyframe'),
  );
}

function resizer() {
  const el = h('div.tl-resizer');
  el.addEventListener('pointerdown', (e) => {
    const startY = e.clientY;
    const startH = root.getBoundingClientRect().height;
    const move = (ev) => {
      // com a timeline em cima, a alça fica na borda de baixo e o sentido inverte
      const dir = document.body.classList.contains('tl-top') ? -1 : 1;
      const hgt = clamp(startH - dir * (ev.clientY - startY), 120, window.innerHeight - 120);
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

/** Ferramenta do timeline: 'select' (A) ou 'blade' (B). */
export function setTool(next) {
  tool = next === 'blade' ? 'blade' : 'select';
  selectToolBtn?.classList.toggle('active', tool === 'select');
  bladeToolBtn?.classList.toggle('active', tool === 'blade');
  root?.classList.toggle('blade-mode', tool === 'blade');
  if (tool !== 'blade') {
    bladeAt = null;
    bladeLine?.remove();
  }
}
export const getTool = () => tool;

/** Liga/desliga o ímã (N). */
export function toggleSnap() {
  snapOn = !snapOn;
  snapBtn?.classList.toggle('active', snapOn);
  toast(snapOn ? 'Ímã ligado' : 'Ímã desligado');
}

/** Tempo arredondado ao quadro mais próximo. */
const toFrame = (t) => {
  const fps = state.project.settings.fps || 30;
  return Math.round(t * fps) / fps;
};

/** Clipes que uma ação "no playhead" afeta: o selecionado (se o playhead está nele) ou todos sob o playhead. */
function clipsAtPlayhead(t) {
  const sel = state.selection ? getClip(state.selection) : null;
  if (sel && t > sel.start + 1e-6 && t < sel.start + sel.duration - 1e-6) return getTrack(sel.trackId)?.locked ? [] : [sel];
  return state.project.clips.filter((c) => t > c.start + 1e-6 && t < c.start + c.duration - 1e-6 && !getTrack(c.trackId)?.locked);
}

/**
 * Apaga a parte do clipe antes (Q, side 'left') ou depois (W, side 'right') do playhead.
 * Com o Modo inserção ligado, os clipes seguintes da track andam para fechar o buraco.
 */
export function trimToPlayhead(side) {
  const t = toFrame(state.time);
  const targets = clipsAtPlayhead(t);
  if (!targets.length) return toast('Posicione o playhead sobre um clipe');
  checkpoint();
  let keep = null;
  for (const clip of targets) {
    const right = splitClip(clip, t);
    if (!right) continue;
    if (side === 'left') {
      // o pedaço que fica herda a entrada do clipe original
      if (clip.animIn) right.animIn = clip.animIn;
      if (clip.textAnim?.in) right.textAnim = { ...right.textAnim, in: clip.textAnim.in };
      const gap = right.start - clip.start;
      removeClip(clip.id);
      if (state.insertMode) {
        for (const c of clipsOnTrack(right.trackId)) if (c.start >= right.start - 1e-6) c.start -= gap;
      }
      keep = right;
    } else {
      if (right.animOut) clip.animOut = right.animOut;
      if (right.textAnim?.out) clip.textAnim = { ...clip.textAnim, out: right.textAnim.out };
      removeClip(right.id);
      if (state.insertMode) rippleRemove(right);
      keep = clip;
    }
  }
  if (keep) state.selection = keep.id;
  if (side === 'left' && state.insertMode && keep) seek(keep.start);
  emit('project');
}

/** Pula para o corte anterior (-1) ou seguinte (+1): começos e fins dos clipes. */
export function jumpToEdit(dir) {
  const points = new Set([0, projectDuration()]);
  for (const c of state.project.clips) {
    if (getTrack(c.trackId)?.hidden) continue;
    points.add(c.start);
    points.add(c.start + c.duration);
  }
  const t = state.time;
  const list = [...points].sort((a, b) => a - b);
  const next = dir > 0 ? list.find((p) => p > t + 1e-4) : [...list].reverse().find((p) => p < t - 1e-4);
  if (next !== undefined) seek(next);
}

export function deleteSelected(ripple = false) {
  const clips = selectedClipIds().map(getClip).filter((c) => c && !getTrack(c.trackId)?.locked);
  if (!clips.length) return;
  checkpoint();
  // o ripple (fechar o buraco) só faz sentido com um clipe
  if (ripple && clips.length === 1) rippleRemove(clips[0]);
  for (const c of clips) removeClip(c.id);
  state.multi = [];
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

export function zoomToFit() {
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
    if (fastMove && patchDraggedClip()) return;
    render();
  });
}

/** Move só o elemento do clipe arrastado (e a linha do ímã). @returns false se precisa do redesenho completo */
function patchDraggedClip() {
  const clip = drag?.clip;
  const el = clip && contentEl.querySelector(`.clip[data-clip-id="${clip.id}"]`);
  if (!el || !el.classList.contains('dragging') || el.closest('.tl-row')?.dataset.trackId !== clip.trackId) return false;
  return timed('timelineFast', () => {
    el.style.left = clip.start * state.zoom + 'px';
    el.classList.toggle('invalid', !!drag.invalid);
    let line = contentEl.querySelector('.snap-line');
    if (drag.snapAt == null) line?.remove();
    else {
      if (!line) contentEl.append((line = h('div.snap-line')));
      line.style.left = HEAD_W + drag.snapAt * state.zoom + 'px';
    }
    return true;
  });
}

function tickInterval(zoom) {
  const steps = [1 / 30, 0.1, 0.25, 0.5, 1, 2, 5, 10, 15, 30, 60, 120, 300, 600];
  return steps.find((s) => s * zoom >= 70) || 600;
}

function render() {
  timed('timeline', renderNow);
}

function renderNow() {
  if (!contentEl) return;
  const zoom = state.zoom;
  const dur = projectDuration();
  const visibleSec = Math.max(1, (scrollEl.clientWidth - HEAD_W) / zoom);
  const totalSec = Math.max(dur + 30, visibleSec + 2);
  const laneW = Math.ceil(totalSec * zoom);
  contentEl.style.width = HEAD_W + laneW + 'px';

  win = visibleWindow(scrollEl.scrollLeft, scrollEl.clientWidth, zoom, HEAD_W);
  const major = tickInterval(zoom);
  const tIndex = transitionIndexFor(state.project, state.rev);
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
  if (tool === 'blade' && bladeAt != null) {
    bladeLine.style.left = HEAD_W + bladeAt * zoom + 'px';
    contentEl.append(bladeLine);
  }
  updatePlayhead(false);
}

function ruler(totalSec, major) {
  const ticks = h('div.tl-ticks');
  const minor = major / (major >= 1 ? 5 : 2);
  // só as marcas da faixa visível: com zoom alto a régua inteira teria dezenas de milhares
  const n = Math.min(Math.ceil(totalSec / minor), Math.ceil(win.t1 / minor));
  for (let i = Math.floor(win.t0 / minor); i <= n; i++) {
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
  const rowH = rowHeight(track);
  // linhas baixas: nome e botões lado a lado; muito baixas: só o nome
  const cls = `div.tl-row${isAudio ? '.audio' : ''}${track.locked ? '.locked' : ''}${track.hidden ? '.hidden-track' : ''}${rowH < 52 ? '.compact' : ''}${rowH < 34 ? '.tiny' : ''}`;
  const lane = h(`div.tl-lane${dropHint === track.id ? '.drop-target' : ''}`, { style: { '--grid': major * state.zoom + 'px' } });
  const clips = clipsOnTrack(track.id);
  // fora da faixa visível só ficam o clipe selecionado e o que está sendo arrastado
  const shown = (c) => (c.start < win.t1 && c.start + c.duration > win.t0) || c.id === state.selection || c.id === drag?.clip?.id;
  for (const clip of clips) if (shown(clip)) lane.append(clipEl(clip, track, tIndex));
  if (!isAudio) {
    const zoom = state.zoom;
    for (const tr of tIndex.transitions) {
      if (tr.trackId !== track.id || tr.from > win.t1 || tr.to < win.t0) continue;
      const name = transitionLabel(tr.spec.type);
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
      if (b.start < win.t0 || b.start > win.t1 || b.transition || Math.abs(a.start + a.duration - b.start) > 0.02) continue;
      lane.append(h('button.trans-add', { dataset: { clipId: b.id }, title: 'Adicionar transição neste corte', style: { left: b.start * zoom + 'px' } }, '⧓'));
    }
  }
  return h(cls, { dataset: { trackId: track.id }, style: { '--row-h': rowH + 'px' } }, trackHead(track), lane);
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
  const grip = h('div.row-resize', { title: 'Arraste para mudar a altura desta track (duplo clique volta ao padrão)', on: { pointerdown: (e) => resizeRow(e, track, grip) } });
  return h('div.tl-head', {}, h('div.name', {}, h('span.dot'), nameInput), btns, grip);
}

/** Arrasta a borda de baixo do cabeçalho para mudar a altura da track. */
let lastGripDown = 0;
function resizeRow(e, track, grip) {
  if (e.button !== 0) return;
  e.preventDefault();
  e.stopPropagation();
  const now = performance.now();
  if (now - lastGripDown < 400) {
    // duplo clique: volta à altura padrão
    lastGripDown = 0;
    if (track.height) { checkpoint(); delete track.height; emit('project'); }
    return;
  }
  lastGripDown = now;
  const row = grip.closest('.tl-row');
  const startY = e.clientY;
  const startH = rowHeight(track);
  let next = startH;
  grip.classList.add('dragging');
  const move = (ev) => {
    next = clamp(startH + ev.clientY - startY, ROW_MIN, ROW_MAX);
    // durante o arrasto só a linha muda de altura; o conteúdo é refeito ao soltar
    row.style.setProperty('--row-h', next + 'px');
  };
  const up = () => {
    window.removeEventListener('pointermove', move);
    grip.classList.remove('dragging');
    if (next === startH) return;
    checkpoint();
    track.height = next;
    emit('project');
  };
  window.addEventListener('pointermove', move);
  window.addEventListener('pointerup', up, { once: true });
}

function clipEl(clip, track, tIndex) {
  const zoom = state.zoom;
  const media = getMedia(clip.mediaId);
  const rt = runtime.get(clip.mediaId);
  const selected = clip.id === state.selection; // principal: mostra keyframes e envelope
  const inSelection = selected || selectedClipIds().includes(clip.id);
  const isDragging = drag?.started && (drag.clip?.id === clip.id || !!drag.group?.some((x) => x.clip.id === clip.id));
  const cls = `div.clip.type-${clip.type}${inSelection ? '.selected' : ''}${isDragging ? '.dragging' : ''}${isDragging && drag.invalid ? '.invalid' : ''}`;
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
      if (!spec || !transitionKnown(spec.type)) continue;
      const ignored = tIndex && (key === 'animIn' ? !tIndex.hasIn(clip) : !tIndex.hasOut(clip));
      el.append(h(`div.anim.${cls}${ignored ? '.ignored' : ''}`, { style: { width: Math.max(4, spec.duration * k * zoom) + 'px' } },
        h('span', {}, transitionLabel(spec.type) + (ignored ? ' (ignorada)' : ''))));
    }
  }

  const hasAudio = clip.type === 'audio' || (clip.type === 'video' && media?.hasAudio && !clip.audioDetached);
  if (hasAudio && (clip.type === 'audio' || selected)) el.append(envelope(clip, w, clipHeight(track)));

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

/** Pontos de encaixe do ímã. ignore: id ou Set de ids de clipes que não contam (os que estão sendo arrastados). */
function snapCandidates(ignore) {
  const skip = ignore instanceof Set ? ignore : new Set([ignore]);
  const c = [0, state.time];
  for (const clip of state.project.clips) {
    if (skip.has(clip.id)) continue;
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
      if (state.selection || state.multi.length) { state.selection = null; state.multi = []; emit('selection'); }
      seek(Math.max(0, timeAt(e.clientX)));
    }
    return;
  }

  const clip = getClip(clipNode.dataset.clipId);
  if (!clip) return;
  if (tool === 'blade') return bladeCut(e, clip);
  // Ctrl/Cmd+clique no corpo do clipe: adiciona/tira da seleção múltipla
  // (nas alças, keyframes e envelope de volume o Ctrl mantém a função de cada um)
  const onBody = !target.classList.contains('handle') && !target.classList.contains('kf') && !target.classList.contains('env-hit') && target.tagName !== 'circle';
  if ((e.ctrlKey || e.metaKey) && onBody) {
    if (!toggleInSelection(clip)) return; // tirou da seleção: nada para arrastar
  } else if (!selectedClipIds().includes(clip.id)) {
    state.selection = clip.id;
    state.multi = [];
    emit('selection');
  } else if (state.selection !== clip.id) {
    // clique num clipe do grupo: ele vira o principal e o grupo continua (para arrastar junto)
    state.selection = clip.id;
    emit('selection');
  }
  const track = getTrack(clip.trackId);
  if (track?.locked) return;
  const clipRect = clipNode.getBoundingClientRect();
  const H = clipHeight(track);
  const base = { clip, x0: e.clientX, y0: e.clientY, clipTop: clipRect.top, H };

  if (target.classList.contains('handle')) {
    return beginDrag(e, { ...base, type: 'trim', side: target.dataset.side, orig: { start: clip.start, duration: clip.duration, inPoint: clip.inPoint, keyframes: snapshotKeyframes(clip) } });
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
  const group = selectedClipIds().map(getClip).filter((c) => c && !getTrack(c.trackId)?.locked);
  beginDrag(e, {
    ...base, type: 'move', orig: { start: clip.start, trackId: clip.trackId },
    group: group.length > 1 && group.includes(clip) ? group.map((c) => ({ clip: c, start: c.start, trackId: c.trackId })) : null,
  });
}

/** Ctrl+clique: alterna o clipe na seleção múltipla. @returns true se o clipe ficou selecionado */
function toggleInSelection(clip) {
  const ids = selectedClipIds();
  const had = ids.includes(clip.id);
  const next = had ? ids.filter((id) => id !== clip.id) : [...ids, clip.id];
  state.selection = had ? next[next.length - 1] || null : clip.id;
  state.multi = next.length > 1 ? next : [];
  emit('selection');
  return !had;
}

/** Arrasto de vários clipes: mesmo deslocamento no tempo e, se couber, nas tracks. */
function moveGroup(e, dx) {
  const g = drag.group;
  const ids = new Set(g.map((x) => x.clip.id));
  const lead = g.find((x) => x.clip === drag.clip) || g[0];
  const minStart = Math.min(...g.map((x) => x.start));
  let delta = Math.max(dx / state.zoom, -minStart);
  // ímã pelas bordas do clipe sob o mouse
  const cands = snapCandidates(ids);
  const s1 = snap(lead.start + delta, cands);
  const s2 = snap(lead.start + lead.clip.duration + delta, cands);
  drag.snapAt = null;
  if (s1.at != null) { delta = s1.value - lead.start; drag.snapAt = s1.at; }
  else if (s2.at != null) { delta = s2.value - lead.clip.duration - lead.start; drag.snapAt = s2.at; }
  delta = Math.max(delta, -minStart);
  // tracks: desloca pelo mesmo número de linhas, se todas as linhas de destino servirem
  const tracks = orderedTracks();
  const row = rowAt(e.clientY);
  const rowDelta = row ? tracks.findIndex((t) => t.id === row.id) - tracks.findIndex((t) => t.id === lead.trackId) : 0;
  const targetOf = (x) => {
    const t = tracks[tracks.findIndex((tr) => tr.id === x.trackId) + rowDelta];
    return t && !t.locked && t.kind === trackKindFor(x.clip.type) ? t.id : null;
  };
  const shiftRows = rowDelta !== 0 && g.every((x) => targetOf(x));
  for (const x of g) {
    x.clip.start = x.start + delta;
    x.clip.trackId = shiftRows ? targetOf(x) : x.trackId;
  }
  drag.insert = false;
  drag.invalid = g.some((x) => state.project.clips.some((o) => !ids.has(o.id) && o.trackId === x.clip.trackId
    && o.start < x.clip.start + x.clip.duration - 1e-6 && o.start + o.duration > x.clip.start + 1e-6));
  fastMove = false;
  emit('project');
}

/** Tempo do corte sob o mouse: encaixa no playhead e nas bordas com o ímã, e no quadro. */
function bladeTime(clientX) {
  const raw = Math.max(0, timeAt(clientX));
  const s = snap(raw, snapCandidates(null));
  return toFrame(s.value);
}

function bladeCut(e, clip) {
  e.preventDefault();
  const t = bladeTime(e.clientX);
  // Shift+clique: corta todas as tracks naquele instante
  const targets = e.shiftKey
    ? state.project.clips.filter((c) => t > c.start + 1e-6 && t < c.start + c.duration - 1e-6 && !getTrack(c.trackId)?.locked)
    : getTrack(clip.trackId)?.locked ? [] : [clip];
  if (!targets.length) return;
  checkpoint();
  let cut = false;
  for (const c of targets) cut = !!splitClip(c, t) || cut;
  if (!cut) return toast('Muito perto da borda do clipe para cortar');
  state.selection = clip.id;
  emit('project');
}

function onBladeHover(e) {
  if (tool !== 'blade' || drag) return;
  if (!e.target.closest('.tl-lane, .clip')) {
    bladeAt = null;
    bladeLine.remove();
    return;
  }
  bladeAt = bladeTime(e.clientX);
  bladeLine.style.left = HEAD_W + bladeAt * state.zoom + 'px';
  if (!bladeLine.isConnected) contentEl.append(bladeLine);
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

  if (drag.type === 'move' && drag.group) return moveGroup(e, dx);
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
    emit('project');
    // sem modo inserção (que desenha o marcador de encaixe), basta mover o elemento do clipe
    fastMove = !drag.insert;
    return;
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
    restoreKeyframes(clip, o.keyframes, -d);
  }
}

function onPointerUp() {
  window.removeEventListener('pointermove', onPointerMove);
  const d = drag;
  drag = null;
  if (!d || !d.started) return render();
  if (d.type === 'move' && d.group) {
    if (d.invalid) {
      for (const x of d.group) { x.clip.start = x.start; x.clip.trackId = x.trackId; }
      toast('Sobreposição: os clipes selecionados voltaram para o lugar');
    }
  } else if (d.type === 'move') {
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
  let comps = [];
  if (mediaId) list = [getMedia(mediaId)].filter(Boolean);
  else if (e.dataTransfer.files.length) {
    const result = await importFiles([...e.dataTransfer.files]);
    list = result.media;
    comps = result.comps;
    if (comps.length) import('./mediaPanel.js').then((m) => m.reportImport(result));
  }
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
  // SVGs e composições exportadas entram como clipes de composição
  for (const comp of comps) {
    let trackId = target === 'new' ? null : target;
    if (target === 'new') {
      checkpoint();
      trackId = addTrack('visual').id;
    }
    const clip = placeComp(comp, trackId, at);
    if (clip) at = clip.start + clip.duration;
  }
}

export { MEDIA_MIME, COMP_MIME };
