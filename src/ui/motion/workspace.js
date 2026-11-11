// Workspace de motion: inicializa palco, timeline de camadas e inspector, alterna o modo e trata os atalhos.
import { state, emit, subscribe, checkpoint } from '../../state/project.js';
import { setProp, valueAt } from '../../state/keyframes.js';
import { IDENTITY, invert, applyVec } from '../../motion/geometry.js';
import { currentComp, parentMatrix } from '../../motion/model.js';
import {
  M, openComp, exitMotion, toggleMotionPlay, seekMotion, stepFrame, selectLayers, deleteSelection, duplicateSelection,
  copySelection, pasteLayers, topLevelSelection,
} from './actions.js';
import { initStage, chooseTool, fitView } from './stage.js';
import { initLayerTimeline } from './layerTimeline.js';
import { initMotionInspector } from './motionInspector.js';
import * as pen from './penTool.js';
import { openNewComp } from '../dialogs.js';

const TOOL_KEYS = { v: 'select', y: 'anchor', h: 'hand', r: 'rect', o: 'ellipse', g: 'polygon', e: 'star', l: 'line', t: 'text', p: 'pen' };

export function initMotion() {
  initStage(document.getElementById('motion-stage-panel'));
  initLayerTimeline(document.getElementById('motion-timeline'));
  initMotionInspector(document.getElementById('motion-inspector'));
  subscribe((reason) => {
    if (reason === 'mode' || reason === 'project') syncMode();
  });
  syncMode();
}

function syncMode() {
  // sem composição aberta não há o que mostrar no modo motion
  if (state.mode === 'motion' && !currentComp()) state.mode = 'edit';
  const motion = state.mode === 'motion';
  document.body.classList.toggle('mode-motion', motion);
  document.getElementById('mode-edit')?.classList.toggle('active', !motion);
  document.getElementById('mode-motion')?.classList.toggle('active', motion);
}

/** Aba "Motion": abre a composição em uso, a mais recente ou o diálogo de nova composição. */
export function enterMotion() {
  const comps = state.project.comps || [];
  const comp = currentComp() || comps[comps.length - 1];
  if (comp) openComp(comp.id);
  else openNewComp();
}

export { exitMotion };

function nudge(dx, dy) {
  const comp = currentComp();
  const items = topLevelSelection();
  if (!comp || !items.length) return false;
  checkpoint();
  const t = M().time;
  for (const layer of items) {
    // o deslocamento é em pixels da composição; a posição da camada é relativa ao pai
    const inv = invert(parentMatrix(comp, layer, t)) || IDENTITY;
    const [lx, ly] = applyVec(inv, dx, dy);
    setProp(layer, 'x', Math.round((valueAt(layer, 'x', t) + lx) * 100) / 100, t, state.autoKey);
    setProp(layer, 'y', Math.round((valueAt(layer, 'y', t) + ly) * 100) / 100, t, state.autoKey);
  }
  emit('project');
  return true;
}

/** Atalhos do modo motion. Retorna true se a tecla foi tratada. */
export function handleMotionKey(e) {
  const comp = currentComp();
  if (!comp) return false;
  if (pen.handleKey(e)) return true;
  const ctrl = e.ctrlKey || e.metaKey;
  const key = e.key.toLowerCase();
  const m = M();
  const step = e.shiftKey ? 10 : 1;

  if (ctrl) {
    if (key === 'd') duplicateSelection();
    else if (key === 'c') copySelection();
    else if (key === 'x') { if (copySelection()) { m.keySel = []; deleteSelection(); } }
    else if (key === 'v') pasteLayers();
    else if (key === 'a') selectLayers(comp.layers.filter((l) => !l.locked).map((l) => l.id));
    else return false;
    return true;
  }
  if (key === ' ') toggleMotionPlay();
  else if (TOOL_KEYS[key]) chooseTool(TOOL_KEYS[key]);
  else if (key === 'delete' || key === 'backspace') deleteSelection();
  else if (key === 'arrowleft') { if (!nudge(-step, 0)) stepFrame(-1); }
  else if (key === 'arrowright') { if (!nudge(step, 0)) stepFrame(1); }
  else if (key === 'arrowup') { if (!nudge(0, -step)) return false; }
  else if (key === 'arrowdown') { if (!nudge(0, step)) return false; }
  else if (key === ',') stepFrame(-1);
  else if (key === '.') stepFrame(1);
  else if (key === 'home') seekMotion(0);
  else if (key === 'end') seekMotion(comp.duration);
  else if (key === '0') fitView();
  else if (key === 'escape') {
    if (m.tool !== 'select') chooseTool('select');
    else if (m.selection.length || m.keySel.length) selectLayers([]);
    else exitMotion();
  } else return false;
  return true;
}
