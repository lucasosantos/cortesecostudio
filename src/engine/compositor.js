// Compõe um frame do projeto no tempo t. Usado tanto no preview quanto na exportação.
import { propsAt } from '../state/keyframes.js';
import { orderedTracks } from '../state/project.js';
import { drawText } from './text.js';
import { drawComp } from '../motion/render.js';
import { hasFx, drawFx, runExtTransition } from '../fx/apply.js';
import { animKnown, transitionKnown, transitionExtId, getExtension, animationDef } from '../fx/registry.js';

export const TRANSITIONS = {
  fade: 'Combinar',
  slide: 'Deslizar',
  flash: 'Flash',
};
export const SLIDE_DIRECTIONS = { left: 'Para a esquerda', right: 'Para a direita', up: 'Para cima', down: 'Para baixo' };
const ADJ_EPS = 0.02; // tolerância para considerar dois clipes "colados"

/** Clipes visuais ativos em t pelo intervalo próprio (sem transições), do fundo para a frente. */
export function visualLayersAt(project, t) {
  const tracks = orderedTracks(project).filter((tr) => tr.kind === 'visual' && !tr.hidden);
  const layers = [];
  for (let i = tracks.length - 1; i >= 0; i--) {
    for (const clip of project.clips) {
      if (clip.trackId === tracks[i].id && t >= clip.start && t < clip.start + clip.duration) layers.push(clip);
    }
  }
  return layers;
}

/**
 * Índice das transições do projeto.
 * - transitions: [{ trackId, out, in, from, to, spec }]
 * - range(clip): intervalo em que o clipe é desenhado (estendido pelas transições)
 */
const indexCache = new WeakMap(); // projeto → { rev, index }
/** Índice de transições com cache: só é refeito quando o projeto muda (rev sobe a cada emit('project')). */
export function transitionIndexFor(project, rev = 0) {
  const hit = indexCache.get(project);
  if (hit && hit.rev === rev) return hit.index;
  const index = buildTransitionIndex(project);
  indexCache.set(project, { rev, index });
  return index;
}

export function buildTransitionIndex(project) {
  const transitions = [];
  const ranges = new Map();
  const noIn = new Set();
  const noOut = new Set();
  const byTrack = new Map();
  for (const c of project.clips) {
    if (c.type === 'audio') continue;
    if (!byTrack.has(c.trackId)) byTrack.set(c.trackId, []);
    byTrack.get(c.trackId).push(c);
  }
  for (const [trackId, list] of byTrack) {
    list.sort((a, b) => a.start - b.start);
    for (let i = 0; i < list.length; i++) {
      const clip = list[i];
      if (!ranges.has(clip.id)) ranges.set(clip.id, [clip.start, clip.start + clip.duration]);
      const spec = clip.transition;
      if (!spec || !transitionKnown(spec.type) || !(spec.duration > 0)) continue;
      const prev = i > 0 && Math.abs(list[i - 1].start + list[i - 1].duration - clip.start) < ADJ_EPS ? list[i - 1] : null;
      // transição só existe entre duas cenas coladas; sem cena anterior, use a animação de entrada
      if (!prev) continue;
      const d = Math.min(spec.duration, clip.duration, prev.duration);
      const from = clip.start - d / 2;
      const to = clip.start + d / 2;
      const pr = ranges.get(prev.id);
      pr[1] = Math.max(pr[1], to);
      ranges.get(clip.id)[0] = from;
      // a transição substitui a saída da cena anterior e a entrada desta
      noOut.add(prev.id);
      noIn.add(clip.id);
      transitions.push({ trackId, out: prev, in: clip, from, to, spec });
    }
  }
  return {
    project,
    transitions,
    range: (clip) => ranges.get(clip.id) || [clip.start, clip.start + clip.duration],
    hasIn: (clip) => !noIn.has(clip.id),
    hasOut: (clip) => !noOut.has(clip.id),
  };
}

/** Todos os clipes desenhados em t (inclui os estendidos por transição). */
export function visibleClipsAt(project, t, index = buildTransitionIndex(project)) {
  const hidden = new Set(project.tracks.filter((tr) => tr.hidden).map((tr) => tr.id));
  return project.clips.filter((c) => {
    if (c.type === 'audio' || hidden.has(c.trackId)) return false;
    const [a, b] = index.range(c);
    return t >= a && t < b;
  });
}

/**
 * Desenha o frame.
 * @param getSource (clip, localT) => CanvasImageSource | null
 * @param scale fração da resolução do projeto em que o canvas de destino está (preview em qualidade reduzida)
 */
export function drawFrame(ctx, project, t, getSource, index = buildTransitionIndex(project), scale = 1) {
  const { width: W, height: H, background } = project.settings;
  // tamanho real do destino: todo o desenho continua em coordenadas do projeto, sob esta transformação
  const Wd = Math.max(1, Math.round(W * scale));
  const Hd = Math.max(1, Math.round(H * scale));
  RS = { sx: Wd / W, sy: Hd / H, Wd, Hd };
  ctx.save();
  ctx.setTransform(RS.sx, 0, 0, RS.sy, 0, 0);
  ctx.globalAlpha = 1;
  ctx.globalCompositeOperation = 'source-over';
  ctx.fillStyle = background || '#000';
  ctx.fillRect(0, 0, W, H);

  const tracks = orderedTracks(project).filter((tr) => tr.kind === 'visual' && !tr.hidden);
  // a track mais alta na lista é a camada da frente: desenha de baixo para cima
  for (let i = tracks.length - 1; i >= 0; i--) {
    const trackId = tracks[i].id;
    const tr = index.transitions.find((x) => x.trackId === trackId && t >= x.from && t < x.to);
    if (tr) {
      drawTransition(ctx, project, tr, t, getSource, index);
      continue;
    }
    for (const clip of project.clips) {
      if (clip.trackId !== trackId || clip.type === 'audio') continue;
      const [a, b] = index.range(clip);
      if (t >= a && t < b) drawClip(ctx, clip, t, getSource, 1, 0, 0, index, W, H);
    }
  }
  ctx.restore();
}

/** Duração efetiva das animações de entrada/saída (cabem juntas no clipe). */
function animDurations(clip, index) {
  const din = index.hasIn(clip) && clip.animIn && animKnown(clip.animIn.type) ? Math.max(0, clip.animIn.duration || 0) : 0;
  const dout = index.hasOut(clip) && clip.animOut && animKnown(clip.animOut.type) ? Math.max(0, clip.animOut.duration || 0) : 0;
  const total = din + dout;
  const k = total > clip.duration ? clip.duration / total : 1;
  return [din * k, dout * k];
}

const DIRS = { left: [-1, 0], right: [1, 0], up: [0, -1], down: [0, 1] };

/** Modificadores de desenho da animação de entrada/saída no tempo t. */
function animState(clip, t, index, W, H) {
  const st = { alpha: 1, dx: 0, dy: 0, flash: null, shader: null, anim: null };
  if (!index) return st;
  const [din, dout] = animDurations(clip, index);
  const local = t - clip.start;
  const apply = (spec, p, entering) => {
    if (spec.type === 'fade') st.alpha *= entering ? p : 1 - p;
    else if (spec.type === 'slide') {
      const [vx, vy] = DIRS[spec.direction] || DIRS.left;
      const e = smooth(p);
      // entrando: vem do lado oposto à direção; saindo: vai na direção
      const k = entering ? e - 1 : e;
      st.dx += vx * W * k;
      st.dy += vy * H * k;
    } else if (spec.type === 'flash') {
      st.flash = { color: spec.color || '#ffffff', a: entering ? 1 - p : p };
    } else if (animationDef(spec.type)) {
      // animação de entrada/saída: roda na caixa do clipe (progress = quanto está visível)
      st.anim = { def: animationDef(spec.type), progress: entering ? p : 1 - p, entering, params: spec.params, time: local };
    } else if (transitionExtId(spec.type)) {
      // transição de extensão usada como entrada/saída: a "outra cena" é vazia
      st.shader = { spec, p, entering };
    }
  };
  if (din > 0 && local >= 0 && local < din) apply(clip.animIn, local / din, true);
  if (dout > 0 && local > clip.duration - dout && local <= clip.duration) apply(clip.animOut, (local - (clip.duration - dout)) / dout, false);
  return st;
}

function drawClip(ctx, clip, t, getSource, alpha = 1, dx = 0, dy = 0, index = null, W = 0, H = 0) {
  const local = t - clip.start;
  const p = propsAt(clip, local);
  const an = animState(clip, t, index, W, H);
  alpha *= an.alpha;
  dx += an.dx;
  dy += an.dy;
  if (an.shader && W && H) {
    const def = getExtension(transitionExtId(an.shader.spec.type));
    const body = layer(4, W, H);
    const empty = layer(5, W, H);
    drawClipBody(body.ctx, clip, local, p, 1, dx, dy, getSource, index, W, H, an.anim);
    const [from, to] = an.shader.entering ? [empty.canvas, body.canvas] : [body.canvas, empty.canvas];
    const out = def ? runExtTransition(def, from, to, RS.Wd, RS.Hd, an.shader.p, an.shader.spec.params) : null;
    ctx.save();
    ctx.globalAlpha = alpha;
    ctx.drawImage(out || body.canvas, 0, 0, W, H);
    ctx.restore();
  } else {
    drawClipBody(ctx, clip, local, p, alpha, dx, dy, getSource, index, W, H, an.anim);
  }
  if (an.flash && an.flash.a > 0) {
    ctx.save();
    ctx.globalAlpha = Math.min(1, an.flash.a);
    ctx.fillStyle = an.flash.color;
    ctx.fillRect(0, 0, W, H);
    ctx.restore();
  }
}

/** Conteúdo do clipe (com efeitos e máscaras) na sua caixa, sem as animações de entrada/saída. */
function drawClipBody(ctx, clip, local, p, alpha, dx, dy, getSource, index, W, H, anim = null) {
  if (p.opacity > 0 && p.width !== 0 && p.height !== 0 && alpha > 0) {
    if (hasFx(clip) || anim) {
      drawClipFx(ctx, clip, local, p, alpha, dx, dy, getSource, index, anim);
    } else if (clip.type === 'text') {
      withBox(ctx, p, alpha, dx, dy, (x, y, w, h) => drawText(ctx, clip, x, y, w, h, { t: local, span: clip.duration }));
    } else if (clip.type === 'comp') {
      drawCompClip(ctx, clip, local, p, alpha, dx, dy, getSource, index, W, H);
    } else {
      const src = getSource(clip, local);
      if (src) withBox(ctx, p, alpha, dx, dy, (x, y, w, h) => ctx.drawImage(src, x, y, w, h));
    }
  }
}

/** Clipe com efeitos ou máscaras: o conteúdo é renderizado à parte, processado e só então posto na caixa. */
function drawClipFx(ctx, clip, local, p, alpha, dx, dy, getSource, index, anim = null) {
  const comp = clip.type === 'comp' ? index?.project?.comps?.find((c) => c.id === clip.compId) : null;
  const src = clip.type === 'text' || clip.type === 'comp' ? null : getSource(clip, local);
  if (clip.type === 'comp' ? !comp : clip.type !== 'text' && !src) return;
  drawFx(clip, {
    t: local,
    duration: clip.duration,
    width: Math.abs(p.width) * RS.sx,
    height: Math.abs(p.height) * RS.sy,
    scale: RS.sx,
    anim,
    source: src,
    paint(c, cw, ch) {
      if (clip.type === 'text') {
        drawText(c, clip, 0, 0, cw, ch, { t: local, span: clip.duration });
      } else if (comp) {
        const ct = Math.min(Math.max((clip.inPoint || 0) + local, 0), Math.max(0, comp.duration - 1e-4));
        c.scale(cw / comp.width, ch / comp.height);
        drawComp(c, comp, ct, getSource, { fields: clip.fieldValues });
      } else {
        c.drawImage(src, 0, 0, cw, ch);
      }
    },
    place: (img, filter, r) => withBox(ctx, p, alpha, dx, dy, (x, y, w, h) => {
      ctx.filter = filter;
      ctx.drawImage(img, x + r.x * w, y + r.y * h, r.w * w, r.h * h);
      ctx.filter = 'none';
    }),
  });
}

/** Desenha a composição de motion do clipe dentro da caixa do clipe. */
function drawCompClip(ctx, clip, local, p, alpha, dx, dy, getSource, index, W, H) {
  const comp = index?.project?.comps?.find((c) => c.id === clip.compId);
  if (!comp) return;
  // depois do fim da composição o último frame fica congelado
  const ct = Math.min(Math.max((clip.inPoint || 0) + local, 0), Math.max(0, comp.duration - 1e-4));
  const paint = (target, a) => withBox(target, p, a, dx, dy, (x, y, w, h) => {
    target.translate(x, y);
    target.scale(w / comp.width, h / comp.height);
    drawComp(target, comp, ct, getSource, { fields: clip.fieldValues });
  });
  const total = Math.max(0, Math.min(1, p.opacity)) * alpha;
  if (total >= 0.999 || !W || !H) return paint(ctx, alpha);
  // translúcido: compõe opaco num canvas à parte para as camadas não transparecerem umas nas outras
  const g = layer(3, W, H);
  paint(g.ctx, 1 / Math.max(1e-6, Math.min(1, p.opacity)));
  ctx.save();
  ctx.globalAlpha = total;
  ctx.drawImage(g.canvas, 0, 0, W, H);
  ctx.restore();
}

function withBox(ctx, p, alpha, dx, dy, fn) {
  ctx.save();
  ctx.globalAlpha = Math.max(0, Math.min(1, p.opacity)) * alpha;
  ctx.translate(p.x + p.width / 2 + dx, p.y + p.height / 2 + dy);
  if (p.rotation) ctx.rotate((p.rotation * Math.PI) / 180);
  fn(-p.width / 2, -p.height / 2, p.width, p.height);
  ctx.restore();
}

// ---------------------------------------------------------------- transições
// escala do quadro em desenho (definida por drawFrame)
let RS = { sx: 1, sy: 1, Wd: 0, Hd: 0 };

const layers = [];
/** Canvas auxiliar do tamanho do destino, já na escala do quadro: desenha-se nele em coordenadas do projeto. */
function layer(i, W, H) {
  const w = RS.Wd || W;
  const hh = RS.Hd || H;
  let l = layers[i];
  if (!l || l.canvas.width !== w || l.canvas.height !== hh) {
    const canvas = typeof OffscreenCanvas !== 'undefined' ? new OffscreenCanvas(w, hh) : Object.assign(document.createElement('canvas'), { width: w, height: hh });
    l = layers[i] = { canvas, ctx: canvas.getContext('2d') };
  }
  l.ctx.setTransform(1, 0, 0, 1, 0, 0);
  l.ctx.globalAlpha = 1;
  l.ctx.globalCompositeOperation = 'source-over';
  l.ctx.clearRect(0, 0, w, hh);
  l.ctx.setTransform(RS.sx, 0, 0, RS.sy, 0, 0);
  return l;
}

const smooth = (u) => u * u * (3 - 2 * u);

function drawTransition(ctx, project, tr, t, getSource, index) {
  const { width: W, height: H } = project.settings;
  const p = Math.min(1, Math.max(0, (t - tr.from) / (tr.to - tr.from)));
  const { out, in: inc, spec } = tr;

  const extId = transitionExtId(spec.type);
  if (extId) {
    // transição de extensão: as duas cenas viram texturas e o shader decide cada pixel
    const def = getExtension(extId);
    const A = layer(0, W, H);
    const B = layer(1, W, H);
    drawClip(A.ctx, out, t, getSource, 1, 0, 0, index, W, H);
    drawClip(B.ctx, inc, t, getSource, 1, 0, 0, index, W, H);
    const result = def ? runExtTransition(def, A.canvas, B.canvas, RS.Wd, RS.Hd, p, spec.params) : null;
    // se o shader não compilar, cai num corte seco no meio
    ctx.drawImage(result || (p < 0.5 ? A.canvas : B.canvas), 0, 0, W, H);
    return;
  }

  if (spec.type === 'fade') {
    // mistura linear real das duas cenas: A·(1-p) + B·p (com alfa pré-multiplicado)
    const A = layer(0, W, H);
    const B = layer(1, W, H);
    const M = layer(2, W, H);
    drawClip(A.ctx, out, t, getSource, 1, 0, 0, index, W, H);
    drawClip(B.ctx, inc, t, getSource, 1, 0, 0, index, W, H);
    M.ctx.globalAlpha = 1 - p;
    M.ctx.drawImage(A.canvas, 0, 0, W, H);
    M.ctx.globalCompositeOperation = 'lighter';
    M.ctx.globalAlpha = p;
    M.ctx.drawImage(B.canvas, 0, 0, W, H);
    ctx.drawImage(M.canvas, 0, 0, W, H);
    return;
  }

  if (spec.type === 'slide') {
    const dir = DIRS[spec.direction] || DIRS.left;
    const e = smooth(p);
    const ox = dir[0] * W;
    const oy = dir[1] * H;
    // a cena que sai é empurrada para fora do quadro enquanto a nova entra pelo lado oposto
    drawClip(ctx, out, t, getSource, 1, ox * e, oy * e, index, W, H);
    drawClip(ctx, inc, t, getSource, 1, ox * (e - 1), oy * (e - 1), index, W, H);
    return;
  }

  if (spec.type === 'flash') {
    if (p < 0.5) {
      drawClip(ctx, out, t, getSource, 1, 0, 0, index, W, H);
    } else {
      drawClip(ctx, inc, t, getSource, 1, 0, 0, index, W, H);
    }
    const a = p < 0.5 ? p * 2 : (1 - p) * 2;
    ctx.save();
    ctx.globalAlpha = Math.max(0, Math.min(1, a));
    ctx.fillStyle = spec.color || '#ffffff';
    ctx.fillRect(0, 0, W, H);
    ctx.restore();
  }
}
