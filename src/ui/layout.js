// Arranjo da interface: cada módulo (Mídia, Preview, Inspector, Timeline) pode ser ocultado ou movido.
// As três colunas de cima trocam de ordem, qualquer uma pode ocupar a altura inteira (ao lado da timeline)
// e a timeline pode ficar em cima ou embaixo. Os layouts prontos são atalhos para esses ajustes.
import { state, subscribe } from '../state/project.js';
import { h, toast, clamp } from './util.js';

export const PANELS = { media: 'Mídia', preview: 'Preview', insp: 'Inspector', tl: 'Timeline' };
const COLUMNS = ['media', 'preview', 'insp'];
const KEY = 'mineeditor.panels';
const OLD_KEY = 'mineeditor.layout';

export const DEFAULT_LAYOUT = { order: ['media', 'preview', 'insp'], hidden: {}, tall: null, tlPos: 'bottom', tlH: null, pvW: null };
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
  if (typeof raw.pvW === 'string' && /^\d+(\.\d+)?(px|vw)$/.test(raw.pvW)) out.pvW = raw.pvW;
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
  const fixed = { media: 'var(--media-w, 260px)', insp: 'var(--insp-w, 300px)' };
  const widths = cols.map((c, i) => {
    if (tall === 'preview') return c === 'preview' ? 'var(--pv-w, 34vw)' : 'minmax(200px, 1fr)';
    // o preview estica; sem ele, a última coluna ocupa a sobra
    const flexible = cols.includes('preview') ? c === 'preview' : i === cols.length - 1;
    return flexible ? 'minmax(0, 1fr)' : fixed[c];
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
  body.style.removeProperty('--pv-w');
  if (layout.tlH) body.style.setProperty('--tl-h', layout.tlH);
  if (layout.pvW) body.style.setProperty('--pv-w', layout.pvW);
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
export const applyPreset = (name) => PRESETS[name] && update({ ...PRESETS[name][1], hidden: {}, tlH: PRESETS[name][1].tlH || null, pvW: null });

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
  apply();
  initPreviewResizer();
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

/** Guarda as alturas/larguras ajustadas pelas alças (timeline e preview). */
export function saveSizes() {
  const st = document.body.style;
  layout = sanitizeLayout({ ...layout, tlH: st.getPropertyValue('--tl-h').trim() || null, pvW: st.getPropertyValue('--pv-w').trim() || null });
  store(KEY, layout);
}

function initPreviewResizer() {
  const handle = document.getElementById('pv-resizer');
  handle.addEventListener('pointerdown', (e) => {
    e.preventDefault();
    const startX = e.clientX;
    const startW = handle.parentElement.getBoundingClientRect().width;
    const dir = document.body.classList.contains('pv-first') ? 1 : -1;
    const move = (ev) => {
      const w = clamp(startW + dir * (ev.clientX - startX), 240, window.innerWidth - 520);
      document.body.style.setProperty('--pv-w', Math.round(w) + 'px');
    };
    const up = () => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
      saveSizes();
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
  });
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
