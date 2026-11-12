// Desenho de texto compartilhado entre os clipes de texto e as camadas de texto do motion:
// estilo (contornos, sombra, gradiente, caixa de fundo) e animação por letra, palavra ou linha.
import { measureText, fontString } from '../state/project.js';
import { applyEasing } from '../motion/easing.js';

export const TEXT_ANIM_PRESETS = {
  fade: 'Aparecer', rise: 'Subir', drop: 'Cair', slide: 'Deslizar', pop: 'Crescer', spin: 'Girar', blur: 'Desfocar', typewriter: 'Máquina de escrever',
};
export const TEXT_LOOP_PRESETS = { wave: 'Onda', shake: 'Tremer', pulse: 'Pulsar', flicker: 'Piscar' };
export const TEXT_UNITS = { char: 'Letra', word: 'Palavra', line: 'Linha' };
export const TEXT_ORDERS = { forward: 'Do início', backward: 'Do fim', center: 'Do centro', edges: 'Das pontas', random: 'Aleatória' };

/** Valores iniciais de cada parte da animação de texto. */
export const TEXT_ANIM_DEFAULTS = {
  in: { preset: 'rise', unit: 'char', order: 'forward', duration: 0.4, delay: 0.04, easing: 'easeOut', amount: 1 },
  out: { preset: 'fade', unit: 'char', order: 'forward', duration: 0.3, delay: 0.03, easing: 'easeIn', amount: 1 },
  loop: { preset: 'wave', unit: 'char', amount: 1, speed: 1, spread: 0.08 },
};

export const hasTextAnim = (item) => !!(item.textAnim && (item.textAnim.in || item.textAnim.out || item.textAnim.loop));

// ---------------------------------------------------------------- layout
const hash = (n) => {
  const x = Math.sin(n * 127.1 + 311.7) * 43758.5453;
  return x - Math.floor(x);
};

const layouts = new Map();
/**
 * Posição de cada letra (x do lado esquerdo, linha, palavra), com cache.
 * O contexto já precisa estar com a fonte e o espaçamento do texto.
 */
function layoutGlyphs(ctx, item, m) {
  const f = item.font;
  const key = JSON.stringify([m.lines, fontString(f), f.letterSpacing || 0, f.align, m.w]);
  let hit = layouts.get(key);
  if (hit) return hit;
  const glyphs = [];
  let word = -1;
  let char = 0;
  m.lines.forEach((line, li) => {
    const left = lineLeft(ctx, line, f, m);
    const chars = Array.from(line);
    let prefix = '';
    let inWord = false;
    for (const c of chars) {
      const x = left + (prefix ? ctx.measureText(prefix).width : 0);
      prefix += c;
      const space = /\s/.test(c);
      if (!space && !inWord) word++;
      inWord = !space;
      if (space) continue;
      glyphs.push({ str: c, x, w: ctx.measureText(c).width - (f.letterSpacing || 0), line: li, word, char: char++ });
    }
  });
  hit = { glyphs, count: { char, word: word + 1, line: m.lines.length } };
  if (layouts.size > 64) layouts.clear();
  layouts.set(key, hit);
  return hit;
}

function lineWidth(ctx, line, f) {
  return line ? ctx.measureText(line).width - (f.letterSpacing || 0) : 0;
}

function lineLeft(ctx, line, f, m) {
  const w = lineWidth(ctx, line, f);
  return f.align === 'left' ? m.pad : f.align === 'right' ? m.w - m.pad - w : (m.w - w) / 2;
}

/** Posição da unidade k (de n) na ordem escolhida (pode ser fracionária: centro e pontas). */
function orderOf(order, k, n) {
  const mid = (n - 1) / 2;
  switch (order) {
    case 'backward': return n - 1 - k;
    case 'center': return Math.abs(k - mid);
    case 'edges': return mid - Math.abs(k - mid);
    case 'random': return hash(k + n * 0.618) * (n - 1);
    default: return k;
  }
}

const maxOrder = (order, n) => (order === 'center' || order === 'edges' ? (n - 1) / 2 : Math.max(0, n - 1));

/** Duração total de uma entrada/saída de texto para `n` unidades. */
export function textAnimLength(spec, n) {
  if (!spec) return 0;
  return Math.max(0, spec.duration || 0) + maxOrder(spec.order, n) * Math.max(0, spec.delay || 0);
}

/** Estado visual de uma unidade numa entrada/saída: v = quanto está visível (0–1). */
function presetState(spec, v, u, size, st) {
  const A = spec.amount ?? 1;
  const hidden = 1 - v;
  switch (spec.preset) {
    case 'rise': st.dy += hidden * size * 0.6 * A; st.alpha *= clamp01(v); break;
    case 'drop': st.dy -= hidden * size * 0.6 * A; st.alpha *= clamp01(v); break;
    case 'slide': st.dx += hidden * size * A; st.alpha *= clamp01(v); break;
    case 'pop': st.scale *= Math.max(0, v); st.alpha *= clamp01(v * 3); break;
    case 'spin': st.rot += hidden * Math.PI * A; st.scale *= 0.3 + 0.7 * clamp01(v); st.alpha *= clamp01(v); break;
    case 'blur': st.blur += hidden * size * 0.25 * A; st.alpha *= clamp01(v); break;
    case 'typewriter': st.alpha *= u >= 0.5 ? 1 : 0; break;
    default: st.alpha *= clamp01(v);
  }
}

const clamp01 = (v) => Math.max(0, Math.min(1, v));

function loopState(spec, t, k, size, st) {
  const A = spec.amount ?? 1;
  const phase = (t * (spec.speed ?? 1) - k * (spec.spread ?? 0.08)) * Math.PI * 2;
  switch (spec.preset) {
    case 'shake': {
      const step = Math.floor(t * (spec.speed ?? 1) * 12);
      st.dx += (hash(k * 7.1 + step) - 0.5) * size * 0.12 * A;
      st.dy += (hash(k * 3.7 + step + 0.5) - 0.5) * size * 0.12 * A;
      break;
    }
    case 'pulse': st.scale *= 1 + 0.15 * A * Math.sin(phase); break;
    case 'flicker': st.alpha *= 1 - clamp01(A) * 0.7 * (hash(k * 5.3 + Math.floor(t * (spec.speed ?? 1) * 10)) > 0.6 ? 1 : 0); break;
    default: st.dy += Math.sin(phase) * size * 0.15 * A;
  }
}

/**
 * Estado de cada letra no tempo `time.t` de um elemento visível por `time.span` segundos.
 * @returns [{ ...glyph, alpha, dx, dy, scale, rot, blur, vis }]
 */
function animateGlyphs(layout, anim, time, size) {
  const { glyphs, count } = layout;
  const unitOf = (g, unit) => (unit === 'word' ? g.word : unit === 'line' ? g.line : g.char);
  const outStart = anim.out ? time.span - textAnimLength(anim.out, count[anim.out.unit] || count.char) : Infinity;
  return glyphs.map((g) => {
    const st = { ...g, alpha: 1, dx: 0, dy: 0, scale: 1, rot: 0, blur: 0, vis: 1 };
    if (anim.in) {
      const n = count[anim.in.unit] || count.char;
      const start = orderOf(anim.in.order, unitOf(g, anim.in.unit), n) * Math.max(0, anim.in.delay || 0);
      const u = clamp01(anim.in.duration > 0 ? (time.t - start) / anim.in.duration : time.t >= start ? 1 : 0);
      const v = u >= 1 ? 1 : applyEasing(u, anim.in.easing || 'easeOut');
      presetState(anim.in, v, u, size, st);
      st.vis = Math.min(st.vis, u > 0 ? 1 : 0);
    }
    if (anim.out && time.t > outStart) {
      const n = count[anim.out.unit] || count.char;
      const start = outStart + orderOf(anim.out.order, unitOf(g, anim.out.unit), n) * Math.max(0, anim.out.delay || 0);
      const u = clamp01(anim.out.duration > 0 ? (time.t - start) / anim.out.duration : time.t >= start ? 1 : 0);
      const v = 1 - (u <= 0 ? 0 : applyEasing(u, anim.out.easing || 'easeIn'));
      presetState(anim.out, v, 1 - u, size, st);
      st.vis = Math.min(st.vis, u < 1 ? 1 : 0);
    }
    if (anim.loop) loopState(anim.loop, time.t, unitOf(g, anim.loop.unit), size, st);
    return st;
  });
}

// ---------------------------------------------------------------- desenho
/** Fator de escala do contexto (sombras e filtros do canvas ignoram a transformação). */
function deviceScale(ctx) {
  const T = ctx.getTransform();
  return { k: Math.sqrt(Math.abs(T.a * T.d - T.b * T.c)) || 1, T };
}

function fillStyleFor(ctx, f, ly) {
  if (!f.color2) return f.color || '#fff';
  const g = ctx.createLinearGradient(0, ly - f.size * 0.5, 0, ly + f.size * 0.5);
  g.addColorStop(0, f.color || '#fff');
  g.addColorStop(1, f.color2);
  return g;
}

function roundRect(ctx, x, y, w, h, r) {
  ctx.beginPath();
  if (ctx.roundRect) ctx.roundRect(x, y, w, h, Math.max(0, Math.min(r, w / 2, h / 2)));
  else ctx.rect(x, y, w, h);
}

/**
 * Desenha o texto de `item` ({ text, font, textAnim? }) esticado na caixa (x, y, w, h).
 * @param time opcional { t, span }: tempo local e duração do elemento (para a animação do texto)
 */
export function drawText(ctx, item, x, y, w, h, time = null) {
  const m = measureText(item);
  const f = item.font;
  ctx.translate(x, y);
  ctx.scale(w / m.w, h / m.h);
  ctx.font = fontString(f);
  ctx.letterSpacing = `${f.letterSpacing || 0}px`;
  ctx.textBaseline = 'middle';
  ctx.textAlign = 'left';
  ctx.lineJoin = 'round';
  const lineY = (i) => m.pad + m.lineH * (i + 0.5);

  // cada "peça" é uma linha inteira (sem animação, preserva o kerning) ou uma letra (com animação)
  let pieces;
  if (time && hasTextAnim(item)) {
    pieces = animateGlyphs(layoutGlyphs(ctx, item, m), item.textAnim, time, f.size).filter((g) => g.alpha > 0.001 && g.scale !== 0);
  } else {
    pieces = m.lines.map((line, i) => ({ str: line, x: lineLeft(ctx, line, f, m), w: lineWidth(ctx, line, f), line: i, alpha: 1, dx: 0, dy: 0, scale: 1, rot: 0, blur: 0, vis: 1 }));
  }

  const { k, T } = deviceScale(ctx);
  if (f.bg) drawBackground(ctx, f, m, pieces, lineY, time && hasTextAnim(item) ? layoutGlyphs(ctx, item, m).glyphs : null);

  const strokes = [];
  if (f.stroke2Width > 0) strokes.push({ color: f.stroke2 || '#ffffff', width: ((f.strokeWidth || 0) + f.stroke2Width) * 2 });
  if (f.strokeWidth > 0) strokes.push({ color: f.stroke || '#000', width: f.strokeWidth * 2 });
  // sem preenchimento (texto vazado): só os contornos, o miolo das letras fica transparente
  const passes = [...strokes.map((s) => ({ stroke: s })), ...(f.noFill ? [] : [{ fill: true }])];
  const shadow = f.shadowColor && (f.shadowBlur > 0 || f.shadowX || f.shadowY);

  passes.forEach((pass, pi) => {
    for (const p of pieces) {
      if (!p.str) continue;
      const ly = lineY(p.line);
      ctx.save();
      ctx.globalAlpha *= p.alpha;
      if (p.dx || p.dy || p.scale !== 1 || p.rot) {
        const cx = p.x + p.w / 2;
        ctx.translate(cx + p.dx, ly + p.dy);
        if (p.rot) ctx.rotate(p.rot);
        if (p.scale !== 1) ctx.scale(p.scale, p.scale);
        ctx.translate(-cx, -ly);
      }
      if (p.blur > 0.05) ctx.filter = `blur(${(p.blur * k * Math.abs(p.scale || 1)).toFixed(2)}px)`;
      // a sombra sai só da camada mais de baixo (contorno externo ou o preenchimento)
      if (shadow && pi === 0) {
        const sx = f.shadowX || 0;
        const sy = f.shadowY || 0;
        ctx.shadowColor = f.shadowColor;
        ctx.shadowBlur = (f.shadowBlur || 0) * k;
        ctx.shadowOffsetX = T.a * sx + T.c * sy;
        ctx.shadowOffsetY = T.b * sx + T.d * sy;
      }
      if (pass.stroke) {
        ctx.strokeStyle = pass.stroke.color;
        ctx.lineWidth = pass.stroke.width;
        ctx.strokeText(p.str, p.x, ly);
      } else {
        ctx.fillStyle = fillStyleFor(ctx, f, ly);
        ctx.fillText(p.str, p.x, ly);
      }
      ctx.restore();
    }
  });
}

/** Caixa de fundo: um bloco atrás de todo o texto ou uma faixa por linha. Com animação, acompanha as letras visíveis. */
function drawBackground(ctx, f, m, pieces, lineY, glyphs) {
  // a caixa envolve também os contornos
  const pad = (f.bgPad || 0) + (f.strokeWidth || 0) + (f.stroke2Width || 0);
  const r = f.bgRadius || 0;
  const lineBox = (i) => {
    const line = m.lines[i];
    const w = lineWidth(ctx, line, f);
    const left = lineLeft(ctx, line, f, m);
    return { x: left - pad, y: lineY(i) - f.size * 0.6 - pad, w: w + pad * 2, h: f.size * 1.2 + pad * 2 };
  };
  // visibilidade por linha = a da letra mais visível nela (sem animação: 1)
  const vis = m.lines.map(() => (glyphs ? 0 : 1));
  if (glyphs) for (const p of pieces) vis[p.line] = Math.max(vis[p.line], p.vis * Math.min(1, p.alpha));
  ctx.save();
  ctx.fillStyle = f.bg;
  if (f.bgMode === 'line') {
    m.lines.forEach((line, i) => {
      if (!line.trim() || vis[i] <= 0) return;
      ctx.globalAlpha = vis[i];
      const b = lineBox(i);
      roundRect(ctx, b.x, b.y, b.w, b.h, r);
      ctx.fill();
    });
  } else {
    const all = Math.max(...vis);
    if (all > 0) {
      ctx.globalAlpha = all;
      let x0 = Infinity;
      let x1 = -Infinity;
      m.lines.forEach((line, i) => {
        if (!line.trim()) return;
        const b = lineBox(i);
        x0 = Math.min(x0, b.x);
        x1 = Math.max(x1, b.x + b.w);
      });
      if (x1 > x0) {
        const top = lineY(0) - m.lineH / 2 - pad;
        const bottom = lineY(m.lines.length - 1) + m.lineH / 2 + pad;
        roundRect(ctx, x0, top, x1 - x0, bottom - top, r);
        ctx.fill();
      }
    }
  }
  ctx.restore();
}
