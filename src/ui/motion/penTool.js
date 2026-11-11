// Caneta e edição de pontos: desenha caminhos novos e edita pontos/alças de camadas de caminho.
// Estado em state.motion.pathEdit = { layerId, sel: ['contorno:ponto'], drawing, contour }.
import { state, emit, checkpoint } from '../../state/project.js';
import { setProp, valueAt, hasKeyframes } from '../../state/keyframes.js';
import { apply, applyVec, invert, segments, segmentPoint, insertPoint } from '../../motion/geometry.js';
import { currentComp, getLayer, createLayer, removeLayers, worldMatrix, normalizePathLayer } from '../../motion/model.js';
import { M, setTool, onBeforeExit } from './actions.js';

const ACCENT = '#4f8cff';
const HIT = 8;
const clone = (v) => JSON.parse(JSON.stringify(v));
const keyOf = (c, i) => `${c}:${i}`;

/** Camada em edição, ou null (limpando o estado se ela não existe mais, p.ex. depois de desfazer). */
function editing() {
  const m = M();
  if (!m.pathEdit) return null;
  const comp = currentComp();
  const layer = comp && getLayer(comp, m.pathEdit.layerId);
  if (!layer || layer.type !== 'shape' || layer.shape !== 'path') {
    m.pathEdit = null;
    return null;
  }
  return { comp, layer, pe: m.pathEdit };
}

const pathOf = (layer) => clone(valueAt(layer, 'path', M().time) || { contours: [] });

function commit(layer, path) {
  setProp(layer, 'path', path, M().time, state.autoKey);
  emit('project');
}

export function enterEdit(layer) {
  const m = M();
  m.selection = [layer.id];
  m.keySel = [];
  m.pathEdit = { layerId: layer.id, sel: [], drawing: false, contour: 0 };
  m.tool = 'select';
  emit('motion');
}

export function exitEdit() {
  const m = M();
  if (!m.pathEdit || m.pathEdit.drawing) return;
  const ed = editing();
  if (ed) normalizePathLayer(ed.layer);
  m.pathEdit = null;
  emit('project');
  emit('motion');
}

/** Encerra o desenho em andamento; caminhos com menos de dois pontos são descartados. */
export function finishDrawing() {
  const m = M();
  if (!m.pathEdit?.drawing) return;
  const ed = editing();
  m.pathEdit = null;
  if (ed) {
    const { comp, layer } = ed;
    const contours = (layer.props.path?.contours || []).filter((c) => c.pts.length >= 2);
    if (!contours.length) {
      removeLayers(comp, [layer.id]);
    } else {
      layer.props.path = { contours };
      // formas fechadas nascem preenchidas; abertas, só com traço
      layer.fillOn = contours.every((c) => c.closed);
      normalizePathLayer(layer);
    }
  }
  if (m.tool === 'pen') setTool('select');
  emit('project');
  emit('motion');
}

onBeforeExit(() => {
  finishDrawing();
  exitEdit();
});

// ---------------------------------------------------------------- ponteiro
/** Retorna um arrasto ({ move, up }) ou null. */
export function pointerDown(e, pos, api) {
  const m = M();
  if (m.tool === 'pen' && !(m.pathEdit && !m.pathEdit.drawing)) return drawPoint(e, pos, api);
  return editPointerDown(e, pos, api);
}

function drawPoint(e, pos, api) {
  const comp = currentComp();
  const m = M();
  checkpoint();
  let ed = editing();
  if (!ed) {
    const layer = createLayer(comp, 'shape', { shape: 'path', path: { contours: [{ closed: false, pts: [] }] }, fillOn: false, strokeOn: true, x: 0, y: 0 });
    layer.props.strokeWidth = 6;
    m.selection = [layer.id];
    m.keySel = [];
    m.pathEdit = { layerId: layer.id, sel: [], drawing: true, contour: 0 };
    ed = editing();
    emit('motion');
  }
  const { layer } = ed;
  const wm = worldMatrix(comp, layer, m.time);
  const inv = invert(wm);
  if (!inv) return null;
  const path = clone(layer.props.path);
  const contour = path.contours[0];

  // clicar no primeiro ponto fecha o caminho
  if (contour.pts.length >= 2) {
    const first = api.toScreen(...apply(wm, contour.pts[0].x, contour.pts[0].y));
    if (Math.hypot(first[0] - pos.sx, first[1] - pos.sy) <= HIT + 2) {
      contour.closed = true;
      layer.props.path = path;
      finishDrawing();
      return null;
    }
  }
  const [x, y] = apply(inv, pos.cx, pos.cy);
  const point = { x, y, ix: 0, iy: 0, ox: 0, oy: 0 };
  contour.pts.push(point);
  layer.props.path = path;
  emit('project');
  return {
    // arrastar ao criar o ponto puxa as alças (curva suave)
    move(ev, cur) {
      const [lx, ly] = apply(inv, cur.cx, cur.cy);
      Object.assign(point, { ox: lx - x, oy: ly - y, ix: x - lx, iy: y - ly });
      layer.props.path = path;
      emit('project');
    },
  };
}

function editPointerDown(e, pos, api) {
  const ed = editing();
  if (!ed) return null;
  const { comp, layer, pe } = ed;
  if (layer.locked) return null;
  const wm = worldMatrix(comp, layer, M().time);
  const inv = invert(wm);
  if (!inv) return null;
  const base = pathOf(layer);
  const screen = (x, y) => api.toScreen(...apply(wm, x, y));
  const near = (x, y) => { const s = screen(x, y); return Math.hypot(s[0] - pos.sx, s[1] - pos.sy) <= HIT; };
  const start = apply(inv, pos.cx, pos.cy);
  let started = false;
  const begin = (cur) => {
    if (started) return true;
    if (Math.hypot(cur.sx - pos.sx, cur.sy - pos.sy) < 2) return false;
    started = true;
    checkpoint();
    return true;
  };

  // 1) alças dos pontos selecionados
  for (const key of pe.sel) {
    const [c, i] = key.split(':').map(Number);
    const pt = base.contours[c]?.pts[i];
    if (!pt) continue;
    for (const side of ['o', 'i']) {
      const hx = pt[side + 'x'] || 0;
      const hy = pt[side + 'y'] || 0;
      if ((!hx && !hy) || !near(pt.x + hx, pt.y + hy)) continue;
      const other = side === 'o' ? 'i' : 'o';
      const ox = pt[other + 'x'] || 0;
      const oy = pt[other + 'y'] || 0;
      const otherLen = Math.hypot(ox, oy);
      // alças alinhadas se movem espelhadas; Alt quebra o alinhamento
      const smooth = otherLen > 1e-6 && Math.abs(hx * oy - hy * ox) < 1e-3 * Math.hypot(hx, hy) * otherLen + 1e-6;
      return {
        move(ev, cur) {
          if (!begin(cur)) return;
          const path = clone(base);
          const p = path.contours[c].pts[i];
          const [lx, ly] = apply(inv, cur.cx, cur.cy);
          const nx = lx - p.x;
          const ny = ly - p.y;
          p[side + 'x'] = nx;
          p[side + 'y'] = ny;
          const len = Math.hypot(nx, ny);
          if (smooth && !ev.altKey && len > 1e-6) {
            p[other + 'x'] = (-nx / len) * otherLen;
            p[other + 'y'] = (-ny / len) * otherLen;
          }
          commit(layer, path);
        },
      };
    }
  }

  // 2) pontos
  for (let c = 0; c < base.contours.length; c++) {
    const pts = base.contours[c].pts;
    for (let i = 0; i < pts.length; i++) {
      if (!near(pts[i].x, pts[i].y)) continue;
      const key = keyOf(c, i);
      if (e.altKey) {
        const hasHandles = pts[i].ix || pts[i].iy || pts[i].ox || pts[i].oy;
        pe.sel = [key];
        emit('motion');
        if (hasHandles) {
          // curva → canto
          checkpoint();
          const path = clone(base);
          Object.assign(path.contours[c].pts[i], { ix: 0, iy: 0, ox: 0, oy: 0 });
          commit(layer, path);
          return null;
        }
        // canto → curva: arrastar puxa as alças
        return {
          move(ev, cur) {
            if (!begin(cur)) return;
            const path = clone(base);
            const p = path.contours[c].pts[i];
            const [lx, ly] = apply(inv, cur.cx, cur.cy);
            Object.assign(p, { ox: lx - p.x, oy: ly - p.y, ix: p.x - lx, iy: p.y - ly });
            commit(layer, path);
          },
        };
      }
      if (e.shiftKey) pe.sel = pe.sel.includes(key) ? pe.sel.filter((k) => k !== key) : [...pe.sel, key];
      else if (!pe.sel.includes(key)) pe.sel = [key];
      emit('motion');
      return movePoints(layer, base, inv, start, begin);
    }
  }

  // 3) clique no traço insere um ponto
  const hit = nearestOnPath(base, screen, pos);
  if (hit && hit.dist <= HIT) {
    checkpoint();
    started = true;
    const path = clone(base);
    const index = insertPoint(path.contours[hit.c], hit.seg, hit.u);
    pe.sel = [keyOf(hit.c, index)];
    commit(layer, path);
    emit('motion');
    return movePoints(layer, path, inv, start, () => true);
  }

  // 4) vazio: limpa a seleção de pontos
  if (pe.sel.length) {
    pe.sel = [];
    emit('motion');
  }
  return null;
}

function movePoints(layer, base, inv, start, begin) {
  return {
    move(ev, cur) {
      if (!begin(cur)) return;
      const [lx, ly] = apply(inv, cur.cx, cur.cy);
      const dx = lx - start[0];
      const dy = ly - start[1];
      const path = clone(base);
      for (const key of M().pathEdit?.sel || []) {
        const [c, i] = key.split(':').map(Number);
        const p = path.contours[c]?.pts[i];
        if (p) { p.x += dx; p.y += dy; }
      }
      commit(layer, path);
    },
  };
}

/** Ponto do caminho mais próximo do ponteiro (em distância de tela). */
function nearestOnPath(path, screen, pos) {
  let best = null;
  path.contours.forEach((contour, c) => {
    segments(contour).forEach(([a, b], seg) => {
      for (let k = 0; k <= 24; k++) {
        const u = k / 24;
        const s = screen(...segmentPoint(a, b, u));
        const dist = Math.hypot(s[0] - pos.sx, s[1] - pos.sy);
        if (!best || dist < best.dist) best = { c, seg, u: Math.min(0.95, Math.max(0.05, u)), dist };
      }
    });
  });
  return best;
}

export function doubleClick(e, pos) {
  const m = M();
  if (m.pathEdit?.drawing) {
    // o duplo clique já criou dois pontos no mesmo lugar: descarta o repetido
    const ed = editing();
    const pts = ed?.layer.props.path?.contours[0]?.pts;
    if (pts && pts.length > 2) pts.pop();
    finishDrawing();
    return true;
  }
  if (m.pathEdit) {
    exitEdit();
    return true;
  }
  return false;
}

/** Teclas do modo caneta/edição. Retorna true se tratou. */
export function handleKey(e) {
  const m = M();
  if (!m.pathEdit) return false;
  const key = e.key;
  if (key === 'Enter' || key === 'Escape') {
    if (m.pathEdit.drawing) finishDrawing();
    else exitEdit();
    return true;
  }
  if (key === 'Delete' || key === 'Backspace') {
    if (m.pathEdit.drawing) removeLastPoint();
    else deletePoints();
    return true;
  }
  if ((e.ctrlKey || e.metaKey) && key.toLowerCase() === 'a' && !m.pathEdit.drawing) {
    const ed = editing();
    if (ed) {
      const path = pathOf(ed.layer);
      m.pathEdit.sel = path.contours.flatMap((c, ci) => c.pts.map((_, i) => keyOf(ci, i)));
      emit('motion');
    }
    return true;
  }
  return false;
}

function removeLastPoint() {
  const ed = editing();
  if (!ed) return;
  const pts = ed.layer.props.path.contours[0].pts;
  if (pts.length <= 1) {
    M().pathEdit.drawing = true;
    finishDrawing();
    return;
  }
  checkpoint();
  pts.pop();
  emit('project');
}

function deletePoints() {
  const ed = editing();
  if (!ed || !ed.pe.sel.length) return;
  const { comp, layer, pe } = ed;
  checkpoint();
  const gone = new Set(pe.sel);
  const path = pathOf(layer);
  path.contours = path.contours
    .map((c, ci) => ({ closed: c.closed, pts: c.pts.filter((_, i) => !gone.has(keyOf(ci, i))) }))
    // um contorno precisa de dois pontos (três, se fechado) para continuar existindo
    .map((c) => (c.closed && c.pts.length < 3 ? { ...c, closed: false } : c))
    .filter((c) => c.pts.length >= 2);
  pe.sel = [];
  if (!path.contours.length) {
    M().pathEdit = null;
    removeLayers(comp, [layer.id]);
    emit('project');
    emit('motion');
    return;
  }
  commit(layer, path);
  emit('motion');
}

/** Os keyframes do caminho têm estruturas diferentes (o morph vira um salto)? */
export function morphMismatch(layer) {
  const list = layer.keyframes?.path;
  if (!list || list.length < 2) return false;
  const sig = (v) => (v?.contours || []).map((c) => `${c.pts.length}${c.closed ? 'c' : 'o'}`).join(',');
  return list.some((k) => sig(k.v) !== sig(list[0].v));
}

export const isAnimatedPath = (layer) => hasKeyframes(layer, 'path');

// ---------------------------------------------------------------- desenho
export function drawOverlay(ctx, api) {
  const ed = editing();
  if (!ed) return;
  const { comp, layer, pe } = ed;
  const wm = worldMatrix(comp, layer, M().time);
  const path = valueAt(layer, 'path', M().time) || { contours: [] };
  const screen = (x, y) => api.toScreen(...apply(wm, x, y));
  const vec = (x, y) => { const v = applyVec(wm, x, y); return [v[0] * api.zoom, v[1] * api.zoom]; };

  // contorno do caminho
  ctx.save();
  ctx.strokeStyle = ACCENT;
  ctx.lineWidth = 1.5;
  ctx.beginPath();
  for (const contour of path.contours) {
    if (!contour.pts.length) continue;
    ctx.moveTo(...screen(contour.pts[0].x, contour.pts[0].y));
    for (const [a, b] of segments(contour)) {
      const c1 = screen(a.x + (a.ox || 0), a.y + (a.oy || 0));
      const c2 = screen(b.x + (b.ix || 0), b.y + (b.iy || 0));
      const end = screen(b.x, b.y);
      ctx.bezierCurveTo(c1[0], c1[1], c2[0], c2[1], end[0], end[1]);
    }
  }
  ctx.stroke();

  // elástico até o ponteiro enquanto desenha
  const drawing = pe.drawing && path.contours[0]?.pts.length;
  if (drawing && api.hover) {
    const last = path.contours[0].pts[path.contours[0].pts.length - 1];
    ctx.setLineDash([4, 4]);
    ctx.beginPath();
    ctx.moveTo(...screen(last.x, last.y));
    ctx.lineTo(api.hover.sx, api.hover.sy);
    ctx.stroke();
    ctx.setLineDash([]);
  }

  path.contours.forEach((contour, c) => {
    contour.pts.forEach((p, i) => {
      const s = screen(p.x, p.y);
      const selected = pe.sel.includes(keyOf(c, i)) || (pe.drawing && i === contour.pts.length - 1);
      if (selected) {
        for (const side of ['i', 'o']) {
          const hx = p[side + 'x'] || 0;
          const hy = p[side + 'y'] || 0;
          if (!hx && !hy) continue;
          const v = vec(hx, hy);
          ctx.strokeStyle = ACCENT;
          ctx.beginPath();
          ctx.moveTo(s[0], s[1]);
          ctx.lineTo(s[0] + v[0], s[1] + v[1]);
          ctx.stroke();
          ctx.fillStyle = '#fff';
          ctx.beginPath();
          ctx.arc(s[0] + v[0], s[1] + v[1], 4, 0, Math.PI * 2);
          ctx.fill();
          ctx.stroke();
        }
      }
      ctx.fillStyle = selected ? ACCENT : '#fff';
      ctx.strokeStyle = pe.drawing && c === 0 && i === 0 ? '#ffd24a' : ACCENT;
      ctx.beginPath();
      ctx.rect(s[0] - 4, s[1] - 4, 8, 8);
      ctx.fill();
      ctx.stroke();
    });
  });
  ctx.restore();
}
