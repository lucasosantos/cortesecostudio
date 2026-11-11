// Timeline de camadas da composição: barras de duração, hierarquia e keyframes por propriedade.
import { state, emit, subscribe, checkpoint } from '../../state/project.js';
import { keyframeTimes, removeKeyframe, keyframeAt, valueAt, hasKeyframes } from '../../state/keyframes.js';
import {
  currentComp, getLayer, PROP_LABELS, PROP_ORDER, setParent, isDescendant, shiftLayer, setCompDuration,
} from '../../motion/model.js';
import { cssColor } from '../../motion/interp.js';
import {
  M, fps, snapFrame, seekMotion, pauseMotion, selectLayers, isKeySelected, toggleKeyframe,
  deleteSelection, duplicateSelection, reorderSelection, exitMotion,
} from './actions.js';
import { h, clamp, formatTime, visibleWindow } from '../util.js';
import { icons } from '../icons.js';
import { saveSizes } from '../layout.js';

const HEAD_W = 300;
let rulerWin = { t0: 0, t1: Infinity, x0: -Infinity, x1: Infinity };
const GLYPH = { shape: '◆', text: 'T', image: '▣', group: '◇' };

let root, scrollEl, contentEl, playheadEl, nameInput, durInput;
let renderQueued = false;
let drag = null;
let bindings = [];
let lastDown = { time: 0, x: 0, y: 0 };

export function initLayerTimeline(el) {
  root = el;
  root.classList.add('mt-head-w');
  scrollEl = h('div.tl-scroll');
  contentEl = h('div.tl-content');
  scrollEl.append(contentEl);
  playheadEl = h('div.playhead');
  root.append(resizer(), toolbar(), scrollEl);

  subscribe((reason) => {
    if (state.mode !== 'motion') return;
    if (reason === 'motion-time') updateTime(true);
    else if (reason === 'project' || reason === 'motion' || reason === 'mode') queueRender();
  });
  contentEl.addEventListener('pointerdown', onPointerDown);
  scrollEl.addEventListener('wheel', onWheel, { passive: false });
  scrollEl.addEventListener('scroll', () => {
    const x = scrollEl.scrollLeft;
    if (x < rulerWin.x0 || x > rulerWin.x1) queueRender();
  }, { passive: true });
  new ResizeObserver(() => queueRender()).observe(scrollEl);
}

function resizer() {
  const el = h('div.tl-resizer');
  el.addEventListener('pointerdown', (e) => {
    const startY = e.clientY;
    const startH = root.getBoundingClientRect().height;
    const move = (ev) => document.body.style.setProperty('--tl-h', clamp(startH - (document.body.classList.contains('tl-top') ? -1 : 1) * (ev.clientY - startY), 120, window.innerHeight - 120) + 'px');
    const up = () => { window.removeEventListener('pointermove', move); window.removeEventListener('pointerup', up); saveSizes(); };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
  });
  return el;
}

function toolbar() {
  nameInput = h('input', {
    type: 'text', title: 'Nome da composição', style: { width: '150px' },
    on: {
      change: (e) => { const comp = currentComp(); if (!comp) return; checkpoint(); comp.name = e.target.value || comp.name; emit('project'); },
      keydown: (e) => { if (e.key === 'Enter') e.target.blur(); },
    },
  });
  durInput = h('input', {
    type: 'number', min: 0.1, step: 0.1, title: 'Duração da composição (segundos)', style: { width: '64px' },
    on: {
      change: (e) => {
        const comp = currentComp();
        const v = Number(e.target.value);
        if (!comp || !(v > 0)) return;
        checkpoint();
        setCompDuration(comp, v);
        if (M().time > comp.duration) M().time = comp.duration;
        emit('project');
      },
      keydown: (e) => { if (e.key === 'Enter') e.target.blur(); },
    },
  });
  return h('div.tl-toolbar', {},
    h('button', { title: 'Voltar para a timeline do vídeo', on: { click: exitMotion } }, '← Edição'),
    h('div.sep'),
    nameInput, durInput, h('span.hint', { style: { marginLeft: 0 } }, 's'),
    h('div.sep'),
    h('button.icon', { title: 'Trazer para frente', on: { click: () => reorderSelection(-1) } }, '↑'),
    h('button.icon', { title: 'Enviar para trás', on: { click: () => reorderSelection(1) } }, '↓'),
    h('button', { title: 'Duplicar camadas (Ctrl+D)', on: { click: duplicateSelection } }, 'Duplicar'),
    h('button', { title: 'Excluir camadas ou keyframes selecionados (Delete)', on: { click: deleteSelection } }, 'Excluir'),
    h('div.sep'),
    h('button.icon', { title: 'Diminuir zoom', on: { click: () => setZoom(M().zoom / 1.4) } }, '−'),
    h('button.icon', { title: 'Aumentar zoom', on: { click: () => setZoom(M().zoom * 1.4) } }, '+'),
    h('button', { title: 'Ajustar a composição à largura', on: { click: zoomToFit } }, 'Ajustar'),
    h('span.hint', {}, 'Arraste as barras para mover no tempo · ◆ no inspector cria keyframes · arraste os losangos · duplo clique remove'),
  );
}

// ---------------------------------------------------------------- zoom
function setZoom(z, anchorClientX) {
  const m = M();
  z = clamp(z, 10, 2000);
  const rect = scrollEl.getBoundingClientRect();
  const ax = anchorClientX != null ? anchorClientX - rect.left - HEAD_W : (rect.width - HEAD_W) / 2;
  const t = (scrollEl.scrollLeft + ax) / m.zoom;
  m.zoom = z;
  render();
  scrollEl.scrollLeft = Math.max(0, t * z - ax);
}

function zoomToFit() {
  const comp = currentComp();
  if (!comp) return;
  M().zoom = clamp((scrollEl.clientWidth - HEAD_W - 40) / comp.duration, 10, 2000);
  render();
  scrollEl.scrollLeft = 0;
}

function onWheel(e) {
  if (!e.ctrlKey && !e.metaKey) return;
  e.preventDefault();
  setZoom(M().zoom * Math.exp(-e.deltaY * 0.002), e.clientX);
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
  for (const s of [0.05, 0.1, 0.2, 0.5, 1, 2, 5, 10, 30, 60]) if (s * zoom >= 70) return s;
  return 120;
}

let fitFor = null;
function render() {
  const comp = currentComp();
  if (!contentEl || !comp || state.mode !== 'motion') return;
  const m = M();
  // ao abrir uma composição, a duração inteira cabe na largura
  if (fitFor !== comp.id && scrollEl.clientWidth > HEAD_W + 60) {
    fitFor = comp.id;
    m.zoom = clamp((scrollEl.clientWidth - HEAD_W - 40) / comp.duration, 10, 2000);
  }
  const zoom = m.zoom;
  const visibleSec = Math.max(1, (scrollEl.clientWidth - HEAD_W) / zoom);
  const totalSec = Math.max(comp.duration + 0.5, visibleSec);
  contentEl.style.width = HEAD_W + Math.ceil(totalSec * zoom) + 'px';
  if (document.activeElement !== nameInput) nameInput.value = comp.name;
  if (document.activeElement !== durInput) durInput.value = Math.round(comp.duration * 100) / 100;

  bindings = [];
  const major = tickInterval(zoom);
  const rows = [];
  for (const layer of comp.layers) {
    rows.push(layerRow(comp, layer, major, totalSec));
    if (m.expanded[layer.id] === false) continue;
    for (const prop of PROP_ORDER) if (hasKeyframes(layer, prop)) rows.push(propRow(layer, prop, major));
  }
  if (!comp.layers.length) {
    rows.push(h('div.mt-row', {}, h('div.mt-head', {}, h('span.mt-note', {}, 'Sem camadas')),
      h('div.mt-lane', { style: { '--grid': major * zoom + 'px' } }, h('span.mt-note', { style: { position: 'absolute', top: '7px' } }, 'Use as ferramentas acima do palco para criar formas, textos e caminhos'))));
  }
  contentEl.replaceChildren(ruler(totalSec, major), ...rows, playheadEl);
  updateTime(false);
}

function ruler(totalSec, major) {
  const zoom = M().zoom;
  const ticks = h('div.tl-ticks');
  const minor = major / 5;
  // só as marcas da faixa visível (mais meia tela de cada lado)
  rulerWin = visibleWindow(scrollEl.scrollLeft, scrollEl.clientWidth, zoom, HEAD_W);
  const n = Math.min(Math.ceil(totalSec / minor), Math.ceil(rulerWin.t1 / minor));
  for (let i = Math.floor(rulerWin.t0 / minor); i <= n; i++) {
    const t = i * minor;
    const isMajor = i % 5 === 0;
    const tick = h(`div.tick${isMajor ? '.major' : ''}`, { style: { left: t * zoom + 'px' } });
    if (isMajor) tick.append(h('span', {}, formatTime(t, major < 1 ? fps() : 0).replace(/\.00$/, '')));
    ticks.append(tick);
  }
  return h('div.tl-ruler', {}, h('div.tl-corner'), ticks);
}

function iconBtn(html, title, on, onClick) {
  const b = h(`button.ic${on ? '.on' : ''}`, { title, on: { click: onClick } });
  b.innerHTML = html;
  return b;
}

function layerRow(comp, layer, major, totalSec) {
  const m = M();
  const zoom = m.zoom;
  const selected = m.selection.includes(layer.id);
  const open = m.expanded[layer.id] !== false;
  const animated = Object.keys(layer.keyframes || {}).length > 0;
  const toggle = (key) => () => { checkpoint(); layer[key] = !layer[key]; emit('project'); };

  const parentSel = h('select', {
    title: 'Pai: a camada acompanha posição, rotação e escala do pai',
    on: {
      change: (e) => {
        checkpoint();
        if (!setParent(comp, layer, e.target.value || null, m.time)) e.target.value = layer.parentId || '';
        emit('project');
      },
    },
  },
  h('option', { value: '' }, 'Sem pai'),
  ...comp.layers.filter((l) => l.id !== layer.id && !isDescendant(comp, l, layer.id))
    .map((l) => h('option', { value: l.id, selected: l.id === layer.parentId }, l.name)));

  const head = h('div.mt-head', {},
    h('button.twirl', {
      title: animated ? 'Mostrar/ocultar propriedades animadas' : 'Sem propriedades animadas',
      style: { visibility: animated ? 'visible' : 'hidden' },
      on: { click: () => { m.expanded[layer.id] = !open; queueRender(); } },
    }, open ? '▾' : '▸'),
    h('span.glyph', { title: layer.matte ? 'Usa outra camada como máscara' : '' }, layer.matte ? '◐' : GLYPH[layer.type]),
    h('input.name', {
      type: 'text', value: layer.name,
      on: {
        change: (e) => { checkpoint(); layer.name = e.target.value || layer.name; emit('project'); },
        keydown: (e) => { if (e.key === 'Enter') e.target.blur(); },
      },
    }),
    parentSel,
    iconBtn(layer.hidden ? icons.eyeOff : icons.eye, 'Mostrar/ocultar', layer.hidden, toggle('hidden')),
    iconBtn(layer.locked ? icons.lock : icons.unlock, 'Travar', layer.locked, toggle('locked')),
  );

  const lane = h('div.mt-lane', { style: { '--grid': major * zoom + 'px' } });
  lane.append(h('div.beyond', { style: { left: comp.duration * zoom + 'px', width: Math.max(0, (totalSec - comp.duration) * zoom) + 'px' } }));
  lane.append(h(`div.mt-bar.type-${layer.type}`, {
    style: { left: layer.in * zoom + 'px', width: Math.max(4, (layer.out - layer.in) * zoom) + 'px' },
  }, h('div.handle.l', { dataset: { side: 'l' } }), h('div.handle.r', { dataset: { side: 'r' } })));
  for (const t of keyframeTimes(layer)) lane.append(h('div.mkf.sum', { style: { left: t * zoom + 'px' } }));

  const cls = `div.mt-row${selected ? '.selected' : ''}${layer.hidden ? '.hidden-layer' : ''}${layer.locked ? '.locked-layer' : ''}`;
  return h(cls, { dataset: { layerId: layer.id } }, head, lane);
}

function formatValue(prop, v) {
  if (prop === 'fill' || prop === 'stroke') return h('span.swatch', { style: { background: cssColor(v) } });
  if (prop === 'path') return `${(v?.contours || []).reduce((n, c) => n + c.pts.length, 0)} pts`;
  if (prop === 'opacity') return `${Math.round(v * 100)}%`;
  return String(Math.round(v * 100) / 100);
}

function propRow(layer, prop, major) {
  const m = M();
  const zoom = m.zoom;
  const value = h('span.pvalue');
  const kfBtn = h('button.kf-btn', { title: 'Adicionar/remover keyframe no playhead', on: { click: () => toggleKeyframe(layer, prop) } }, '◆');
  const nav = (dir) => h('button.kf-nav', {
    title: dir < 0 ? 'Keyframe anterior' : 'Próximo keyframe',
    on: {
      click: () => {
        const list = layer.keyframes?.[prop] || [];
        const k = dir < 0 ? [...list].reverse().find((x) => x.t < m.time - 1e-4) : list.find((x) => x.t > m.time + 1e-4);
        if (k) { pauseMotion(); seekMotion(k.t); }
      },
    },
  }, dir < 0 ? '◀' : '▶');
  bindings.push(() => {
    value.replaceChildren(formatValue(prop, valueAt(layer, prop, m.time)));
    kfBtn.classList.toggle('on', !!keyframeAt(layer, prop, m.time));
    kfBtn.classList.add('has');
  });
  const head = h('div.mt-head', {}, h('span.plabel', {}, PROP_LABELS[prop] || prop), value, h('div.kf-ctrls', {}, nav(-1), kfBtn, nav(1)));
  const lane = h('div.mt-lane', { style: { '--grid': major * zoom + 'px' } });
  for (const k of layer.keyframes[prop]) {
    const cls = `div.mkf${isKeySelected(layer.id, prop, k.t) ? '.sel' : ''}${k.ease === 'hold' ? '.hold' : ''}`;
    lane.append(h(cls, {
      dataset: { layerId: layer.id, prop, t: String(k.t) },
      title: `${PROP_LABELS[prop] || prop} em ${formatTime(k.t, fps())} — arraste para mover, duplo clique remove`,
      style: { left: k.t * zoom + 'px' },
    }));
  }
  return h('div.mt-row.prop', { dataset: { layerId: layer.id, prop } }, head, lane);
}

function updateTime(follow) {
  const m = M();
  const x = HEAD_W + m.time * m.zoom;
  playheadEl.style.left = x + 'px';
  for (const b of bindings) b();
  if (follow && m.playing) {
    const left = scrollEl.scrollLeft + HEAD_W;
    const right = scrollEl.scrollLeft + scrollEl.clientWidth;
    if (x > right - 20 || x < left) scrollEl.scrollLeft = Math.max(0, x - HEAD_W - 40);
  }
}

// ---------------------------------------------------------------- interação
const timeAt = (clientX) => (clientX - contentEl.getBoundingClientRect().left - HEAD_W) / M().zoom;

function onPointerDown(e) {
  const comp = currentComp();
  if (e.button !== 0 || !comp) return;
  const m = M();
  // duplo clique detectado aqui: as linhas são redesenhadas entre um clique e outro,
  // então o 'dblclick' nativo nem sempre chega ao losango
  const now = performance.now();
  const twice = now - lastDown.time < 400 && Math.hypot(e.clientX - lastDown.x, e.clientY - lastDown.y) < 5;
  lastDown = twice ? { time: 0, x: 0, y: 0 } : { time: now, x: e.clientX, y: e.clientY };
  const dblTarget = twice ? e.target.closest('.mkf:not(.sum)') : null;
  if (dblTarget) {
    // só vale como duplo clique se o botão for solto sem arrastar (senão é "selecionar e arrastar")
    window.addEventListener('pointerup', (ev) => {
      if (Math.hypot(ev.clientX - e.clientX, ev.clientY - e.clientY) < 3) onDoubleClick({ target: dblTarget });
    }, { once: true });
  }
  const row = e.target.closest('.mt-row');
  const layer = row ? getLayer(comp, row.dataset.layerId) : null;

  if (e.target.closest('.mt-head')) {
    // clicar no cabeçalho seleciona a camada (os controles continuam funcionando)
    if (layer && !row.classList.contains('prop') && !e.target.closest('button, select')) {
      if (e.shiftKey || e.ctrlKey || e.metaKey) selectLayers([layer.id], { toggle: true });
      else if (!(m.selection.length === 1 && m.selection[0] === layer.id)) selectLayers([layer.id]);
    }
    return;
  }

  const kfEl = e.target.closest('.mkf:not(.sum)');
  if (kfEl && layer) {
    e.preventDefault();
    const key = { layerId: layer.id, prop: kfEl.dataset.prop, t: Number(kfEl.dataset.t) };
    const already = isKeySelected(key.layerId, key.prop, key.t);
    if (e.shiftKey || e.ctrlKey || e.metaKey) {
      m.keySel = already ? m.keySel.filter((k) => !(k.layerId === key.layerId && k.prop === key.prop && Math.abs(k.t - key.t) < 1e-4)) : [...m.keySel, key];
    } else if (!already) {
      m.keySel = [key];
    }
    emit('motion');
    if (!layer.locked && m.keySel.length) beginDrag(e, keyDrag(comp, e));
    return;
  }

  const bar = e.target.closest('.mt-bar');
  if (bar && layer) {
    e.preventDefault();
    if (e.shiftKey || e.ctrlKey || e.metaKey) selectLayers([layer.id], { toggle: true });
    else if (!m.selection.includes(layer.id)) selectLayers([layer.id]);
    if (!layer.locked) beginDrag(e, barDrag(comp, layer, e.target.dataset.side || 'move', e));
    return;
  }

  // régua ou área vazia: move o playhead
  e.preventDefault();
  if (m.keySel.length) { m.keySel = []; emit('motion'); }
  pauseMotion();
  const scrub = (ev) => seekMotion(snapFrame(Math.max(0, timeAt(ev.clientX))));
  scrub(e);
  beginDrag(e, { move: scrub });
}

function beginDrag(e, d) {
  if (!d) return;
  drag = d;
  const move = (ev) => drag?.move?.(ev);
  const up = (ev) => {
    window.removeEventListener('pointermove', move);
    window.removeEventListener('pointerup', up);
    const done = drag;
    drag = null;
    done?.up?.(ev);
  };
  window.addEventListener('pointermove', move);
  window.addEventListener('pointerup', up);
}

/** Arrasta os keyframes selecionados no tempo. */
function keyDrag(comp, e) {
  const m = M();
  const x0 = e.clientX;
  const keys = m.keySel.map((k) => ({ ...k }));
  const layerIds = [...new Set(keys.map((k) => k.layerId))];
  const orig = new Map(layerIds.map((id) => [id, JSON.stringify(getLayer(comp, id)?.keyframes || {})]));
  const minT = Math.min(...keys.map((k) => k.t));
  let started = false;
  return {
    move(ev) {
      let dt = (ev.clientX - x0) / m.zoom;
      dt = snapFrame(Math.max(-minT, dt));
      if (!started) {
        if (dt === 0) return;
        started = true;
        checkpoint();
      }
      for (const id of layerIds) {
        const layer = getLayer(comp, id);
        if (!layer || layer.locked) continue;
        layer.keyframes = JSON.parse(orig.get(id));
        const mine = keys.filter((k) => k.layerId === id);
        for (const prop of new Set(mine.map((k) => k.prop))) {
          const list = layer.keyframes[prop];
          if (!list) continue;
          const moved = new Set();
          for (const k of mine) {
            if (k.prop !== prop) continue;
            const kf = list.find((x) => Math.abs(x.t - k.t) < 1e-4 && !moved.has(x));
            if (kf) { kf.t = Math.max(0, k.t + dt); moved.add(kf); }
          }
          // um keyframe arrastado para cima de outro o substitui
          layer.keyframes[prop] = list.filter((x) => moved.has(x) || ![...moved].some((mk) => Math.abs(mk.t - x.t) < 1e-4)).sort((a, b) => a.t - b.t);
        }
      }
      m.keySel = keys.map((k) => ({ ...k, t: Math.max(0, k.t + dt) }));
      emit('project');
    },
  };
}

/** Move a camada no tempo (com os keyframes) ou apara o início/fim. */
function barDrag(comp, layer, side, e) {
  const m = M();
  const x0 = e.clientX;
  const frame = 1 / fps();
  const targets = side === 'move' ? comp.layers.filter((l) => m.selection.includes(l.id) && !l.locked) : [layer];
  const orig = targets.map((l) => ({ layer: l, in: l.in, out: l.out, keyframes: JSON.stringify(l.keyframes || {}) }));
  const minIn = Math.min(...orig.map((o) => o.in));
  const maxOut = Math.max(...orig.map((o) => o.out));
  let started = false;
  return {
    move(ev) {
      let dt = snapFrame((ev.clientX - x0) / m.zoom);
      if (!started) {
        if (dt === 0) return;
        started = true;
        checkpoint();
      }
      for (const o of orig) {
        o.layer.in = o.in;
        o.layer.out = o.out;
        if (side === 'l') {
          o.layer.in = clamp(o.in + dt, 0, o.out - frame);
        } else if (side === 'r') {
          o.layer.out = clamp(o.out + dt, o.in + frame, comp.duration);
        } else {
          o.layer.keyframes = JSON.parse(o.keyframes);
          dt = clamp(dt, -minIn, Math.max(-minIn, comp.duration - maxOut));
          shiftLayer(o.layer, dt);
        }
      }
      emit('project');
    },
  };
}

function onDoubleClick(e) {
  const comp = currentComp();
  const kfEl = e.target.closest('.mkf:not(.sum)');
  if (!comp || !kfEl) return;
  const layer = getLayer(comp, kfEl.dataset.layerId);
  if (!layer || layer.locked) return;
  checkpoint();
  removeKeyframe(layer, kfEl.dataset.prop, Number(kfEl.dataset.t));
  M().keySel = [];
  emit('project');
}
