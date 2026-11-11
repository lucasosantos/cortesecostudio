// Aplica efeitos e máscaras a um conteúdo desenhado em canvas (clipe da timeline ou camada do motion).
// Ordem: conteúdo → efeitos de shader → máscaras → filtros de canvas (sombra, brilho externo, desfoque).
import { getExtension, effectValues, animationDef } from './registry.js';
import { buildSource, uniformValue, defaultFor, ANIM_PAD } from './shader.js';
import { runTransition, runChain } from './gl.js';
import { activeMasks, applyMasks } from './mask.js';

const MAX = 4096;
const pool = [];
// conteúdo com efeitos pode conter outro conteúdo com efeitos (composição → camadas):
// cada nível usa os próprios canvases auxiliares
let depth = 0;

function scratch(slot, w, h) {
  const i = depth * 4 + slot;
  let s = pool[i];
  if (!s || s.canvas.width !== w || s.canvas.height !== h) {
    const canvas = typeof OffscreenCanvas !== 'undefined' ? new OffscreenCanvas(w, h) : Object.assign(document.createElement('canvas'), { width: w, height: h });
    s = pool[i] = { canvas, ctx: canvas.getContext('2d') };
  }
  s.ctx.setTransform(1, 0, 0, 1, 0, 0);
  s.ctx.globalAlpha = 1;
  s.ctx.globalCompositeOperation = 'source-over';
  s.ctx.filter = 'none';
  s.ctx.clearRect(0, 0, w, h);
  return s;
}

export const activeEffects = (obj) => (obj.effects || []).filter((e) => e.enabled !== false);

/** O objeto (clipe ou camada) tem algum efeito ou máscara ligado? */
export const hasFx = (obj) => activeEffects(obj).length > 0 || activeMasks(obj).length > 0;

const sources = new WeakMap();
/** Fragment shader completo de uma definição de efeito ou transição (com cache por definição). */
export function effectSource(def) {
  let hit = sources.get(def);
  if (!hit || hit.glsl !== def.glsl) {
    hit = { glsl: def.glsl, frag: buildSource(def) };
    sources.set(def, hit);
  }
  return hit.frag;
}

/**
 * Roda uma transição de extensão entre duas imagens do mesmo tamanho.
 * @param params valores escolhidos pelo usuário ({ nome: valor }); o que faltar usa o padrão
 * @returns canvas com o resultado (copiar antes da próxima chamada), ou null se não foi possível
 */
export function runExtTransition(def, from, to, width, height, progress, params = {}) {
  const uniforms = { progress: Math.max(0, Math.min(1, progress)), time: progress };
  for (const p of def.params || []) uniforms[p.name] = uniformValue(p, params[p.name] ?? defaultFor(p));
  return runTransition(from, to, width, height, effectSource(def), uniforms);
}

/**
 * Animação de entrada/saída (extensões "animation") de um objeto com animIn/animOut no tempo local,
 * para um elemento visível durante `span` segundos. Entrada e saída são encolhidas para caber juntas.
 * @returns { def, progress (quanto está visível), entering, params, time } ou null
 */
export function animationAt(obj, local, span) {
  const len = (spec) => (spec && animationDef(spec.type) ? Math.max(0, spec.duration || 0) : 0);
  let din = len(obj.animIn);
  let dout = len(obj.animOut);
  if (din + dout > span && din + dout > 0) {
    const k = span / (din + dout);
    din *= k;
    dout *= k;
  }
  if (din > 0 && local >= 0 && local < din) {
    return { def: animationDef(obj.animIn.type), progress: local / din, entering: true, params: obj.animIn.params, time: local };
  }
  if (dout > 0 && local > span - dout && local <= span) {
    return { def: animationDef(obj.animOut.type), progress: 1 - (local - (span - dout)) / dout, entering: false, params: obj.animOut.params, time: local };
  }
  return null;
}

/**
 * @param opts {
 *   t, duration   tempo local e duração (para os uniforms time/progress e os keyframes)
 *   progress      opcional: substitui t / duration (camadas do motion começam em layer.in)
 *   width, height tamanho, em pixels do destino, em que o conteúdo é renderizado
 *   scale         pixels do destino por pixel do projeto (para sombra/desfoque/suavização)
 *   paint(ctx2d, w, h)       desenha o conteúdo cru em (0, 0)–(w, h)
 *   source        opcional: quando o conteúdo é só uma imagem ou vídeo esticado na caixa, a própria fonte.
 *                 Ela vai direto para a placa de vídeo como textura, sem a cópia intermediária num canvas 2D
 *   anim          opcional: animação de entrada/saída ({ def, progress, entering, params, time }); o resultado
 *                 ganha uma margem em volta da caixa para o elemento poder sair dela
 *   place(imagem, filtroCss, r) desenha o resultado no destino; r = { x, y, w, h } é o retângulo da imagem
 *                 relativo à caixa do conteúdo (sem animação: { 0, 0, 1, 1 })
 * }
 */
export function drawFx(obj, opts) {
  const cw = Math.max(1, Math.min(MAX, Math.round(opts.width)));
  const ch = Math.max(1, Math.min(MAX, Math.round(opts.height)));
  const scale = opts.scale || 1;
  const t = opts.t;
  // conteúdo cru: a fonte direta, se houver; senão, pintado num canvas auxiliar só quando for preciso
  let painted = null;
  const content = () => {
    if (opts.source) return opts.source;
    if (!painted) {
      painted = scratch(0, cw, ch);
      depth++;
      try {
        painted.ctx.save();
        opts.paint(painted.ctx, cw, ch);
        painted.ctx.restore();
      } finally {
        depth--;
      }
    }
    return painted.canvas;
  };

  const passes = [];
  const filters = [];
  const progress = opts.progress ?? (opts.duration > 0 ? Math.max(0, Math.min(1, t / opts.duration)) : 0);
  for (const effect of activeEffects(obj)) {
    const def = getExtension(effect.type);
    if (!def || def.kind !== 'effect') continue;
    const values = effectValues(effect, def, t);
    if (def.canvas) {
      const css = def.filter(values, scale);
      if (css) filters.push(css);
      continue;
    }
    const uniforms = { time: t, progress };
    for (const p of def.params || []) uniforms[p.name] = uniformValue(p, values[p.name]);
    passes.push({ frag: effectSource(def), uniforms });
  }

  let result = content();
  let fromGl = false; // o resultado está no canvas do WebGL (que não pode ser a textura de entrada dele mesmo)
  if (passes.length) {
    const out = runChain(result, cw, ch, passes);
    if (out) {
      result = out;
      fromGl = true;
    }
  }

  const masks = activeMasks(obj);
  if (masks.length) {
    const b = scratch(1, cw, ch);
    b.ctx.drawImage(result, 0, 0, cw, ch);
    applyMasks(b.ctx, masks, t, cw, ch, scratch(2, cw, ch), scale);
    result = b.canvas;
    fromGl = false;
  }
  let rect = { x: 0, y: 0, w: 1, h: 1 };
  const an = opts.anim;
  if (an?.def) {
    const pw = Math.min(MAX, cw + 2 * Math.round(cw * ANIM_PAD));
    const ph = Math.min(MAX, ch + 2 * Math.round(ch * ANIM_PAD));
    const px = Math.floor((pw - cw) / 2);
    const py = Math.floor((ph - ch) / 2);
    if (fromGl) {
      const c = scratch(1, cw, ch);
      c.ctx.drawImage(result, 0, 0, cw, ch);
      result = c.canvas;
    }
    const uniforms = {
      time: an.time ?? t, progress: Math.max(0, Math.min(1, an.progress)), entering: an.entering ? 1 : 0,
      resolution: [cw, ch], ratio: cw / ch, uBox: [px / pw, py / ph, cw / pw, ch / ph],
    };
    for (const p of an.def.params || []) uniforms[p.name] = uniformValue(p, an.params?.[p.name] ?? defaultFor(p));
    const out = runChain(result, pw, ph, [{ frag: effectSource(an.def), uniforms }]);
    if (out) {
      result = out;
      rect = { x: -px / cw, y: -py / ch, w: pw / cw, h: ph / ch };
    }
  }
  opts.place(result, filters.join(' ') || 'none', rect);
}
