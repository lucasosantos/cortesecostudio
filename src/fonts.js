// Fontes: as padrão, as instaladas no app (arquivos .ttf/.otf/.woff/.woff2 guardados no IndexedDB)
// e as do sistema operacional (Local Font Access do Chromium). As instaladas que um projeto usa vão
// embutidas no arquivo salvo, para o texto sair igual em outra máquina.

export const DEFAULT_FONTS = [
  ['Inter, Arial, sans-serif', 'Sans (Inter/Arial)'],
  ['Georgia, "Times New Roman", serif', 'Serif (Georgia)'],
  ['"Courier New", monospace', 'Mono (Courier)'],
  ['Impact, "Arial Black", sans-serif', 'Impact'],
  ['"Comic Sans MS", cursive', 'Comic'],
  ['Verdana, sans-serif', 'Verdana'],
  ['"Trebuchet MS", sans-serif', 'Trebuchet'],
];

export const FONT_ACCEPT = '.ttf,.otf,.woff,.woff2,font/ttf,font/otf,font/woff,font/woff2';

/** Valor CSS de font-family para um nome de família. */
export const familyCss = (name) => `"${String(name).replace(/["\\]/g, '')}", sans-serif`;

/** Primeiro nome da lista de font-family, sem aspas. */
export const familyName = (css) => String(css || '').split(',')[0].trim().replace(/^["']|["']$/g, '');

/** Nome amigável para mostrar no seletor. */
export function familyLabel(css) {
  const d = DEFAULT_FONTS.find(([v]) => v === css);
  return d ? d[1] : familyName(css) || 'Fonte';
}

// ---------------------------------------------------------------- leitura do arquivo da fonte
/**
 * Família, peso e estilo de um arquivo TrueType/OpenType (tabelas name e OS/2).
 * WOFF/WOFF2 são comprimidos: para eles devolve null e o nome vem do arquivo.
 */
export function readFontInfo(buffer) {
  const v = new DataView(buffer instanceof ArrayBuffer ? buffer : buffer.buffer);
  if (v.byteLength < 12) return null;
  const tag = v.getUint32(0);
  // 0x00010000 (TrueType), 'OTTO' (CFF), 'true'
  if (tag !== 0x00010000 && tag !== 0x4f54544f && tag !== 0x74727565) return null;
  const n = v.getUint16(4);
  const tables = {};
  for (let i = 0; i < n; i++) {
    const p = 12 + i * 16;
    if (p + 16 > v.byteLength) return null;
    const t = String.fromCharCode(v.getUint8(p), v.getUint8(p + 1), v.getUint8(p + 2), v.getUint8(p + 3));
    tables[t] = { offset: v.getUint32(p + 8), length: v.getUint32(p + 12) };
  }
  const info = { family: null, weight: 400, italic: false };
  const name = tables.name;
  if (name && name.offset + 6 <= v.byteLength) {
    const count = v.getUint16(name.offset + 2);
    const strBase = name.offset + v.getUint16(name.offset + 4);
    const found = {};
    for (let i = 0; i < count; i++) {
      const r = name.offset + 6 + i * 12;
      if (r + 12 > v.byteLength) break;
      const platform = v.getUint16(r);
      const id = v.getUint16(r + 6);
      const len = v.getUint16(r + 8);
      const off = strBase + v.getUint16(r + 10);
      if ((id !== 1 && id !== 16) || off + len > v.byteLength) continue;
      let s = '';
      if (platform === 0 || platform === 3) {
        for (let k = 0; k + 1 < len; k += 2) s += String.fromCharCode(v.getUint16(off + k));
      } else if (platform === 1) {
        for (let k = 0; k < len; k++) s += String.fromCharCode(v.getUint8(off + k));
      } else continue;
      // Windows/Unicode tem preferência sobre Mac
      if (s && (!found[id] || platform !== 1)) found[id] = s;
    }
    // 16 = família tipográfica (sem "Bold", "Light"...); 1 = família antiga
    info.family = (found[16] || found[1] || '').trim() || null;
  }
  const os2 = tables['OS/2'];
  if (os2 && os2.offset + 64 <= v.byteLength) {
    const w = v.getUint16(os2.offset + 4);
    if (w >= 1 && w <= 1000) info.weight = w;
    info.italic = !!(v.getUint16(os2.offset + 62) & 1);
  }
  return info;
}

/** Nome de família a partir do nome do arquivo ("Roboto-BoldItalic.ttf" → "Roboto"). */
export function familyFromFileName(file) {
  const base = String(file).replace(/\.[^.]+$/, '');
  const fam = base.split(/[-_]/)[0].replace(/([a-z])([A-Z])/g, '$1 $2').trim();
  return fam || base || 'Fonte';
}

export function weightFromFileName(file) {
  const s = String(file).toLowerCase();
  const table = [['thin', 100], ['extralight', 200], ['ultralight', 200], ['light', 300], ['medium', 500], ['semibold', 600], ['demibold', 600], ['extrabold', 800], ['ultrabold', 800], ['black', 900], ['heavy', 900], ['bold', 700]];
  for (const [k, w] of table) if (s.includes(k)) return w;
  return 400;
}

// ---------------------------------------------------------------- registro em memória
/** Faces carregadas nesta sessão: { id, family, weight, style, fileName, data: ArrayBuffer, source: 'library' | 'project', face } */
const faces = new Map();
const listeners = new Set();
export const onFontsChange = (fn) => (listeners.add(fn), () => listeners.delete(fn));
const changed = () => { for (const fn of listeners) fn(); };

const faceKey = (f) => `${f.family}|${f.weight}|${f.style}`;

/** Famílias instaladas (app + as que vieram embutidas no projeto), em ordem alfabética. */
export function installedFamilies() {
  const map = new Map();
  for (const f of faces.values()) {
    const e = map.get(f.family) || { family: f.family, faces: 0, library: false };
    e.faces++;
    e.library ||= f.source === 'library';
    map.set(f.family, e);
  }
  return [...map.values()].sort((a, b) => a.family.localeCompare(b.family));
}

/** Carrega uma face no documento (canvas e prévia passam a usá-la). */
async function register(entry) {
  const key = faceKey(entry);
  const existing = [...faces.values()].find((f) => faceKey(f) === key);
  if (existing) {
    // a mesma face vinda do projeto e da biblioteca: vale a da biblioteca
    if (entry.source === 'library') existing.source = 'library';
    return existing;
  }
  const face = new FontFace(entry.family, entry.data, { weight: String(entry.weight), style: entry.style });
  await face.load();
  document.fonts.add(face);
  const rec = { ...entry, face };
  faces.set(rec.id, rec);
  return rec;
}

// ---------------------------------------------------------------- biblioteca persistente (IndexedDB)
const DB = 'corteseco-fonts';
const STORE = 'fonts';
function openDb() {
  return new Promise((resolve, reject) => {
    if (typeof indexedDB === 'undefined') return reject(new Error('IndexedDB indisponível'));
    const req = indexedDB.open(DB, 1);
    req.onupgradeneeded = () => req.result.createObjectStore(STORE, { keyPath: 'id' });
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}
async function dbDo(mode, fn) {
  const db = await openDb();
  try {
    return await new Promise((resolve, reject) => {
      const tx = db.transaction(STORE, mode);
      const req = fn(tx.objectStore(STORE));
      tx.oncomplete = () => resolve(req?.result);
      tx.onerror = () => reject(tx.error);
    });
  } finally {
    db.close();
  }
}

/** Carrega as fontes instaladas no app (chamado na partida). */
export async function initFonts() {
  let list = [];
  try {
    list = (await dbDo('readonly', (s) => s.getAll())) || [];
  } catch (err) {
    console.warn('Fontes instaladas indisponíveis:', err);
  }
  for (const f of list) {
    try {
      await register({ ...f, source: 'library' });
    } catch (err) {
      console.warn('Fonte instalada não carregou:', f.fileName, err);
    }
  }
  if (list.length) changed();
}

/**
 * Instala arquivos de fonte (File[]) no app.
 * @returns { families: string[], failed: string[] }
 */
export async function installFontFiles(files) {
  const families = new Set();
  const failed = [];
  for (const file of files) {
    try {
      const data = await file.arrayBuffer();
      const info = readFontInfo(data);
      const entry = {
        id: `font-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`,
        family: info?.family || familyFromFileName(file.name),
        weight: info?.weight || weightFromFileName(file.name),
        style: info ? (info.italic ? 'italic' : 'normal') : /italic|oblique/i.test(file.name) ? 'italic' : 'normal',
        fileName: file.name,
        data,
      };
      const rec = await register({ ...entry, source: 'library' });
      // a mesma face já estava instalada: não duplica no banco
      if (rec.id === entry.id) await dbDo('readwrite', (s) => s.put(entry));
      else await dbDo('readwrite', (s) => s.put({ id: rec.id, family: rec.family, weight: rec.weight, style: rec.style, fileName: rec.fileName, data: rec.data }));
      families.add(entry.family);
    } catch (err) {
      console.warn('Falha ao instalar', file.name, err);
      failed.push(file.name);
    }
  }
  changed();
  return { families: [...families], failed };
}

/** Remove uma família da biblioteca do app (continua disponível até fechar, se estiver em uso). */
export async function uninstallFamily(family) {
  for (const f of [...faces.values()]) {
    if (f.family !== family || f.source !== 'library') continue;
    await dbDo('readwrite', (s) => s.delete(f.id));
    document.fonts.delete(f.face);
    faces.delete(f.id);
  }
  changed();
}

// ---------------------------------------------------------------- embutir nos arquivos
const toBase64 = (buffer) => {
  const bytes = new Uint8Array(buffer);
  let s = '';
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(s);
};
const fromBase64 = (b64) => Uint8Array.from(atob(b64), (c) => c.charCodeAt(0)).buffer;

/** Famílias (nomes) usadas pelos textos de clipes e de camadas de composições. */
export function usedFamilies(project) {
  const out = new Set();
  const add = (font) => { if (font?.family) out.add(familyName(font.family)); };
  for (const c of project?.clips || []) if (c.type === 'text') add(c.font);
  for (const comp of project?.comps || []) for (const l of comp.layers || []) if (l.type === 'text') add(l.font);
  return out;
}

/** Faces instaladas que o projeto (ou a composição, passada como { comps: [comp] }) usa, prontas para JSON. */
export function packFonts(project) {
  const used = usedFamilies(project);
  return [...faces.values()].filter((f) => used.has(f.family)).map((f) => ({
    family: f.family, weight: f.weight, style: f.style, fileName: f.fileName, data: toBase64(f.data),
  }));
}

/** Carrega as fontes embutidas num arquivo (projeto ou composição). Não instala no app. */
export async function loadPackedFonts(list) {
  if (!Array.isArray(list) || !list.length) return 0;
  let n = 0;
  for (const f of list) {
    if (!f?.family || !f.data) continue;
    try {
      await register({
        id: `font-p-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`,
        family: String(f.family), weight: Number(f.weight) || 400, style: f.style === 'italic' ? 'italic' : 'normal',
        fileName: String(f.fileName || f.family), data: fromBase64(f.data), source: 'project',
      });
      n++;
    } catch (err) {
      console.warn('Fonte embutida não carregou:', f.family, err);
    }
  }
  changed();
  return n;
}

// ---------------------------------------------------------------- fontes do sistema
let systemFamilies = null;
export const systemFontsSupported = () => typeof window !== 'undefined' && typeof window.queryLocalFonts === 'function';
export const getSystemFamilies = () => systemFamilies;

/**
 * Lista as famílias de fonte instaladas no sistema operacional.
 * Precisa ser chamada a partir de um clique (o navegador pode pedir permissão).
 */
export async function loadSystemFamilies() {
  if (systemFamilies) return systemFamilies;
  if (!systemFontsSupported()) throw new Error('este navegador não permite listar as fontes do sistema');
  const list = await window.queryLocalFonts();
  systemFamilies = [...new Set(list.map((f) => f.family))].filter(Boolean).sort((a, b) => a.localeCompare(b));
  try { localStorage.setItem('mineeditor.systemFonts', '1'); } catch { /* sem armazenamento */ }
  changed();
  return systemFamilies;
}

/** O usuário já liberou as fontes do sistema antes (tenta carregar sozinho ao abrir o seletor). */
export function systemFontsGranted() {
  try { return localStorage.getItem('mineeditor.systemFonts') === '1'; } catch { return false; }
}
