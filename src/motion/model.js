// Modelo do motion: composições e camadas (dados serializados em project.comps).
// As camadas têm o mesmo formato { props, keyframes } dos clipes; o tempo dos keyframes é o tempo da composição.
import { state, uid, measureText } from '../state/project.js';
import { valueAt, hasKeyframes, shiftKeyframes } from '../state/keyframes.js';
import { IDENTITY, mul, trs, invert, apply, decompose, shapePath, pathBounds, translatePath } from './geometry.js';

export const SHAPES = { rect: 'Retângulo', ellipse: 'Elipse', polygon: 'Polígono', star: 'Estrela', line: 'Linha', path: 'Caminho' };
export const LAYER_TYPES = { shape: 'Forma', text: 'Texto', image: 'Imagem', group: 'Grupo' };

/** Rótulos das propriedades animáveis, na ordem em que aparecem na interface. */
export const PROP_LABELS = {
  x: 'Posição X', y: 'Posição Y', sx: 'Escala X', sy: 'Escala Y', rotation: 'Rotação', opacity: 'Opacidade',
  ax: 'Âncora X', ay: 'Âncora Y', w: 'Largura', h: 'Altura', radius: 'Arredondamento', sides: 'Pontas', inner: 'Raio interno',
  fill: 'Preenchimento', stroke: 'Traço', strokeWidth: 'Espessura',
  trimStart: 'Traço: início', trimEnd: 'Traço: fim', trimOffset: 'Traço: deslocamento', path: 'Caminho',
};
export const PROP_ORDER = Object.keys(PROP_LABELS);

// ---------------------------------------------------------------- composições
export const getComp = (id, project = state.project) => project.comps?.find((c) => c.id === id) || null;
export const currentComp = () => getComp(state.motion.compId);

export function createComp({ name, width, height, duration } = {}) {
  const s = state.project.settings;
  state.project.comps ||= [];
  const comp = {
    id: uid('k'),
    name: name || `Composição ${state.project.comps.length + 1}`,
    width: Math.max(2, Math.round(width || s.width)),
    height: Math.max(2, Math.round(height || s.height)),
    duration: Math.max(0.1, duration || 5),
    background: null,
    layers: [],
  };
  state.project.comps.push(comp);
  return comp;
}

/** Remove a composição e os clipes da timeline que a exibem. */
export function removeComp(id) {
  state.project.comps = (state.project.comps || []).filter((c) => c.id !== id);
  state.project.clips = state.project.clips.filter((c) => c.compId !== id);
  if (state.selection && !state.project.clips.some((c) => c.id === state.selection)) state.selection = null;
  if (state.motion.compId === id) Object.assign(state.motion, { compId: null, selection: [], keySel: [] });
}

export const compUsage = (id) => state.project.clips.filter((c) => c.compId === id).length;

/** Muda a duração da composição, acompanhando as camadas que iam até o fim. */
export function setCompDuration(comp, duration) {
  duration = Math.max(0.1, duration);
  for (const l of comp.layers) {
    if (l.out >= comp.duration - 1e-6 || l.out > duration) l.out = duration;
    if (l.in >= l.out) l.in = Math.max(0, l.out - 0.1);
  }
  comp.duration = duration;
}

// ---------------------------------------------------------------- camadas
export const getLayer = (comp, id) => comp?.layers.find((l) => l.id === id) || null;
export const selectedLayers = (comp = currentComp()) => (comp ? comp.layers.filter((l) => state.motion.selection.includes(l.id)) : []);
export const layerActive = (layer, t) => t >= layer.in - 1e-9 && t < layer.out;

const baseProps = () => ({ ax: 0, ay: 0, x: 0, y: 0, sx: 100, sy: 100, rotation: 0, opacity: 1 });

const DEFAULT_FONT = { family: 'Inter, Arial, sans-serif', size: 96, color: '#ffffff', bold: true, italic: false, align: 'center', stroke: '#000000', strokeWidth: 0 };

/**
 * Cria uma camada na frente das demais.
 * opts: { name, shape, x, y (centro, em coordenadas da composição), w, h, text, media, path, props }
 */
export function createLayer(comp, type, opts = {}) {
  const layer = {
    id: uid('l'),
    name: opts.name || '',
    type,
    parentId: null,
    hidden: false,
    locked: false,
    in: 0,
    out: comp.duration,
    matte: null,
    props: baseProps(),
    keyframes: {},
  };
  const p = layer.props;
  const cx = opts.x ?? comp.width / 2;
  const cy = opts.y ?? comp.height / 2;

  if (type === 'shape') {
    layer.shape = opts.shape || 'rect';
    layer.fillOn = layer.shape !== 'line' && opts.fillOn !== false;
    layer.strokeOn = layer.shape === 'line' || !!opts.strokeOn;
    layer.lineCap = 'round';
    layer.lineJoin = 'round';
    layer.fillRule = opts.fillRule || 'nonzero';
    Object.assign(p, {
      w: opts.w ?? 300, h: opts.h ?? (layer.shape === 'line' ? 0 : 300), radius: 0, sides: 5, inner: 0.5,
      fill: '#4f8cffff', stroke: '#ffffffff', strokeWidth: layer.strokeOn ? 8 : 0,
      trimStart: 0, trimEnd: 100, trimOffset: 0,
    });
    if (layer.shape === 'path') {
      // o caminho é guardado em coordenadas locais com origem no canto da própria caixa
      const b = pathBounds(opts.path) || { x: 0, y: 0, w: 0, h: 0 };
      p.path = translatePath(opts.path || { contours: [] }, -b.x, -b.y);
      p.w = b.w;
      p.h = b.h;
      layer.name ||= SHAPES.path;
      Object.assign(p, { ax: b.w / 2, ay: b.h / 2, x: opts.x ?? b.x + b.w / 2, y: opts.y ?? b.y + b.h / 2 });
    } else {
      Object.assign(p, { ax: p.w / 2, ay: p.h / 2, x: cx, y: cy });
    }
    layer.name ||= SHAPES[layer.shape];
  } else if (type === 'text') {
    layer.text = opts.text ?? 'Seu texto';
    layer.font = { ...DEFAULT_FONT, size: Math.round(comp.height / 10), ...(opts.font || {}) };
    const m = measureText(layer);
    Object.assign(p, { ax: m.w / 2, ay: m.h / 2, x: cx, y: cy });
    layer.name ||= 'Texto';
  } else if (type === 'image') {
    const media = opts.media;
    layer.mediaId = media?.id || null;
    const w = media?.width || 300;
    const h = media?.height || 300;
    // imagens maiores que a composição entram reduzidas para caber
    const fit = Math.min(1, comp.width / w, comp.height / h);
    Object.assign(p, { w, h, ax: w / 2, ay: h / 2, x: cx, y: cy, sx: fit * 100, sy: fit * 100 });
    layer.name ||= media?.name || 'Imagem';
  } else {
    Object.assign(p, { w: 100, h: 100, ax: 50, ay: 50, x: cx, y: cy });
    layer.name ||= 'Grupo';
  }
  if (opts.props) Object.assign(p, opts.props);
  comp.layers.unshift(layer);
  return layer;
}

/** Valores de todas as propriedades da camada no tempo t. */
export function layerPropsAt(layer, t) {
  const out = {};
  for (const k in layer.props) out[k] = valueAt(layer, k, t);
  return out;
}

/** Caixa local { x, y, w, h } da camada (antes da transformação). */
export function localBounds(layer, p) {
  if (layer.type === 'text') {
    const m = measureText(layer);
    return { x: 0, y: 0, w: m.w, h: m.h };
  }
  if (layer.type === 'shape' && layer.shape === 'path') return pathBounds(shapePath(layer, p)) || { x: 0, y: 0, w: 0, h: 0 };
  // grupo não tem geometria: é mostrado como uma caixa em volta da própria âncora
  if (layer.type === 'group') return { x: p.ax - p.w / 2, y: p.ay - p.h / 2, w: p.w, h: p.h };
  // largura/altura negativas (linha desenhada para trás) continuam formando uma caixa válida
  return { x: Math.min(0, p.w), y: Math.min(0, p.h), w: Math.abs(p.w), h: Math.abs(p.h) };
}

/** Matriz que leva coordenadas locais da camada para coordenadas da composição. */
export function worldMatrix(comp, layer, t, cache) {
  if (cache?.has(layer.id)) return cache.get(layer.id);
  let m = trs(layerPropsAt(layer, t));
  const parent = layer.parentId ? getLayer(comp, layer.parentId) : null;
  // o guard evita laço infinito se um arquivo editado à mão trouxer um ciclo
  if (parent && parent !== layer && !isDescendant(comp, parent, layer.id)) m = mul(worldMatrix(comp, parent, t, cache), m);
  cache?.set(layer.id, m);
  return m;
}

export function parentMatrix(comp, layer, t, cache) {
  const parent = layer.parentId ? getLayer(comp, layer.parentId) : null;
  return parent ? worldMatrix(comp, parent, t, cache) : IDENTITY;
}

/** A camada `layer` está abaixo de `ancestorId` na hierarquia? */
export function isDescendant(comp, layer, ancestorId) {
  const seen = new Set();
  let cur = layer;
  while (cur?.parentId && !seen.has(cur.id)) {
    if (cur.parentId === ancestorId) return true;
    seen.add(cur.id);
    cur = getLayer(comp, cur.parentId);
  }
  return false;
}

/**
 * Define o pai da camada mantendo-a no mesmo lugar da tela no tempo t.
 * Retorna false (sem alterar nada) se criaria um ciclo.
 */
export function setParent(comp, layer, parentId, t = 0) {
  parentId ||= null;
  if (parentId === layer.id) return false;
  const parent = parentId ? getLayer(comp, parentId) : null;
  if (parentId && (!parent || isDescendant(comp, parent, layer.id))) return false;
  const world = worldMatrix(comp, layer, t);
  const inv = parent ? invert(worldMatrix(comp, parent, t)) : IDENTITY;
  layer.parentId = parentId;
  if (!inv) return true;
  const local = mul(inv, world);
  const d = decompose(local);
  const p = layerPropsAt(layer, t);
  const [x, y] = apply(local, p.ax, p.ay);
  const next = { x, y, rotation: d.rotation, sx: d.sx, sy: d.sy };
  // propriedades animadas não são regravadas: reposicionar só um instante quebraria a animação
  for (const k in next) if (!hasKeyframes(layer, k)) layer.props[k] = Math.round(next[k] * 1000) / 1000;
  return true;
}

/** Remove camadas; as filhas sobem para o pai da removida e mattes órfãos são desfeitos. */
export function removeLayers(comp, ids, t = 0) {
  const gone = new Set(ids);
  for (const layer of comp.layers) {
    if (gone.has(layer.id)) continue;
    let target = layer.parentId;
    const seen = new Set();
    while (target && gone.has(target) && !seen.has(target)) {
      seen.add(target);
      target = getLayer(comp, target)?.parentId || null;
    }
    if (target !== layer.parentId) setParent(comp, layer, target, t);
    if (layer.matte && gone.has(layer.matte.layerId)) layer.matte = null;
  }
  comp.layers = comp.layers.filter((l) => !gone.has(l.id));
  if (comp.fields) comp.fields = comp.fields.filter((f) => !gone.has(f.layerId));
  state.motion.selection = state.motion.selection.filter((id) => !gone.has(id));
  state.motion.keySel = [];
}

/** Duplica camadas (cada cópia fica logo acima da original). Retorna as cópias. */
export function duplicateLayers(comp, ids) {
  const copies = [];
  for (const id of ids) {
    const i = comp.layers.findIndex((l) => l.id === id);
    if (i < 0) continue;
    const copy = JSON.parse(JSON.stringify(comp.layers[i]));
    copy.id = uid('l');
    copy.name = `${copy.name} cópia`;
    comp.layers.splice(i, 0, copy);
    copies.push(copy);
  }
  return copies;
}

/** Sobe (-1) ou desce (+1) a camada na pilha. */
export function moveLayer(comp, id, dir) {
  const i = comp.layers.findIndex((l) => l.id === id);
  const j = i + dir;
  if (i < 0 || j < 0 || j >= comp.layers.length) return;
  [comp.layers[i], comp.layers[j]] = [comp.layers[j], comp.layers[i]];
}

/** Posição da camada (valor fixo e todos os keyframes de x/y) antes de mover a trajetória inteira. */
export function positionSnapshot(layer) {
  return {
    x: layer.props.x, y: layer.props.y,
    kx: (layer.keyframes?.x || []).map((k) => k.v), ky: (layer.keyframes?.y || []).map((k) => k.v),
  };
}

/**
 * Desloca a camada inteira no espaço: o valor fixo e todos os keyframes de posição somam (dx, dy),
 * então a animação continua igual, só que em outro lugar. Não cria keyframes.
 */
export function offsetPosition(layer, snap, dx, dy) {
  const r = (v) => Math.round(v * 100) / 100;
  layer.props.x = r(snap.x + dx);
  layer.props.y = r(snap.y + dy);
  (layer.keyframes?.x || []).forEach((k, i) => { if (i < snap.kx.length) k.v = r(snap.kx[i] + dx); });
  (layer.keyframes?.y || []).forEach((k, i) => { if (i < snap.ky.length) k.v = r(snap.ky[i] + dy); });
}

/** Move a camada no tempo levando os keyframes junto. */
export function shiftLayer(layer, dt) {
  layer.in += dt;
  layer.out += dt;
  shiftKeyframes(layer, dt);
}

/** Mantém a âncora no centro quando o tamanho natural muda (texto editado, forma redimensionada). */
export function recenterAnchor(layer, before, after) {
  const p = layer.props;
  if (hasKeyframes(layer, 'ax') || hasKeyframes(layer, 'ay')) return;
  const centered = Math.abs(p.ax - (before.x + before.w / 2)) < 0.51 && Math.abs(p.ay - (before.y + before.h / 2)) < 0.51;
  if (!centered) return;
  p.ax = after.x + after.w / 2;
  p.ay = after.y + after.h / 2;
}

/** Tira das composições as camadas de imagem que usam uma mídia removida. */
export function removeLayersUsingMedia(mediaId) {
  for (const comp of state.project.comps || []) {
    const ids = comp.layers.filter((l) => l.type === 'image' && l.mediaId === mediaId).map((l) => l.id);
    if (ids.length) removeLayers(comp, ids);
  }
}

/**
 * Recoloca a origem do caminho no canto da própria caixa e a âncora no centro, sem mover a camada na tela.
 * Não faz nada se o caminho ou a transformação estiverem animados (os keyframes guardam as coordenadas antigas).
 */
export function normalizePathLayer(layer) {
  if (layer.type !== 'shape' || layer.shape !== 'path') return;
  if (['path', 'ax', 'ay', 'x', 'y'].some((k) => hasKeyframes(layer, k))) return;
  const p = layer.props;
  const b = pathBounds(p.path);
  if (!b) return;
  const [x, y] = apply(trs(p), b.x + b.w / 2, b.y + b.h / 2);
  p.path = translatePath(p.path, -b.x, -b.y);
  Object.assign(p, { w: b.w, h: b.h, ax: b.w / 2, ay: b.h / 2, x, y });
}

/** Troca uma forma paramétrica pelo caminho editável equivalente (no tempo t). */
export function convertToPath(layer, t = 0) {
  if (layer.type !== 'shape' || layer.shape === 'path') return false;
  const path = JSON.parse(JSON.stringify(shapePath(layer, layerPropsAt(layer, t))));
  // a geometria passa a ser o caminho: os parâmetros antigos deixam de ter efeito
  for (const k of ['w', 'h', 'radius', 'sides', 'inner']) {
    if (hasKeyframes(layer, k)) layer.props[k] = valueAt(layer, k, t);
    delete layer.keyframes[k];
  }
  if (layer.shape === 'line') layer.fillOn = false;
  layer.shape = 'path';
  layer.props.path = path;
  return true;
}
