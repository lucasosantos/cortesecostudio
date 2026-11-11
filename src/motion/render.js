// Renderização de uma composição de motion num contexto 2D.
// É a mesma função no palco do workspace, no preview da timeline e na exportação.
import { measureText } from '../state/project.js';
import { drawText } from '../engine/text.js';
import { cssColor } from './interp.js';
import { shapePath, trace, traceContour, contourLength, trimDash } from './geometry.js';
import { layerPropsAt, worldMatrix, layerActive, getLayer } from './model.js';

const scratch = [];
/** Canvas auxiliar do tamanho do destino (usado pelos mattes). */
function scratchCanvas(i, w, h) {
  let s = scratch[i];
  if (!s || s.canvas.width !== w || s.canvas.height !== h) {
    const canvas = typeof OffscreenCanvas !== 'undefined' ? new OffscreenCanvas(w, h) : Object.assign(document.createElement('canvas'), { width: w, height: h });
    s = scratch[i] = { canvas, ctx: canvas.getContext('2d') };
  }
  s.ctx.setTransform(1, 0, 0, 1, 0, 0);
  s.ctx.globalAlpha = 1;
  s.ctx.globalCompositeOperation = 'source-over';
  s.ctx.clearRect(0, 0, w, h);
  return s;
}

/**
 * Desenha a composição no tempo t. O contexto já deve estar transformado de modo que
 * (0, 0)–(comp.width, comp.height) seja a área da composição.
 * @param getSource ({ type: 'image', mediaId }) => CanvasImageSource | null
 * @param opts { clip: recorta na área da composição (padrão true), background: pinta o fundo (padrão true) }
 */
export function drawComp(ctx, comp, t, getSource, opts = {}) {
  const frame = { comp, t, getSource, cache: new Map() };
  ctx.save();
  if (opts.clip !== false) {
    ctx.beginPath();
    ctx.rect(0, 0, comp.width, comp.height);
    ctx.clip();
  }
  if (comp.background && opts.background !== false) {
    ctx.fillStyle = cssColor(comp.background);
    ctx.fillRect(0, 0, comp.width, comp.height);
  }
  // camadas usadas como matte por outra camada visível não aparecem por conta própria
  const matteIds = new Set(comp.layers.filter((l) => l.matte && !l.hidden).map((l) => l.matte.layerId));
  for (let i = comp.layers.length - 1; i >= 0; i--) {
    const layer = comp.layers[i];
    if (layer.hidden || layer.type === 'group' || matteIds.has(layer.id) || !layerActive(layer, t)) continue;
    const matte = layer.matte ? getLayer(comp, layer.matte.layerId) : null;
    if (matte && matte !== layer) drawMatted(ctx, frame, layer, matte);
    else drawLayer(ctx, frame, layer);
  }
  ctx.restore();
}

function drawMatted(ctx, frame, layer, matte) {
  const inverted = !!layer.matte.inverted;
  const matteOn = layerActive(matte, frame.t) && matte.type !== 'group';
  if (!matteOn) {
    // sem matte no instante: nada passa (ou tudo, se invertido)
    if (inverted) drawLayer(ctx, frame, layer);
    return;
  }
  const { width, height } = ctx.canvas;
  const off = scratchCanvas(0, width, height);
  off.ctx.setTransform(ctx.getTransform());
  drawLayer(off.ctx, frame, layer);
  off.ctx.globalCompositeOperation = inverted ? 'destination-out' : 'destination-in';
  drawLayer(off.ctx, frame, matte);
  ctx.save();
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.drawImage(off.canvas, 0, 0);
  ctx.restore();
}

export function drawLayer(ctx, frame, layer) {
  const p = layerPropsAt(layer, frame.t);
  const opacity = Math.max(0, Math.min(1, p.opacity));
  if (opacity <= 0) return;
  const m = worldMatrix(frame.comp, layer, frame.t, frame.cache);
  ctx.save();
  ctx.transform(m[0], m[1], m[2], m[3], m[4], m[5]);
  ctx.globalAlpha *= opacity;

  if (layer.type === 'shape') {
    const path = shapePath(layer, p);
    if (layer.fillOn) {
      ctx.beginPath();
      trace(ctx, path);
      ctx.fillStyle = cssColor(p.fill);
      ctx.fill(layer.fillRule === 'evenodd' ? 'evenodd' : 'nonzero');
    }
    if (layer.strokeOn && p.strokeWidth > 0) strokePath(ctx, path, layer, p);
  } else if (layer.type === 'text') {
    const size = measureText(layer);
    drawText(ctx, layer, 0, 0, size.w, size.h);
  } else if (layer.type === 'image') {
    const src = frame.getSource?.({ type: 'image', mediaId: layer.mediaId, id: layer.id });
    if (src) ctx.drawImage(src, 0, 0, p.w, p.h);
  }
  ctx.restore();
}

function strokePath(ctx, path, layer, p) {
  ctx.lineWidth = p.strokeWidth;
  ctx.lineCap = layer.lineCap || 'round';
  ctx.lineJoin = layer.lineJoin || 'round';
  ctx.strokeStyle = cssColor(p.stroke);
  const start = (p.trimStart ?? 0) / 100;
  const end = (p.trimEnd ?? 100) / 100;
  const offset = (p.trimOffset || 0) / 100;
  const trimmed = Math.min(start, end) > 1e-6 || Math.max(start, end) < 1 - 1e-6;
  if (!trimmed) {
    ctx.beginPath();
    trace(ctx, path);
    ctx.stroke();
    return;
  }
  // cada contorno é aparado separadamente: o tracejado do canvas recomeça a cada subcaminho
  for (const contour of path.contours) {
    const dash = trimDash(contourLength(contour), start, end, offset, contour.closed);
    if (dash === false) continue;
    ctx.beginPath();
    traceContour(ctx, contour);
    if (dash) {
      ctx.setLineDash(dash.dash);
      ctx.lineDashOffset = dash.offset;
    } else {
      ctx.setLineDash([]);
    }
    ctx.stroke();
  }
  ctx.setLineDash([]);
}
