// Keyframes: tempos relativos ao início do clipe (segundos).
// Servem tanto para clipes da timeline quanto para camadas de composição: qualquer objeto { props, keyframes }.
import { applyEasing } from '../motion/easing.js';
import { lerpValue, cloneValue } from '../motion/interp.js';
export const KF_PROPS = ['x', 'y', 'width', 'height', 'rotation', 'opacity', 'volume'];
export const EASINGS = ['linear', 'ease', 'hold'];
const EPS = 1 / 240;

/** Propriedades que têm keyframes neste objeto (clipe ou camada de composição). */
const animatedProps = (obj) => Object.keys(obj.keyframes || {});

/** Valor interpolado de uma propriedade no tempo local t. */
export function valueAt(clip, prop, t) {
  const kfs = clip.keyframes?.[prop];
  if (!kfs || kfs.length === 0) return clip.props[prop];
  if (t <= kfs[0].t) return kfs[0].v;
  const last = kfs[kfs.length - 1];
  if (t >= last.t) return last.v;
  for (let i = 0; i < kfs.length - 1; i++) {
    const a = kfs[i];
    const b = kfs[i + 1];
    // intervalo semiaberto: exatamente em cima de um keyframe vale o valor dele (importa para valores
    // que não se misturam, como caminhos com quantidades de pontos diferentes)
    if (t >= a.t && t < b.t) {
      if (b.t === a.t) return b.v;
      return lerpValue(a.v, b.v, applyEasing((t - a.t) / (b.t - a.t), a.ease));
    }
  }
  return last.v;
}

/** Todas as propriedades interpoladas no tempo local t. */
export function propsAt(clip, t) {
  const out = {};
  for (const p of KF_PROPS) out[p] = valueAt(clip, p, t);
  return out;
}

export function hasKeyframes(clip, prop) {
  return !!clip.keyframes?.[prop]?.length;
}

export function keyframeAt(clip, prop, t) {
  return clip.keyframes?.[prop]?.find((k) => Math.abs(k.t - t) < EPS) || null;
}

export function setKeyframe(clip, prop, t, v, easing) {
  clip.keyframes ||= {};
  const list = (clip.keyframes[prop] ||= []);
  const existing = list.find((k) => Math.abs(k.t - t) < EPS);
  v = cloneValue(v);
  if (existing) {
    existing.v = v;
    if (easing) existing.ease = easing;
  } else {
    list.push({ t, v, ease: easing || 'linear' });
    list.sort((a, b) => a.t - b.t);
  }
}

export function removeKeyframe(clip, prop, t) {
  const list = clip.keyframes?.[prop];
  if (!list) return;
  const i = list.findIndex((k) => Math.abs(k.t - t) < EPS);
  // ao remover o último keyframe, o valor que ele tinha vira o valor estático
  const last = i >= 0 && list.length === 1 ? list[0].v : undefined;
  if (i >= 0) list.splice(i, 1);
  if (list.length === 0) {
    if (last !== undefined) clip.props[prop] = last;
    delete clip.keyframes[prop];
  }
}

/** Remove todos os keyframes da propriedade, mantendo o valor atual como estático. */
export function clearKeyframes(clip, prop, t) {
  if (!clip.keyframes?.[prop]) return;
  clip.props[prop] = valueAt(clip, prop, t);
  delete clip.keyframes[prop];
}

/**
 * Define uma propriedade respeitando a animação: se a propriedade já tem keyframes
 * (ou autoKey está ligado), grava keyframe em t; senão altera o valor estático.
 */
export function setProp(clip, prop, v, t, autoKey = false) {
  if (hasKeyframes(clip, prop) || autoKey) setKeyframe(clip, prop, t, v);
  else clip.props[prop] = cloneValue(v);
}

/** Tempos únicos de keyframe do clipe (todas as propriedades). */
export function keyframeTimes(clip) {
  const set = new Map();
  for (const p of animatedProps(clip)) {
    for (const k of clip.keyframes?.[p] || []) {
      const key = Math.round(k.t * 1000);
      if (!set.has(key)) set.set(key, k.t);
    }
  }
  return [...set.values()].sort((a, b) => a - b);
}

/** Move todos os keyframes no tempo `from` para `to`. */
export function moveKeyframesAt(clip, from, to) {
  for (const p of animatedProps(clip)) {
    const list = clip.keyframes?.[p];
    if (!list) continue;
    for (const k of list) if (Math.abs(k.t - from) < EPS) k.t = to;
    list.sort((a, b) => a.t - b.t);
  }
}

export function removeKeyframesAt(clip, t) {
  for (const p of animatedProps(clip)) if (keyframeAt(clip, p, t)) removeKeyframe(clip, p, t);
}

/**
 * Divide a animação no tempo local `local`: `left` fica com os keyframes até ali, `right` com os seguintes
 * (ainda nos tempos originais). Os dois ganham um keyframe na fronteira para a animação não mudar.
 */
export function splitKeyframes(left, right, local) {
  for (const p of animatedProps(left)) {
    if (!hasKeyframes(left, p)) continue;
    const v = valueAt(left, p, local);
    setKeyframe(left, p, local, v);
    setKeyframe(right, p, local, v);
    left.keyframes[p] = left.keyframes[p].filter((k) => k.t <= local + 1e-6);
    right.keyframes[p] = right.keyframes[p].filter((k) => k.t >= local - 1e-6);
  }
}

/** Desloca todos os keyframes por dt (usado ao aparar o início do clipe). */
export function shiftKeyframes(clip, dt) {
  for (const p of animatedProps(clip)) {
    const list = clip.keyframes?.[p];
    if (list) for (const k of list) k.t += dt;
  }
}
