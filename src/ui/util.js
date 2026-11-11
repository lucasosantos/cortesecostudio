// Utilidades de UI.

/** Aplica um objeto de estilos; nomes começando com "--" são variáveis CSS (que só entram por setProperty). */
export function setStyle(el, styles) {
  for (const [k, v] of Object.entries(styles)) {
    if (k.startsWith('--')) el.style.setProperty(k, v);
    else el.style[k] = v;
  }
}

/** Cria um elemento: h('div.cls#id', { attrs, on: {click} }, ...children) */
export function h(sel, attrs = {}, ...children) {
  const [, tag = 'div', rest = ''] = sel.match(/^([a-z0-9-]*)(.*)$/i);
  const el = document.createElement(tag || 'div');
  for (const part of rest.match(/[.#][^.#]+/g) || []) {
    if (part[0] === '.') el.classList.add(part.slice(1));
    else el.id = part.slice(1);
  }
  for (const [k, v] of Object.entries(attrs || {})) {
    if (v == null || v === false) continue;
    if (k === 'on') for (const [ev, fn] of Object.entries(v)) el.addEventListener(ev, fn);
    else if (k === 'style' && typeof v === 'object') setStyle(el, v);
    else if (k === 'dataset') Object.assign(el.dataset, v);
    // em <textarea> o atributo "value" não existe: o conteúdo só entra pela propriedade
    else if (k === 'value' && el.tagName === 'TEXTAREA') el.value = v;
    else if (k in el && k !== 'list' && typeof v !== 'string') el[k] = v;
    else el.setAttribute(k, v === true ? '' : v);
  }
  for (const c of children.flat()) if (c != null && c !== false) el.append(c instanceof Node ? c : String(c));
  return el;
}

/**
 * Faixa de tempo a desenhar: o que está visível mais meia tela de cada lado.
 * @returns { t0, t1 (segundos), x0, x1 (pixels de rolagem em que a faixa continua valendo) }
 */
export function visibleWindow(scrollLeft, viewWidth, zoom, headWidth = 0) {
  const laneW = Math.max(1, viewWidth - headWidth);
  const margin = laneW / 2;
  return {
    t0: Math.max(0, (scrollLeft - margin) / zoom),
    t1: (scrollLeft + laneW + margin) / zoom,
    // só redesenha quando a rolagem passa de um quarto de tela além do que foi criado
    x0: scrollLeft - margin / 2,
    x1: scrollLeft + margin / 2,
  };
}

export function formatTime(t, fps) {
  t = Math.max(0, t || 0);
  const m = Math.floor(t / 60);
  const s = Math.floor(t % 60);
  const frac = fps ? Math.floor((t % 1) * fps) : Math.floor((t % 1) * 100);
  return `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}.${String(frac).padStart(2, '0')}`;
}

export function formatDuration(t) {
  t = Math.max(0, t || 0);
  const m = Math.floor(t / 60);
  const s = Math.round(t % 60);
  return `${m}:${String(s).padStart(2, '0')}`;
}

let toastTimer;
export function toast(msg, type = '') {
  document.querySelector('.toast')?.remove();
  const el = h(`div.toast${type ? '.' + type : ''}`, {}, msg);
  document.body.appendChild(el);
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.remove(), 3500);
}

/** Abre um modal. Retorna { close, el }. */
export function openModal({ title, body, footer, onClose, dismissable = true }) {
  const root = document.getElementById('modal-root');
  const modal = h('div.modal', {}, h('header', {}, title), h('div.body', {}, body), footer ? h('footer', {}, footer) : null);
  const backdrop = h('div.modal-backdrop', {}, modal);
  const close = () => {
    backdrop.remove();
    document.removeEventListener('keydown', onKey, true);
    onClose?.();
  };
  const onKey = (e) => {
    if (e.key === 'Escape' && dismissable) close();
  };
  if (dismissable) backdrop.addEventListener('mousedown', (e) => e.target === backdrop && close());
  document.addEventListener('keydown', onKey, true);
  root.appendChild(backdrop);
  return { close, el: modal };
}

export const clamp = (v, a, b) => Math.min(b, Math.max(a, v));
