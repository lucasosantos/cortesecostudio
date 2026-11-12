// Utilitários de interface do FX Lab: criação de elementos e controles de valor por tipo.
import { defaultFor } from '../fx/shader.js';

/** Cria um elemento: h('div.classe', { atributos, on: { evento } }, ...filhos) */
export function h(tag, props = {}, ...children) {
  const [name, ...classes] = tag.split('.');
  const el = document.createElement(name || 'div');
  if (classes.length) el.className = classes.join(' ');
  for (const [k, v] of Object.entries(props || {})) {
    if (k === 'on') for (const [ev, fn] of Object.entries(v)) el.addEventListener(ev, fn);
    else if (k in el && typeof v !== 'string') el[k] = v;
    else if (v !== undefined && v !== null && v !== false) el.setAttribute(k, v === true ? '' : v);
  }
  for (const c of children.flat(Infinity)) if (c !== null && c !== undefined && c !== false) el.append(c);
  return el;
}

const NUMERIC = new Set(['float', 'int']);

export function rangeFor(p) {
  const d = Number(p.default) || 0;
  const min = Number.isFinite(p.min) ? p.min : Math.min(0, d);
  const max = Number.isFinite(p.max) ? p.max : Math.max(1, d * 2, min + 1);
  const step = Number.isFinite(p.step) && p.step > 0 ? p.step : p.type === 'int' ? 1 : (max - min) / 200;
  return { min, max, step };
}

function colorParts(p) {
  const hex = String(defaultFor(p));
  return { rgb: hex.slice(0, 7), alpha: p.type === 'color' && hex.length >= 9 ? parseInt(hex.slice(7, 9), 16) / 255 : 1 };
}

/**
 * Controle para um valor do tipo de parâmetro `p.type`, começando em `p.default`.
 * @param onSet chamado com o novo valor (já no formato do parâmetro)
 */
export function controlFor(p, onSet) {
  const set = (v) => { p.default = v; onSet(v); };
  if (NUMERIC.has(p.type)) {
    const { min, max, step } = rangeFor(p);
    const num = h('input', { type: 'number', step, value: p.default ?? 0, 'aria-label': `${p.label} (valor)` });
    const range = h('input', { type: 'range', min, max, step, value: p.default ?? 0, 'aria-label': p.label });
    const apply = (v, from) => {
      const n = p.type === 'int' ? Math.round(Number(v)) : Number(v);
      if (!Number.isFinite(n) || v === '') return;
      set(n);
      if (from !== num) num.value = n;
      if (from !== range) range.value = n;
    };
    range.addEventListener('input', () => apply(range.value, range));
    num.addEventListener('input', () => apply(num.value, num));
    return h('div.ctl', {}, range, num);
  }
  if (p.type === 'bool') {
    return h('div.ctl', {}, h('input', { type: 'checkbox', checked: !!p.default, 'aria-label': p.label, on: { change: (e) => set(e.target.checked) } }));
  }
  if (p.type === 'color' || p.type === 'color3') {
    const { rgb, alpha } = colorParts(p);
    const color = h('input', { type: 'color', value: rgb, 'aria-label': p.label });
    const a = p.type === 'color' ? h('input', { type: 'range', min: 0, max: 1, step: 0.01, value: alpha, title: 'Opacidade', 'aria-label': `${p.label} (opacidade)` }) : null;
    const apply = () => set(p.type === 'color' ? color.value + Math.round(Number(a.value) * 255).toString(16).padStart(2, '0') : color.value);
    color.addEventListener('input', apply);
    a?.addEventListener('input', apply);
    return h('div.ctl', {}, color, a);
  }
  // vec2 / ivec2
  const v = defaultFor(p);
  const ints = p.type === 'ivec2';
  const inputs = [0, 1].map((i) => h('input', {
    type: 'number', step: ints ? 1 : 0.01, value: v[i], 'aria-label': `${p.label} ${i ? 'y' : 'x'}`,
    on: { input: () => set(inputs.map((el) => (ints ? Math.round(Number(el.value) || 0) : Number(el.value) || 0))) },
  }));
  return h('div.ctl', {}, h('span.axis', {}, 'x'), inputs[0], h('span.axis', {}, 'y'), inputs[1]);
}
