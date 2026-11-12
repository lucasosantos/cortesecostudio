// Implementação das ferramentas MCP: o que uma IA conectada pode ler e alterar no projeto aberto.
// As definições (nomes, descrições, esquemas) ficam em mcp/tools.json; aqui cada uma vira uma função.
// Mensagens de erro são em inglês porque quem as lê é o modelo.
import {
  state, emit, pushHistory, undo, redo, getClip, getTrack, getMedia, orderedTracks, projectDuration, overlaps, addTrack, removeTrack,
  moveTrack, removeClip, rippleRemove, splitClip, createClipFromMedia, createTextClip, createCompClip, measureText, serializeProject,
} from '../state/project.js';
import { KF_PROPS, EASINGS } from '../state/keyframes.js';
import { EASING_LABELS } from '../motion/easing.js';
import {
  TEXT_ANIM_PRESETS, TEXT_LOOP_PRESETS, TEXT_UNITS, TEXT_ORDERS, TEXT_ANIM_DEFAULTS,
} from '../engine/text.js';
import {
  getComp, getLayer, createComp, createLayer, removeLayers, setParent, recenterAnchor, layerPropsAt, localBounds,
  SHAPES, LAYER_TYPES, PROP_LABELS,
} from '../motion/model.js';
import { PRESETS, applyPreset } from '../motion/presets.js';
import { parseSvgPath } from '../motion/svgPath.js';
import { importSvg } from '../motion/svgImport.js';
import { DEFAULT_FONTS, installedFamilies, familyCss } from '../fonts.js';
import { drawComp } from '../motion/render.js';
import {
  listExtensions, getExtension, createEffect, validateExtension, installExtension, transitionKnown, transitionOptions, transitionExtId,
  animKnown, animationDef,
  embedUsedExtensions, FORMAT, NATIVE_TRANSITIONS,
} from '../fx/registry.js';
import { buildSource, parseShaderLog } from '../fx/shader.js';
import { checkShader, glAvailable } from '../fx/gl.js';
import { createMask, MASK_SHAPES } from '../fx/mask.js';
import { importPaths, isMissing, runtime } from '../media/library.js';
import { exportProject, exportExtension } from '../engine/exporter.js';
import { getPref } from '../prefs.js';
import { pause, seek, mediaSettled } from '../engine/player.js';
import { exitMotion } from '../ui/motion/actions.js';
import { renderFullFrame } from '../ui/preview.js';
import { readFileByPath, writeFileAt, isDesktop, canStreamToDisk, openFileWriter } from '../platform/index.js';

// ---------------------------------------------------------------- utilidades
export class ToolError extends Error {}
const fail = (msg) => { throw new ToolError(msg); };
const r3 = (v) => (typeof v === 'number' ? Math.round(v * 1000) / 1000 : v);
const isNum = (v) => typeof v === 'number' && Number.isFinite(v);
const num = (v, name, { min = -Infinity, max = Infinity } = {}) => {
  if (!isNum(v)) fail(`"${name}" must be a number.`);
  if (v < min || v > max) fail(`"${name}" must be between ${min} and ${max}.`);
  return v;
};
const frame = () => 1 / (state.project.settings.fps || 30);
const basename = (p) => String(p).split(/[\\/]/).pop();

const clipOf = (id) => getClip(id) || fail(`No clip with id "${id}". Call get_project to list clips.`);
const trackOf = (id) => getTrack(id) || fail(`No track with id "${id}". Call get_project to list tracks.`);
const compOf = (id) => getComp(id) || fail(`No composition with id "${id}". Call get_project to list compositions.`);
const layerOf = (comp, id) => getLayer(comp, id) || fail(`No layer with id "${id}" in composition "${comp.name}". Call get_composition.`);

const isColor = (v) => typeof v === 'string' && /^#[0-9a-f]{3,8}$/i.test(v);
const isEase = (e) => e === undefined || (typeof e === 'string' && e in EASING_LABELS) || (Array.isArray(e) && e.length === 4 && e.every(isNum));

/** Lista de keyframes validada e ordenada. `check` valida o valor de cada um. */
function keyframeList(list, label, check) {
  if (!Array.isArray(list) || !list.length) fail(`Keyframes of "${label}" must be a non-empty array of { t, v, ease } (or null to remove the animation).`);
  const out = list.map((k, i) => {
    if (!k || !isNum(k.t) || k.t < 0) fail(`Keyframe ${i} of "${label}": "t" must be a number >= 0 (seconds).`);
    if (!isEase(k.ease)) fail(`Keyframe ${i} of "${label}": unknown ease ${JSON.stringify(k.ease)}. Use one of ${Object.keys(EASING_LABELS).join(', ')} or [x1, y1, x2, y2].`);
    check(k.v, `keyframe ${i} of "${label}"`);
    return { t: k.t, v: k.v, ease: k.ease || 'linear' };
  }).sort((a, b) => a.t - b.t);
  for (let i = 1; i < out.length; i++) if (out[i].t - out[i - 1].t < 1e-4) fail(`"${label}" has two keyframes at the same time (${out[i].t}).`);
  return out;
}

/** Aplica { prop: lista | null } a um objeto { props, keyframes }. */
function applyKeyframes(target, keyframes, allowed, checkFor) {
  if (keyframes === undefined) return;
  if (!keyframes || typeof keyframes !== 'object') fail('"keyframes" must be an object { prop: [{ t, v, ease }] }.');
  for (const [prop, list] of Object.entries(keyframes)) {
    if (!allowed.includes(prop)) fail(`"${prop}" cannot be animated here. Animatable: ${allowed.join(', ')}.`);
    target.keyframes ||= {};
    if (list === null) {
      delete target.keyframes[prop];
      continue;
    }
    target.keyframes[prop] = keyframeList(list, prop, checkFor(prop));
  }
}

const numberCheck = (v, where) => { if (!isNum(v)) fail(`The value of ${where} must be a number.`); };

/** Executa uma alteração do projeto como um único passo de desfazer; se falhar, nada muda. */
function mutate(label, fn) {
  const before = JSON.stringify(state.project);
  let result;
  try {
    result = fn();
  } catch (err) {
    state.project = JSON.parse(before);
    emit('project');
    throw err;
  }
  pushHistory(before);
  emit('project');
  for (const l of listeners) l(label);
  return result;
}

const listeners = new Set();
/** Avisa a interface a cada alteração feita pela IA. */
export const onAiAction = (fn) => { listeners.add(fn); return () => listeners.delete(fn); };

// ---------------------------------------------------------------- resumos
function specSummary(spec) {
  return spec ? { type: spec.type, duration: r3(spec.duration), ...(spec.direction ? { direction: spec.direction } : {}), ...(spec.params && Object.keys(spec.params).length ? { params: spec.params } : {}) } : undefined;
}

function clipSummary(c) {
  const out = {
    id: c.id, type: c.type, name: c.name, trackId: c.trackId,
    start: r3(c.start), duration: r3(c.duration), end: r3(c.start + c.duration),
  };
  if (c.type === 'video' || c.type === 'audio' || c.type === 'comp') out.inPoint = r3(c.inPoint || 0);
  if (c.mediaId) out.mediaId = c.mediaId;
  if (c.compId) out.compId = c.compId;
  if (c.type === 'text') out.text = c.text;
  if (c.textAnim) out.textAnim = Object.fromEntries(Object.entries(c.textAnim).filter(([, v]) => v).map(([k, v]) => [k, `${v.preset} by ${v.unit}`]));
  out.props = Object.fromEntries(Object.entries(c.props).filter(([k]) => (c.type === 'audio' ? k === 'volume' : true)).map(([k, v]) => [k, r3(v)]));
  const animated = Object.keys(c.keyframes || {});
  if (animated.length) out.animated = animated;
  if (c.effects?.length) out.effects = c.effects.map((e) => (e.enabled === false ? `${e.type} (off)` : e.type));
  if (c.masks?.length) out.masks = c.masks.map((m) => m.shape + (m.inverted ? ' (inverted)' : ''));
  for (const k of ['transition', 'animIn', 'animOut']) if (c[k]) out[k] = specSummary(c[k]);
  return out;
}

const mediaSummary = (m) => ({
  id: m.id, name: m.name, type: m.type, ...(m.type !== 'image' ? { duration: r3(m.duration) } : {}),
  ...(m.width ? { width: m.width, height: m.height } : {}), ...(m.type === 'video' ? { hasAudio: !!m.hasAudio } : {}),
  ...(m.path ? { path: m.path } : {}), ...(isMissing(m.id) ? { missing: true } : {}),
});

const layerSummary = (l) => ({ id: l.id, name: l.name, type: l.type, ...(l.shape ? { shape: l.shape } : {}), ...(l.parentId ? { parentId: l.parentId } : {}) });

// ---------------------------------------------------------------- clipes
/** Track para um clipe novo: a pedida (validada) ou a primeira livre do tipo certo, ou uma nova. */
function pickTrack(trackId, kind, start, duration) {
  if (trackId) {
    const track = trackOf(trackId);
    if (track.kind !== kind) fail(`Track "${track.name}" is ${track.kind}; this clip needs a ${kind} track.`);
    if (track.locked) fail(`Track "${track.name}" is locked.`);
    assertFree(track, start, duration, null);
    return track;
  }
  return orderedTracks().find((t) => t.kind === kind && !t.locked && !overlaps(t.id, start, start + duration)) || addTrack(kind);
}

function assertFree(track, start, duration, ignoreId) {
  const hit = state.project.clips.find((c) => c.trackId === track.id && c.id !== ignoreId && c.start < start + duration - 1e-6 && c.start + c.duration > start + 1e-6);
  if (hit) fail(`That time range overlaps clip "${hit.name}" (${hit.id}, ${r3(hit.start)}-${r3(hit.start + hit.duration)} s) on track "${track.name}". Choose another time or track, or omit trackId.`);
}

function applyClipProps(clip, props) {
  if (props === undefined) return;
  if (!props || typeof props !== 'object') fail('"props" must be an object.');
  for (const [k, v] of Object.entries(props)) {
    if (!KF_PROPS.includes(k)) fail(`Unknown clip property "${k}". Valid: ${KF_PROPS.join(', ')}.`);
    num(v, `props.${k}`, k === 'opacity' ? { min: 0, max: 1 } : k === 'volume' ? { min: 0, max: 2 } : {});
    clip.props[k] = v;
  }
}

const FONT_KEYS = {
  family: 'string', size: 'number', color: 'color', bold: 'boolean', italic: 'boolean', noFill: 'boolean', align: 'align', stroke: 'color', strokeWidth: 'number',
  stroke2: 'color', stroke2Width: 'number', color2: 'colorOrEmpty', letterSpacing: 'signed', lineHeight: 'number', upper: 'boolean',
  shadowColor: 'colorOrEmpty', shadowX: 'signed', shadowY: 'signed', shadowBlur: 'number',
  bg: 'colorOrEmpty', bgPad: 'number', bgRadius: 'number', bgMode: 'bgMode',
};
function applyFont(target, font) {
  if (font === undefined) return;
  if (!font || typeof font !== 'object') fail('"font" must be an object.');
  for (const [k, v] of Object.entries(font)) {
    const kind = FONT_KEYS[k];
    if (!kind) fail(`Unknown font field "${k}". Valid: ${Object.keys(FONT_KEYS).join(', ')}.`);
    if (kind === 'number' && !(isNum(v) && v >= 0)) fail(`font.${k} must be a number >= 0.`);
    if (kind === 'color' && !isColor(v)) fail(`font.${k} must be a color like "#ffcc00".`);
    if (kind === 'boolean' && typeof v !== 'boolean') fail(`font.${k} must be true or false.`);
    if (kind === 'align' && !['left', 'center', 'right'].includes(v)) fail('font.align must be left, center or right.');
    if (kind === 'string' && typeof v !== 'string') fail(`font.${k} must be a string.`);
    if (kind === 'signed' && !isNum(v)) fail(`font.${k} must be a number.`);
    if (kind === 'colorOrEmpty' && v !== '' && !isColor(v)) fail(`font.${k} must be a color like "#000000b3" (with optional alpha) or "" to turn it off.`);
    if (kind === 'bgMode' && !['block', 'line'].includes(v)) fail('font.bgMode must be block or line.');
    target.font[k] = v;
  }
  if (target.font.size < 4) target.font.size = 4;
  if (target.font.lineHeight !== undefined && target.font.lineHeight < 0.5) target.font.lineHeight = 0.5;
}

const TEXT_ANIM_FIELDS = {
  in: ['preset', 'unit', 'order', 'duration', 'delay', 'easing', 'amount'],
  out: ['preset', 'unit', 'order', 'duration', 'delay', 'easing', 'amount'],
  loop: ['preset', 'unit', 'amount', 'speed', 'spread'],
};
/** Animação de texto por letra/palavra/linha: { in?, out?, loop? } (cada parte null remove). */
function applyTextAnim(target, anim) {
  if (anim === undefined) return;
  if (target.type !== 'text') fail('"textAnim" only applies to text clips and text layers.');
  if (anim === null) { delete target.textAnim; return; }
  if (typeof anim !== 'object') fail('"textAnim" must be an object { in?, out?, loop? } or null.');
  const next = { in: null, out: null, loop: null, ...(target.textAnim || {}) };
  for (const [key, spec] of Object.entries(anim)) {
    if (!TEXT_ANIM_FIELDS[key]) fail(`Unknown textAnim part "${key}". Valid: in, out, loop.`);
    if (spec === null) { next[key] = null; continue; }
    if (typeof spec !== 'object') fail(`textAnim.${key} must be an object or null.`);
    const presets = key === 'loop' ? TEXT_LOOP_PRESETS : TEXT_ANIM_PRESETS;
    const out = { ...TEXT_ANIM_DEFAULTS[key], ...(next[key] || {}) };
    for (const [k, v] of Object.entries(spec)) {
      if (!TEXT_ANIM_FIELDS[key].includes(k)) fail(`Unknown field textAnim.${key}.${k}. Valid: ${TEXT_ANIM_FIELDS[key].join(', ')}.`);
      if (k === 'preset' && !presets[v]) fail(`textAnim.${key}.preset must be one of ${Object.keys(presets).join(', ')}.`);
      if (k === 'unit' && !TEXT_UNITS[v]) fail(`textAnim.${key}.unit must be one of ${Object.keys(TEXT_UNITS).join(', ')}.`);
      if (k === 'order' && !TEXT_ORDERS[v]) fail(`textAnim.${key}.order must be one of ${Object.keys(TEXT_ORDERS).join(', ')}.`);
      if (k === 'easing' && !(EASING_LABELS[v] && v !== 'hold')) fail(`textAnim.${key}.easing must be one of ${Object.keys(EASING_LABELS).filter((e) => e !== 'hold').join(', ')}.`);
      if (['duration', 'delay', 'amount', 'speed', 'spread'].includes(k) && !isNum(v)) fail(`textAnim.${key}.${k} must be a number.`);
      if ((k === 'duration' || k === 'delay') && v < 0) fail(`textAnim.${key}.${k} must be >= 0.`);
      out[k] = v;
    }
    if (!presets[out.preset]) fail(`textAnim.${key} needs a "preset" (${Object.keys(presets).join(', ')}).`);
    next[key] = out;
  }
  target.textAnim = next;
}

/** Depois de mudar texto/fonte de um clipe: a caixa acompanha o novo tamanho, mantendo centro e escala. */
function refitText(clip, before) {
  const after = measureText(clip);
  const s = before && before.h ? clip.props.height / before.h : 1;
  const cx = clip.props.x + clip.props.width / 2;
  const cy = clip.props.y + clip.props.height / 2;
  clip.props.width = Math.round(after.w * s);
  clip.props.height = Math.round(after.h * s);
  clip.props.x = Math.round(cx - clip.props.width / 2);
  clip.props.y = Math.round(cy - clip.props.height / 2);
}

function fitProps(srcW, srcH, mode) {
  const { width: W, height: H } = state.project.settings;
  let w = srcW;
  let h = srcH;
  if (mode === 'fill') { w = W; h = H; } else if (mode === 'contain' || mode === 'cover') {
    const s = mode === 'contain' ? Math.min(W / srcW, H / srcH) : Math.max(W / srcW, H / srcH);
    w = srcW * s;
    h = srcH * s;
  }
  return { x: Math.round((W - w) / 2), y: Math.round((H - h) / 2), width: Math.round(w), height: Math.round(h) };
}

function transitionSpec(spec, key, { layer = false } = {}) {
  if (spec === null) return null;
  if (!spec || typeof spec !== 'object') fail(`"${key}" must be an object { type, duration } or null.`);
  const animations = () => listExtensions('animation').map((e) => `ext:${e.id}`);
  if (layer) {
    if (!animationDef(spec.type)) fail(`Unknown entry/exit animation "${spec.type}" for a layer. Available: ${animations().join(', ')}.`);
  } else if (key === 'transition') {
    if (!transitionKnown(spec.type)) fail(`Unknown transition type "${spec.type}". Available: ${transitionOptions().map((o) => o[0]).join(', ')}.`);
  } else if (!animKnown(spec.type)) {
    fail(`Unknown ${key} type "${spec.type}". Available: ${[...transitionOptions().map((o) => o[0]), ...animations()].join(', ')}.`);
  }
  const out = { type: spec.type, duration: num(spec.duration ?? (key === 'transition' ? 1 : 0.5), `${key}.duration`, { min: 0.05, max: 30 }), direction: 'left', color: '#ffffff', params: {} };
  if (spec.direction !== undefined) {
    if (!['left', 'right', 'up', 'down'].includes(spec.direction)) fail(`${key}.direction must be left, right, up or down.`);
    out.direction = spec.direction;
  }
  if (spec.color !== undefined) {
    if (!isColor(spec.color)) fail(`${key}.color must be a color like "#ffffff".`);
    out.color = spec.color;
  }
  const def = getExtension(transitionExtId(spec.type));
  if (spec.params !== undefined) {
    if (!def) fail(`"${spec.type}" has no params.`);
    for (const [k, v] of Object.entries(spec.params || {})) {
      const p = def.params.find((x) => x.name === k);
      if (!p) fail(`"${spec.type}" has no param "${k}". Params: ${def.params.map((x) => x.name).join(', ') || 'none'}.`);
      out.params[k] = paramValue(p, v, `${key}.params.${k}`);
    }
  }
  return out;
}

function paramValue(p, v, where) {
  switch (p.type) {
    case 'bool': if (typeof v !== 'boolean') fail(`${where} must be true or false.`); return v;
    case 'color': case 'color3': if (!isColor(v)) fail(`${where} must be a color like "#00ff00".`); return v;
    case 'vec2': case 'ivec2': if (!Array.isArray(v) || v.length !== 2 || !v.every(isNum)) fail(`${where} must be [a, b].`); return v;
    default: return num(v, where);
  }
}

// ---------------------------------------------------------------- efeitos e máscaras
function buildEffects(list) {
  if (!Array.isArray(list)) fail('"effects" must be an array.');
  return list.map((item, i) => {
    const def = getExtension(item?.type);
    if (!def || def.kind !== 'effect') fail(`Unknown effect "${item?.type}" (item ${i}). Available: ${listExtensions('effect').map((e) => e.id).join(', ')}.`);
    const fx = createEffect(def.id);
    if (item.enabled === false) fx.enabled = false;
    const names = def.params.map((p) => p.name);
    for (const [k, v] of Object.entries(item.params || {})) {
      const p = def.params.find((x) => x.name === k);
      if (!p) fail(`Effect "${def.id}" has no param "${k}". Params: ${names.join(', ') || 'none'}.`);
      fx.props[k] = paramValue(p, v, `effects[${i}].params.${k}`);
    }
    const animatable = def.params.filter((p) => ['float', 'int', 'color', 'color3'].includes(p.type)).map((p) => p.name);
    applyKeyframes(fx, item.keyframes, animatable, (prop) => {
      const p = def.params.find((x) => x.name === prop);
      return (v, where) => paramValue(p, v, where);
    });
    return fx;
  });
}

function buildMasks(list) {
  if (!Array.isArray(list)) fail('"masks" must be an array.');
  return list.map((item, i) => {
    if (!MASK_SHAPES[item?.shape]) fail(`masks[${i}].shape must be rect, ellipse or path.`);
    const mask = createMask(item.shape);
    for (const k of ['x', 'y', 'w', 'h', 'radius', 'feather']) if (item[k] !== undefined) mask.props[k] = num(item[k], `masks[${i}].${k}`, k === 'feather' ? { min: 0, max: 2000 } : k === 'radius' ? { min: 0, max: 1 } : {});
    if (item.shape === 'path') {
      if (!Array.isArray(item.points) || item.points.length < 3) fail(`masks[${i}]: a "path" mask needs "points" with at least 3 [x, y] pairs (fractions 0-1 of the clip box).`);
      mask.props.path = { contours: [{ closed: true, pts: item.points.map((p, j) => {
        if (!Array.isArray(p) || p.length < 2 || !isNum(p[0]) || !isNum(p[1])) fail(`masks[${i}].points[${j}] must be [x, y].`);
        return { x: p[0], y: p[1], ix: 0, iy: 0, ox: 0, oy: 0 };
      }) }] };
    }
    if (item.inverted) mask.inverted = true;
    if (item.enabled === false) mask.enabled = false;
    applyKeyframes(mask, item.keyframes, ['x', 'y', 'w', 'h', 'radius', 'feather'], () => numberCheck);
    return mask;
  });
}

// ---------------------------------------------------------------- camadas do motion
const LAYER_COLOR_PROPS = ['fill', 'stroke'];
function layerPropCheck(layer, prop) {
  if (!(prop in layer.props)) fail(`Layer "${layer.name}" (${layer.type}${layer.shape ? '/' + layer.shape : ''}) has no property "${prop}". It has: ${Object.keys(layer.props).filter((k) => k !== 'path').join(', ')}.`);
  if (prop === 'path') fail('The "path" property cannot be set through props/keyframes; create the layer with "points" or "svgPath".');
  if (LAYER_COLOR_PROPS.includes(prop)) return (v, where) => { if (!isColor(v)) fail(`The value of ${where} must be a color like "#ff8800ff".`); };
  return numberCheck;
}

function applyLayerProps(layer, props) {
  if (props === undefined) return;
  if (!props || typeof props !== 'object') fail('"props" must be an object.');
  for (const [k, v] of Object.entries(props)) {
    layerPropCheck(layer, k)(v, `props.${k}`);
    layer.props[k] = v;
  }
}

function applyLayerText(layer, text, font) {
  if (text === undefined && font === undefined) return;
  if (layer.type !== 'text') fail('"text" and "font" only apply to text layers.');
  const m0 = measureText(layer);
  if (text !== undefined) layer.text = String(text);
  applyFont(layer, font);
  const m1 = measureText(layer);
  recenterAnchor(layer, { x: 0, y: 0, w: m0.w, h: m0.h }, { x: 0, y: 0, w: m1.w, h: m1.h });
}

function applyLayerCommon(comp, layer, a, { parent = true } = {}) {
  if (a.name !== undefined) layer.name = String(a.name);
  applyTextAnim(layer, a.textAnim);
  applyLayerProps(layer, a.props);
  applyKeyframes(layer, a.keyframes, Object.keys(layer.props).filter((k) => k !== 'path'), (prop) => layerPropCheck(layer, prop));
  if (a.fillOn !== undefined) layer.fillOn = !!a.fillOn;
  if (a.strokeOn !== undefined) {
    layer.strokeOn = !!a.strokeOn;
    if (layer.strokeOn && !(layer.props.strokeWidth > 0)) layer.props.strokeWidth = 6;
  }
  if (a.in !== undefined) layer.in = num(a.in, 'in', { min: 0, max: comp.duration });
  if (a.out !== undefined) layer.out = num(a.out, 'out', { min: 0, max: comp.duration });
  if (layer.out - layer.in < frame() / 2) fail('"out" must be greater than "in".');
  if (parent && a.parentId !== undefined) {
    if (a.parentId !== null) layerOf(comp, a.parentId);
    // mantém a camada onde está na tela no instante keepAt (pais animados mudam de lugar com o tempo)
    const at = a.keepAt === undefined ? 0 : num(a.keepAt, 'keepAt', { min: 0, max: comp.duration });
    if (!setParent(comp, layer, a.parentId, at)) fail('That parent would create a cycle (a layer cannot be the child of its own descendant).');
  }
  for (const key of ['animIn', 'animOut']) {
    if (a[key] === undefined) continue;
    if (layer.type === 'group') fail(`"${key}" does not apply to group layers.`);
    const spec = transitionSpec(a[key], key, { layer: true });
    if (spec) layer[key] = { type: spec.type, duration: spec.duration, params: spec.params };
    else delete layer[key];
  }
  if (a.preset !== undefined) {
    if (!PRESETS[a.preset?.id]) fail(`Unknown preset "${a.preset?.id}". Available: ${Object.keys(PRESETS).join(', ')}.`);
    if (!applyPreset(comp, layer, a.preset.id, a.preset.duration ?? 0.5)) fail(`Preset "${a.preset.id}" does not apply to a ${layer.type} layer.`);
  }
}

// ---------------------------------------------------------------- quadros
function toJpeg(source, sw, sh, maxWidth, background) {
  const k = Math.min(1, maxWidth / sw);
  const canvas = Object.assign(document.createElement('canvas'), { width: Math.max(1, Math.round(sw * k)), height: Math.max(1, Math.round(sh * k)) });
  const ctx = canvas.getContext('2d');
  if (background) {
    ctx.fillStyle = background;
    ctx.fillRect(0, 0, canvas.width, canvas.height);
  }
  ctx.drawImage(source, 0, 0, canvas.width, canvas.height);
  return { image: canvas.toDataURL('image/jpeg', 0.85).split(',')[1], mimeType: 'image/jpeg', width: canvas.width, height: canvas.height };
}

// com a janela minimizada o navegador pode parar de animar: não espera para sempre
const nextFrame = () => new Promise((resolve) => {
  requestAnimationFrame(() => resolve());
  setTimeout(resolve, 120);
});
const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// ---------------------------------------------------------------- ferramentas
export const TOOLS = {
  get_project() {
    const p = state.project;
    return {
      name: state.projectName,
      settings: { ...p.settings },
      duration: r3(projectDuration()),
      playhead: r3(state.time),
      selectedClipId: state.selection,
      tracks: orderedTracks().map((t, i) => ({ id: t.id, name: t.name, kind: t.kind, order: i, hidden: !!t.hidden, muted: !!t.muted, locked: !!t.locked })),
      clips: [...p.clips].sort((a, b) => a.start - b.start).map(clipSummary),
      media: p.media.map(mediaSummary),
      compositions: (p.comps || []).map((c) => ({ id: c.id, name: c.name, width: c.width, height: c.height, duration: r3(c.duration), layers: c.layers.map(layerSummary) })),
      notes: 'Visual tracks are listed front to back. Use get_clip / get_composition for full detail, get_frame to see the result.',
    };
  },

  get_clip({ clipId }) {
    return JSON.parse(JSON.stringify(clipOf(clipId)));
  },

  get_composition({ compId }) {
    return JSON.parse(JSON.stringify(compOf(compId)));
  },

  get_capabilities() {
    const params = (e) => (e.params || []).map((p) => ({ name: p.name, type: p.type, default: p.default, ...(isNum(p.min) ? { min: p.min } : {}), ...(isNum(p.max) ? { max: p.max } : {}) }));
    return {
      clipProps: {
        x: 'left edge, px', y: 'top edge, px', width: 'px', height: 'px', rotation: 'degrees, around the center', opacity: '0-1', volume: '0-2 (video/audio)',
      },
      easings: { names: Object.keys(EASING_LABELS), clipInspectorNames: EASINGS, bezier: '[x1, y1, x2, y2] with x in 0-1', note: 'The ease of a keyframe shapes the motion from it to the next keyframe. "hold" jumps.' },
      effects: listExtensions('effect').map((e) => ({ id: e.id, name: e.name, description: e.description || '', params: params(e), ...(e.canvas ? { appliedLast: true } : {}) })),
      transitions: [
        ...Object.keys(NATIVE_TRANSITIONS).map((type) => ({ type, name: NATIVE_TRANSITIONS[type], ...(type === 'slide' ? { options: 'direction: left|right|up|down' } : type === 'flash' ? { options: 'color: #rrggbb' } : {}) })),
        ...listExtensions('transition').map((e) => ({ type: `ext:${e.id}`, name: e.name, params: params(e) })),
      ],
      fonts: {
        defaults: DEFAULT_FONTS.map(([family]) => family),
        installed: installedFamilies().map((f) => familyCss(f.family)),
        note: 'font.family is a CSS font-family list. Any font installed on the operating system also works by name, e.g. "\\"Roboto Slab\\", sans-serif".',
      },
      entryExitAnimations: listExtensions('animation').map((e) => ({ type: `ext:${e.id}`, name: e.name, description: e.description || '', params: params(e) })),
      transitionRules: 'clip.transition joins a clip with the previous clip that ends exactly where it starts, on the same track. animIn/animOut animate the clip alone and accept the transitions above or the entryExitAnimations. Motion layers accept animIn/animOut with entryExitAnimations only (they play from layer.in and end at layer.out).',
      masks: { shapes: Object.keys(MASK_SHAPES), coordinates: 'fractions 0-1 of the clip box', animatable: ['x', 'y', 'w', 'h', 'radius', 'feather'] },
      motion: {
        layerTypes: Object.keys(LAYER_TYPES),
        shapes: Object.keys(SHAPES),
        layerProps: { ...PROP_LABELS, note: 'x/y = position of the anchor in the composition (or in the parent). sx/sy = scale in %. ax/ay = anchor in the layer\'s own pixels (default: its center). opacity 0-1. fill/stroke = "#rrggbbaa". trimStart/trimEnd/trimOffset in % animate a stroke drawing itself. radius = corner radius (rect). sides/inner = polygon and star.' },
        presets: Object.fromEntries(Object.entries(PRESETS).map(([id, p]) => [id, `${p.side === 'in' ? 'entrance' : 'exit'}${p.shapeOnly ? ' (shape layers)' : ''}`])),
        limits: 'Compositions have no audio or video layers and cannot contain other compositions.',
      },
      text: { fontFields: Object.keys(FONT_KEYS), families: ['Inter, Arial, sans-serif', 'Georgia, "Times New Roman", serif', '"Courier New", monospace', 'Impact, "Arial Black", sans-serif', 'Verdana, sans-serif'] },
      webgl: glAvailable(),
    };
  },

  async get_frame({ time, compId, maxWidth = 960 } = {}) {
    maxWidth = Math.max(64, Math.min(1920, Math.round(Number(maxWidth) || 960)));
    if (compId) {
      const comp = compOf(compId);
      const t = Math.max(0, Math.min(comp.duration, time ?? 0));
      const canvas = Object.assign(document.createElement('canvas'), { width: comp.width, height: comp.height });
      drawComp(canvas.getContext('2d'), comp, t, (item) => runtime.get(item.mediaId)?.image || null);
      // fundo cinza para o conteúdo transparente não sumir no JPEG
      return { ...toJpeg(canvas, comp.width, comp.height, maxWidth, '#3a3d46'), time: r3(t), compId, note: 'Transparent areas are shown gray.' };
    }
    if (state.mode !== 'edit') exitMotion();
    pause();
    const t = Math.max(0, Math.min(Math.max(0, projectDuration() - frame() / 2), time ?? state.time));
    seek(t);
    // espera os vídeos chegarem ao quadro pedido e o preview redesenhar
    const until = performance.now() + 2500;
    await nextFrame();
    while (!mediaSettled() && performance.now() < until) await wait(40);
    await nextFrame();
    // quadro em resolução cheia, independente da qualidade escolhida para o preview
    const canvas = renderFullFrame();
    return { ...toJpeg(canvas, canvas.width, canvas.height, maxWidth), time: r3(t) };
  },

  async import_media({ paths }) {
    if (!isDesktop) fail('Importing by path only works in the desktop app.');
    if (!Array.isArray(paths) || !paths.length) fail('"paths" must be a non-empty array of absolute file paths.');
    const { added, failed } = await importPaths(paths);
    return { imported: added.map(mediaSummary), ...(failed.length ? { failed } : {}) };
  },

  add_clip(a) {
    const given = ['mediaId', 'text', 'compId'].filter((k) => a[k] !== undefined);
    if (given.length !== 1) fail('Give exactly one of "mediaId", "text" or "compId".');
    return mutate('add_clip', () => {
      const start = a.start === undefined ? projectDuration() : num(a.start, 'start', { min: 0 });
      let clip;
      if (a.mediaId !== undefined) {
        const media = getMedia(a.mediaId) || fail(`No media with id "${a.mediaId}". Call get_project, or import_media first.`);
        const timed = media.type === 'video' || media.type === 'audio';
        const inPoint = a.inPoint === undefined ? 0 : num(a.inPoint, 'inPoint', { min: 0, max: timed ? Math.max(0, media.duration - frame()) : 0 });
        const natural = timed ? Math.max(frame(), (media.duration || 5) - inPoint) : 5;
        const duration = a.duration === undefined ? natural : num(a.duration, 'duration', { min: frame(), max: timed ? natural : 36000 });
        const track = pickTrack(a.trackId, media.type === 'audio' ? 'audio' : 'visual', start, duration);
        clip = createClipFromMedia(media, track.id, start);
        Object.assign(clip, { duration, inPoint });
        if (media.type !== 'audio' && a.fit && a.fit !== 'contain') Object.assign(clip.props, fitProps(media.width || 1280, media.height || 720, a.fit));
      } else if (a.text !== undefined) {
        const duration = a.duration === undefined ? 5 : num(a.duration, 'duration', { min: frame(), max: 36000 });
        const track = pickTrack(a.trackId, 'visual', start, duration);
        clip = createTextClip(track.id, start, String(a.text));
        clip.duration = duration;
        if (a.font) {
          const before = measureText(clip);
          applyFont(clip, a.font);
          refitText(clip, before);
        }
      } else {
        const comp = compOf(a.compId);
        const duration = a.duration === undefined ? comp.duration : num(a.duration, 'duration', { min: frame(), max: 36000 });
        const track = pickTrack(a.trackId, 'visual', start, duration);
        clip = createCompClip(comp, track.id, start);
        clip.duration = duration;
        if (a.inPoint !== undefined) clip.inPoint = num(a.inPoint, 'inPoint', { min: 0, max: comp.duration });
        if (a.fit && a.fit !== 'contain') Object.assign(clip.props, fitProps(comp.width, comp.height, a.fit));
      }
      if (a.name !== undefined) clip.name = String(a.name);
      applyClipProps(clip, a.props);
      applyTextAnim(clip, a.textAnim);
      state.selection = clip.id;
      return clipSummary(clip);
    });
  },

  update_clip(a) {
    return mutate('update_clip', () => {
      const clip = clipOf(a.clipId);
      const media = getMedia(clip.mediaId);
      const timed = clip.type === 'video' || clip.type === 'audio';
      if (a.inPoint !== undefined) {
        if (!timed && clip.type !== 'comp') fail('"inPoint" only applies to video, audio and composition clips.');
        clip.inPoint = num(a.inPoint, 'inPoint', { min: 0, max: timed && media?.duration ? Math.max(0, media.duration - frame()) : 36000 });
      }
      if (a.duration !== undefined) clip.duration = num(a.duration, 'duration', { min: frame(), max: 36000 });
      if (timed && media?.duration && clip.inPoint + clip.duration > media.duration + 1e-3) {
        fail(`inPoint + duration (${r3(clip.inPoint + clip.duration)} s) goes past the end of the media (${r3(media.duration)} s).`);
      }
      if (a.start !== undefined) clip.start = num(a.start, 'start', { min: 0 });
      if (a.trackId !== undefined) {
        const track = trackOf(a.trackId);
        const kind = clip.type === 'audio' ? 'audio' : 'visual';
        if (track.kind !== kind) fail(`Track "${track.name}" is ${track.kind}; this clip needs a ${kind} track.`);
        clip.trackId = track.id;
      }
      if (a.start !== undefined || a.duration !== undefined || a.trackId !== undefined) assertFree(getTrack(clip.trackId), clip.start, clip.duration, clip.id);
      if (a.name !== undefined) clip.name = String(a.name);
      if (a.text !== undefined || a.font !== undefined) {
        if (clip.type !== 'text') fail('"text" and "font" only apply to text clips.');
        const before = measureText(clip);
        if (a.text !== undefined) clip.text = String(a.text);
        applyFont(clip, a.font);
        refitText(clip, before);
      }
      applyClipProps(clip, a.props);
      applyTextAnim(clip, a.textAnim);
      applyKeyframes(clip, a.keyframes, clip.type === 'audio' ? ['volume'] : KF_PROPS, () => numberCheck);
      for (const key of ['transition', 'animIn', 'animOut']) {
        if (a[key] === undefined) continue;
        if (clip.type === 'audio') fail(`"${key}" does not apply to audio clips.`);
        const spec = transitionSpec(a[key], key);
        if (spec) clip[key] = spec;
        else delete clip[key];
      }
      const out = clipSummary(clip);
      if (clip.transition) {
        const prev = state.project.clips.find((c) => c.trackId === clip.trackId && c.id !== clip.id && Math.abs(c.start + c.duration - clip.start) < 0.02);
        if (!prev) out.warning = 'The transition has no effect yet: no clip ends exactly where this one starts on the same track.';
      }
      return out;
    });
  },

  split_clip({ clipId, time }) {
    return mutate('split_clip', () => {
      const clip = clipOf(clipId);
      const right = splitClip(clip, num(time, 'time'));
      if (!right) fail(`Time ${time} is not inside clip "${clip.name}" (${r3(clip.start)}-${r3(clip.start + clip.duration)} s).`);
      return { left: clipSummary(clip), right: clipSummary(right) };
    });
  },

  delete_clips({ clipIds, ripple = false }) {
    if (!Array.isArray(clipIds) || !clipIds.length) fail('"clipIds" must be a non-empty array.');
    return mutate('delete_clips', () => {
      // do fim para o começo, para o ripple de um não deslocar os próximos a apagar
      const clips = clipIds.map(clipOf).sort((x, y) => y.start - x.start);
      for (const clip of clips) {
        if (ripple) rippleRemove(clip);
        removeClip(clip.id);
      }
      return { deleted: clips.length, duration: r3(projectDuration()) };
    });
  },

  set_effects(a) {
    return mutate('set_effects', () => {
      let target;
      if (a.clipId) {
        target = clipOf(a.clipId);
        if (target.type === 'audio') fail('Audio clips have no visual effects.');
      } else if (a.compId && a.layerId) {
        target = layerOf(compOf(a.compId), a.layerId);
        if (target.type === 'group') fail('Group layers are not drawn and cannot have effects.');
      } else fail('Give "clipId", or "compId" and "layerId".');
      target.effects = buildEffects(a.effects);
      return { effects: target.effects.map((e) => ({ type: e.type, enabled: e.enabled, params: e.props, animated: Object.keys(e.keyframes) })) };
    });
  },

  set_masks({ clipId, masks }) {
    return mutate('set_masks', () => {
      const clip = clipOf(clipId);
      if (clip.type === 'audio') fail('Audio clips cannot be masked.');
      clip.masks = buildMasks(masks);
      state.maskEdit = null;
      return { masks: clip.masks.map((m) => ({ shape: m.shape, inverted: m.inverted, ...Object.fromEntries(Object.entries(m.props).filter(([k]) => k !== 'path')) })) };
    });
  },

  add_track({ kind, name }) {
    if (kind !== 'visual' && kind !== 'audio') fail('"kind" must be "visual" or "audio".');
    return mutate('add_track', () => {
      const track = addTrack(kind);
      if (name) track.name = String(name);
      return { id: track.id, name: track.name, kind: track.kind };
    });
  },

  update_track(a) {
    return mutate('update_track', () => {
      const track = trackOf(a.trackId);
      if (a.name !== undefined) track.name = String(a.name);
      for (const k of ['hidden', 'muted', 'locked']) if (a[k] !== undefined) track[k] = !!a[k];
      if (a.move !== undefined) {
        if (a.move !== 'up' && a.move !== 'down') fail('"move" must be "up" or "down".');
        moveTrack(track.id, a.move === 'up' ? -1 : 1);
      }
      return { tracks: orderedTracks().map((t, i) => ({ id: t.id, name: t.name, kind: t.kind, order: i, hidden: !!t.hidden, muted: !!t.muted, locked: !!t.locked })) };
    });
  },

  delete_track({ trackId }) {
    return mutate('delete_track', () => {
      const track = trackOf(trackId);
      const clips = state.project.clips.filter((c) => c.trackId === track.id).length;
      removeTrack(track.id);
      return { deletedTrack: track.name, deletedClips: clips };
    });
  },

  set_project_settings(a) {
    return mutate('set_project_settings', () => {
      const s = state.project.settings;
      const even = (v, name) => Math.max(16, Math.round(num(v, name, { min: 16, max: 7680 }) / 2) * 2);
      const w = a.width === undefined ? s.width : even(a.width, 'width');
      const h = a.height === undefined ? s.height : even(a.height, 'height');
      if (a.rescale && (w !== s.width || h !== s.height)) {
        const sx = w / s.width;
        const sy = h / s.height;
        const scale = { x: sx, width: sx, y: sy, height: sy };
        for (const clip of state.project.clips) {
          if (clip.type === 'audio') continue;
          for (const [k, f] of Object.entries(scale)) {
            clip.props[k] = Math.round(clip.props[k] * f * 100) / 100;
            for (const kf of clip.keyframes?.[k] || []) kf.v = Math.round(kf.v * f * 100) / 100;
          }
        }
      }
      Object.assign(s, { width: w, height: h });
      if (a.fps !== undefined) s.fps = num(a.fps, 'fps', { min: 1, max: 120 });
      if (a.background !== undefined) {
        if (!isColor(a.background)) fail('"background" must be a color like "#000000".');
        s.background = a.background.slice(0, 7);
      }
      return { settings: { ...s } };
    });
  },

  create_composition(a = {}) {
    return mutate('create_composition', () => {
      const comp = createComp({
        name: a.name, width: a.width === undefined ? undefined : num(a.width, 'width', { min: 2, max: 7680 }),
        height: a.height === undefined ? undefined : num(a.height, 'height', { min: 2, max: 7680 }),
        duration: a.duration === undefined ? 5 : num(a.duration, 'duration', { min: 0.1, max: 3600 }),
      });
      if (a.background) {
        if (!isColor(a.background)) fail('"background" must be a color like "#000000" or null.');
        comp.background = a.background.length === 7 ? `${a.background}ff` : a.background;
      }
      return { id: comp.id, name: comp.name, width: comp.width, height: comp.height, duration: comp.duration, next: 'Add layers with add_layer, then place it with add_clip { compId }.' };
    });
  },

  add_layer(a) {
    return mutate('add_layer', () => {
      const comp = compOf(a.compId);
      if (!LAYER_TYPES[a.type]) fail(`"type" must be one of ${Object.keys(LAYER_TYPES).join(', ')}.`);
      const opts = { name: a.name, x: a.x, y: a.y, w: a.w, h: a.h, text: a.text, fillOn: a.fillOn, strokeOn: a.strokeOn };
      for (const k of ['x', 'y', 'w', 'h']) if (a[k] !== undefined) num(a[k], k);
      if (a.type === 'shape') {
        opts.shape = a.shape || 'rect';
        if (!SHAPES[opts.shape]) fail(`"shape" must be one of ${Object.keys(SHAPES).join(', ')}.`);
        if (opts.shape === 'path') {
          let path;
          if (a.svgPath) path = parseSvgPath(a.svgPath);
          else if (Array.isArray(a.points) && a.points.length >= 2) {
            path = { contours: [{ closed: a.closed !== false, pts: a.points.map((p, i) => {
              if (!Array.isArray(p) || !isNum(p[0]) || !isNum(p[1])) fail(`points[${i}] must be [x, y].`);
              return { x: p[0], y: p[1], ix: 0, iy: 0, ox: 0, oy: 0 };
            }) }] };
          }
          if (!path?.contours.length) fail('A "path" shape needs "points" (at least 2 [x, y] pairs) or a valid "svgPath".');
          opts.path = path;
          // a posição vem dos próprios pontos, a menos que x/y sejam dados
          if (a.x === undefined) delete opts.x;
          if (a.y === undefined) delete opts.y;
          const open = path.contours.every((c) => !c.closed);
          if (a.fillOn === undefined) opts.fillOn = !open;
          if (a.strokeOn === undefined) opts.strokeOn = open;
        }
      } else if (a.type === 'image') {
        const media = getMedia(a.mediaId) || fail(`No media with id "${a.mediaId}".`);
        if (media.type !== 'image') fail('Compositions only accept image media; video and audio go on the main timeline.');
        opts.media = media;
      } else if (a.type === 'text' && a.text === undefined) {
        fail('A text layer needs "text".');
      }
      const parent = a.parentId ? layerOf(comp, a.parentId) : null;
      const layer = createLayer(comp, a.type, opts);
      if (a.type === 'text' && a.font) applyLayerText(layer, undefined, a.font);
      if (parent) {
        // com pai, x/y são nas coordenadas do pai; sem x/y, a camada nasce no centro dele
        const b = localBounds(parent, layerPropsAt(parent, 0));
        if (a.x === undefined && !(a.type === 'shape' && opts.shape === 'path')) layer.props.x = b.x + b.w / 2;
        if (a.y === undefined && !(a.type === 'shape' && opts.shape === 'path')) layer.props.y = b.y + b.h / 2;
        layer.parentId = parent.id;
      }
      applyLayerCommon(comp, layer, a, { parent: false });
      return { ...layerSummary(layer), props: Object.fromEntries(Object.entries(layerPropsAt(layer, 0)).filter(([k]) => k !== 'path').map(([k, v]) => [k, r3(v)])) };
    });
  },

  update_layer(a) {
    return mutate('update_layer', () => {
      const comp = compOf(a.compId);
      const layer = layerOf(comp, a.layerId);
      applyLayerText(layer, a.text, a.font);
      applyLayerCommon(comp, layer, a);
      for (const k of ['hidden', 'locked']) if (a[k] !== undefined) layer[k] = !!a[k];
      if (a.matte !== undefined) {
        if (a.matte === null) layer.matte = null;
        else {
          const other = layerOf(comp, a.matte.layerId);
          if (other === layer) fail('A layer cannot be its own matte.');
          layer.matte = { layerId: other.id, inverted: !!a.matte.inverted };
        }
      }
      if (a.order !== undefined) {
        const i = comp.layers.indexOf(layer);
        const to = { front: 0, back: comp.layers.length - 1, forward: Math.max(0, i - 1), backward: Math.min(comp.layers.length - 1, i + 1) }[a.order];
        if (to === undefined) fail('"order" must be front, back, forward or backward.');
        comp.layers.splice(i, 1);
        comp.layers.splice(to, 0, layer);
      }
      return { ...layerSummary(layer), animated: Object.keys(layer.keyframes || {}), stack: comp.layers.map((l) => l.name) };
    });
  },

  delete_layers({ compId, layerIds }) {
    if (!Array.isArray(layerIds) || !layerIds.length) fail('"layerIds" must be a non-empty array.');
    return mutate('delete_layers', () => {
      const comp = compOf(compId);
      for (const id of layerIds) layerOf(comp, id);
      removeLayers(comp, layerIds);
      return { remaining: comp.layers.map(layerSummary) };
    });
  },

  async import_svg({ compId, svg, path, name }) {
    let text = svg;
    if (!text && path) {
      if (!isDesktop) fail('Reading a file by path only works in the desktop app; pass the SVG markup in "svg".');
      const bytes = await readFileByPath(String(path));
      if (!bytes) fail(`Could not read "${path}".`);
      text = new TextDecoder().decode(bytes);
    }
    if (!text) fail('Give "svg" (markup) or "path" (file).');
    return mutate('import_svg', () => {
      const comp = compOf(compId);
      try {
        const r = importSvg(comp, text, name || (path ? basename(path) : 'SVG'));
        return { rootLayerId: r.root.id, shapes: r.shapes, layers: r.layers.map(layerSummary), ...(r.warnings.length ? { warnings: r.warnings } : {}) };
      } catch (err) {
        return fail(`SVG import failed: ${err.message}`);
      }
    });
  },

  install_extension(a) {
    const r = validateExtension({ format: FORMAT, version: 1, author: 'IA', ...a });
    if (!r.ok) fail(r.errors.join(' '));
    if (!glAvailable()) fail('WebGL2 is not available in this environment, so shaders cannot run.');
    const check = checkShader(buildSource(r.ext));
    if (!check.ok) {
      const errors = parseShaderLog(check.log, r.ext.glsl.split('\n').length);
      fail(`The GLSL does not compile:\n${errors.map((e) => (e.line ? `line ${e.line}: ${e.message}` : e.message)).join('\n')}`);
    }
    const existed = !!getExtension(r.ext.id);
    installExtension(r.ext);
    for (const l of listeners) l('install_extension');
    return {
      id: r.ext.id, kind: r.ext.kind, replaced: existed,
      use: r.ext.kind === 'effect' ? `set_effects with type "${r.ext.id}"`
        : r.ext.kind === 'animation' ? `animIn/animOut of clips (update_clip) or layers (update_layer) with type "ext:${r.ext.id}"`
          : `transition/animIn/animOut with type "ext:${r.ext.id}"`,
    };
  },

  seek({ time }) {
    if (state.mode !== 'edit') exitMotion();
    pause();
    seek(Math.min(num(time, 'time', { min: 0 }), projectDuration()));
    return { playhead: r3(state.time) };
  },

  undo({ steps = 1, redo: forward = false } = {}) {
    const n = Math.max(1, Math.min(50, Math.round(Number(steps) || 1)));
    for (let i = 0; i < n; i++) (forward ? redo : undo)();
    return { done: forward ? 'redo' : 'undo', steps: n, duration: r3(projectDuration()), clips: state.project.clips.length };
  },

  async save_project({ path }) {
    if (!isDesktop) fail('Saving to a path only works in the desktop app.');
    if (!/\.json$/i.test(String(path || ''))) fail('"path" must be an absolute path ending in .json.');
    embedUsedExtensions();
    await writeFileAt(String(path), new TextEncoder().encode(serializeProject()));
    state.projectName = basename(path).replace(/\.json$/i, '');
    return { saved: path };
  },

  async export_video({ path, format = 'mp4', quality = 'high' }) {
    if (!isDesktop) fail('Exporting to a path only works in the desktop app.');
    if (!path || typeof path !== 'string') fail('"path" must be an absolute file path.');
    if (!['mp4', 'mp3'].includes(format)) fail('"format" must be "mp4" or "mp3".');
    if (projectDuration() <= 0) fail('The timeline is empty: nothing to export.');
    pause();
    // o contêiner pode cair para WebM se este ambiente não codifica H.264
    const out = path.replace(/\.[a-z0-9]+$/i, '') + '.' + (await exportExtension(state.project, format));
    const opts = { format, quality, hardware: true, fast: getPref('fastExport') };
    let result;
    if (canStreamToDisk) {
      // grava direto no disco, aos poucos
      const writer = await openFileWriter(out);
      try {
        result = await exportProject(state.project, { ...opts, writer });
        await writer.close();
      } catch (err) {
        await writer.abort().catch(() => {});
        throw err;
      }
    } else {
      result = await exportProject(state.project, opts);
      await writeFileAt(out, new Uint8Array(result.data));
    }
    return { path: out, bytes: result.bytes, duration: r3(projectDuration()), ...(result.note ? { note: result.note } : {}) };
  },
};

/** Executa uma ferramenta pelo nome. Erros de uso voltam como mensagem para o modelo. */
export async function callTool(name, args) {
  const fn = TOOLS[name];
  if (!fn) throw new ToolError(`Unknown tool "${name}".`);
  if (args !== undefined && (args === null || typeof args !== 'object' || Array.isArray(args))) throw new ToolError('Arguments must be an object.');
  return fn(args || {});
}

