// Interface dos campos editáveis das composições: marcar campos no workspace de motion
// e preencher os valores de cada clipe no inspector da timeline.
import { state, emit, checkpoint } from '../state/project.js';
import { parseColor, formatColor } from '../motion/interp.js';
import {
  FIELD_PROPS, FIELD_KIND, compFields, fieldFor, addField, removeField, fieldDefault, fieldValue,
} from '../motion/fields.js';
import { h } from './util.js';

/** Assinatura dos campos (os inspectors refazem o painel quando ela muda). */
export const fieldsKey = (comp) => (comp?.fields || []).map((f) => `${f.id}:${f.prop}:${f.layerId}`).join(',');

const has = (obj, k) => !!obj && Object.prototype.hasOwnProperty.call(obj, k);

// ---------------------------------------------------------------- workspace de motion
/** Seção da camada: quais propriedades dela cada clipe pode trocar. */
export function layerFieldsSection(comp, layer, env) {
  const props = FIELD_PROPS[layer.type];
  if (!props) return null;
  const sec = h('div.insp-section');
  for (const [prop, propLabel] of Object.entries(props)) {
    const field = fieldFor(comp, layer.id, prop);
    const toggle = h('input', {
      type: 'checkbox', checked: !!field, disabled: !!layer.locked,
      on: {
        change: (e) => {
          checkpoint();
          if (e.target.checked) addField(comp, layer, prop);
          else removeField(comp, field.id);
          emit('project');
        },
      },
    });
    sec.append(h('div.insp-row', {}, h('label', {}, propLabel), h('div.ctrl', {}, h('label.toggle-row', { style: { padding: 0 } }, toggle, 'Editável por clipe')), h('span')));
    if (field) sec.append(labelRow(field, env));
  }
  sec.append(h('div.insp-note', {}, 'Campos editáveis aparecem no inspector de cada clipe desta composição na timeline: use a mesma composição várias vezes, trocando só o nome, a cor ou a imagem.'));
  return sec;
}

function labelRow(field, env) {
  const input = h('input', {
    type: 'text', maxLength: 60, value: field.label, title: 'Nome do campo no inspector do clipe',
    on: { focus: env.beginEdit, blur: env.endEdit, input: (e) => { env.beginEdit(); field.label = e.target.value || 'Campo'; emit('project'); } },
  });
  return h('div.insp-row', {}, h('label', {}, 'Nome do campo'), h('div.ctrl', {}, input), h('span'));
}

/** Seção da composição: lista dos campos, com nome e ordem. */
export function compFieldsSection(comp, env) {
  const fields = compFields(comp);
  const sec = h('div.insp-section');
  if (!fields.length) {
    sec.append(h('div.insp-note', {},
      'Nenhum campo ainda. Selecione uma camada de texto, forma ou imagem e marque ', h('b', {}, 'Editável por clipe'),
      ' (por exemplo, o texto com o nome de um participante). Cada clipe desta composição na timeline poderá ter o seu valor.'));
    return sec;
  }
  fields.forEach((f, i) => {
    const layer = comp.layers.find((l) => l.id === f.layerId);
    const input = h('input', {
      type: 'text', maxLength: 60, value: f.label, 'aria-label': 'Nome do campo',
      on: { focus: env.beginEdit, blur: env.endEdit, input: (e) => { env.beginEdit(); f.label = e.target.value || 'Campo'; emit('project'); } },
    });
    const up = h('button.icon-btn', {
      title: 'Subir (ordem no inspector do clipe)', disabled: i === 0,
      on: {
        click: () => {
          checkpoint();
          const list = comp.fields;
          const a = list.indexOf(f);
          const b = list.indexOf(fields[i - 1]);
          [list[a], list[b]] = [list[b], list[a]];
          emit('project');
        },
      },
    }, '↑');
    const del = h('button.icon-btn', {
      title: 'Deixar de ser editável (os clipes voltam a mostrar o valor da composição)',
      on: { click: () => { checkpoint(); removeField(comp, f.id); emit('project'); } },
    }, '✕');
    sec.append(h('div.insp-row', {}, h('label', { title: `${layer?.name || ''}: ${FIELD_PROPS[layer?.type]?.[f.prop] || f.prop}` }, FIELD_PROPS[layer?.type]?.[f.prop] || f.prop),
      h('div.ctrl', {}, input, up), del));
  });
  sec.append(h('div.insp-note', {}, 'Valem para todos os clipes desta composição. O valor que está na composição é o padrão.'));
  return sec;
}

// ---------------------------------------------------------------- inspector do clipe
/**
 * Seção do clipe de composição com um controle por campo.
 * env: { bindings, beginEdit, endEdit }
 */
export function clipFieldsSection(clip, comp, env) {
  const fields = compFields(comp);
  const sec = h('div.insp-section');
  if (!fields.length) {
    sec.append(h('div.insp-note', {}, 'Esta composição não tem campos editáveis. Em "Editar composição", selecione uma camada e marque ',
      h('b', {}, 'Editável por clipe'), ' para trocar textos, cores ou imagens só neste clipe.'));
    return sec;
  }
  const set = (f, v) => {
    env.beginEdit();
    clip.fieldValues = { ...(clip.fieldValues || {}), [f.id]: v };
    emit('project');
  };
  const reset = (f) => {
    checkpoint();
    const next = { ...(clip.fieldValues || {}) };
    delete next[f.id];
    clip.fieldValues = next;
    emit('project');
  };
  for (const f of fields) {
    const resetBtn = h('button.icon-btn', { title: 'Voltar ao valor da composição', on: { click: () => reset(f) } }, '↺');
    env.bindings.push(() => { resetBtn.style.visibility = has(clip.fieldValues, f.id) ? 'visible' : 'hidden'; });
    const kind = FIELD_KIND[f.prop];
    if (kind === 'text') {
      const ta = h('textarea.text-input', {
        rows: 2, 'aria-label': f.label,
        on: { focus: env.beginEdit, blur: env.endEdit, input: (e) => set(f, e.target.value) },
      });
      env.bindings.push(() => { if (document.activeElement !== ta) ta.value = fieldValue(comp, f, clip.fieldValues) ?? ''; });
      ta.style.minHeight = '44px';
      sec.append(h('div.insp-row', {}, h('label', {}, f.label), h('div.ctrl'), resetBtn), ta);
    } else if (kind === 'color') {
      const color = h('input', { type: 'color', 'aria-label': f.label, on: { focus: env.beginEdit, blur: env.endEdit, input: () => apply() } });
      const alpha = h('input', { type: 'range', min: 0, max: 100, step: 1, title: 'Transparência', 'aria-label': `${f.label} (opacidade)`, on: { pointerdown: env.beginEdit, pointerup: env.endEdit, input: () => apply() } });
      const apply = () => {
        const [r, g, b] = parseColor(color.value);
        set(f, formatColor([r, g, b, Math.round((Number(alpha.value) / 100) * 255)]));
      };
      env.bindings.push(() => {
        const [r, g, b, a] = parseColor(fieldValue(comp, f, clip.fieldValues) || '#ffffffff');
        if (document.activeElement !== color) color.value = formatColor([r, g, b]).slice(0, 7);
        if (document.activeElement !== alpha) alpha.value = Math.round((a / 255) * 100);
      });
      // a cor do texto não tem transparência
      if (f.prop === 'textColor') alpha.hidden = true;
      sec.append(h('div.insp-row', {}, h('label', {}, f.label), h('div.ctrl', {}, h('div.color-ctrl', {}, color, alpha)), resetBtn));
    } else {
      const images = state.project.media.filter((m) => m.type === 'image');
      const def = fieldDefault(comp, f);
      const sel = h('select', {
        'aria-label': f.label,
        on: { change: (e) => { checkpoint(); if (e.target.value === '') reset(f); else { set(f, e.target.value); env.endEdit(); } } },
      }, h('option', { value: '' }, `Padrão (${state.project.media.find((m) => m.id === def)?.name || 'nenhuma'})`),
      ...images.map((m) => h('option', { value: m.id }, m.name)));
      env.bindings.push(() => { if (document.activeElement !== sel) sel.value = has(clip.fieldValues, f.id) ? clip.fieldValues[f.id] || '' : ''; });
      sec.append(h('div.insp-row', {}, h('label', {}, f.label), h('div.ctrl', {}, sel), resetBtn));
    }
  }
  sec.append(h('div.insp-note', {}, 'Valem só para este clipe. ↺ volta ao valor que está na composição.'));
  return sec;
}

