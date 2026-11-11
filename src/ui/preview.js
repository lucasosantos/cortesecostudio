// Preview: canvas na resolução do projeto, loop de desenho e alças para mover/redimensionar.
import { state, emit, subscribe, checkpoint, getClip, getTrack, projectDuration, localTime } from '../state/project.js';
import { propsAt, setProp } from '../state/keyframes.js';
import { drawFrame, visualLayersAt, buildTransitionIndex } from '../engine/compositor.js';
import { tick, syncMedia, previewSource } from '../engine/player.js';
import { h, formatTime } from './util.js';
import { icon } from './icons.js';

let canvas, ctx, frameEl, stageEl, overlayEl, boxEl;
let scale = 1;
let drag = null;

export function initPreview() {
  canvas = document.getElementById('preview-canvas');
  ctx = canvas.getContext('2d');
  frameEl = document.getElementById('preview-frame');
  stageEl = document.getElementById('preview-stage');
  overlayEl = document.getElementById('preview-overlay');

  new ResizeObserver(layout).observe(stageEl);
  subscribe((reason) => {
    if (reason === 'project' || reason === 'selection') layout();
    if (reason === 'play') {
      document.getElementById('play-btn').innerHTML = icon(state.playing ? 'pause' : 'play');
    }
  });
  overlayEl.addEventListener('pointerdown', onPointerDown);
  layout();
  requestAnimationFrame(loop);
}

function layout() {
  const { width: W, height: H } = state.project.settings;
  if (canvas.width !== W || canvas.height !== H) {
    canvas.width = W;
    canvas.height = H;
  }
  const r = stageEl.getBoundingClientRect();
  const availW = Math.max(50, r.width - 28);
  const availH = Math.max(50, r.height - 28);
  scale = Math.min(availW / W, availH / H);
  frameEl.style.width = Math.round(W * scale) + 'px';
  frameEl.style.height = Math.round(H * scale) + 'px';
  document.getElementById('settings-label').textContent = `${W}×${H} · ${state.project.settings.fps}fps`;
}

function loop() {
  if (state.mode !== 'edit') {
    // o workspace de motion tem o próprio palco
    requestAnimationFrame(loop);
    return;
  }
  tick();
  const index = buildTransitionIndex(state.project);
  syncMedia(index);
  drawFrame(ctx, state.project, state.time, (clip) => previewSource(clip), index);
  updateOverlay();
  document.getElementById('tc-current').textContent = formatTime(state.time, state.project.settings.fps);
  document.getElementById('tc-total').textContent = formatTime(projectDuration(), state.project.settings.fps);
  requestAnimationFrame(loop);
}

/** Clipe visual selecionado e visível no tempo atual. */
function activeSelection() {
  const clip = state.selection ? getClip(state.selection) : null;
  if (!clip || clip.type === 'audio') return null;
  const t = state.time;
  if (t < clip.start || t >= clip.start + clip.duration) return null;
  if (getTrack(clip.trackId)?.hidden) return null;
  return clip;
}

function updateOverlay() {
  const clip = activeSelection();
  if (!clip) {
    if (boxEl) { boxEl.remove(); boxEl = null; }
    return;
  }
  if (!boxEl) {
    boxEl = h('div.sel-box', {}, ...['nw', 'n', 'ne', 'e', 'se', 's', 'sw', 'w'].map((d) => h(`div.h.${d}`, { dataset: { dir: d } })));
    overlayEl.append(boxEl);
  }
  const p = propsAt(clip, localTime(clip));
  Object.assign(boxEl.style, {
    left: p.x * scale + 'px',
    top: p.y * scale + 'px',
    width: Math.max(1, p.width * scale) + 'px',
    height: Math.max(1, p.height * scale) + 'px',
    transform: p.rotation ? `rotate(${p.rotation}deg)` : '',
  });
}

/** Clipe visual mais à frente sob o ponto (coordenadas do projeto). */
function hitTest(px, py) {
  const layers = visualLayersAt(state.project, state.time).reverse();
  for (const clip of layers) {
    if (getTrack(clip.trackId)?.locked) continue;
    const p = propsAt(clip, state.time - clip.start);
    const cx = p.x + p.width / 2;
    const cy = p.y + p.height / 2;
    const a = (-(p.rotation || 0) * Math.PI) / 180;
    const dx = px - cx;
    const dy = py - cy;
    const lx = dx * Math.cos(a) - dy * Math.sin(a);
    const ly = dx * Math.sin(a) + dy * Math.cos(a);
    if (Math.abs(lx) <= Math.abs(p.width) / 2 && Math.abs(ly) <= Math.abs(p.height) / 2) return clip;
  }
  return null;
}

function onPointerDown(e) {
  if (e.button !== 0) return;
  const rect = overlayEl.getBoundingClientRect();
  const px = (e.clientX - rect.left) / scale;
  const py = (e.clientY - rect.top) / scale;
  let clip = activeSelection();
  const dir = e.target.dataset?.dir;

  if (!dir && !(clip && e.target === boxEl)) {
    const hit = hitTest(px, py);
    if (hit?.id !== state.selection) {
      state.selection = hit?.id || null;
      emit('selection');
    }
    clip = hit;
    if (!clip) return;
  }
  if (getTrack(clip.trackId)?.locked) return;
  e.preventDefault();
  const local = localTime(clip);
  drag = { clip, dir: dir || 'move', x0: e.clientX, y0: e.clientY, p: propsAt(clip, local), local, started: false };
  window.addEventListener('pointermove', onPointerMove);
  window.addEventListener('pointerup', onPointerUp, { once: true });
}

function onPointerMove(e) {
  if (!drag) return;
  const dx = (e.clientX - drag.x0) / scale;
  const dy = (e.clientY - drag.y0) / scale;
  if (!drag.started) {
    if (Math.abs(dx) * scale < 2 && Math.abs(dy) * scale < 2) return;
    drag.started = true;
    checkpoint();
  }
  const { clip, p, local, dir } = drag;
  const set = (prop, v) => setProp(clip, prop, Math.round(v * 100) / 100, local, state.autoKey);

  if (dir === 'move') {
    let x = p.x + dx;
    let y = p.y + dy;
    if (!e.altKey) {
      // ímã nas bordas e no centro do quadro
      const { width: W, height: H } = state.project.settings;
      const thr = 8 / scale;
      for (const [target, off] of [[0, 0], [W / 2, p.width / 2], [W, p.width]]) if (Math.abs(x + off - target) < thr) x = target - off;
      for (const [target, off] of [[0, 0], [H / 2, p.height / 2], [H, p.height]]) if (Math.abs(y + off - target) < thr) y = target - off;
    }
    set('x', x);
    set('y', y);
  } else {
    // redimensiona no espaço do clipe (rotação desfeita), ancorando o lado oposto
    const a = (-(p.rotation || 0) * Math.PI) / 180;
    const lx = dx * Math.cos(a) - dy * Math.sin(a);
    const ly = dx * Math.sin(a) + dy * Math.cos(a);
    let w = p.width;
    let hgt = p.height;
    if (dir.includes('e')) w = p.width + lx;
    if (dir.includes('w')) w = p.width - lx;
    if (dir.includes('s')) hgt = p.height + ly;
    if (dir.includes('n')) hgt = p.height - ly;
    const corner = dir.length === 2;
    const keepAspect = corner ? !e.shiftKey : e.shiftKey;
    if (keepAspect && p.height) {
      const ratio = p.width / p.height;
      if (Math.abs(w / p.width) > Math.abs(hgt / p.height)) hgt = w / ratio;
      else w = hgt * ratio;
    }
    w = Math.max(4, w);
    hgt = Math.max(4, hgt);
    // posição: mantém o lado oposto fixo (ou o centro, com Ctrl)
    let x = p.x;
    let y = p.y;
    if (e.ctrlKey) {
      x = p.x + (p.width - w) / 2;
      y = p.y + (p.height - hgt) / 2;
    } else {
      if (dir.includes('w')) x = p.x + (p.width - w);
      else if (!dir.includes('e')) x = p.x + (p.width - w) / 2;
      if (dir.includes('n')) y = p.y + (p.height - hgt);
      else if (!dir.includes('s')) y = p.y + (p.height - hgt) / 2;
    }
    set('width', w);
    set('height', hgt);
    set('x', x);
    set('y', y);
  }
  emit('project');
}

function onPointerUp() {
  window.removeEventListener('pointermove', onPointerMove);
  drag = null;
}
