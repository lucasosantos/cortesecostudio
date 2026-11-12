// Campos editáveis de uma composição: propriedades de camadas que cada clipe da timeline pode trocar
// (ex.: o nome numa legenda, a cor de uma faixa) sem duplicar a composição.
//   comp.fields = [{ id, label, layerId, prop }]
//   clip.fieldValues = { [field.id]: valor }   (sem valor = o que está na composição)
import { uid, measureText } from '../state/project.js';
import { valueAt, hasKeyframes } from '../state/keyframes.js';

/** Propriedades que podem virar campo, por tipo de camada. */
export const FIELD_PROPS = {
  text: { text: 'Texto', textColor: 'Cor do texto' },
  shape: { fill: 'Preenchimento', stroke: 'Traço' },
  image: { image: 'Imagem' },
};
/** Tipo de valor de cada propriedade: 'text', 'color' (#rrggbbaa) ou 'media' (id de mídia). */
export const FIELD_KIND = { text: 'text', textColor: 'color', fill: 'color', stroke: 'color', image: 'media' };

const layerOf = (comp, id) => comp?.layers?.find((l) => l.id === id) || null;

export const compFields = (comp) => (comp?.fields || []).filter((f) => FIELD_PROPS[layerOf(comp, f.layerId)?.type]?.[f.prop]);

export const fieldFor = (comp, layerId, prop) => (comp?.fields || []).find((f) => f.layerId === layerId && f.prop === prop) || null;

export function addField(comp, layer, prop, label) {
  if (!FIELD_PROPS[layer.type]?.[prop]) throw new Error(`"${prop}" não pode ser campo numa camada do tipo ${layer.type}.`);
  const existing = fieldFor(comp, layer.id, prop);
  if (existing) return existing;
  const field = { id: uid('f'), label: (label || defaultLabel(layer, prop)).slice(0, 60), layerId: layer.id, prop };
  comp.fields = [...(comp.fields || []), field];
  return field;
}

export function removeField(comp, id) {
  comp.fields = (comp.fields || []).filter((f) => f.id !== id);
}

export function defaultLabel(layer, prop) {
  if (prop === 'text') return layer.name && layer.name !== 'Texto' ? layer.name : 'Texto';
  return `${layer.name || 'Camada'}: ${FIELD_PROPS[layer.type][prop].toLowerCase()}`;
}

/** Valor atual do campo na composição (o padrão dos clipes que não o trocaram). */
export function fieldDefault(comp, field) {
  const layer = layerOf(comp, field.layerId);
  if (!layer) return null;
  switch (field.prop) {
    case 'text': return layer.text ?? '';
    case 'textColor': return normColor(layer.font?.color || '#ffffff');
    case 'fill': case 'stroke': return normColor(hasKeyframes(layer, field.prop) ? valueAt(layer, field.prop, layer.in || 0) : layer.props[field.prop]);
    case 'image': return layer.mediaId || null;
    default: return null;
  }
}

const normColor = (c) => {
  const s = String(c || '#ffffff');
  return s.length === 7 ? `${s}ff` : s.slice(0, 9);
};

/** Valor do campo no clipe (o próprio do clipe ou, sem ele, o da composição). */
export function fieldValue(comp, field, values) {
  return values && Object.prototype.hasOwnProperty.call(values, field.id) ? values[field.id] : fieldDefault(comp, field);
}

/** Confere e normaliza um valor para o tipo do campo. Lança erro com mensagem para o usuário. */
export function coerceFieldValue(field, value) {
  const kind = FIELD_KIND[field.prop];
  if (kind === 'text') return String(value ?? '').slice(0, 2000);
  if (kind === 'color') {
    const s = String(value || '').trim();
    if (!/^#([0-9a-f]{6}|[0-9a-f]{8})$/i.test(s)) throw new Error(`Cor inválida para "${field.label}": use #rrggbb ou #rrggbbaa.`);
    return normColor(s.toLowerCase());
  }
  if (value === null || value === '') return null;
  return String(value);
}

/** Camada com os valores de campo aplicados (a original, se nada muda). */
function overriddenLayer(layer, fields, values) {
  let out = layer;
  for (const f of fields) {
    if (!Object.prototype.hasOwnProperty.call(values, f.id)) continue;
    const v = values[f.id];
    if (f.prop === 'text') {
      const before = measureText(out);
      out = { ...out, text: String(v ?? '') };
      // o texto muda de tamanho: a âncora fica na mesma posição relativa (centro continua centro)
      const after = measureText(out);
      const p = { ...out.props };
      if (!hasKeyframes(layer, 'ax') && before.w > 0) p.ax = (p.ax * after.w) / before.w;
      if (!hasKeyframes(layer, 'ay') && before.h > 0) p.ay = (p.ay * after.h) / before.h;
      out.props = p;
    } else if (f.prop === 'textColor') {
      if (typeof v === 'string' && v) out = { ...out, font: { ...out.font, color: v.slice(0, 7) } };
    } else if (f.prop === 'fill' || f.prop === 'stroke') {
      if (typeof v !== 'string' || !v) continue;
      // o valor do clipe vale para a camada toda: substitui a animação de cor, se houver
      const keyframes = { ...out.keyframes };
      delete keyframes[f.prop];
      out = { ...out, props: { ...out.props, [f.prop]: v }, keyframes };
    } else if (f.prop === 'image') {
      if (v) out = { ...out, mediaId: v, fit: 'contain' };
    }
  }
  return out;
}

/**
 * Composição com os valores de campo de um clipe aplicados. Devolve a própria composição se não há o que trocar.
 * Não altera a composição original (cria cópias rasas só das camadas afetadas).
 */
export function applyFields(comp, values) {
  if (!comp?.fields?.length || !values) return comp;
  const fields = compFields(comp).filter((f) => Object.prototype.hasOwnProperty.call(values, f.id));
  if (!fields.length) return comp;
  const byLayer = new Map();
  for (const f of fields) byLayer.set(f.layerId, [...(byLayer.get(f.layerId) || []), f]);
  return { ...comp, layers: comp.layers.map((l) => (byLayer.has(l.id) ? overriddenLayer(l, byLayer.get(l.id), values) : l)) };
}

/** Texto curto que identifica o clipe na timeline (o primeiro campo de texto trocado). */
export function fieldSummary(comp, values) {
  if (!values) return '';
  const f = compFields(comp).find((x) => x.prop === 'text' && Object.prototype.hasOwnProperty.call(values, x.id));
  return f ? String(values[f.id]).split('\n')[0].slice(0, 40) : '';
}

/** Mídia removida do projeto: os clipes que a escolheram num campo de imagem voltam ao padrão. */
export function clearFieldMedia(project, mediaId) {
  for (const clip of project.clips || []) {
    if (clip.type !== 'comp' || !clip.fieldValues) continue;
    const comp = project.comps?.find((c) => c.id === clip.compId);
    for (const f of compFields(comp)) if (f.prop === 'image' && clip.fieldValues[f.id] === mediaId) delete clip.fieldValues[f.id];
  }
}
