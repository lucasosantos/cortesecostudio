// Palco do workspace de motion: vista com pan/zoom, seleção, gizmo de transformação e ferramentas de criação.
import { state, emit, subscribe, checkpoint, getMedia } from '../../state/project.js';
import { setProp, valueAt } from '../../state/keyframes.js';
import { runtime } from '../../media/library.js';
import { drawComp } from '../../motion/render.js';
import { IDENTITY, apply, applyVec, invert, trs, shapePath, trace } from '../../motion/geometry.js';
import {
  currentComp, layerPropsAt, localBounds, worldMatrix, parentMatrix, layerActive, createLayer,
} from '../../motion/model.js';
import {
  M, tickMotion, selectLayers, setTool, addLayer, topLevelSelection, toggleMotionPlay, seekMotion, stepFrame, fps,
} from './actions.js';
import * as pen from './penTool.js';
import { h, toast, formatTime, clamp } from '../util.js';
import { MEDIA_MIME } from '../timeline.js';
import { importSvg } from '../../motion/svgImport.js';
import { count, timed } from '../../perf.js';

const TOOLS = [
  ['select', '⬉', 'Selecionar e transformar (V)'],
  ['anchor', '⌖', 'Mover o ponto de âncora (Y)'],
  ['hand', '✋', 'Mover a vista (H) — também com o botão do meio'],
  null,
  ['rect', '▭', 'Retângulo (R)'],
  ['ellipse', '◯', 'Elipse (O)'],
  ['polygon', '⬠', 'Polígono (G)'],
  ['star', '★', 'Estrela (E)'],
  ['line', '╱', 'Linha (L)'],
  ['text', 'T', 'Texto (T)'],
  ['pen', '✒', 'Caneta: desenhar caminho (P)'],
];
const SHAPE_TOOLS = ['rect', 'ellipse', 'polygon', 'star', 'line'];
const HINTS = {
  select: 'Clique para selecionar · arraste para mover · alças redimensionam · círculo gira · duplo clique num caminho edita os pontos',
  anchor: 'Arraste para reposicionar a âncora da camada selecionada (Alt desliga o ímã)',
  hand: 'Arraste para mover a vista · roda do mouse dá zoom',
  text: 'Clique onde o texto deve ficar',
  pen: 'Clique cria pontos · arraste cria curvas · clique no primeiro ponto fecha · Enter termina',
};
const ACCENT = '#4f8cff';

let panel, stageEl, canvas, ctx, toolsEl, hintEl, tcEl, playBtn, zoomLabel, emptyEl;
let hitCtx;
let dpr = 1;
let view = { zoom: 1, x: 0, y: 0 };
let fittedFor = null;
let drag = null;
let gizmo = [];
let hover = null; // última posição do ponteiro (para o elástico da caneta)
let checker = null;
let dirty = true; // o palco só é redesenhado quando algo mudou
const invalidate = () => { dirty = true; };

export function initStage(el) {
  panel = el;
  toolsEl = h('div.motion-tools');
  canvas = h('canvas');
  emptyEl = h('div.motion-empty', {}, 'Nenhuma composição aberta.');
  stageEl = h('div.motion-stage', {}, canvas, emptyEl);
  tcEl = h('span.timecode');
  playBtn = h('button.play', { title: 'Play/Pausa (Espaço)', on: { click: toggleMotionPlay } }, '▶');
  const transport = h('div.transport', {},
    h('button', { title: 'Início (Home)', on: { click: () => seekMotion(0) } }, '⏮'),
    h('button', { title: 'Frame anterior (,)', on: { click: () => stepFrame(-1) } }, '◂'),
    playBtn,
    h('button', { title: 'Próximo frame (.)', on: { click: () => stepFrame(1) } }, '▸'),
    h('button', { title: 'Fim (End)', on: { click: () => seekMotion(currentComp()?.duration || 0) } }, '⏭'),
    tcEl,
  );
  panel.append(toolsEl, stageEl, transport);
  ctx = canvas.getContext('2d');
  hitCtx = document.createElement('canvas').getContext('2d');
  buildTools();

  new ResizeObserver(resize).observe(stageEl);
  canvas.addEventListener('pointerdown', onPointerDown);
  canvas.addEventListener('pointermove', onPointerMove);
  canvas.addEventListener('pointerup', onPointerUp);
  canvas.addEventListener('pointercancel', onPointerUp);
  canvas.addEventListener('dblclick', onDoubleClick);
  canvas.addEventListener('wheel', onWheel, { passive: false });
  canvas.addEventListener('contextmenu', (e) => e.preventDefault());
  stageEl.addEventListener('dragover', onDragOver);
  stageEl.addEventListener('dragleave', () => stageEl.classList.remove('drop-target'));
  stageEl.addEventListener('drop', onDrop);

  subscribe((reason) => {
    dirty = true;
    if (reason === 'motion' || reason === 'mode') syncTools();
  });
  for (const ev of ['pointerdown', 'pointermove', 'pointerup', 'pointercancel', 'pointerleave', 'dblclick', 'wheel']) canvas.addEventListener(ev, invalidate, { passive: true });
  syncTools();
  requestAnimationFrame(loop);
}

function buildTools() {
  const btns = TOOLS.map((tool) => {
    if (!tool) return h('div.sep');
    const [id, glyph, title] = tool;
    return h('button', { title, dataset: { tool: id }, on: { click: () => chooseTool(id) } }, glyph);
  });
  zoomLabel = h('button', { title: 'Ajustar a composição à vista (0)', on: { click: fitView } }, '100%');
  hintEl = h('span.hint');
  toolsEl.append(...btns, h('div.sep'), zoomLabel, hintEl);
}

/** Troca de ferramenta, encerrando o desenho com a caneta se houver um em andamento. */
export function chooseTool(id) {
  if (id !== 'pen') pen.finishDrawing();
  if (id !== 'select' && id !== 'pen') pen.exitEdit();
  setTool(id);
}

function syncTools() {
  const m = M();
  for (const b of toolsEl.querySelectorAll('[data-tool]')) b.classList.toggle('active', b.dataset.tool === m.tool);
  hintEl.textContent = m.pathEdit && !m.pathEdit.drawing
    ? 'Editando pontos: arraste pontos e alças · clique no traço cria ponto · Alt+clique alterna canto/curva · Del remove · Esc sai'
    : HINTS[m.tool] || 'Arraste no palco para desenhar (Shift mantém a proporção) · clique cria no tamanho padrão';
  playBtn.textContent = m.playing ? '❚❚' : '▶';
  canvas.style.cursor = m.tool === 'hand' ? 'grab' : m.tool === 'select' ? 'default' : 'crosshair';
  emptyEl.style.display = currentComp() ? 'none' : '';
}

// ---------------------------------------------------------------- vista
function resize() {
  dpr = window.devicePixelRatio || 1;
  const r = stageEl.getBoundingClientRect();
  canvas.width = Math.max(1, Math.round(r.width * dpr));
  canvas.height = Math.max(1, Math.round(r.height * dpr));
  checker = null;
  fittedFor = null;
  dirty = true;
}

export function fitView() {
  const comp = currentComp();
  if (!comp) return;
  const r = stageEl.getBoundingClientRect();
  const z = Math.max(0.01, Math.min((r.width - 48) / comp.width, (r.height - 48) / comp.height));
  view = { zoom: z, x: (r.width - comp.width * z) / 2, y: (r.height - comp.height * z) / 2 };
  dirty = true;
}

const toScreen = (cx, cy) => [cx * view.zoom + view.x, cy * view.zoom + view.y];

function eventPos(e) {
  const r = canvas.getBoundingClientRect();
  const sx = e.clientX - r.left;
  const sy = e.clientY - r.top;
  return { sx, sy, cx: (sx - view.x) / view.zoom, cy: (sy - view.y) / view.zoom };
}

function onWheel(e) {
  if (!currentComp()) return;
  e.preventDefault();
  const pos = eventPos(e);
  const z = clamp(view.zoom * Math.exp(-e.deltaY * 0.0015), 0.02, 40);
  view = { zoom: z, x: pos.sx - pos.cx * z, y: pos.sy - pos.cy * z };
}

/** O que a caneta precisa saber do palco. */
const api = {
  toScreen,
  get zoom() { return view.zoom; },
  get hover() { return hover; },
  get dpr() { return dpr; },
};

// ---------------------------------------------------------------- desenho
const getImage = (item) => runtime.get(item.mediaId)?.image || null;

function loop() {
  requestAnimationFrame(loop);
  if (state.mode !== 'motion') return;
  count('stageRaf');
  tickMotion();
  if (!dirty) return;
  dirty = false;
  timed('stageDraw', draw);
}

function draw() {
  const comp = currentComp();
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.globalAlpha = 1;
  ctx.fillStyle = '#0d0e11';
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  gizmo = [];
  if (!comp) return;
  const key = `${comp.id}:${comp.width}x${comp.height}:${canvas.width}x${canvas.height}`;
  if (fittedFor !== key) {
    fittedFor = key;
    fitView();
  }
  const z = view.zoom;
  const t = M().time;

  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  if (!checker) {
    const c = document.createElement('canvas');
    c.width = c.height = 20;
    const g = c.getContext('2d');
    g.fillStyle = '#16171b';
    g.fillRect(0, 0, 20, 20);
    g.fillStyle = '#1b1d22';
    g.fillRect(0, 0, 10, 10);
    g.fillRect(10, 10, 10, 10);
    checker = ctx.createPattern(c, 'repeat');
  }
  ctx.fillStyle = checker;
  ctx.fillRect(view.x, view.y, comp.width * z, comp.height * z);

  ctx.setTransform(dpr * z, 0, 0, dpr * z, dpr * view.x, dpr * view.y);
  drawComp(ctx, comp, t, getImage);

  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.strokeStyle = '#3a3e49';
  ctx.lineWidth = 1;
  ctx.strokeRect(Math.round(view.x) - 0.5, Math.round(view.y) - 0.5, Math.round(comp.width * z) + 1, Math.round(comp.height * z) + 1);

  drawOverlay(comp, t);
  tcEl.textContent = `${formatTime(t, fps())} / ${formatTime(comp.duration, fps())}`;
  zoomLabel.textContent = `${Math.round(z * 100)}%`;
}

/** Cantos e pontos médios da caixa da camada em coordenadas de tela. */
function boxPoints(comp, layer, t, cache) {
  const p = layerPropsAt(layer, t);
  const b = localBounds(layer, p);
  const m = worldMatrix(comp, layer, t, cache);
  const at = (u, v) => toScreen(...apply(m, b.x + b.w * u, b.y + b.h * v));
  return { p, b, m, at };
}

function drawOverlay(comp, t) {
  const m = M();
  const cache = new Map();
  const sel = comp.layers.filter((l) => m.selection.includes(l.id));
  ctx.lineWidth = 1.5;
  for (const layer of sel) {
    if (m.pathEdit?.layerId === layer.id) continue;
    const { at } = boxPoints(comp, layer, t, cache);
    ctx.strokeStyle = ACCENT;
    ctx.globalAlpha = layerActive(layer, t) && !layer.hidden ? 1 : 0.4;
    ctx.beginPath();
    if (layer.type === 'shape' && layer.shape === 'line') {
      const { p, m: wm } = boxPoints(comp, layer, t, cache);
      ctx.moveTo(...toScreen(...apply(wm, 0, 0)));
      ctx.lineTo(...toScreen(...apply(wm, p.w, p.h)));
    } else {
      ctx.moveTo(...at(0, 0));
      ctx.lineTo(...at(1, 0));
      ctx.lineTo(...at(1, 1));
      ctx.lineTo(...at(0, 1));
      ctx.closePath();
    }
    ctx.stroke();
  }
  ctx.globalAlpha = 1;

  const single = sel.length === 1 ? sel[0] : null;
  if (single && !single.locked && !m.pathEdit && (m.tool === 'select' || m.tool === 'anchor')) drawGizmo(comp, single, t, cache);
  pen.drawOverlay(ctx, api);
}

function drawGizmo(comp, layer, t, cache) {
  const tool = M().tool;
  const { p, m, at } = boxPoints(comp, layer, t, cache);
  const anchor = toScreen(...apply(m, p.ax, p.ay));

  if (tool === 'select') {
    const isLine = layer.type === 'shape' && layer.shape === 'line';
    const parametric = layer.type === 'shape' && !['path', 'line'].includes(layer.shape);
    if (isLine) {
      gizmo.push({ kind: 'end', i: 0, pos: toScreen(...apply(m, 0, 0)) }, { kind: 'end', i: 1, pos: toScreen(...apply(m, p.w, p.h)) });
    } else {
      for (const [hx, hy] of [[-1, -1], [0, -1], [1, -1], [1, 0], [1, 1], [0, 1], [-1, 1], [-1, 0]]) {
        gizmo.push({ kind: parametric ? 'size' : 'scale', hx, hy, pos: at((hx + 1) / 2, (hy + 1) / 2) });
      }
    }
    // alça de rotação: para fora da borda superior
    const top = at(0.5, 0);
    const center = at(0.5, 0.5);
    let nx = top[0] - center[0];
    let ny = top[1] - center[1];
    const len = Math.hypot(nx, ny);
    if (len < 1e-3) { nx = 0; ny = -1; } else { nx /= len; ny /= len; }
    const rot = [top[0] + nx * 26, top[1] + ny * 26];
    ctx.strokeStyle = ACCENT;
    ctx.beginPath();
    ctx.moveTo(...top);
    ctx.lineTo(...rot);
    ctx.stroke();
    gizmo.push({ kind: 'rotate', pos: rot });

    for (const g of gizmo) {
      ctx.fillStyle = '#fff';
      ctx.strokeStyle = ACCENT;
      ctx.beginPath();
      if (g.kind === 'rotate') ctx.arc(g.pos[0], g.pos[1], 5.5, 0, Math.PI * 2);
      else ctx.rect(g.pos[0] - 4.5, g.pos[1] - 4.5, 9, 9);
      ctx.fill();
      ctx.stroke();
    }
  }

  // ponto de âncora
  ctx.strokeStyle = tool === 'anchor' ? '#ffd24a' : ACCENT;
  ctx.fillStyle = 'rgba(13,14,17,.6)';
  ctx.beginPath();
  ctx.arc(anchor[0], anchor[1], 5, 0, Math.PI * 2);
  ctx.fill();
  ctx.stroke();
  ctx.beginPath();
  ctx.moveTo(anchor[0] - 9, anchor[1]);
  ctx.lineTo(anchor[0] + 9, anchor[1]);
  ctx.moveTo(anchor[0], anchor[1] - 9);
  ctx.lineTo(anchor[0], anchor[1] + 9);
  ctx.stroke();
}

// ---------------------------------------------------------------- acerto do ponteiro
function hitGizmo(pos) {
  for (let i = gizmo.length - 1; i >= 0; i--) {
    const g = gizmo[i];
    if (Math.hypot(g.pos[0] - pos.sx, g.pos[1] - pos.sy) <= 8) return g;
  }
  return null;
}

/** Camada mais à frente sob o ponto (coordenadas da composição). */
export function hitLayer(cx, cy) {
  const comp = currentComp();
  if (!comp) return null;
  const t = M().time;
  const cache = new Map();
  const matteIds = new Set(comp.layers.filter((l) => l.matte && !l.hidden).map((l) => l.matte.layerId));
  for (const layer of comp.layers) {
    if (layer.hidden || layer.locked || matteIds.has(layer.id) || !layerActive(layer, t)) continue;
    const wm = worldMatrix(comp, layer, t, cache);
    const inv = invert(wm);
    if (!inv) continue;
    const [lx, ly] = apply(inv, cx, cy);
    const p = layerPropsAt(layer, t);
    if (layer.type === 'shape') {
      // tolerância de ~6 px de tela convertida para unidades locais
      const scale = Math.sqrt(Math.abs(wm[0] * wm[3] - wm[1] * wm[2])) || 1;
      const tol = 6 / (view.zoom * scale);
      hitCtx.beginPath();
      trace(hitCtx, shapePath(layer, p));
      hitCtx.lineWidth = Math.max(layer.strokeOn ? p.strokeWidth : 0, tol * 2);
      if ((layer.fillOn && hitCtx.isPointInPath(lx, ly, layer.fillRule === 'evenodd' ? 'evenodd' : 'nonzero')) || hitCtx.isPointInStroke(lx, ly)) return layer;
    } else {
      const b = localBounds(layer, p);
      if (lx >= b.x && lx <= b.x + b.w && ly >= b.y && ly <= b.y + b.h) return layer;
    }
  }
  return null;
}

// ---------------------------------------------------------------- ponteiro
function onPointerDown(e) {
  const comp = currentComp();
  if (!comp) return;
  const pos = eventPos(e);
  const m = M();
  canvas.setPointerCapture(e.pointerId);
  if (e.button === 1 || (e.button === 0 && m.tool === 'hand')) {
    e.preventDefault();
    drag = startPan(pos);
    return;
  }
  if (e.button !== 0) return;
  e.preventDefault();
  document.activeElement?.blur?.();

  if (m.tool === 'pen' || m.pathEdit) {
    drag = pen.pointerDown(e, pos, api);
    return;
  }
  if (SHAPE_TOOLS.includes(m.tool)) {
    drag = startCreate(comp, m.tool, pos);
    return;
  }
  if (m.tool === 'text') {
    addLayer('text', { x: pos.cx, y: pos.cy });
    setTool('select');
    focusTextInput();
    return;
  }

  const sel = comp.layers.filter((l) => m.selection.includes(l.id));
  const single = sel.length === 1 && !sel[0].locked ? sel[0] : null;
  if (m.tool === 'anchor') {
    if (single) drag = startAnchor(comp, single, pos, e);
    else toast('Selecione uma camada para mover a âncora');
    return;
  }
  const g = single ? hitGizmo(pos) : null;
  if (g) {
    drag = g.kind === 'rotate' ? startRotate(comp, single, pos) : g.kind === 'scale' ? startScale(comp, single, g, pos) : startSize(comp, single, g, pos);
    return;
  }
  const hit = hitLayer(pos.cx, pos.cy);
  if (!hit) {
    if (!e.shiftKey && m.selection.length) selectLayers([]);
    return;
  }
  if (e.shiftKey) selectLayers([hit.id], { toggle: true });
  else if (!m.selection.includes(hit.id)) selectLayers([hit.id]);
  drag = startMove(comp, pos);
}

function onPointerMove(e) {
  const pos = eventPos(e);
  hover = pos;
  if (drag) drag.move?.(e, pos);
}

function onPointerUp(e) {
  const d = drag;
  drag = null;
  if (canvas.hasPointerCapture?.(e.pointerId)) canvas.releasePointerCapture(e.pointerId);
  d?.up?.(e, eventPos(e));
}

function onDoubleClick(e) {
  const comp = currentComp();
  if (!comp) return;
  const pos = eventPos(e);
  if (pen.doubleClick(e, pos, api)) return;
  if (M().tool !== 'select') return;
  const hit = hitLayer(pos.cx, pos.cy);
  if (!hit) return;
  if (hit.type === 'text') {
    selectLayers([hit.id]);
    focusTextInput();
  } else if (hit.type === 'shape' && hit.shape === 'path') {
    pen.enterEdit(hit);
  }
}

function focusTextInput() {
  setTimeout(() => {
    const ta = document.querySelector('#motion-inspector textarea');
    if (ta) { ta.focus(); ta.select(); }
  }, 30);
}

/** Só começa de fato depois de alguns pixels, para um clique não virar arrasto. */
function threshold(pos, onStart) {
  let started = false;
  return (cur) => {
    if (started) return true;
    if (Math.hypot(cur.sx - pos.sx, cur.sy - pos.sy) < 3) return false;
    started = true;
    onStart?.();
    return true;
  };
}

const round2 = (v) => Math.round(v * 100) / 100;
const setLayerProp = (layer, prop, v) => setProp(layer, prop, typeof v === 'number' ? round2(v) : v, M().time, state.autoKey);

function startPan(pos) {
  const start = { ...view };
  canvas.style.cursor = 'grabbing';
  return {
    move: (e, cur) => { view = { zoom: start.zoom, x: start.x + cur.sx - pos.sx, y: start.y + cur.sy - pos.sy }; },
    up: syncTools,
  };
}

function startMove(comp, pos) {
  const t = M().time;
  const items = topLevelSelection().map((layer) => ({
    layer,
    x: valueAt(layer, 'x', t),
    y: valueAt(layer, 'y', t),
    pm: parentMatrix(comp, layer, t),
  }));
  if (!items.length) return null;
  const begin = threshold(pos, checkpoint);
  return {
    move(e, cur) {
      if (!begin(cur)) return;
      let dx = cur.cx - pos.cx;
      let dy = cur.cy - pos.cy;
      if (e.shiftKey) {
        if (Math.abs(dx) > Math.abs(dy)) dy = 0;
        else dx = 0;
      }
      if (!e.altKey) {
        // ímã: a âncora da primeira camada gruda no centro e nas bordas da composição
        const [wx, wy] = apply(items[0].pm, items[0].x, items[0].y);
        const thr = 6 / view.zoom;
        for (const target of [0, comp.width / 2, comp.width]) if (Math.abs(wx + dx - target) < thr) dx = target - wx;
        for (const target of [0, comp.height / 2, comp.height]) if (Math.abs(wy + dy - target) < thr) dy = target - wy;
      }
      for (const it of items) {
        const inv = invert(it.pm) || IDENTITY;
        const [lx, ly] = applyVec(inv, dx, dy);
        setLayerProp(it.layer, 'x', it.x + lx);
        setLayerProp(it.layer, 'y', it.y + ly);
      }
      emit('project');
    },
  };
}

/** Redimensiona uma forma paramétrica mudando largura/altura e mantendo o lado oposto parado. */
function startSize(comp, layer, g, pos) {
  const t = M().time;
  const p0 = layerPropsAt(layer, t);
  const inv = invert(worldMatrix(comp, layer, t));
  if (!inv) return null;
  const local0 = trs(p0);
  const begin = threshold(pos, checkpoint);
  return {
    move(e, cur) {
      if (!begin(cur)) return;
      const [lx, ly] = apply(inv, cur.cx, cur.cy);
      let x0 = 0;
      let y0 = 0;
      let w;
      let hgt;
      if (g.kind === 'end') {
        // extremidades da linha
        let ex = g.i ? lx : p0.w;
        let ey = g.i ? ly : p0.h;
        if (!g.i) { x0 = lx; y0 = ly; }
        if (e.shiftKey) {
          // trava em múltiplos de 45°
          const fx = g.i ? 0 : p0.w;
          const fy = g.i ? 0 : p0.h;
          const mx = g.i ? ex : x0;
          const my = g.i ? ey : y0;
          const ang = Math.round(Math.atan2(my - fy, mx - fx) / (Math.PI / 4)) * (Math.PI / 4);
          const len = Math.hypot(mx - fx, my - fy);
          const nx = fx + Math.cos(ang) * len;
          const ny = fy + Math.sin(ang) * len;
          if (g.i) { ex = nx; ey = ny; } else { x0 = nx; y0 = ny; }
        }
        w = ex - x0;
        hgt = ey - y0;
        const [x, y] = apply(local0, x0 + w / 2, y0 + hgt / 2);
        for (const [k, v] of [['w', w], ['h', hgt], ['ax', w / 2], ['ay', hgt / 2], ['x', x], ['y', y]]) setLayerProp(layer, k, v);
        emit('project');
        return;
      }
      let x1 = p0.w;
      let y1 = p0.h;
      if (g.hx < 0) x0 = Math.min(lx, x1 - 1);
      if (g.hx > 0) x1 = Math.max(lx, x0 + 1);
      if (g.hy < 0) y0 = Math.min(ly, y1 - 1);
      if (g.hy > 0) y1 = Math.max(ly, y0 + 1);
      w = x1 - x0;
      hgt = y1 - y0;
      if (e.shiftKey && p0.w > 0 && p0.h > 0) {
        const s = g.hx && g.hy ? Math.max(w / p0.w, hgt / p0.h) : g.hx ? w / p0.w : hgt / p0.h;
        w = p0.w * s;
        hgt = p0.h * s;
        x0 = g.hx < 0 ? p0.w - w : g.hx > 0 ? 0 : (p0.w - w) / 2;
        y0 = g.hy < 0 ? p0.h - hgt : g.hy > 0 ? 0 : (p0.h - hgt) / 2;
      }
      // a âncora acompanha proporcionalmente (o centro continua no centro)
      const ax = p0.w ? (p0.ax * w) / p0.w : w / 2;
      const ay = p0.h ? (p0.ay * hgt) / p0.h : hgt / 2;
      const [x, y] = apply(local0, x0 + ax, y0 + ay);
      for (const [k, v] of [['w', w], ['h', hgt], ['ax', ax], ['ay', ay], ['x', x], ['y', y]]) setLayerProp(layer, k, v);
      emit('project');
    },
  };
}

/** Escala em torno da âncora (texto, imagem, caminho e grupo). */
function startScale(comp, layer, g, pos) {
  const t = M().time;
  const p0 = layerPropsAt(layer, t);
  const invP = invert(parentMatrix(comp, layer, t)) || IDENTITY;
  const r = (-(p0.rotation || 0) * Math.PI) / 180;
  // vetor da âncora até o ponteiro, no espaço do pai e com a rotação da camada desfeita
  const vec = (cur) => {
    const [px, py] = apply(invP, cur.cx, cur.cy);
    const dx = px - p0.x;
    const dy = py - p0.y;
    return [dx * Math.cos(r) - dy * Math.sin(r), dx * Math.sin(r) + dy * Math.cos(r)];
  };
  const v0 = vec(pos);
  const begin = threshold(pos, checkpoint);
  return {
    move(e, cur) {
      if (!begin(cur)) return;
      const v = vec(cur);
      let fx = Math.abs(v0[0]) > 1e-3 ? v[0] / v0[0] : 1;
      let fy = Math.abs(v0[1]) > 1e-3 ? v[1] / v0[1] : 1;
      if (g.hx && g.hy && !e.shiftKey) {
        // cantos mantêm a proporção (Shift libera)
        const d = v0[0] * v0[0] + v0[1] * v0[1];
        fx = fy = d > 1e-6 ? (v[0] * v0[0] + v[1] * v0[1]) / d : 1;
      }
      if (g.hx) setLayerProp(layer, 'sx', p0.sx * fx);
      if (g.hy) setLayerProp(layer, 'sy', p0.sy * fy);
      emit('project');
    },
  };
}

function startRotate(comp, layer, pos) {
  const t = M().time;
  const p0 = layerPropsAt(layer, t);
  const center = toScreen(...apply(worldMatrix(comp, layer, t), p0.ax, p0.ay));
  const angle = (cur) => Math.atan2(cur.sy - center[1], cur.sx - center[0]);
  const a0 = angle(pos);
  // se a hierarquia estiver espelhada, o sentido da rotação na tela se inverte
  const pm = parentMatrix(comp, layer, t);
  const flip = (pm[0] * pm[3] - pm[1] * pm[2] < 0 ? -1 : 1) * (p0.sx * p0.sy < 0 ? -1 : 1);
  const begin = threshold(pos, checkpoint);
  let prev = a0;
  let total = 0;
  return {
    move(e, cur) {
      if (!begin(cur)) return;
      // acumula voltas completas em vez de saltar de 180° para -180°
      const a = angle(cur);
      let d = a - prev;
      if (d > Math.PI) d -= Math.PI * 2;
      if (d < -Math.PI) d += Math.PI * 2;
      total += d;
      prev = a;
      let rot = p0.rotation + (flip * total * 180) / Math.PI;
      if (e.shiftKey) rot = Math.round(rot / 15) * 15;
      setLayerProp(layer, 'rotation', rot);
      emit('project');
    },
  };
}

/** Move a âncora sem tirar a camada do lugar. */
function startAnchor(comp, layer, pos, e0) {
  const t = M().time;
  const p0 = layerPropsAt(layer, t);
  const b = localBounds(layer, p0);
  const inv = invert(worldMatrix(comp, layer, t));
  if (!inv) return null;
  const local0 = trs(p0);
  let started = false;
  const applyAt = (e, cur) => {
    if (!started) { started = true; checkpoint(); }
    let [lx, ly] = apply(inv, cur.cx, cur.cy);
    if (!e.altKey) {
      // ímã nos cantos, meios e centro da caixa
      const scale = Math.sqrt(Math.abs(local0[0] * local0[3] - local0[1] * local0[2])) || 1;
      const thr = 8 / (view.zoom * scale);
      for (const u of [0, 0.5, 1]) if (Math.abs(lx - (b.x + b.w * u)) < thr) lx = b.x + b.w * u;
      for (const v of [0, 0.5, 1]) if (Math.abs(ly - (b.y + b.h * v)) < thr) ly = b.y + b.h * v;
    }
    const [x, y] = apply(local0, lx, ly);
    for (const [k, v] of [['ax', lx], ['ay', ly], ['x', x], ['y', y]]) setLayerProp(layer, k, v);
    emit('project');
  };
  applyAt(e0, pos);
  return { move: applyAt };
}

function startCreate(comp, kind, pos) {
  const isLine = kind === 'line';
  let layer = null;
  const begin = threshold(pos, () => {
    checkpoint();
    layer = createLayer(comp, 'shape', { shape: kind, x: pos.cx, y: pos.cy, w: 1, h: isLine ? 0 : 1 });
    M().selection = [layer.id];
    M().keySel = [];
  });
  return {
    move(e, cur) {
      if (!begin(cur)) return;
      const p = layer.props;
      let w = cur.cx - pos.cx;
      let hgt = cur.cy - pos.cy;
      if (isLine) {
        if (e.shiftKey) {
          const ang = Math.round(Math.atan2(hgt, w) / (Math.PI / 4)) * (Math.PI / 4);
          const len = Math.hypot(w, hgt);
          w = Math.cos(ang) * len;
          hgt = Math.sin(ang) * len;
        }
        Object.assign(p, { w: round2(w), h: round2(hgt), ax: round2(w / 2), ay: round2(hgt / 2), x: round2(pos.cx + w / 2), y: round2(pos.cy + hgt / 2) });
      } else {
        let aw = Math.abs(w);
        let ah = Math.abs(hgt);
        if (e.shiftKey) aw = ah = Math.max(aw, ah);
        aw = Math.max(1, aw);
        ah = Math.max(1, ah);
        const x0 = w < 0 ? pos.cx - aw : pos.cx;
        const y0 = hgt < 0 ? pos.cy - ah : pos.cy;
        Object.assign(p, { w: round2(aw), h: round2(ah), ax: round2(aw / 2), ay: round2(ah / 2), x: round2(x0 + aw / 2), y: round2(y0 + ah / 2) });
      }
      emit('project');
    },
    up(e, cur) {
      // clique sem arrastar: forma no tamanho padrão, centrada no ponto
      if (!layer) addLayer('shape', { shape: kind, x: cur.cx, y: cur.cy, w: isLine ? 300 : 200, h: isLine ? 0 : 200 });
      setTool('select');
      emit('motion');
    },
  };
}

// ---------------------------------------------------------------- soltar imagens da biblioteca
function onDragOver(e) {
  const types = [...e.dataTransfer.types];
  if (!(types.includes(MEDIA_MIME) || types.includes('Files')) || !currentComp()) return;
  e.preventDefault();
  e.dataTransfer.dropEffect = 'copy';
  stageEl.classList.add('drop-target');
}

function onDrop(e) {
  stageEl.classList.remove('drop-target');
  const svgs = [...(e.dataTransfer.files || [])].filter((f) => /\.svg$/i.test(f.name) || f.type === 'image/svg+xml');
  if (svgs.length && currentComp()) {
    e.preventDefault();
    e.stopPropagation();
    dropSvgs(svgs);
    return;
  }
  const media = getMedia(e.dataTransfer.getData(MEDIA_MIME));
  if (!media || !currentComp()) return;
  e.preventDefault();
  e.stopPropagation();
  if (media.type !== 'image') return toast('Composições aceitam imagens; vídeo e áudio ficam na timeline principal', 'error');
  const pos = eventPos(e);
  addLayer('image', { media, x: pos.cx, y: pos.cy });
}

/** SVG solto no palco: as formas entram como camadas vetoriais na composição aberta. */
async function dropSvgs(files) {
  const comp = currentComp();
  const ids = [];
  const warnings = [];
  checkpoint();
  for (const file of files) {
    try {
      const r = importSvg(comp, await file.text(), file.name);
      ids.push(r.root.id);
      warnings.push(...r.warnings);
    } catch (err) {
      toast(`Não foi possível importar ${file.name}: ${err.message}`, 'error');
    }
  }
  if (!ids.length) return;
  selectLayers(ids);
  emit('project');
  toast(`SVG importado como camadas vetoriais${warnings.length ? ' · ' + warnings.join(' · ') : ''}`);
}
