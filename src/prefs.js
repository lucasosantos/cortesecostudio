// Preferências do usuário nesta máquina (não fazem parte do projeto).
const KEY = 'corteseco.prefs';
export const PREF_DEFAULTS = {
  previewQuality: 'auto', // 'auto' | 1 | 0.5 | 0.25
  proxyMode: 'auto', // 'auto' (vídeos acima de 720 de altura) | 'always' | 'never'
  proxyHeight: 540,
  fastExport: false,
};

let cache = null;
const listeners = new Set();

function load() {
  if (cache) return cache;
  cache = { ...PREF_DEFAULTS };
  try {
    const raw = typeof localStorage !== 'undefined' ? localStorage.getItem(KEY) : null;
    if (raw) Object.assign(cache, sanitize(JSON.parse(raw)));
  } catch {
    /* sem armazenamento: vale o padrão */
  }
  return cache;
}

/** Mantém só chaves conhecidas com valores válidos. */
export function sanitize(obj) {
  const out = {};
  if (!obj || typeof obj !== 'object') return out;
  if (obj.previewQuality === 'auto' || [1, 0.5, 0.25].includes(obj.previewQuality)) out.previewQuality = obj.previewQuality;
  if (['auto', 'always', 'never'].includes(obj.proxyMode)) out.proxyMode = obj.proxyMode;
  if ([360, 540, 720].includes(obj.proxyHeight)) out.proxyHeight = obj.proxyHeight;
  if (typeof obj.fastExport === 'boolean') out.fastExport = obj.fastExport;
  return out;
}

export const getPref = (name) => load()[name];

export function setPref(name, value) {
  const next = sanitize({ [name]: value });
  if (!(name in next)) return;
  load()[name] = next[name];
  try {
    if (typeof localStorage !== 'undefined') localStorage.setItem(KEY, JSON.stringify(cache));
  } catch {
    /* vale só nesta sessão */
  }
  for (const fn of listeners) fn(name);
}

export const onPrefChange = (fn) => { listeners.add(fn); return () => listeners.delete(fn); };
