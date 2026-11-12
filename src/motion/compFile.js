// Arquivo de composição (.csmotion): leva uma composição de motion de um projeto para outro.
// As imagens usadas pelas camadas vão embutidas (base64), para abrir em qualquer projeto ou máquina.
import { state, uid } from '../state/project.js';
import { packFonts, loadPackedFonts } from '../fonts.js';

export const COMP_EXT = 'csmotion';
export const COMP_KIND = 'motion-comp';

/**
 * Monta o conteúdo do arquivo. media: [{ id, name, width, height, mime, data(base64) }] já lidos.
 * @returns objeto pronto para JSON.stringify
 */
export function packComp(comp, media = []) {
  return { app: 'CorteSeco Studio', kind: COMP_KIND, version: 1, comp: JSON.parse(JSON.stringify(comp)), media };
}

/** Ids das mídias usadas pelas camadas de imagem da composição. */
export const compMediaIds = (comp) => [...new Set(comp.layers.filter((l) => l.type === 'image' && l.mediaId).map((l) => l.mediaId))];

/** O texto parece um arquivo de composição? */
export function parseCompFile(text) {
  let data;
  try {
    data = typeof text === 'string' ? JSON.parse(text) : text;
  } catch {
    throw new Error('arquivo de composição inválido');
  }
  if (!data || data.kind !== COMP_KIND || !data.comp || !Array.isArray(data.comp.layers)) throw new Error('arquivo de composição inválido');
  return data;
}

/**
 * Cria no projeto uma cópia da composição do arquivo, com ids novos.
 * mediaMap: id da mídia no arquivo → id da mídia no projeto (camadas sem mídia correspondente ficam sem imagem).
 * @returns a composição adicionada
 */
export function instantiateComp(data, mediaMap = {}, project = state.project) {
  const comp = JSON.parse(JSON.stringify(data.comp));
  const ids = {};
  for (const l of comp.layers) ids[l.id] = uid('l');
  for (const l of comp.layers) {
    l.id = ids[l.id];
    if (l.parentId) l.parentId = ids[l.parentId] || null;
    if (l.matte) l.matte = ids[l.matte.layerId] ? { ...l.matte, layerId: ids[l.matte.layerId] } : null;
    if (l.type === 'image') l.mediaId = mediaMap[l.mediaId] || null;
  }
  comp.id = uid('k');
  project.comps ||= [];
  const names = new Set(project.comps.map((c) => c.name));
  const base = comp.name || 'Composição';
  let name = base;
  for (let i = 2; names.has(name); i++) name = `${base} (${i})`;
  comp.name = name;
  project.comps.push(comp);
  return comp;
}

const toBase64 = (bytes) => {
  let s = '';
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(s);
};
const fromBase64 = (b64) => Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));

/** Gera o texto do arquivo, lendo as imagens usadas. */
export async function exportCompText(comp) {
  const { runtime } = await import('../media/library.js');
  const media = [];
  for (const id of compMediaIds(comp)) {
    const m = state.project.media.find((x) => x.id === id);
    const rt = runtime.get(id);
    if (!m || !rt) continue;
    try {
      const blob = rt.blob || (await (await fetch(rt.url)).blob());
      media.push({ id, name: m.name, width: m.width, height: m.height, mime: blob.type || '', data: toBase64(new Uint8Array(await blob.arrayBuffer())) });
    } catch (err) {
      console.warn('Imagem não embutida na composição:', m.name, err);
    }
  }
  const fonts = packFonts({ comps: [comp] });
  return JSON.stringify({ ...packComp(comp, media), ...(fonts.length ? { fonts } : {}) });
}

/** Importa o texto de um arquivo .csmotion para o projeto atual. @returns a composição criada */
export async function importCompText(text) {
  const data = parseCompFile(text);
  await loadPackedFonts(data.fonts);
  const { attachBlob } = await import('../media/library.js');
  const mediaMap = {};
  for (const m of data.media || []) {
    if (!m?.data) continue;
    const media = { id: uid('m'), name: m.name || 'imagem', type: 'image', path: null, duration: 0, width: m.width || 0, height: m.height || 0, hasAudio: false, size: 0 };
    try {
      const blob = new Blob([fromBase64(m.data)], m.mime ? { type: m.mime } : {});
      media.size = blob.size;
      await attachBlob(media, blob);
    } catch (err) {
      console.warn('Imagem da composição não carregou:', m.name, err);
      continue;
    }
    state.project.media.push(media);
    mediaMap[m.id] = media.id;
  }
  return instantiateComp(data, mediaMap);
}
