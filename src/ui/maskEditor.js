// Edição de máscara no preview: alças de retângulo/elipse e pontos da forma livre, por cima do clipe.
// Estado em state.maskEdit = { clipId, maskId, sel: ['contorno:ponto'] }.
import { state, emit, checkpoint, localTime } from '../state/project.js';
import { setProp, valueAt } from '../state/keyframes.js';
import { segments, segmentPoint, trace, insertPoint } from '../motion/geometry.js';
import { maskPath, maskPropsAt } from '../fx/mask.js';

const NS = 'http://www.w3.org/2000/svg';
const clone = (v) => JSON.parse(JSON.stringify(v));
const keyOf = (c, i) => `${c}:${i}`;
const round = (v) => Math.round(v * 10000) / 10000;

let boxEl = null;
let svgEl = null;
let builtSig = '';

/** Máscara em edição no clipe (limpa o estado se ela não existe mais). */
export function editedMask(clip) {
  const me = state.maskEdit;
  if (!me) return null;
  const mask = clip && me.clipId === clip.id ? (clip.masks || []).find((m) => m.id === me.maskId) : null;
  if (!mask || mask.enabled === false) {
    // a máscara sumiu (desfazer, exclusão) ou a seleção mudou de clipe
    state.maskEdit = null;
    return null;
  }
  me.sel ||= [];
  return mask;
}

export function hideMaskOverlay() {
  boxEl?.remove();
  boxEl = null;
  svgEl = null;
  builtSig = '';
}

function pathD(path) {
  let d = '';
  const f = (n) => +n.toFixed(2);
  trace({
    moveTo: (x, y) => { d += `M${f(x)} ${f(y)}`; },
    lineTo: (x, y) => { d += `L${f(x)} ${f(y)}`; },
    bezierCurveTo: (a, b, c, e, x, y) => { d += `C${f(a)} ${f(b)} ${f(c)} ${f(e)} ${f(x)} ${f(y)}`; },
    closePath: () => { d += 'Z'; },
  }, path);
  return d;
}

const el = (tag, attrs = {}) => {
  const node = document.createElementNS(NS, tag);
  for (const [k, v] of Object.entries(attrs)) node.setAttribute(k, v);
  return node;
};

/** Desenha (ou atualiza) as alças da máscara sobre a caixa do clipe. p = propriedades do clipe; scale = px de tela por px do projeto. */
export function updateMaskOverlay(overlayEl, clip, mask, p, scale) {
  const bw = Math.max(1, Math.abs(p.width) * scale);
  const bh = Math.max(1, Math.abs(p.height) * scale);
  if (!boxEl) {
    svgEl = el('svg', { class: 'mask-svg' });
    boxEl = document.createElement('div');
    boxEl.className = 'mask-box';
    boxEl.append(svgEl);
    overlayEl.append(boxEl);
  }
  Object.assign(boxEl.style, {
    left: p.x * scale + 'px', top: p.y * scale + 'px', width: bw + 'px', height: bh + 'px',
    transform: p.rotation ? `rotate(${p.rotation}deg)` : '',
  });
  const t = localTime(clip);
  const mp = maskPropsAt(mask, t);
  const sig = JSON.stringify([mask.id, mask.shape, mp, Math.round(bw), Math.round(bh), state.maskEdit.sel]);
  if (sig === builtSig) return;
  builtSig = sig;

  svgEl.setAttribute('viewBox', `0 0 ${bw} ${bh}`);
  const nodes = [];
  const outline = pathD(maskPath(mask, t, bw, bh));
  if (mask.shape === 'path') {
    nodes.push(el('path', { d: outline, class: 'mask-edge', 'data-role': 'edge' }), el('path', { d: outline, class: 'mask-line' }));
    (mp.path?.contours || []).forEach((contour, c) => {
      contour.pts.forEach((pt, i) => {
        const x = pt.x * bw;
        const y = pt.y * bh;
        const selected = state.maskEdit.sel.includes(keyOf(c, i));
        if (selected) {
          for (const side of ['i', 'o']) {
            const hx = (pt[side + 'x'] || 0) * bw;
            const hy = (pt[side + 'y'] || 0) * bh;
            if (!hx && !hy) continue;
            nodes.push(
              el('line', { x1: x, y1: y, x2: x + hx, y2: y + hy, class: 'mask-line' }),
              el('circle', { cx: x + hx, cy: y + hy, r: 4.5, class: 'mask-knob', 'data-role': 'knob', 'data-c': c, 'data-i': i, 'data-side': side }),
            );
          }
        }
        nodes.push(el('rect', { x: x - 4.5, y: y - 4.5, width: 9, height: 9, class: `mask-pt${selected ? ' sel' : ''}`, 'data-role': 'point', 'data-c': c, 'data-i': i }));
      });
    });
  } else {
    nodes.push(el('path', { d: outline, class: 'mask-body', 'data-role': 'body' }), el('path', { d: outline, class: 'mask-line' }));
    for (const [hx, hy] of [[-1, -1], [0, -1], [1, -1], [1, 0], [1, 1], [0, 1], [-1, 1], [-1, 0]]) {
      const x = (mp.x + (mp.w * (hx + 1)) / 2) * bw;
      const y = (mp.y + (mp.h * (hy + 1)) / 2) * bh;
      nodes.push(el('rect', { x: x - 4.5, y: y - 4.5, width: 9, height: 9, class: 'mask-pt', 'data-role': 'handle', 'data-hx': hx, 'data-hy': hy }));
    }
  }
  svgEl.replaceChildren(...nodes);
}

/**
 * Trata o clique no overlay quando há máscara em edição. Retorna true se o evento era da máscara.
 * p = propriedades do clipe; scale = px de tela por px do projeto; origin = retângulo do overlay na tela.
 */
export function maskPointerDown(e, clip, mask, p, scale, origin) {
  const role = e.target.dataset?.role;
  if (!role || !boxEl?.contains(e.target)) return false;
  e.preventDefault();
  const me = state.maskEdit;
  const t = localTime(clip);
  const w = p.width || 1;
  const h = p.height || 1;
  const cx = p.x + p.width / 2;
  const cy = p.y + p.height / 2;
  const a = (-(p.rotation || 0) * Math.PI) / 180;
  /** Ponteiro em frações (0–1) da caixa do clipe, desfazendo a rotação. */
  const local = (ev) => {
    const dx = (ev.clientX - origin.left) / scale - cx;
    const dy = (ev.clientY - origin.top) / scale - cy;
    return [(dx * Math.cos(a) - dy * Math.sin(a) + p.width / 2) / w, (dx * Math.sin(a) + dy * Math.cos(a) + p.height / 2) / h];
  };
  const start = local(e);
  const set = (prop, v) => setProp(mask, prop, typeof v === 'number' ? round(v) : v, t, state.autoKey);
  let started = false;
  const begin = (ev) => {
    if (started) return true;
    if (Math.hypot(ev.clientX - e.clientX, ev.clientY - e.clientY) < 2) return false;
    started = true;
    checkpoint();
    return true;
  };
  const run = (move) => {
    const onMove = (ev) => { if (begin(ev)) { move(ev, local(ev)); emit('project'); } };
    const onUp = () => { window.removeEventListener('pointermove', onMove); window.removeEventListener('pointerup', onUp); };
    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp);
  };

  if (mask.shape !== 'path') {
    const m0 = maskPropsAt(mask, t);
    if (role === 'body') {
      run((ev, cur) => { set('x', m0.x + cur[0] - start[0]); set('y', m0.y + cur[1] - start[1]); });
    } else if (role === 'handle') {
      const hx = Number(e.target.dataset.hx);
      const hy = Number(e.target.dataset.hy);
      run((ev, cur) => {
        let x0 = m0.x;
        let y0 = m0.y;
        let x1 = m0.x + m0.w;
        let y1 = m0.y + m0.h;
        if (hx < 0) x0 = Math.min(cur[0], x1 - 0.01);
        if (hx > 0) x1 = Math.max(cur[0], x0 + 0.01);
        if (hy < 0) y0 = Math.min(cur[1], y1 - 0.01);
        if (hy > 0) y1 = Math.max(cur[1], y0 + 0.01);
        set('x', x0); set('y', y0); set('w', x1 - x0); set('h', y1 - y0);
      });
    }
    return true;
  }

  // ---- forma livre
  const base = clone(valueAt(mask, 'path', t) || { contours: [] });
  const commit = (path) => set('path', path);
  const c = Number(e.target.dataset.c);
  const i = Number(e.target.dataset.i);
  if (role === 'knob') {
    const side = e.target.dataset.side;
    const other = side === 'o' ? 'i' : 'o';
    const pt0 = base.contours[c].pts[i];
    // comprimentos em pixels para testar o alinhamento sem distorção da proporção da caixa
    const hx = (pt0[side + 'x'] || 0) * w;
    const hy = (pt0[side + 'y'] || 0) * h;
    const ox = (pt0[other + 'x'] || 0) * w;
    const oy = (pt0[other + 'y'] || 0) * h;
    const otherLen = Math.hypot(ox, oy);
    const smooth = otherLen > 1e-6 && Math.abs(hx * oy - hy * ox) < 1e-3 * Math.hypot(hx, hy) * otherLen + 1e-6;
    run((ev, cur) => {
      const path = clone(base);
      const pt = path.contours[c].pts[i];
      const nx = cur[0] - pt.x;
      const ny = cur[1] - pt.y;
      pt[side + 'x'] = nx;
      pt[side + 'y'] = ny;
      const len = Math.hypot(nx * w, ny * h);
      if (smooth && !ev.altKey && len > 1e-6) {
        pt[other + 'x'] = ((-nx * w) / len) * otherLen / w;
        pt[other + 'y'] = ((-ny * h) / len) * otherLen / h;
      }
      commit(path);
    });
    return true;
  }
  if (role === 'point') {
    const key = keyOf(c, i);
    const pt0 = base.contours[c].pts[i];
    if (e.altKey) {
      me.sel = [key];
      if (pt0.ix || pt0.iy || pt0.ox || pt0.oy) {
        // curva → canto
        checkpoint();
        const path = clone(base);
        Object.assign(path.contours[c].pts[i], { ix: 0, iy: 0, ox: 0, oy: 0 });
        commit(path);
        emit('project');
      } else {
        // canto → curva: arrastar puxa as alças
        run((ev, cur) => {
          const path = clone(base);
          const pt = path.contours[c].pts[i];
          Object.assign(pt, { ox: cur[0] - pt.x, oy: cur[1] - pt.y, ix: pt.x - cur[0], iy: pt.y - cur[1] });
          commit(path);
        });
      }
      builtSig = '';
      return true;
    }
    if (e.shiftKey) me.sel = me.sel.includes(key) ? me.sel.filter((k) => k !== key) : [...me.sel, key];
    else if (!me.sel.includes(key)) me.sel = [key];
    movePoints(base, start, run, commit);
    return true;
  }
  if (role === 'edge') {
    // clique na linha: insere um ponto ali e já permite arrastá-lo
    let best = null;
    base.contours.forEach((contour, ci) => segments(contour).forEach(([p0, p1], seg) => {
      for (let k = 1; k < 24; k++) {
        const u = k / 24;
        const [x, y] = segmentPoint(p0, p1, u);
        const d = Math.hypot((x - start[0]) * w, (y - start[1]) * h);
        if (!best || d < best.d) best = { d, c: ci, seg, u };
      }
    }));
    if (!best) return true;
    checkpoint();
    started = true;
    const path = clone(base);
    const index = insertPoint(path.contours[best.c], best.seg, best.u);
    me.sel = [keyOf(best.c, index)];
    commit(path);
    emit('project');
    movePoints(path, start, run, commit);
    return true;
  }
  return true;
}

function movePoints(base, start, run, commit) {
  run((ev, cur) => {
    const path = clone(base);
    for (const key of state.maskEdit?.sel || []) {
      const [c, i] = key.split(':').map(Number);
      const pt = path.contours[c]?.pts[i];
      if (pt) { pt.x += cur[0] - start[0]; pt.y += cur[1] - start[1]; }
    }
    commit(path);
  });
}

/** Teclas durante a edição de máscara. Retorna true se tratou. */
export function maskKey(e, clip) {
  const mask = editedMask(clip);
  if (!mask) return false;
  if (e.key === 'Escape' || e.key === 'Enter') {
    state.maskEdit = null;
    emit('selection');
    return true;
  }
  if (e.key === 'Delete' || e.key === 'Backspace') {
    // enquanto se edita a máscara, Delete nunca apaga o clipe por engano
    if (mask.shape !== 'path') return true;
    const me = state.maskEdit;
    if (!me.sel.length) return true; // não apaga o clipe por engano enquanto se editam pontos
    const t = localTime(clip);
    const gone = new Set(me.sel);
    const path = clone(valueAt(mask, 'path', t) || { contours: [] });
    const contours = path.contours
      .map((c, ci) => ({ closed: c.closed, pts: c.pts.filter((_, i) => !gone.has(keyOf(ci, i))) }))
      .filter((c) => c.pts.length >= 3);
    me.sel = [];
    if (!contours.length) return true; // a forma precisa de pelo menos três pontos
    checkpoint();
    setProp(mask, 'path', { contours }, t, state.autoKey);
    emit('project');
    return true;
  }
  return false;
}
