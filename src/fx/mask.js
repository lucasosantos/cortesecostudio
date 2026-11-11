// Máscaras de clipe: recortam o conteúdo por um retângulo, uma elipse ou uma forma livre.
// Posição e tamanho são frações (0–1) da caixa do clipe, para a máscara acompanhar o clipe ao redimensionar.
import { uid } from '../state/project.js';
import { valueAt } from '../state/keyframes.js';
import { shapePath, trace, transformPath, translatePath } from '../motion/geometry.js';

export const MASK_SHAPES = { rect: 'Retângulo', ellipse: 'Elipse', path: 'Forma livre' };

export function createMask(shape = 'rect') {
  const mask = {
    id: uid('mk'), shape, enabled: true, inverted: false,
    props: { x: 0.15, y: 0.15, w: 0.7, h: 0.7, radius: 0, feather: 0 },
    keyframes: {},
  };
  if (shape === 'path') {
    // começa como um losango, para já haver pontos a arrastar
    const pt = (x, y) => ({ x, y, ix: 0, iy: 0, ox: 0, oy: 0 });
    mask.props.path = { contours: [{ closed: true, pts: [pt(0.5, 0.12), pt(0.88, 0.5), pt(0.5, 0.88), pt(0.12, 0.5)] }] };
  }
  return mask;
}

export const activeMasks = (obj) => (obj.masks || []).filter((m) => m.enabled !== false);

/** Valores das propriedades da máscara no tempo t. */
export function maskPropsAt(mask, t) {
  const out = {};
  for (const k in mask.props) out[k] = valueAt(mask, k, t);
  return out;
}

/** Caminho da máscara em pixels de uma caixa de cw × ch. */
export function maskPath(mask, t, cw, ch) {
  const p = maskPropsAt(mask, t);
  if (mask.shape === 'path') return transformPath(p.path?.contours ? p.path : { contours: [] }, [cw, 0, 0, ch, 0, 0]);
  const w = Math.max(0, p.w) * cw;
  const h = Math.max(0, p.h) * ch;
  const radius = Math.max(0, Math.min(1, p.radius || 0)) * (Math.min(w, h) / 2);
  return translatePath(shapePath({ shape: mask.shape === 'ellipse' ? 'ellipse' : 'rect' }, { w, h, radius }), p.x * cw, p.y * ch);
}

/**
 * Recorta o conteúdo já desenhado em `ctx` (canvas de cw × ch) pelas máscaras.
 * Área visível = união das máscaras normais (ou tudo, se só houver invertidas) menos a união das invertidas.
 * @param scratch { canvas, ctx } auxiliar do mesmo tamanho
 * @param scale fator para a suavização (a suavização é dada em pixels do projeto)
 */
export function applyMasks(ctx, masks, t, cw, ch, scratch, scale = 1) {
  const m = scratch.ctx;
  const fill = (mask, op) => {
    const feather = Math.max(0, valueAt(mask, 'feather', t) || 0) * scale;
    m.globalCompositeOperation = op;
    m.filter = feather > 0.01 ? `blur(${feather.toFixed(2)}px)` : 'none';
    m.fillStyle = '#fff';
    m.beginPath();
    trace(m, maskPath(mask, t, cw, ch));
    m.fill();
  };
  const normal = masks.filter((k) => !k.inverted);
  const inverted = masks.filter((k) => k.inverted);
  m.save();
  if (!normal.length) {
    m.fillStyle = '#fff';
    m.fillRect(0, 0, cw, ch);
  }
  for (const mask of normal) fill(mask, 'source-over');
  for (const mask of inverted) fill(mask, 'destination-out');
  m.restore();
  m.filter = 'none';
  ctx.save();
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.globalAlpha = 1;
  ctx.globalCompositeOperation = 'destination-in';
  ctx.drawImage(scratch.canvas, 0, 0);
  ctx.restore();
}
