// Layouts da interface: padrão, vertical (preview ocupando toda a altura à direita/esquerda) e timeline grande.
import { state, subscribe } from '../state/project.js';
import { toast, clamp } from './util.js';

const LAYOUTS = ['classic', 'vertical-right', 'vertical-left', 'timeline'];
const KEY = 'mineeditor.layout';
const SIZES_KEY = 'mineeditor.layoutSizes';

let current = 'classic';
let sizes = {}; // por layout: { tlH, pvW }
let hinted = false;

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
    /* armazenamento indisponível: o layout só não é lembrado */
  }
};

export function initLayout() {
  sizes = load(SIZES_KEY, {});
  const select = document.getElementById('layout-select');
  select.addEventListener('change', () => setLayout(select.value));
  setLayout(load(KEY, 'classic'));

  initPreviewResizer();

  // sugere o layout vertical uma vez quando o projeto fica em formato retrato
  subscribe((reason) => {
    if (reason !== 'project' || hinted) return;
    const { width, height } = state.project.settings;
    if (height > width && current === 'classic') {
      hinted = true;
      toast('Projeto vertical: experimente o Layout Vertical no topo da tela');
    }
  });
}

export function setLayout(name) {
  if (!LAYOUTS.includes(name)) name = 'classic';
  saveSizes();
  const body = document.body;
  for (const l of LAYOUTS) body.classList.remove('layout-' + l);
  if (name !== 'classic') body.classList.add('layout-' + name);
  current = name;
  // restaura os tamanhos salvos para este layout
  const s = sizes[name] || {};
  body.style.removeProperty('--tl-h');
  body.style.removeProperty('--pv-w');
  if (s.tlH) body.style.setProperty('--tl-h', s.tlH);
  if (s.pvW) body.style.setProperty('--pv-w', s.pvW);
  document.getElementById('layout-select').value = name;
  store(KEY, name);
}

function saveSizes() {
  const st = document.body.style;
  sizes[current] = { tlH: st.getPropertyValue('--tl-h') || null, pvW: st.getPropertyValue('--pv-w') || null };
  store(SIZES_KEY, sizes);
}

function initPreviewResizer() {
  const handle = document.getElementById('pv-resizer');
  handle.addEventListener('pointerdown', (e) => {
    e.preventDefault();
    const startX = e.clientX;
    const startW = handle.parentElement.getBoundingClientRect().width;
    const dir = current === 'vertical-left' ? 1 : -1;
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

/** Chamado pelo redimensionador da timeline ao soltar. */
export { saveSizes };
