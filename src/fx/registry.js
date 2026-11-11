// Registro de efeitos e transições: nativos + instalados pelo usuário + embutidos no projeto aberto.
import { state, uid } from '../state/project.js';
import { valueAt } from '../state/keyframes.js';
import { formatColor } from '../motion/interp.js';
import { BUILTIN } from './builtin.js';
import { PARAM_GLSL, defaultFor, isParamName, ENTRY_FUNCTION } from './shader.js';

export const FORMAT = 'corteseco-fx';
export const MAX_BYTES = 200_000;
const STORE_KEY = 'corteseco.extensions';
/** Transições que já existiam no editor (feitas em canvas, não em shader). */
export const NATIVE_TRANSITIONS = { fade: 'Combinar', slide: 'Deslizar', flash: 'Flash' };

// ---------------------------------------------------------------- instalados
let installed = null;
let version = 0;
/** Muda a cada instalação/remoção (os inspectors usam para saber quando refazer as listas). */
export const extensionsVersion = () => version;
const listeners = new Set();
/** Avisa quando a lista de extensões instaladas muda. */
export const onExtensionsChange = (fn) => { listeners.add(fn); return () => listeners.delete(fn); };

function load() {
  if (installed) return installed;
  installed = [];
  try {
    const raw = typeof localStorage !== 'undefined' ? localStorage.getItem(STORE_KEY) : null;
    for (const item of raw ? JSON.parse(raw) : []) {
      const r = validateExtension(item);
      if (r.ok) installed.push(r.ext);
    }
  } catch {
    /* armazenamento indisponível ou corrompido: começa vazio */
  }
  return installed;
}

function save() {
  try {
    if (typeof localStorage !== 'undefined') localStorage.setItem(STORE_KEY, JSON.stringify(installed));
  } catch {
    /* sem armazenamento: as extensões valem só nesta sessão */
  }
  version++;
  for (const fn of listeners) fn();
}

export const installedExtensions = () => load();

/** Extensões que vieram dentro do projeto aberto e não estão instaladas nesta máquina. */
export function projectOnlyExtensions(project = state.project) {
  const have = new Set(load().map((e) => e.id));
  return (project.extensions || []).filter((e) => e && !have.has(e.id) && !BUILTIN.some((b) => b.id === e.id));
}

/** Todas as definições disponíveis (opcionalmente só 'effect', 'transition' ou 'animation'). */
export function listExtensions(kind) {
  const all = [...BUILTIN, ...load(), ...projectOnlyExtensions()];
  return kind ? all.filter((e) => e.kind === kind) : all;
}

export function getExtension(id) {
  return BUILTIN.find((e) => e.id === id) || load().find((e) => e.id === id) || (state.project.extensions || []).find((e) => e?.id === id) || null;
}

export const isInstalled = (id) => load().some((e) => e.id === id);

export function installExtension(ext) {
  const r = validateExtension(ext);
  if (!r.ok) throw new Error(r.errors[0]);
  load();
  installed = [...installed.filter((e) => e.id !== r.ext.id), r.ext];
  save();
  return r.ext;
}

export function removeExtension(id) {
  load();
  installed = installed.filter((e) => e.id !== id);
  save();
}

/** Id que ainda não existe, derivado de `id` (para "manter os dois" ao instalar um id repetido). */
export function freeId(id) {
  let n = 2;
  let candidate = id;
  while (getExtension(candidate) || NATIVE_TRANSITIONS[candidate]) candidate = `${id}-${n++}`.slice(0, 64);
  return candidate;
}

// ---------------------------------------------------------------- validação
const ID_RE = /^[a-z0-9][a-z0-9._-]{1,63}$/;

export const slugify = (text) => String(text || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase()
  .replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40) || 'extensao';

/**
 * Confere e normaliza uma extensão vinda de arquivo. Só os campos conhecidos sobrevivem.
 * @returns { ok, errors: string[], ext }
 */
export function validateExtension(raw) {
  const errors = [];
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return { ok: false, errors: ['O arquivo não é uma extensão do CorteSeco Studio.'], ext: null };
  if (raw.format !== FORMAT) errors.push(`Formato desconhecido (esperado "${FORMAT}").`);
  if (!ENTRY_FUNCTION[raw.kind]) errors.push('O campo "kind" precisa ser "effect", "transition" ou "animation".');
  const id = String(raw.id || '');
  if (!ID_RE.test(id)) errors.push('Id inválido: use letras minúsculas, números, ponto, hífen e sublinhado (2 a 64 caracteres).');
  if (BUILTIN.some((b) => b.id === id) || NATIVE_TRANSITIONS[id]) errors.push(`O id "${id}" é reservado para um recurso nativo.`);
  const name = String(raw.name || '').trim();
  if (!name) errors.push('Falta o nome.');
  const glsl = typeof raw.glsl === 'string' ? raw.glsl : '';
  if (!glsl.trim()) errors.push('Falta o código GLSL.');
  if (glsl.length > MAX_BYTES) errors.push(`O código passa de ${MAX_BYTES / 1000} KB.`);
  const fn = ENTRY_FUNCTION[raw.kind] || 'effect';
  if (glsl && !new RegExp(`\\b${fn}\\s*\\(`).test(glsl)) errors.push(`O código precisa definir a função "vec4 ${fn}(vec2 uv)".`);

  const params = [];
  const seen = new Set();
  const list = Array.isArray(raw.params) ? raw.params : [];
  if (list.length > 32) errors.push('Máximo de 32 parâmetros.');
  for (const p of list.slice(0, 32)) {
    if (!p || typeof p !== 'object') { errors.push('Parâmetro inválido.'); continue; }
    const pname = String(p.name || '');
    if (!isParamName(pname)) { errors.push(`Nome de parâmetro inválido ou reservado: "${pname}".`); continue; }
    if (seen.has(pname)) { errors.push(`Parâmetro repetido: "${pname}".`); continue; }
    if (!PARAM_GLSL[p.type]) { errors.push(`Tipo desconhecido no parâmetro "${pname}": "${p.type}".`); continue; }
    seen.add(pname);
    const out = { name: pname, label: String(p.label || pname).slice(0, 60), type: p.type };
    out.default = defaultFor({ type: p.type, default: p.default });
    for (const k of ['min', 'max', 'step']) if (Number.isFinite(Number(p[k])) && p[k] !== null && p[k] !== '') out[k] = Number(p[k]);
    params.push(out);
  }
  const ext = {
    format: FORMAT, version: 1, id, name: name.slice(0, 80), kind: raw.kind,
    author: String(raw.author || '').slice(0, 80), description: String(raw.description || '').slice(0, 400),
    params, glsl,
  };
  return { ok: errors.length === 0, errors, ext };
}

/** Texto do arquivo .csfx.json de uma extensão. */
export function exportExtension(ext) {
  const { format, version, id, name, kind, author, description, params, glsl } = ext;
  return JSON.stringify({ format: format || FORMAT, version: version || 1, id, name, kind, author: author || '', description: description || '', params: params || [], glsl }, null, 2);
}

// ---------------------------------------------------------------- gl-transitions
const hexOf = (nums) => formatColor(nums.slice(0, 3).map((v) => v * 255).concat(nums.length > 3 ? [nums[3] * 255] : [])).slice(0, nums.length > 3 ? 9 : 7);

function glDefault(type, text) {
  // tira o nome do construtor ("vec3", "ivec2") para o dígito dele não ser lido como valor
  const t = String(text || '').trim().replace(/;$/, '').replace(/\b[iub]?vec\d\b/g, '');
  const nums = (t.match(/[-+]?(?:\d+\.?\d*|\.\d+)(?:[eE][-+]?\d+)?/g) || []).map(Number);
  const fill = (n) => (nums.length === 1 ? Array(n).fill(nums[0]) : Array.from({ length: n }, (_, i) => nums[i] ?? 0));
  if (type === 'bool') return /true/.test(t);
  if (type === 'float' || type === 'int') return nums[0] ?? 0;
  if (type === 'vec2' || type === 'ivec2') return fill(2);
  if (type === 'vec3') return hexOf(fill(3));
  if (type === 'vec4') return hexOf(fill(4));
  return 0;
}

/**
 * Converte um arquivo .glsl do projeto gl-transitions numa extensão de transição.
 * Os `uniform tipo nome; // = padrão` viram parâmetros e saem do código (o invólucro os declara).
 */
export function parseGlTransition(source, fileName = 'transicao.glsl') {
  const base = fileName.replace(/\.glsl$/i, '').split(/[\\/]/).pop();
  const params = [];
  const map = { float: 'float', int: 'int', bool: 'bool', vec2: 'vec2', ivec2: 'ivec2', vec3: 'color3', vec4: 'color' };
  const unsupported = [];
  const glsl = String(source).replace(/^[ \t]*uniform\s+(\w+)\s+(\w+)\s*;?[ \t]*(?:\/\/\s*=\s*(.*))?$/gm, (line, type, name, def) => {
    if (!map[type]) { unsupported.push(`${type} ${name}`); return line; }
    params.push({ name, label: name, type: map[type], default: glDefault(type, def) });
    return `// parâmetro: ${name}`;
  });
  if (unsupported.length) throw new Error(`Esta transição usa um tipo de parâmetro não suportado (${unsupported.join(', ')}).`);
  const author = (/\/\/\s*Author:\s*(.+)/i.exec(source)?.[1] || '').trim();
  const license = (/\/\/\s*License:\s*(.+)/i.exec(source)?.[1] || '').trim();
  return {
    format: FORMAT, version: 1, id: `gl.${slugify(base)}`, name: base, kind: 'transition', author,
    description: `Importada do gl-transitions${license ? ` (licença ${license})` : ''}.`,
    params, glsl,
  };
}

/** Lê o conteúdo de um arquivo de extensão (.csfx.json / .json / .glsl). Lança erro com mensagem para o usuário. */
export function readExtensionFile(text, fileName = '') {
  if (text.length > MAX_BYTES * 2) throw new Error('Arquivo grande demais para ser uma extensão.');
  if (/\.glsl$/i.test(fileName) || (!text.trim().startsWith('{') && /\btransition\s*\(/.test(text))) {
    const r = validateExtension(parseGlTransition(text, fileName || 'transicao.glsl'));
    if (!r.ok) throw new Error(r.errors[0]);
    return r.ext;
  }
  let data;
  try {
    data = JSON.parse(text);
  } catch {
    throw new Error('O arquivo não é um JSON válido.');
  }
  const r = validateExtension(data);
  if (!r.ok) throw new Error(r.errors.join(' '));
  return r.ext;
}

// ---------------------------------------------------------------- instâncias de efeito
/** Nova instância de efeito para um clipe ou camada. */
export function createEffect(type) {
  const def = getExtension(type);
  const props = {};
  for (const p of def?.params || []) props[p.name] = defaultFor(p);
  return { id: uid('fx'), type, enabled: true, props, keyframes: {} };
}

/** Valores dos parâmetros de uma instância no tempo t (parâmetros novos da definição entram com o padrão). */
export function effectValues(effect, def, t) {
  const out = {};
  for (const p of def.params || []) out[p.name] = effect.props && p.name in effect.props ? valueAt(effect, p.name, t) : defaultFor(p);
  return out;
}

// ---------------------------------------------------------------- transições
export const transitionExtId = (type) => (typeof type === 'string' && type.startsWith('ext:') ? type.slice(4) : null);

/** A transição existe (nativa ou de extensão disponível)? */
export function transitionKnown(type) {
  if (NATIVE_TRANSITIONS[type]) return true;
  const id = transitionExtId(type);
  return !!id && getExtension(id)?.kind === 'transition';
}

export function transitionLabel(type) {
  if (NATIVE_TRANSITIONS[type]) return NATIVE_TRANSITIONS[type];
  const id = transitionExtId(type);
  return (id && getExtension(id)?.name) || 'Transição';
}

/** [tipo, nome] de todas as transições disponíveis, nativas primeiro. */
export function transitionOptions() {
  return [...Object.entries(NATIVE_TRANSITIONS), ...listExtensions('transition').map((e) => [`ext:${e.id}`, e.name])];
}

/** Definição da animação de entrada/saída (kind "animation") referida por `type`, ou null. */
export function animationDef(type) {
  const def = getExtension(transitionExtId(type));
  return def?.kind === 'animation' ? def : null;
}

/** O tipo serve como entrada/saída de um clipe? (nativas, animações de entrada/saída e transições) */
export const animKnown = (type) => transitionKnown(type) || !!animationDef(type);

/**
 * Opções para os seletores de entrada/saída, agrupadas: [[título, [[tipo, nome], ...]], ...].
 * Camadas do motion só aceitam as animações de entrada/saída (`layer: true`).
 */
export function animOptions({ layer = false } = {}) {
  const anims = listExtensions('animation').map((e) => [`ext:${e.id}`, e.name]);
  if (layer) return [['Entrada/saída', anims]];
  return [
    ['Simples', Object.entries(NATIVE_TRANSITIONS)],
    ['Entrada/saída', anims],
    ['Transições (com a cena vazia)', listExtensions('transition').map((e) => [`ext:${e.id}`, e.name])],
  ].filter(([, list]) => list.length);
}

// ---------------------------------------------------------------- projeto
/** Ids de extensões (não nativas) usadas pelo projeto. */
export function usedExtensionIds(project = state.project) {
  const ids = new Set();
  const addFx = (obj) => { for (const e of obj.effects || []) ids.add(e.type); };
  for (const clip of project.clips || []) {
    addFx(clip);
    for (const key of ['transition', 'animIn', 'animOut']) {
      const id = transitionExtId(clip[key]?.type);
      if (id) ids.add(id);
    }
  }
  for (const comp of project.comps || []) {
    for (const layer of comp.layers || []) {
      addFx(layer);
      for (const key of ['animIn', 'animOut']) {
        const id = transitionExtId(layer[key]?.type);
        if (id) ids.add(id);
      }
    }
  }
  for (const b of BUILTIN) ids.delete(b.id);
  return [...ids];
}

/** Guarda no projeto uma cópia das extensões que ele usa, para abrir em outra máquina. */
export function embedUsedExtensions(project = state.project) {
  const list = [];
  for (const id of usedExtensionIds(project)) {
    const ext = load().find((e) => e.id === id) || (project.extensions || []).find((e) => e?.id === id);
    if (ext) list.push(JSON.parse(exportExtension(ext)));
  }
  project.extensions = list;
  return list;
}
