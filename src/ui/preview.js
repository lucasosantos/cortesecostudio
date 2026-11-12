// Preview: canvas na resolução do projeto, loop de desenho e alças para mover/redimensionar.
import { state, emit, subscribe, checkpoint, getClip, getTrack, projectDuration, localTime } from '../state/project.js';
import { propsAt, setProp } from '../state/keyframes.js';
import { drawFrame, visualLayersAt, transitionIndexFor } from '../engine/compositor.js';
import { tick, syncMedia, previewSource, setMediaFrameListener } from '../engine/player.js';
import { getPref, onPrefChange } from '../prefs.js';
import { h, formatTime } from './util.js';
import { icon } from './icons.js';
import { count, timed } from '../perf.js';
import { editedMask, updateMaskOverlay, hideMaskOverlay, maskPointerDown } from './maskEditor.js';

let canvas, ctx, frameEl, stageEl, overlayEl, boxEl;
let scale = 1;
let drag = null;
// o quadro só é redesenhado quando algo mudou
let dirty = true;
let lastDraw = 0;
let renderScale = 1; // fração da resolução do projeto em que o preview é desenhado
let softwareGl = false; // sem placa de vídeo: a qualidade automática fica mais baixa
let lastTc = '';
let lastTotal = '';

/** Pede um redesenho do preview no próximo quadro. */
export function invalidatePreview() {
  dirty = true;
}

/** Informa que o app está desenhando sem placa de vídeo (a qualidade automática cai pela metade). */
export function setSoftwareRendering(on) {
  softwareGl = !!on;
  layout();
}

/** Fração da resolução do projeto usada no preview: a escolhida ou, em "auto", a que cabe na tela. */
export function previewScaleFor(quality, displayScale, dpr = 1, software = false) {
  if (quality !== 'auto') return Math.min(1, Math.max(0.1, Number(quality) || 1));
  const want = displayScale * dpr * (software ? 0.5 : 1);
  // degraus fixos, para o canvas não ser recriado a cada pixel de redimensionamento
  for (const step of [0.25, 0.375, 0.5, 0.75]) if (want <= step) return step;
  return 1;
}

export function initPreview() {
  canvas = document.getElementById('preview-canvas');
  ctx = canvas.getContext('2d');
  frameEl = document.getElementById('preview-frame');
  stageEl = document.getElementById('preview-stage');
  overlayEl = document.getElementById('preview-overlay');

  new ResizeObserver(layout).observe(stageEl);
  setMediaFrameListener(invalidatePreview);
  onPrefChange((name) => { if (name === 'previewQuality') layout(); });
  subscribe((reason) => {
    if (reason !== 'zoom' && !reason.startsWith('motion')) dirty = true;
    if (reason === 'project' || reason === 'mode') layout();
    if (reason === 'play') {
      document.getElementById('play-btn').innerHTML = icon(state.playing ? 'pause' : 'play');
    }
  });
  overlayEl.addEventListener('pointerdown', onPointerDown);
  layout();
  requestAnimationFrame(loop);
}

let stageW = 0;
let stageH = 0;
let layoutKey = '';
function layout(entries) {
  const { width: W, height: H, fps } = state.project.settings;
  // medir a tela força o navegador a recalcular o layout: só no redimensionamento (ou na primeira vez)
  if (entries?.[0]?.contentRect) {
    stageW = entries[0].contentRect.width;
    stageH = entries[0].contentRect.height;
  } else if (!stageW || !stageH) {
    const r = stageEl.getBoundingClientRect();
    stageW = r.width;
    stageH = r.height;
  }
  const quality = getPref('previewQuality');
  const key = `${W}x${H}@${fps}|${stageW}x${stageH}|${quality}|${softwareGl}`;
  if (key === layoutKey) return;
  layoutKey = key;
  const availW = Math.max(50, stageW - 28);
  const availH = Math.max(50, stageH - 28);
  scale = Math.min(availW / W, availH / H);
  renderScale = previewScaleFor(quality, scale, window.devicePixelRatio || 1, softwareGl);
  const cw = Math.max(1, Math.round(W * renderScale));
  const ch = Math.max(1, Math.round(H * renderScale));
  if (canvas.width !== cw || canvas.height !== ch) {
    canvas.width = cw;
    canvas.height = ch;
  }
  frameEl.style.width = Math.round(W * scale) + 'px';
  frameEl.style.height = Math.round(H * scale) + 'px';
  document.getElementById('settings-label').textContent = `${W}×${H} · ${fps}fps`;
  dirty = true;
}

/** Resolução atual do preview, para a tela de Desempenho. */
export const previewInfo = () => ({ width: canvas?.width || 0, height: canvas?.height || 0, scale: renderScale });

function loop(now) {
  requestAnimationFrame(loop);
  // o workspace de motion tem o próprio palco; durante a exportação o preview não disputa a máquina
  if (state.mode !== 'edit' || state.exporting) return;
  count('raf');
  if (state.playing) {
    // tocando, desenha no máximo na taxa de quadros do projeto (o monitor costuma pedir o dobro)
    const interval = 1000 / (state.project.settings.fps || 30);
    if (now - lastDraw < interval - 2) return;
    tick();
  }
  if (!dirty) return;
  dirty = false;
  lastDraw = now;
  const index = transitionIndexFor(state.project, state.rev);
  syncMedia(index);
  timed('draw', () => drawFrame(ctx, state.project, state.time, (clip) => previewSource(clip), index, renderScale));
  updateOverlay();
  const fps = state.project.settings.fps;
  const tc = formatTime(state.time, fps);
  if (tc !== lastTc) document.getElementById('tc-current').textContent = lastTc = tc;
  const total = formatTime(projectDuration(), fps);
  if (total !== lastTotal) document.getElementById('tc-total').textContent = lastTotal = total;
}

/** Quadro atual na resolução cheia do projeto, num canvas próprio (captura para a IA). */
export function renderFullFrame() {
  const { width: W, height: H } = state.project.settings;
  const out = Object.assign(document.createElement('canvas'), { width: W, height: H });
  const index = transitionIndexFor(state.project, state.rev);
  syncMedia(index);
  drawFrame(out.getContext('2d'), state.project, state.time, (clip) => previewSource(clip), index, 1);
  return out;
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
  const mask = clip ? editedMask(clip) : null;
  if (!mask) hideMaskOverlay();
  if (!clip || mask) {
    if (boxEl) { boxEl.remove(); boxEl = null; }
    // editando uma máscara: as alças são as dela, não as do clipe
    if (mask) updateMaskOverlay(overlayEl, clip, mask, propsAt(clip, localTime(clip)), scale);
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
  const mask = clip ? editedMask(clip) : null;
  if (mask) {
    if (!getTrack(clip.trackId)?.locked) maskPointerDown(e, clip, mask, propsAt(clip, localTime(clip)), scale, rect);
    // durante a edição de máscara o clique não seleciona nem move clipes
    return;
  }
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
    const place = (ww, hh) => {
      let x = p.x;
      let y = p.y;
      if (e.ctrlKey) {
        x = p.x + (p.width - ww) / 2;
        y = p.y + (p.height - hh) / 2;
      } else {
        if (dir.includes('w')) x = p.x + (p.width - ww);
        else if (!dir.includes('e')) x = p.x + (p.width - ww) / 2;
        if (dir.includes('n')) y = p.y + (p.height - hh);
        else if (!dir.includes('s')) y = p.y + (p.height - hh) / 2;
      }
      return [x, y];
    };
    if (!e.altKey && !p.rotation) [w, hgt] = snapResize(dir, w, hgt, place, keepAspect && p.height ? p.width / p.height : 0, e.ctrlKey);
    const [x, y] = place(w, hgt);
    set('width', w);
    set('height', hgt);
    set('x', x);
    set('y', y);
  }
  emit('project');
}

/**
 * Ímã ao redimensionar: a borda arrastada gruda nas bordas e no centro do quadro.
 * @param place (w, h) => [x, y] posição da caixa para esse tamanho
 * @param ratio proporção travada (largura/altura) ou 0
 * @returns [w, h] corrigidos
 */
function snapResize(dir, w, hgt, place, ratio, centered) {
  const { width: W, height: H } = state.project.settings;
  const thr = 8 / scale;
  // quanto a borda anda por unidade de tamanho: 1 (lado oposto fixo) ou ½ (redimensiona pelo centro, com Ctrl)
  const k = centered ? 0.5 : 1;
  const [x, y] = place(w, hgt);
  const near = (edge, targets) => {
    let best = null;
    for (const target of targets) if (Math.abs(target - edge) < thr && (best === null || Math.abs(target - edge) < Math.abs(best))) best = target - edge;
    return best;
  };
  const hx = dir.includes('e') ? 1 : dir.includes('w') ? -1 : 0;
  const vy = dir.includes('s') ? 1 : dir.includes('n') ? -1 : 0;
  const ex = hx ? near(hx > 0 ? x + w : x, [0, W / 2, W]) : null;
  const ey = vy ? near(vy > 0 ? y + hgt : y, [0, H / 2, H]) : null;
  if (ex === null && ey === null) return [w, hgt];
  // com a proporção travada, só uma borda manda: a mais próxima do alvo
  const useX = ex !== null && (ey === null || !ratio || Math.abs(ex) <= Math.abs(ey));
  const useY = ey !== null && (!ratio || !useX);
  let nw = useX ? w + (hx * ex) / k : w;
  let nh = useY ? hgt + (vy * ey) / k : hgt;
  if (ratio) {
    if (useX) nh = nw / ratio;
    else nw = nh * ratio;
  }
  return nw >= 4 && nh >= 4 ? [nw, nh] : [w, hgt];
}

function onPointerUp() {
  window.removeEventListener('pointermove', onPointerMove);
  drag = null;
}
