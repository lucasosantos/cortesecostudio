// Ações compartilhadas do workspace de motion: tempo, seleção e operações sobre camadas e keyframes.
import { state, emit, checkpoint, uid } from '../../state/project.js';
import { removeKeyframe, setKeyframe, valueAt, keyframeAt } from '../../state/keyframes.js';
import {
  currentComp, getLayer, createLayer, removeLayers, duplicateLayers, moveLayer, selectedLayers, isDescendant,
} from '../../motion/model.js';
import { pause } from '../../engine/player.js';
import { toast } from '../util.js';

export const M = () => state.motion;
export const fps = () => state.project.settings.fps || 30;
/** Arredonda um tempo para o frame mais próximo. */
export const snapFrame = (t) => Math.round(t * fps()) / fps();

// ---------------------------------------------------------------- tempo
let wallStart = 0;
let timeStart = 0;

export function seekMotion(t) {
  const comp = currentComp();
  const m = M();
  m.time = Math.min(Math.max(0, t), comp ? comp.duration : 0);
  if (m.playing) {
    timeStart = m.time;
    wallStart = performance.now();
  }
  emit('motion-time');
}

export function playMotion() {
  const comp = currentComp();
  const m = M();
  if (!comp || m.playing) return;
  if (m.time >= comp.duration - 1 / fps()) m.time = 0;
  m.playing = true;
  timeStart = m.time;
  wallStart = performance.now();
  emit('motion');
}

export function pauseMotion() {
  const m = M();
  if (!m.playing) return;
  m.playing = false;
  m.time = snapFrame(m.time);
  emit('motion');
  emit('motion-time');
}

export const toggleMotionPlay = () => (M().playing ? pauseMotion() : playMotion());

/** Avança o relógio (em laço); chamado a cada frame de animação pelo palco. */
export function tickMotion() {
  const comp = currentComp();
  const m = M();
  if (!m.playing || !comp) return;
  let t = timeStart + (performance.now() - wallStart) / 1000;
  if (t >= comp.duration) {
    t = 0;
    timeStart = 0;
    wallStart = performance.now();
  }
  m.time = t;
  emit('motion-time');
}

export const stepFrame = (dir) => { pauseMotion(); seekMotion(snapFrame(M().time) + dir / fps()); };

// ---------------------------------------------------------------- seleção
export function selectLayers(ids, { toggle = false } = {}) {
  const m = M();
  if (toggle) {
    for (const id of ids) {
      if (m.selection.includes(id)) m.selection = m.selection.filter((x) => x !== id);
      else m.selection = [...m.selection, id];
    }
  } else {
    m.selection = [...ids];
  }
  m.keySel = [];
  if (m.pathEdit && !(m.selection.length === 1 && m.selection[0] === m.pathEdit.layerId)) m.pathEdit = null;
  emit('motion');
}

export function setTool(tool) {
  const m = M();
  if (m.tool === tool) return;
  m.tool = tool;
  emit('motion');
}

/** Camadas selecionadas que podem ser alteradas (não travadas). */
export const editableSelection = () => selectedLayers().filter((l) => !l.locked);

/** Selecionadas sem as que já são movidas junto com um ancestral também selecionado. */
export function topLevelSelection() {
  const comp = currentComp();
  const sel = editableSelection();
  return sel.filter((l) => !sel.some((o) => o !== l && isDescendant(comp, l, o.id)));
}

// ---------------------------------------------------------------- camadas
export function addLayer(type, opts = {}) {
  const comp = currentComp();
  if (!comp) return null;
  checkpoint();
  const layer = createLayer(comp, type, opts);
  M().selection = [layer.id];
  M().keySel = [];
  emit('project');
  emit('motion');
  return layer;
}

export function deleteSelection() {
  const comp = currentComp();
  const m = M();
  if (!comp) return;
  if (m.keySel.length) {
    checkpoint();
    for (const k of m.keySel) {
      const layer = getLayer(comp, k.layerId);
      if (layer && !layer.locked) removeKeyframe(layer, k.prop, k.t);
    }
    m.keySel = [];
    emit('project');
    return;
  }
  const ids = editableSelection().map((l) => l.id);
  if (!ids.length) return;
  checkpoint();
  removeLayers(comp, ids, m.time);
  m.pathEdit = null;
  emit('project');
  emit('motion');
}

export function duplicateSelection() {
  const comp = currentComp();
  const ids = M().selection;
  if (!comp || !ids.length) return;
  checkpoint();
  const copies = duplicateLayers(comp, ids);
  M().selection = copies.map((l) => l.id);
  emit('project');
  emit('motion');
}

export function reorderSelection(dir) {
  const comp = currentComp();
  if (!comp || !M().selection.length) return;
  checkpoint();
  // ao descer, processa de baixo para cima para as camadas não se ultrapassarem
  const list = comp.layers.filter((l) => M().selection.includes(l.id));
  if (dir > 0) list.reverse();
  for (const l of list) {
    const i = comp.layers.indexOf(l);
    const neighbour = comp.layers[i + dir];
    if (neighbour && !M().selection.includes(neighbour.id)) moveLayer(comp, l.id, dir);
  }
  emit('project');
}

let clipboard = [];
export function copySelection() {
  clipboard = JSON.parse(JSON.stringify(selectedLayers()));
  return clipboard.length;
}

export function pasteLayers() {
  const comp = currentComp();
  if (!comp || !clipboard.length) return;
  checkpoint();
  const map = new Map();
  const copies = JSON.parse(JSON.stringify(clipboard)).map((l) => {
    const id = uid('l');
    map.set(l.id, id);
    return { ...l, id };
  });
  for (const l of copies) {
    // referências a camadas copiadas junto apontam para as cópias; as demais só valem se existirem aqui
    const ref = (id) => map.get(id) || (getLayer(comp, id) ? id : null);
    l.parentId = l.parentId ? ref(l.parentId) : null;
    if (l.matte) {
      const target = ref(l.matte.layerId);
      l.matte = target ? { ...l.matte, layerId: target } : null;
    }
    l.out = Math.min(l.out, comp.duration);
    l.in = Math.min(l.in, Math.max(0, l.out - 1 / fps()));
  }
  comp.layers.unshift(...copies);
  M().selection = copies.map((l) => l.id);
  M().keySel = [];
  emit('project');
  emit('motion');
  toast(`${copies.length} camada(s) colada(s)`);
}

// ---------------------------------------------------------------- keyframes
export const isKeySelected = (layerId, prop, t) => M().keySel.some((k) => k.layerId === layerId && k.prop === prop && Math.abs(k.t - t) < 1e-4);

/** Keyframes alvo das ações de easing: os selecionados ou, se não houver, os do playhead nas camadas selecionadas. */
export function targetKeyframes() {
  const comp = currentComp();
  const m = M();
  if (!comp) return [];
  const out = [];
  if (m.keySel.length) {
    for (const k of m.keySel) {
      const layer = getLayer(comp, k.layerId);
      const kf = layer && keyframeAt(layer, k.prop, k.t);
      if (kf) out.push({ layer, prop: k.prop, kf });
    }
    return out;
  }
  for (const layer of selectedLayers(comp)) {
    for (const prop of Object.keys(layer.keyframes || {})) {
      const kf = keyframeAt(layer, prop, m.time);
      if (kf) out.push({ layer, prop, kf });
    }
  }
  return out;
}

/** Liga/desliga o keyframe da propriedade no playhead. */
export function toggleKeyframe(layer, prop) {
  const t = M().time;
  checkpoint();
  if (keyframeAt(layer, prop, t)) removeKeyframe(layer, prop, t);
  else setKeyframe(layer, prop, t, valueAt(layer, prop, t));
  emit('project');
}

// ---------------------------------------------------------------- modo
/** Abre a composição no workspace de motion. */
export function openComp(compId) {
  const comp = state.project.comps?.find((c) => c.id === compId);
  if (!comp) return;
  const m = M();
  if (m.compId !== compId) Object.assign(m, { compId, selection: [], keySel: [], pathEdit: null, time: 0, playing: false, tool: 'select' });
  pause(); // a timeline principal não toca enquanto se edita a composição
  state.mode = 'motion';
  emit('mode');
  emit('motion');
}

const exitHooks = [];
/** Registra algo a concluir antes de sair do modo motion (p.ex. o desenho em andamento da caneta). */
export const onBeforeExit = (fn) => exitHooks.push(fn);

export function exitMotion() {
  if (state.mode !== 'motion') return;
  for (const fn of exitHooks) fn();
  pauseMotion();
  M().pathEdit = null;
  state.mode = 'edit';
  emit('mode');
  emit('project');
}

// ---------------------------------------------------------------- mover trajetória
const PATH_KEY = 'corteseco.motion.movePath';
let movePath = (() => {
  try { return typeof localStorage !== 'undefined' && localStorage.getItem(PATH_KEY) === '1'; } catch { return false; }
})();
/** Modo "mover trajetória": arrastar/setas deslocam todos os keyframes de posição juntos. */
export const movePathMode = () => movePath;
export function setMovePathMode(on) {
  movePath = !!on;
  try { localStorage.setItem(PATH_KEY, movePath ? '1' : '0'); } catch { /* vale só nesta sessão */ }
  emit('motion');
}
