// Ícones SVG inline (herdam a cor do texto via currentColor).

// --- Ícones da coleção "Chunk 16px Thick" (svgrepo.com), em src/icons/ ---
const files = import.meta.glob('../icons/*.svg', { query: '?raw', import: 'default', eager: true });

// Limpa o SVG baixado: remove cabeçalho/comentários/metadados, troca cores fixas
// por currentColor e tira width/height fixos (o tamanho vem do CSS: .ico).
function normalize(src) {
  return src
    .replace(/<\?xml[^>]*\?>/g, '')
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/<title>[\s\S]*?<\/title>|<desc>[\s\S]*?<\/desc>|<defs>\s*<\/defs>/g, '')
    .replace(/\s(width|height)="[^"]*"(?=[^>]*viewBox)/g, '')
    .replace(/fill="#(?:000000|000|202327)"/gi, 'fill="currentColor"')
    .replace(/<svg\b/, '<svg class="ico" aria-hidden="true" focusable="false"')
    .replace(/>\s+</g, '><')
    .trim();
}

const raw = {};
for (const [path, src] of Object.entries(files)) {
  const name = path.split('/').pop().replace(/(-svgrepo-com)?\.svg$/, '');
  raw[name] = normalize(src);
}

// Nomes semânticos usados pela interface -> arquivo em src/icons/
const map = {
  undo: 'arrow-rotate-left',
  redo: 'arrow-rotate-right',
  media: 'vidicon-f',
  text: 'align-text-left',
  comp: 'add-so',
  edit: 'scissors',
  motion: 'vector-curve',
  settings: 'settings-1389',
  toStart: 'rewind',
  toEnd: 'rewind', // espelhado via CSS (.ico-flip)
  prev: 'angle-left',
  next: 'angle-right',
  play: 'play',
  pause: 'pause',
  new: 'file-plus',
  open: 'folder-open',
  save: 'floppy-disk',
  export: 'download',
  keyframe: 'diamond-shape',
  close: 'xmark-circle',
  vol: 'volume-low',
  volOff: 'volume-x',
};

/** SVG de um ícone pelo nome semântico (ou nome do arquivo). */
export function icon(name, flip = false) {
  const s = raw[map[name] || name] || '';
  return flip ? s.replace('class="ico"', 'class="ico ico-flip"') : s;
}

/** Define o conteúdo de um elemento como o ícone e devolve o elemento. */
export function withIcon(el, name) {
  el.innerHTML = icon(name);
  return el;
}

/** Insere o ícone em todo elemento com data-icon="nome" (antes do texto existente). */
export function applyIcons(root = document) {
  root.querySelectorAll('[data-icon]').forEach((el) => {
    if (el.querySelector(':scope > svg.ico')) return;
    const name = el.dataset.icon;
    el.insertAdjacentHTML('afterbegin', icon(name, name === 'toEnd'));
    if (el.textContent.trim()) el.classList.add('has-ico');
  });
}

// Ícones dos cabeçalhos de track na timeline
export const icons = {
  eye: icon('eye'),
  eyeOff: icon('eye-slash'),
  vol: icon('vol'),
  volOff: icon('volOff'),
  lock: icon('lock-closed'),
  unlock: icon('lock-open'),
  up: icon('angle-up'),
  down: icon('angle-down'),
  trash: icon('trash'),
};
