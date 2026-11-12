// Controles de estilo e de animação de texto, usados pelo inspector de clipes e pelo do motion.
import { emit } from '../state/project.js';
import { parseColor } from '../motion/interp.js';
import { EASING_LABELS } from '../motion/easing.js';
import {
  TEXT_ANIM_PRESETS, TEXT_LOOP_PRESETS, TEXT_UNITS, TEXT_ORDERS, TEXT_ANIM_DEFAULTS, textAnimLength,
} from '../engine/text.js';
import { h } from './util.js';

const row = (label, ...ctrl) => h('div.insp-row', {}, h('label', {}, label), h('div.ctrl', {}, ...ctrl), h('span'));
const hex2 = (v) => Math.round(Math.max(0, Math.min(255, v))).toString(16).padStart(2, '0');
const solid = (color) => {
  const [r, g, b] = parseColor(color || '#000000');
  return `#${hex2(r)}${hex2(g)}${hex2(b)}`;
};
const alphaOf = (color) => (parseColor(color || '#000000')[3] ?? 255) / 255;
const withAlpha = (hex, a) => `${solid(hex)}${hex2(a * 255)}`;

/**
 * Linhas de estilo do texto: contornos, gradiente, sombra, caixa de fundo, espaçamento e maiúsculas.
 * env: { restyle(fn) — muda algo que altera o tamanho do texto; beginEdit(); endEdit(); locked?() }
 */
export function textStyleRows(item, env) {
  const f = item.font;
  const paint = (fn) => {
    if (env.locked?.()) return;
    env.beginEdit();
    fn();
    emit('project');
  };
  const sized = (fn) => {
    if (env.locked?.()) return;
    env.restyle(fn);
  };
  const edit = { focus: env.beginEdit, blur: env.endEdit };
  const num = (value, onValue, opts = {}) => h('input', {
    type: 'number', step: opts.step ?? 1, min: opts.min, max: opts.max, value, title: opts.title || '',
    style: { width: opts.width || '58px' },
    on: { ...edit, input: (e) => { if (e.target.value !== '' && Number.isFinite(Number(e.target.value))) onValue(Number(e.target.value)); } },
  });
  const color = (value, onValue) => h('input', { type: 'color', value: solid(value), on: { ...edit, input: (e) => onValue(e.target.value) } });
  const opacity = (value, onValue) => h('input', {
    type: 'range', min: 0, max: 1, step: 0.05, value, title: 'Opacidade', style: { width: '64px' },
    on: { ...edit, input: (e) => onValue(Number(e.target.value)) },
  });
  const check = (checked, onValue, title) => h('input', { type: 'checkbox', checked, title, on: { change: (e) => { onValue(e.target.checked); env.endEdit(); } } });
  const unit = (text) => h('span.insp-note', { style: { padding: 0 } }, text);
  const details = (rows, visible) => h('div', { style: { display: visible ? '' : 'none' } }, ...rows);

  // contornos
  const strokeNum = num(f.strokeWidth || 0, (v) => sized(() => { f.strokeWidth = Math.max(0, v); }), { min: 0, title: 'Espessura (0 = sem contorno)' });
  const strokeColor = color(f.stroke || '#000000', (v) => paint(() => { f.stroke = v; }));
  const outline = row('Contorno', strokeColor, strokeNum, unit('px'));

  // preenchimento: desligado, sobra só o contorno (texto vazado)
  const fill = row('Preencher',
    h('label.toggle-row', { style: { padding: 0 }, title: 'Desmarque para deixar as letras vazadas, só com o contorno' },
      check(!f.noFill, (on) => sized(() => {
        f.noFill = !on;
        // sem preenchimento e sem contorno o texto sumiria: liga um contorno
        if (f.noFill && !(f.strokeWidth > 0)) {
          f.strokeWidth = Math.max(2, Math.round(f.size * 0.03));
          // o contorno assume a cor que as letras tinham
          f.stroke = f.color || '#ffffff';
          strokeNum.value = f.strokeWidth;
          strokeColor.value = f.stroke.slice(0, 7);
        }
      })),
      'Letras preenchidas'));
  const outline2 = row('2º contorno',
    color(f.stroke2 || '#ffffff', (v) => paint(() => { f.stroke2 = v; })),
    num(f.stroke2Width || 0, (v) => sized(() => { f.stroke2Width = Math.max(0, v); }), { min: 0, title: 'Borda por fora do primeiro contorno (0 = sem)' }), unit('px'));

  // gradiente
  const grad = row('Gradiente',
    check(!!f.color2, (on) => paint(() => { f.color2 = on ? f.color2Last || '#ffb400' : ''; })),
    color(f.color2 || f.color2Last || '#ffb400', (v) => paint(() => { f.color2 = v; f.color2Last = v; })),
    unit('cor de baixo'));

  // sombra
  const shadowDetails = details([
    row('Deslocar', num(f.shadowX ?? 4, (v) => paint(() => { f.shadowX = v; }), { title: 'X' }), num(f.shadowY ?? 4, (v) => paint(() => { f.shadowY = v; }), { title: 'Y' }), unit('px')),
    row('Desfoque', num(f.shadowBlur ?? 8, (v) => paint(() => { f.shadowBlur = Math.max(0, v); }), { min: 0 }), unit('px')),
  ], !!f.shadowColor);
  const shadow = row('Sombra',
    check(!!f.shadowColor, (on) => paint(() => {
      if (on) {
        f.shadowColor = f.shadowLast || '#000000b3';
        f.shadowX ??= 4;
        f.shadowY ??= 4;
        f.shadowBlur ??= 8;
      } else {
        f.shadowLast = f.shadowColor;
        f.shadowColor = '';
      }
      shadowDetails.style.display = on ? '' : 'none';
    })),
    color(f.shadowColor || '#000000', (v) => paint(() => { f.shadowColor = withAlpha(v, alphaOf(f.shadowColor || '#000000b3')); })),
    opacity(alphaOf(f.shadowColor || '#000000b3'), (a) => paint(() => { f.shadowColor = withAlpha(f.shadowColor || '#000000', a); })));

  // caixa de fundo
  const bgDetails = details([
    row('Margem', num(f.bgPad ?? 16, (v) => sized(() => { f.bgPad = Math.max(0, v); }), { min: 0 }), unit('px'),
      h('select', { on: { change: (e) => { paint(() => { f.bgMode = e.target.value; }); env.endEdit(); } } },
        h('option', { value: 'block', selected: f.bgMode !== 'line' }, 'Um bloco'),
        h('option', { value: 'line', selected: f.bgMode === 'line' }, 'Por linha'))),
    row('Arredondar', num(f.bgRadius ?? 12, (v) => paint(() => { f.bgRadius = Math.max(0, v); }), { min: 0 }), unit('px')),
  ], !!f.bg);
  const bg = row('Caixa de fundo',
    check(!!f.bg, (on) => sized(() => {
      if (on) {
        f.bg = f.bgLast || '#000000b3';
        f.bgPad ??= 16;
        f.bgRadius ??= 12;
      } else {
        f.bgLast = f.bg;
        f.bg = '';
      }
      bgDetails.style.display = on ? '' : 'none';
    })),
    color(f.bg || '#000000', (v) => paint(() => { f.bg = withAlpha(v, alphaOf(f.bg || '#000000b3')); })),
    opacity(alphaOf(f.bg || '#000000b3'), (a) => paint(() => { f.bg = withAlpha(f.bg || '#000000', a); })));

  // tipografia
  const spacing = row('Espaçamento',
    num(f.letterSpacing || 0, (v) => sized(() => { f.letterSpacing = v; }), { title: 'Entre letras, em px (pode ser negativo)' }), unit('px'),
    num(f.lineHeight || 1.2, (v) => sized(() => { f.lineHeight = Math.max(0.5, v); }), { step: 0.05, min: 0.5, title: 'Altura da linha (× tamanho da fonte)' }), unit('linha'));
  const upper = h('label.toggle-row', {}, check(!!f.upper, (on) => sized(() => { f.upper = on; })), 'Tudo em maiúsculas');

  return [fill, outline, outline2, grad, shadow, shadowDetails, bg, bgDetails, spacing, upper];
}

/** Quantas unidades (letras, palavras, linhas) o texto tem. */
function unitCount(item, unit) {
  const text = String(item.text || '');
  if (unit === 'word') return (text.match(/\S+/g) || []).length || 1;
  if (unit === 'line') return text.split('\n').length;
  return text.replace(/\s/g, '').length || 1;
}

/**
 * Seção "Animação do texto": entrada e saída por letra/palavra/linha e um efeito contínuo.
 * env: { beginEdit(), endEdit(), locked?(), span() — duração do elemento em segundos }
 */
export function textAnimSection(item, env) {
  const sec = h('div.insp-section');
  const render = () => sec.replaceChildren(...build());
  const set = (fn, rebuild = false) => {
    if (env.locked?.()) return;
    env.beginEdit();
    item.textAnim ||= { in: null, out: null, loop: null };
    fn(item.textAnim);
    emit('project');
    if (rebuild) {
      env.endEdit();
      render();
    }
  };
  const edit = { focus: env.beginEdit, blur: env.endEdit };
  const select = (options, value, onValue) => h('select', { on: { change: (e) => onValue(e.target.value) } },
    ...Object.entries(options).map(([v, n]) => h('option', { value: v, selected: v === value }, n)));
  const num = (value, onValue, opts = {}) => h('input', {
    type: 'number', step: opts.step ?? 0.01, min: opts.min ?? 0, max: opts.max, value, style: { width: '62px' },
    on: { ...edit, input: (e) => { if (e.target.value !== '' && Number.isFinite(Number(e.target.value))) set((a) => opts.write(a, Number(e.target.value))); } },
  });
  const unit = (text) => h('span.insp-note', { style: { padding: 0 } }, text);
  const easings = Object.fromEntries(Object.entries(EASING_LABELS).filter(([k]) => k !== 'hold'));

  const part = (key, title) => {
    const spec = item.textAnim?.[key] || null;
    const presets = key === 'loop' ? TEXT_LOOP_PRESETS : TEXT_ANIM_PRESETS;
    const out = [row(title, select({ none: 'Nenhuma', ...presets }, spec?.preset || 'none', (v) => set((a) => {
      if (v === 'none') a[key] = null;
      else a[key] = { ...TEXT_ANIM_DEFAULTS[key], ...(a[key] || {}), preset: v, ...(v === 'typewriter' ? { unit: 'char', duration: 0.05, delay: 0.06, easing: 'linear' } : {}) };
    }, true)))];
    if (!spec) return out;
    const w = (field) => (a, v) => { a[key][field] = v; };
    out.push(row('Por', select(TEXT_UNITS, spec.unit, (v) => set((a) => { a[key].unit = v; }, true)),
      key === 'loop' ? null : select(TEXT_ORDERS, spec.order || 'forward', (v) => set((a) => { a[key].order = v; }, true))));
    if (key === 'loop') {
      out.push(row('Intensidade', num(spec.amount ?? 1, null, { step: 0.1, write: w('amount') })));
      out.push(row('Velocidade', num(spec.speed ?? 1, null, { step: 0.1, write: w('speed') }), unit('ciclos/s')));
      out.push(row('Defasagem', num(spec.spread ?? 0.08, null, { step: 0.01, write: w('spread') }), unit('por unidade')));
      return out;
    }
    out.push(row('Duração', num(spec.duration, null, { write: w('duration'), max: 30 }), unit('s cada'),
      num(spec.delay, null, { write: w('delay'), max: 10 }), unit('s entre')));
    if (spec.preset !== 'typewriter') {
      out.push(row('Curva', select(easings, spec.easing || 'easeOut', (v) => set((a) => { a[key].easing = v; }))),
        row('Intensidade', num(spec.amount ?? 1, null, { step: 0.1, write: w('amount') })));
    }
    const total = textAnimLength(spec, unitCount(item, spec.unit));
    const span = env.span?.() ?? Infinity;
    out.push(h('div.insp-note', { style: total > span / 2 ? { color: '#ffb84d' } : {} },
      `${key === 'in' ? 'Entrada' : 'Saída'} completa em ${total.toFixed(2)} s${total > span / 2 ? ' — mais que metade da duração do elemento' : ''}.`));
    return out;
  };

  const build = () => [
    ...part('in', 'Entrada'),
    ...part('out', 'Saída'),
    ...part('loop', 'Contínua'),
    item.textAnim && (item.textAnim.in || item.textAnim.out || item.textAnim.loop) ? null
      : h('div.insp-note', {}, 'Anime o texto letra por letra, palavra por palavra ou linha por linha. A entrada começa no início do elemento e a saída termina no fim dele.'),
  ].filter(Boolean);
  render();
  return sec;
}
