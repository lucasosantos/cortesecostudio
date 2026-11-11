// Montagem dos shaders das extensões (efeitos e transições) e conversão de parâmetros em uniforms.
// Módulo puro: não toca em WebGL, para poder ser testado fora do navegador.
import { parseColor } from '../motion/interp.js';

/** Tipos de parâmetro aceitos → tipo GLSL do uniform. */
export const PARAM_GLSL = {
  float: 'float', int: 'int', bool: 'bool',
  color: 'vec4', color3: 'vec3', vec2: 'vec2', ivec2: 'ivec2',
};
export const PARAM_LABELS = {
  float: 'Número', int: 'Inteiro', bool: 'Liga/desliga', color: 'Cor com transparência', color3: 'Cor', vec2: 'Par de números', ivec2: 'Par de inteiros',
};

/** Nomes que o invólucro já usa e que um parâmetro não pode repetir. */
export const RESERVED = new Set([
  'time', 'progress', 'resolution', 'ratio', 'uSrc', 'uFrom', 'uTo', 'vUv', 'outColor',
  'getColor', 'getFromColor', 'getToColor', 'effect', 'transition', 'animate', 'entering', 'uBox', 'main', 'texture', 'texture2D',
]);

export const VERTEX = `#version 300 es
in vec2 aPos;
out vec2 vUv;
void main() {
  vUv = aPos * 0.5 + 0.5;
  gl_Position = vec4(aPos, 0.0, 1.0);
}`;

const isName = (s) => /^[A-Za-z_][A-Za-z0-9_]*$/.test(s) && !/^gl_/.test(s) && !RESERVED.has(s);

export function paramUniforms(params = []) {
  return params.filter((p) => PARAM_GLSL[p.type] && isName(p.name)).map((p) => `uniform ${PARAM_GLSL[p.type]} ${p.name};`).join('\n');
}

const HEAD = `#version 300 es
precision highp float;
precision highp int;
#define texture2D texture
in vec2 vUv;
out vec4 outColor;
uniform float time;
uniform float progress;
uniform vec2 resolution;
uniform float ratio;`;

/**
 * Shader completo de um efeito. O autor escreve `vec4 effect(vec2 uv)` e lê a imagem com getColor(uv).
 * As cores são "retas" (sem alfa pré-multiplicado); uv (0,0) é o canto inferior esquerdo.
 */
export function buildEffectSource(ext) {
  return `${HEAD}
uniform sampler2D uSrc;
${paramUniforms(ext.params)}
vec4 getColor(vec2 uv) {
  vec4 c = texture(uSrc, uv);
  return c.a > 0.0 ? vec4(c.rgb / c.a, c.a) : vec4(0.0);
}
#line 1
${ext.glsl}
void main() {
  vec4 c = clamp(effect(vUv), 0.0, 1.0);
  outColor = vec4(c.rgb * c.a, c.a);
}`;
}

/**
 * Shader completo de uma transição, com a assinatura do gl-transitions:
 * `vec4 transition(vec2 uv)`, getFromColor(uv), getToColor(uv), progress e ratio.
 */
export function buildTransitionSource(ext) {
  return `${HEAD}
uniform sampler2D uFrom;
uniform sampler2D uTo;
${paramUniforms(ext.params)}
vec4 getFromColor(vec2 uv) { return texture(uFrom, uv); }
vec4 getToColor(vec2 uv) { return texture(uTo, uv); }
#line 1
${ext.glsl}
void main() {
  outColor = clamp(transition(vUv), 0.0, 1.0);
}`;
}

/**
 * Shader completo de uma animação de entrada/saída de um elemento (clipe ou camada).
 * O autor escreve `vec4 animate(vec2 uv)`: uv 0–1 cobre a caixa do elemento, mas a imagem final tem
 * uma margem em volta (uv vai de -ANIM_PAD a 1+ANIM_PAD), então o elemento pode se mover/crescer para fora dela.
 * progress = quanto do elemento está visível: na entrada vai de 0 a 1; na saída, de 1 a 0 (o mesmo código serve
 * para as duas). `entering` diz qual das duas está acontecendo. getColor(uv) é transparente fora da caixa.
 */
export function buildAnimationSource(ext) {
  return `${HEAD}
uniform sampler2D uSrc;
uniform bool entering;
uniform vec4 uBox;
${paramUniforms(ext.params)}
vec4 getColor(vec2 uv) {
  if (uv.x < 0.0 || uv.y < 0.0 || uv.x > 1.0 || uv.y > 1.0) return vec4(0.0);
  vec4 c = texture(uSrc, uv);
  return c.a > 0.0 ? vec4(c.rgb / c.a, c.a) : vec4(0.0);
}
#line 1
${ext.glsl}
void main() {
  vec4 c = clamp(animate((vUv - uBox.xy) / uBox.zw), 0.0, 1.0);
  outColor = vec4(c.rgb * c.a, c.a);
}`;
}

/** Margem em volta do elemento durante a animação, em fração do tamanho dele (de cada lado). */
export const ANIM_PAD = 0.25;

/** Nome da função que cada tipo de extensão precisa definir. */
export const ENTRY_FUNCTION = { effect: 'effect', transition: 'transition', animation: 'animate' };

export const buildSource = (ext) => (ext.kind === 'transition' ? buildTransitionSource(ext)
  : ext.kind === 'animation' ? buildAnimationSource(ext) : buildEffectSource(ext));

/**
 * Converte o log do compilador em [{ line, message }], com a linha relativa ao código do autor
 * (o invólucro usa `#line 1` antes dele). Linhas além do código apontam para a última.
 */
export function parseShaderLog(log, userLines = Infinity) {
  const out = [];
  for (const raw of String(log || '').split('\n')) {
    const text = raw.trim();
    if (!text) continue;
    const m = /^(?:ERROR|WARNING):\s*\d+:(\d+):\s*(.*)$/.exec(text);
    if (m) out.push({ line: Math.max(1, Math.min(Number(m[1]), userLines)), message: m[2] });
    else out.push({ line: 0, message: text });
  }
  return out;
}

/** Valor padrão de um parâmetro quando o autor não informou (ou informou algo inválido). */
export function defaultFor(param) {
  const d = param.default;
  switch (param.type) {
    case 'bool': return !!d;
    case 'int': return Number.isFinite(Number(d)) ? Math.round(Number(d)) : 0;
    case 'color': return typeof d === 'string' && d[0] === '#' ? d : '#ffffffff';
    case 'color3': return typeof d === 'string' && d[0] === '#' ? d : '#ffffff';
    case 'vec2': case 'ivec2': return Array.isArray(d) && d.length === 2 && d.every((v) => Number.isFinite(Number(v))) ? d.map(Number) : [0, 0];
    default: return Number.isFinite(Number(d)) ? Number(d) : 0;
  }
}

/** Valor no formato que o uniform espera (número ou lista de números). */
export function uniformValue(param, value) {
  if (value === undefined || value === null) value = defaultFor(param);
  switch (param.type) {
    case 'bool': return value ? 1 : 0;
    case 'int': return Math.round(Number(value) || 0);
    case 'color': return parseColor(value).map((v) => v / 255);
    case 'color3': return parseColor(value).slice(0, 3).map((v) => v / 255);
    case 'vec2': return [Number(value?.[0]) || 0, Number(value?.[1]) || 0];
    case 'ivec2': return [Math.round(Number(value?.[0]) || 0), Math.round(Number(value?.[1]) || 0)];
    default: return Number(value) || 0;
  }
}

export { isName as isParamName };
