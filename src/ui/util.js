// Utilidades de UI.

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
    else if (k === 'style' && typeof v === 'object') Object.assign(el.style, v);
    else if (k === 'dataset') Object.assign(el.dataset, v);
    else if (k in el && k !== 'list' && typeof v !== 'string') el[k] = v;
    else el.setAttribute(k, v === true ? '' : v);
  }
  for (const c of children.flat()) if (c != null && c !== false) el.append(c instanceof Node ? c : String(c));
  return el;
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
