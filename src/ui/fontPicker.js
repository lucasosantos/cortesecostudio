// Seletor de fonte com busca: padrão, instaladas no app e do sistema operacional.
import { h, toast } from './util.js';
import { pickFiles } from '../platform/index.js';
import {
  DEFAULT_FONTS, FONT_ACCEPT, familyCss, familyLabel, installedFamilies, installFontFiles, uninstallFamily,
  onFontsChange, systemFontsSupported, getSystemFamilies, loadSystemFamilies, systemFontsGranted,
} from '../fonts.js';

const MAX_SYSTEM_ROWS = 400; // a lista do sistema pode ter milhares: mostra as primeiras que batem com a busca

let open = null; // { el, button, onPick, off }

/**
 * Botão que mostra a fonte atual e abre o seletor.
 * getValue(): font-family atual · onPick(css): aplica a fonte escolhida
 */
export function fontPicker(getValue, onPick, { disabled = false } = {}) {
  const btn = h('button.font-pick', { type: 'button', disabled, title: 'Escolher fonte (padrão, instaladas ou do sistema)' });
  const refresh = () => {
    const v = getValue();
    btn.textContent = familyLabel(v);
    btn.style.fontFamily = v;
  };
  refresh();
  btn.addEventListener('click', (e) => {
    e.stopPropagation();
    if (open?.button === btn) return closePicker();
    openPicker(btn, getValue(), (css) => { onPick(css); refresh(); });
  });
  return btn;
}

export function closePicker() {
  if (!open) return;
  open.off();
  open.el.remove();
  open = null;
}

function openPicker(button, current, onPick) {
  closePicker();
  const search = h('input.fp-search', { type: 'search', placeholder: 'Buscar ou digitar o nome de uma fonte…' });
  const list = h('div.fp-list');
  const el = h('div.font-popover', {},
    search,
    list,
    h('div.fp-actions', {},
      h('button', { type: 'button', title: 'Arquivos .ttf, .otf, .woff ou .woff2 — ficam guardados no app', on: { click: install } }, 'Instalar fonte…'),
    ),
  );
  document.body.append(el);
  const r = button.getBoundingClientRect();
  const H = Math.min(440, window.innerHeight - 24);
  el.style.maxHeight = H + 'px';
  el.style.left = Math.max(8, Math.min(r.left, window.innerWidth - 340)) + 'px';
  el.style.top = (r.bottom + H + 8 < window.innerHeight ? r.bottom + 4 : Math.max(8, r.top - H - 4)) + 'px';

  const pick = (css) => { onPick(css); closePicker(); };
  const item = (css, label, extra = []) => h(`div.fp-item${css === current ? '.active' : ''}`, {
    title: label, on: { click: () => pick(css) },
  }, h('span.fp-name', { style: { fontFamily: css } }, label), ...extra);

  let loadingSystem = false;
  const loadSystem = async () => {
    loadingSystem = true;
    render();
    try {
      await loadSystemFamilies();
    } catch (err) {
      toast(`Não foi possível listar as fontes do sistema: ${err.message}. Digite o nome da fonte na busca.`, 'error');
    }
    loadingSystem = false;
    if (open?.el === el) render();
  };

  function render() {
    const q = search.value.trim().toLowerCase();
    const match = (s) => !q || s.toLowerCase().includes(q);
    const out = [];
    const defaults = DEFAULT_FONTS.filter(([v, n]) => match(n) || match(v));
    if (defaults.length) out.push(h('div.fp-title', {}, 'Padrão'), ...defaults.map(([v, n]) => item(v, n)));

    const inst = installedFamilies().filter((f) => match(f.family));
    out.push(h('div.fp-title', {}, 'Instaladas no app'));
    if (inst.length) {
      out.push(...inst.map((f) => item(familyCss(f.family), f.family, [
        h('span.fp-tag', {}, f.library ? (f.faces > 1 ? `${f.faces} estilos` : '') : 'do projeto'),
        f.library ? h('button.fp-del', {
          type: 'button', title: 'Desinstalar do app',
          on: {
            click: async (e) => {
              e.stopPropagation();
              if (!confirm(`Desinstalar a fonte "${f.family}" do app? Projetos salvos que a usam continuam com uma cópia.`)) return;
              await uninstallFamily(f.family);
            },
          },
        }, '✕') : '',
      ])));
    } else if (!q) {
      out.push(h('div.fp-note', {}, 'Nenhuma ainda. Use "Instalar fonte…" para adicionar arquivos de fonte.'));
    }

    out.push(h('div.fp-title', {}, 'Do sistema'));
    const sys = getSystemFamilies();
    if (sys) {
      const hits = sys.filter(match);
      out.push(...hits.slice(0, MAX_SYSTEM_ROWS).map((name) => item(familyCss(name), name)));
      if (hits.length > MAX_SYSTEM_ROWS) out.push(h('div.fp-note', {}, `+${hits.length - MAX_SYSTEM_ROWS} fontes — refine a busca`));
      if (!hits.length) out.push(h('div.fp-note', {}, 'Nenhuma fonte do sistema com esse nome.'));
    } else if (loadingSystem) {
      out.push(h('div.fp-note', {}, 'Carregando fontes do sistema…'));
    } else if (systemFontsSupported()) {
      out.push(h('button.fp-load', { type: 'button', on: { click: loadSystem } }, 'Mostrar fontes instaladas no computador'));
    } else {
      out.push(h('div.fp-note', {}, 'Este navegador não lista as fontes do sistema, mas você pode digitar o nome de uma fonte instalada na busca.'));
    }

    // qualquer nome digitado: o navegador usa a fonte do sistema com esse nome, se existir
    const typed = search.value.trim();
    const known = typed && (DEFAULT_FONTS.some(([, n]) => n.toLowerCase() === typed.toLowerCase())
      || installedFamilies().some((f) => f.family.toLowerCase() === typed.toLowerCase())
      || sys?.some((n) => n.toLowerCase() === typed.toLowerCase()));
    if (typed && !known) {
      out.unshift(h('div.fp-item.fp-typed', { on: { click: () => pick(familyCss(typed)) } },
        h('span.fp-name', { style: { fontFamily: familyCss(typed) } }, typed), h('span.fp-tag', {}, 'usar este nome')));
    }
    list.replaceChildren(...out);
  }

  async function install() {
    const files = await pickFiles({ accept: FONT_ACCEPT, multiple: true });
    if (!files.length) return;
    const { families, failed } = await installFontFiles(files);
    if (failed.length) toast(`Não foi possível instalar: ${failed.join(', ')}`, 'error');
    if (families.length) {
      toast(`Fonte instalada: ${families.join(', ')}`);
      // uma família só: já aplica no texto
      if (families.length === 1) return pick(familyCss(families[0]));
    }
    if (open?.el === el) render();
  }

  search.addEventListener('input', render);
  search.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') closePicker();
    if (e.key === 'Enter') {
      const first = list.querySelector('.fp-item');
      first?.click();
    }
  });
  const outside = (e) => { if (!el.contains(e.target) && e.target !== button) closePicker(); };
  const offFonts = onFontsChange(() => open?.el === el && render());
  setTimeout(() => document.addEventListener('pointerdown', outside, true));
  open = { el, button, onPick, off: () => { document.removeEventListener('pointerdown', outside, true); offFonts(); } };
  render();
  search.focus();
  // já liberado antes: carrega a lista do sistema sem pedir outro clique
  if (!getSystemFamilies() && systemFontsGranted() && systemFontsSupported()) loadSystem();
  // rola até a fonte atual
  list.querySelector('.fp-item.active')?.scrollIntoView({ block: 'nearest' });
}
