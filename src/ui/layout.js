// Arranjo da interface: cada módulo (Mídia, Preview, Inspector, Timeline) pode ser ocultado ou movido.
// As três colunas de cima trocam de ordem, qualquer uma pode ocupar a altura inteira (ao lado da timeline)
// e a timeline pode ficar em cima ou embaixo. Os layouts prontos são atalhos para esses ajustes.
import { state, subscribe } from '../state/project.js';
import { h, toast, clamp } from './util.js';

export const PANELS = { media: 'Mídia', preview: 'Preview', insp: 'Inspector', tl: 'Timeline' };
const COLUMNS = ['media', 'preview', 'insp'];
const KEY = 'mineeditor.panels';
const OLD_KEY = 'mineeditor.layout';

export const DEFAULT_LAYOUT = { order: ['media', 'preview', 'insp'], hidden: {}, tall: null, tlPos: 'bottom', tlH: null, pvW: null, mediaW: null, inspW: null };
// largura de cada coluna: variável CSS, padrão e a chave do arranjo onde fica salva
const WIDTH = {
  media: { v: '--media-w', def: '260px', key: 'mediaW' },
  preview: { v: '--pv-w', def: '34vw', key: 'pvW' },
  insp: { v: '--insp-w', def: '300px', key: 'inspW' },
};
// painéis de cada coluna (o do workspace de motion ocupa o mesmo lugar)
const COLUMN_PANELS = { media: ['#media-panel'], preview: ['.preview-panel', '#motion-stage-panel'], insp: ['#inspector', '#motion-inspector'] };
const MIN_COL = 180;
const MIN_FLEX = 240;
export const PRESETS = {
  classic: ['Padrão', { order: ['media', 'preview', 'insp'], tall: null, tlPos: 'bottom' }],
  'vertical-right': ['Vertical (preview à direita)', { order: ['media', 'insp', 'preview'], tall: 'preview', tlPos: 'bottom' }],
  'vertical-left': ['Vertical (preview à esquerda)', { order: ['preview', 'media', 'insp'], tall: 'preview', tlPos: 'bottom' }],
  timeline: ['Timeline grande', { order: ['media', 'preview', 'insp'], tall: null, tlPos: 'bottom', tlH: '58vh' }],
};

let layout = { ...DEFAULT_LAYOUT };
let hinted = false;
let menu = null;

const load = (k, fallback) => {
  try {
    const v = localStorage.getItem(k);
    return v ? JSON.parse(v) : fallback;
  } catch {
    return fallback;
  }
};
const store = (k, v) => {
  try {
    localStorage.setItem(k, JSON.stringify(v));
  } catch {
    /* armazenamento indisponível: o arranjo só não é lembrado */
  }
};

/** Arranjo válido a partir de dados salvos (ou de qualquer objeto parcial). */
export function sanitizeLayout(raw) {
  const out = { ...DEFAULT_LAYOUT, hidden: {} };
  if (!raw || typeof raw !== 'object') return out;
  if (Array.isArray(raw.order) && raw.order.length === 3 && COLUMNS.every((c) => raw.order.includes(c))) out.order = [...raw.order];
  for (const p of Object.keys(PANELS)) if (raw.hidden?.[p]) out.hidden[p] = true;
  if (COLUMNS.includes(raw.tall)) out.tall = raw.tall;
  if (raw.tlPos === 'top') out.tlPos = 'top';
  if (typeof raw.tlH === 'string' && /^\d+(\.\d+)?(px|vh)$/.test(raw.tlH)) out.tlH = raw.tlH;
  for (const key of ['pvW', 'mediaW', 'inspW']) {
    if (typeof raw[key] === 'string' && /^\d+(\.\d+)?(px|vw)$/.test(raw[key])) out[key] = raw[key];
  }
  return out;
}

/**
 * Grade CSS para um arranjo.
 * @returns { columns, rows, areas, tall } — tall = painel que de fato ocupa a altura inteira (ou null)
 */
export function gridFor(l) {
  const cols = l.order.filter((c) => !l.hidden[c]);
  const tl = !l.hidden.tl;
  // altura inteira só faz sentido com a timeline visível e outra coluna para ficar acima dela
  const tall = tl && cols.length > 1 && cols.includes(l.tall) ? l.tall : null;
  // uma coluna estica e as outras têm largura própria (ajustável pelas alças entre colunas):
  // o preview estica; com ele na altura inteira (ou sem ele), a última das outras colunas ocupa a sobra
  const others = cols.filter((c) => c !== 'preview');
  const flex = cols.includes('preview') && tall !== 'preview' ? 'preview' : others[others.length - 1] || cols[0] || null;
  const widths = cols.map((c) => {
    if (c === flex) return tall === 'preview' ? `minmax(${MIN_COL}px, 1fr)` : 'minmax(0, 1fr)';
    return `var(${WIDTH[c].v}, ${WIDTH[c].def})`;
  });
  const n = Math.max(1, cols.length);
  const line = (cells) => `'${cells.join(' ')}'`;
  const rows = [['46px', line(Array(n).fill('top'))]];
  const panelsRow = cols.length ? [tl ? 'minmax(160px, 1fr)' : 'minmax(0, 1fr)', line(cols)] : null;
  const tlRow = tl ? [cols.length ? 'var(--tl-h, 340px)' : 'minmax(0, 1fr)', line(cols.length ? cols.map((c) => (c === tall ? c : 'tl')) : ['tl'])] : null;
  for (const r of l.tlPos === 'top' ? [tlRow, panelsRow] : [panelsRow, tlRow]) if (r) rows.push(r);
  return {
    columns: cols.length ? widths.join(' ') : 'minmax(0, 1fr)',
    rows: rows.map((r) => r[0]).join(' '),
    areas: rows.map((r) => r[1]).join(' '),
    tall,
    flex,
    cols,
  };
}

function apply() {
  const body = document.body;
  const g = gridFor(layout);
  body.style.gridTemplateColumns = g.columns;
  body.style.gridTemplateRows = g.rows;
  body.style.gridTemplateAreas = g.areas;
  for (const p of Object.keys(PANELS)) body.classList.toggle('hide-' + p, !!layout.hidden[p]);
  body.classList.toggle('tl-top', layout.tlPos === 'top');
  const visible = layout.order.filter((c) => !layout.hidden[c]);
  // a alça de largura do preview fica do lado em que há outra coluna
  body.classList.toggle('tall-preview', g.tall === 'preview');
  body.classList.toggle('pv-first', visible[0] === 'preview');
  body.style.removeProperty('--tl-h');
  if (layout.tlH) body.style.setProperty('--tl-h', layout.tlH);
  for (const w of Object.values(WIDTH)) {
    body.style.removeProperty(w.v);
    if (layout[w.key]) body.style.setProperty(w.v, layout[w.key]);
  }
  grid = g;
  placeResizers();
  document.getElementById('panels-btn')?.classList.toggle('active', Object.keys(layout.hidden).length > 0);
}

function update(patch) {
  layout = sanitizeLayout({ ...layout, ...patch });
  store(KEY, layout);
  apply();
  if (menu) renderMenu();
}

export const getLayout = () => layout;
export const setPanelHidden = (panel, hidden) => update({ hidden: { ...layout.hidden, [panel]: hidden } });
export const applyPreset = (name) => PRESETS[name] && update({ ...PRESETS[name][1], hidden: {}, tlH: PRESETS[name][1].tlH || null, pvW: null, mediaW: null, inspW: null });

/** Move uma coluna uma posição para a esquerda (-1) ou para a direita (+1). */
export function movePanel(panel, dir) {
  const order = [...layout.order];
  const i = order.indexOf(panel);
  const j = i + dir;
  if (i < 0 || j < 0 || j >= order.length) return;
  [order[i], order[j]] = [order[j], order[i]];
  update({ order });
}

export function initLayout() {
  const saved = load(KEY, null);
  // quem usava um dos layouts prontos da versão anterior continua com ele
  const old = saved ? null : load(OLD_KEY, null);
  layout = sanitizeLayout(saved || (PRESETS[old] ? PRESETS[old][1] : null));
  initColumnResizers();
  apply();
  // na fase de captura: um clique dentro do menu refaz o conteúdo dele, e o elemento clicado deixa de existir
  document.addEventListener('click', (e) => {
    if (e.target.closest('[data-action="panels"]')) return toggleMenu();
    if (menu && !e.target.closest('.panels-menu')) closeMenu();
  }, true);
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && menu) closeMenu(); });

  // sugere o layout vertical uma vez quando o projeto fica em formato retrato
  subscribe((reason) => {
    if (reason !== 'project' || hinted) return;
    const { width, height } = state.project.settings;
    if (height > width && layout.tall !== 'preview') {
      hinted = true;
      toast('Projeto vertical: experimente um layout Vertical no menu Painéis, no topo da tela');
    }
  });
}

/** Guarda as alturas/larguras ajustadas pelas alças (timeline e colunas). */
export function saveSizes() {
  const st = document.body.style;
  const patch = { tlH: st.getPropertyValue('--tl-h').trim() || null };
  for (const w of Object.values(WIDTH)) patch[w.key] = st.getPropertyValue(w.v).trim() || null;
  layout = sanitizeLayout({ ...layout, ...patch });
  store(KEY, layout);
}

// ---------------------------------------------------------------- alças de largura entre colunas
let grid = null;
let resizerLayer = null;

/** Painel visível que representa a coluna agora (o de edição ou o do workspace de motion). */
function columnEl(col) {
  for (const sel of COLUMN_PANELS[col]) {
    const el = document.querySelector(sel);
    if (el && el.getClientRects().length) return el;
  }
  return null;
}

function initColumnResizers() {
  resizerLayer = h('div.col-resizers');
  document.body.append(resizerLayer);
  const reposition = () => requestAnimationFrame(placeResizers);
  window.addEventListener('resize', reposition);
  // o tamanho dos painéis muda com a timeline, o modo (edição/motion) e os próprios arrastos
  if (typeof ResizeObserver !== 'undefined') {
    const ro = new ResizeObserver(reposition);
    for (const sels of Object.values(COLUMN_PANELS)) for (const sel of sels) { const el = document.querySelector(sel); if (el) ro.observe(el); }
  }
  subscribe((reason) => { if (reason === 'mode') reposition(); });
}

/** Uma alça em cada divisa entre colunas vizinhas, na faixa de altura que as duas compartilham. */
function placeResizers() {
  if (!resizerLayer || !grid) return;
  const cols = grid.cols;
  const handles = [];
  for (let i = 0; i < cols.length - 1; i++) {
    const a = columnEl(cols[i]);
    const b = columnEl(cols[i + 1]);
    if (!a || !b) continue;
    const ra = a.getBoundingClientRect();
    const rb = b.getBoundingClientRect();
    // ao lado de uma coluna de altura inteira a divisa desce até o fim (passa também ao lado da timeline)
    const tallRect = grid.tall === cols[i] ? ra : grid.tall === cols[i + 1] ? rb : null;
    const top = tallRect ? tallRect.top : Math.max(ra.top, rb.top);
    const bottom = tallRect ? tallRect.bottom : Math.min(ra.bottom, rb.bottom);
    if (bottom - top < 10) continue;
    const el = h('div.col-resizer', {
      title: 'Arraste para mudar a largura · duplo clique volta ao padrão',
      style: { left: Math.round(ra.right) - 3 + 'px', top: top + 'px', height: bottom - top + 'px' },
    });
    el.addEventListener('pointerdown', (e) => startColumnDrag(e, cols[i], cols[i + 1]));
    el.addEventListener('dblclick', () => resetColumn(cols[i], cols[i + 1]));
    handles.push(el);
  }
  resizerLayer.replaceChildren(...handles);
}

/** A divisa entre a e b muda a largura da coluna que não estica (a da esquerda, se as duas tiverem largura própria). */
const resizedOf = (a, b) => (a !== grid.flex ? { col: a, dir: 1 } : { col: b, dir: -1 });

function startColumnDrag(e, a, b) {
  if (e.button !== 0) return;
  e.preventDefault();
  const { col, dir } = resizedOf(a, b);
  const el = columnEl(col);
  const flexEl = grid.flex ? columnEl(grid.flex) : null;
  if (!el) return;
  const startX = e.clientX;
  const startW = el.getBoundingClientRect().width;
  // a coluna que estica não pode ficar estreita demais
  const room = flexEl && grid.flex !== col ? flexEl.getBoundingClientRect().width - MIN_FLEX : Infinity;
  document.body.classList.add('col-resizing');
  const move = (ev) => {
    const w = clamp(startW + dir * (ev.clientX - startX), MIN_COL, startW + Math.max(0, room));
    document.body.style.setProperty(WIDTH[col].v, Math.round(w) + 'px');
  };
  const up = () => {
    window.removeEventListener('pointermove', move);
    window.removeEventListener('pointerup', up);
    document.body.classList.remove('col-resizing');
    saveSizes();
    placeResizers();
  };
  window.addEventListener('pointermove', move);
  window.addEventListener('pointerup', up);
}

function resetColumn(a, b) {
  update({ [WIDTH[resizedOf(a, b).col].key]: null });
}

// ---------------------------------------------------------------- menu "Painéis"
function toggleMenu() {
  if (menu) return closeMenu();
  menu = h('div.panels-menu');
  document.body.append(menu);
  renderMenu();
  const r = document.getElementById('panels-btn').getBoundingClientRect();
  menu.style.top = r.bottom + 6 + 'px';
  menu.style.right = Math.max(8, window.innerWidth - r.right) + 'px';
}

function closeMenu() {
  menu?.remove();
  menu = null;
}

function renderMenu() {
  const visibleCols = layout.order.filter((c) => !layout.hidden[c]);
  const row = (panel) => {
    const hidden = !!layout.hidden[panel];
    const i = layout.order.indexOf(panel);
    const show = h('input', { type: 'checkbox', checked: !hidden, on: { change: (e) => setPanelHidden(panel, !e.target.checked) } });
    const controls = panel === 'tl'
      ? [
        h(`button${layout.tlPos === 'top' ? '.active' : ''}`, { title: 'Timeline em cima', on: { click: () => update({ tlPos: 'top' }) } }, 'Em cima'),
        h(`button${layout.tlPos !== 'top' ? '.active' : ''}`, { title: 'Timeline embaixo', on: { click: () => update({ tlPos: 'bottom' }) } }, 'Embaixo'),
      ]
      : [
        h('button.icon', { title: 'Mover para a esquerda', disabled: i === 0, on: { click: () => movePanel(panel, -1) } }, '◀'),
        h('button.icon', { title: 'Mover para a direita', disabled: i === layout.order.length - 1, on: { click: () => movePanel(panel, 1) } }, '▶'),
        h(`button${layout.tall === panel ? '.active' : ''}`, {
          title: 'Ocupa a altura inteira da janela, ao lado da timeline',
          disabled: hidden || !!layout.hidden.tl || visibleCols.length < 2,
          on: { click: () => update({ tall: layout.tall === panel ? null : panel }) },
        }, 'Altura inteira'),
      ];
    return h(`div.pm-row${hidden ? '.off' : ''}`, {}, h('label', {}, show, PANELS[panel]), h('div.pm-ctrl', {}, ...controls));
  };
  menu.replaceChildren(
    h('div.pm-title', {}, 'Painéis'),
    ...layout.order.map(row),
    row('tl'),
    h('div.pm-note', {}, 'Desmarque para ocultar. As setas trocam a ordem das colunas.'),
    h('div.pm-title', {}, 'Layouts prontos'),
    h('div.pm-presets', {}, ...Object.entries(PRESETS).map(([name, [label]]) => h('button', { on: { click: () => applyPreset(name) } }, label))),
  );
}
