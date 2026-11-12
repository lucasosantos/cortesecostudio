// Biblioteca de mídia: importar, listar, arrastar para a timeline, reapontar arquivos ausentes.
import { state, emit, subscribe, checkpoint } from '../state/project.js';
import { runtime, importFiles, removeMedia, isMissing, MEDIA_ACCEPT, attachBlob } from '../media/library.js';
import { pickFiles, pathForFile, saveFile } from '../platform/index.js';
import { COMP_EXT, exportCompText } from '../motion/compFile.js';
import { placeMedia, placeComp, MEDIA_MIME, COMP_MIME } from './timeline.js';
import { h, formatDuration, toast } from './util.js';
import { withIcon } from './icons.js';
import { removeComp, compUsage } from '../motion/model.js';
import { drawComp } from '../motion/render.js';
import { openComp, exitMotion } from './motion/actions.js';
import { openNewComp } from './dialogs.js';
import { timed } from '../perf.js';

let root, grid, compGrid, compEmpty;

export function initMediaPanel(el) {
  root = el;
  root.classList.add('media-panel-root');
  grid = h('div.media-grid');
  root.append(
    h('h3', {}, h('span.grow', {}, 'Mídia'), h('button', { on: { click: importDialog } }, 'Importar')),
    h('div.media-drop', {}, 'Arraste arquivos de vídeo, áudio ou imagem aqui · SVG vira composição vetorial editável'),
    grid,
    h('h3', {}, h('span.grow', {}, 'Composições'), h('button', { title: 'Importar uma composição exportada (.csmotion) ou um SVG', on: { click: importCompDialog } }, 'Importar'),
      h('button', { title: 'Nova composição de motion design', on: { click: openNewComp } }, 'Nova')),
    (compEmpty = h('div.insp-note', {}, 'Composições são animações de formas, textos e vetores que entram na timeline como um clipe.')),
    (compGrid = h('div.media-grid')),
  );
  root.addEventListener('dragover', (e) => {
    if (![...e.dataTransfer.types].includes('Files')) return;
    e.preventDefault();
    root.classList.add('dragover');
  });
  root.addEventListener('dragleave', (e) => { if (!root.contains(e.relatedTarget)) root.classList.remove('dragover'); });
  root.addEventListener('drop', async (e) => {
    e.preventDefault();
    e.stopPropagation();
    root.classList.remove('dragover');
    reportImport(await importFiles([...e.dataTransfer.files]));
  });
  subscribe((r) => { if (r === 'media' || r === 'project' || r === 'mode') timed('mediaPanel', render); });
  render();
}

export async function importDialog() {
  const files = await pickFiles({ accept: MEDIA_ACCEPT, multiple: true });
  if (files.length) reportImport(await importFiles(files));
}

/** Salva a composição num arquivo .csmotion (com as imagens embutidas) para usar em outros projetos. */
export async function exportCompDialog(comp) {
  if (!comp) return;
  try {
    const text = await exportCompText(comp);
    const safe = comp.name.replace(/[\\/:*?"<>|]+/g, '_').trim() || 'composicao';
    const saved = await saveFile(`${safe}.${COMP_EXT}`, new TextEncoder().encode(text), [{ name: 'Composição CorteSeco Studio', extensions: [COMP_EXT] }]);
    if (saved) toast(`Composição exportada: ${saved}`);
  } catch (err) {
    toast(`Não foi possível exportar "${comp.name}": ${err.message}`, 'error');
  }
}

/** Importa composições exportadas (.csmotion) ou SVGs como composições novas. */
export async function importCompDialog() {
  const files = await pickFiles({ accept: `.${COMP_EXT},.svg,image/svg+xml`, multiple: true });
  if (!files.length) return;
  checkpoint();
  reportImport(await importFiles(files));
}

/** Avisa quando arquivos viraram composições (SVG vetorial / composição exportada). */
export function reportImport(result) {
  const n = result?.comps?.length || 0;
  if (!n) return;
  const names = result.comps.map((c) => `"${c.name}"`).join(', ');
  const extra = result.warnings.length ? ' · ' + result.warnings.join(' · ') : '';
  toast(`${n > 1 ? 'Composições criadas' : 'Composição criada'}: ${names} — duplo clique para editar as curvas${extra}`);
}

// A grade só é refeita quando a lista muda: emit('project') acontece a cada movimento do mouse num arrasto.
let mediaSig = null;
let compSig = null;
const compCanvases = new Map(); // compId → { canvas, hash }
let thumbTimer = 0;

function render() {
  const sig = state.project.media.map((m) => {
    const rt = runtime.get(m.id);
    return [m.id, m.name, m.type, m.duration, m.width, m.height, isMissing(m.id) ? 1 : 0, rt?.thumb?.length || 0, rt?.waveform ? 1 : 0, rt?.proxy || ''].join(':');
  }).join('|');
  if (sig !== mediaSig) {
    mediaSig = sig;
    renderMedia();
  }
  renderComps();
}

function renderMedia() {
  const icon = { video: '🎬', audio: '♪', image: '🖼' };
  const label = { video: 'VÍDEO', audio: 'ÁUDIO', image: 'IMAGEM' };
  // os eventos buscam a mídia pelo id na hora: depois de um desfazer os objetos do projeto são outros
  const find = (id) => state.project.media.find((x) => x.id === id);
  grid.replaceChildren(...state.project.media.map((m) => {
    const id = m.id;
    const rt = runtime.get(id);
    const missing = isMissing(id);
    const thumb = h('div.thumb', { style: rt?.thumb ? { backgroundImage: `url(${rt.thumb})` } : {} });
    if (missing) thumb.append('Arquivo ausente — clique para localizar');
    else if (!rt?.thumb) thumb.append(m.type === 'audio' && rt?.waveform ? '' : icon[m.type]);
    if (!missing && m.type === 'audio' && rt?.waveform) Object.assign(thumb.style, { backgroundImage: `url(${rt.waveform})`, backgroundSize: '100% 60%' });

    const item = h(`div.media-item${missing ? '.missing' : ''}`, {
      draggable: !missing,
      title: `${m.name}\nDuplo clique: adicionar no playhead`,
      on: {
        dragstart: (e) => {
          e.dataTransfer.setData(MEDIA_MIME, id);
          e.dataTransfer.effectAllowed = 'copy';
        },
        dblclick: () => { const media = find(id); if (media && !isMissing(id)) placeMedia(media, null, state.time); },
        click: () => { const media = find(id); if (media && isMissing(id)) relinkOne(media); },
      },
    },
    thumb,
    h('span.badge', {}, label[m.type]),
    rt?.proxy ? h(`span.badge.proxy-badge${rt.proxy === 'ready' ? '.ready' : ''}`, { title: rt.proxy === 'ready' ? 'O preview usa uma cópia leve deste vídeo (a exportação usa o original)' : 'Gerando a cópia leve para o preview…' }, rt.proxy === 'ready' ? 'PROXY' : `PROXY ${rt.proxy}`) : null,
    withIcon(h('button.remove', {
      title: 'Remover da biblioteca (e da timeline)',
      on: {
        click: (e) => {
          e.stopPropagation();
          const media = find(id);
          if (!media) return;
          const used = state.project.clips.filter((c) => c.mediaId === id).length;
          if (used && !confirm(`"${media.name}" é usado em ${used} clipe(s). Remover mesmo assim?`)) return;
          checkpoint();
          removeMedia(id);
          emit('project');
        },
      },
    }), 'close'),
    h('div.meta', {},
      h('div.name', {}, m.name),
      h('div.sub', {}, h('span', {}, m.type === 'image' ? `${m.width}×${m.height}` : formatDuration(m.duration)), h('span', {}, m.width ? `${m.width}×${m.height}` : '')),
    ));
    return item;
  }));
}

const getCompById = (id) => (state.project.comps || []).find((c) => c.id === id);

/** Código curto do conteúdo, para saber se a miniatura precisa ser redesenhada. */
function hashOf(text) {
  let hsh = 5381;
  for (let i = 0; i < text.length; i++) hsh = ((hsh << 5) + hsh + text.charCodeAt(i)) | 0;
  return `${text.length}:${hsh}`;
}

function drawCompThumb(comp, canvas, openId) {
  const ctx = canvas.getContext('2d');
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.clearRect(0, 0, canvas.width, canvas.height);
  const s = Math.min(192 / comp.width, 108 / comp.height);
  ctx.translate((192 - comp.width * s) / 2, (108 - comp.height * s) / 2);
  ctx.scale(s, s);
  try {
    // um frame da composição (o do playhead, se ela estiver aberta)
    drawComp(ctx, comp, comp.id === openId ? state.motion.time : Math.min(comp.duration / 2, 1), (item) => runtime.get(item.mediaId)?.image || null);
  } catch (err) {
    console.warn('Falha ao desenhar a miniatura de', comp.name, err);
  }
}

/** Redesenha só as miniaturas das composições que mudaram. */
function refreshCompThumbs() {
  const openId = state.mode === 'motion' ? state.motion.compId : null;
  for (const comp of state.project.comps || []) {
    const entry = compCanvases.get(comp.id);
    if (!entry) continue;
    const hash = hashOf(JSON.stringify(comp)) + (runtime.size ? `/${runtime.size}` : '');
    if (hash === entry.hash) continue;
    entry.hash = hash;
    timed('compThumb', () => drawCompThumb(comp, entry.canvas, openId));
  }
}

function renderComps() {
  const comps = state.project.comps || [];
  const openId = state.mode === 'motion' ? state.motion.compId : null;
  // miniaturas: desenhadas um pouco depois da última mudança (desenhar a cada movimento do mouse é caro)
  clearTimeout(thumbTimer);
  thumbTimer = setTimeout(refreshCompThumbs, 300);
  const sig = `${openId}|` + comps.map((c) => [c.id, c.name, c.duration, c.width, c.height].join(':')).join('|');
  if (sig === compSig) return;
  compSig = sig;
  compEmpty.style.display = comps.length ? 'none' : '';
  for (const id of [...compCanvases.keys()]) if (!comps.some((c) => c.id === id)) compCanvases.delete(id);
  compGrid.replaceChildren(...comps.map((comp) => {
    const id = comp.id;
    let entry = compCanvases.get(id);
    if (!entry) {
      // composição nova: a miniatura aparece na hora
      entry = { canvas: h('canvas', { width: 192, height: 108 }), hash: null };
      compCanvases.set(id, entry);
    }
    return h(`div.media-item.comp-item${id === openId ? '.open' : ''}`, {
      draggable: true,
      title: `${comp.name}\nDuplo clique: editar no workspace de motion\nArraste para a timeline para usar no vídeo`,
      on: {
        dragstart: (e) => {
          e.dataTransfer.setData(COMP_MIME, id);
          e.dataTransfer.effectAllowed = 'copy';
        },
        dblclick: () => openComp(id),
      },
    },
    h('div.thumb', {}, entry.canvas),
    h('span.badge', {}, 'MOTION'),
    h('button.export', {
      title: 'Exportar a composição (.csmotion) para usar em outros projetos',
      on: { click: (e) => { e.stopPropagation(); exportCompDialog(getCompById(id)); } },
    }, '⤓'),
    h('button.remove', {
      title: 'Excluir a composição (e os clipes que a usam)',
      on: {
        click: (e) => {
          e.stopPropagation();
          const current = getCompById(id);
          if (!current) return;
          const used = compUsage(id);
          if (!confirm(used ? `"${current.name}" é usada em ${used} clipe(s). Excluir mesmo assim?` : `Excluir a composição "${current.name}"?`)) return;
          checkpoint();
          if (id === (state.mode === 'motion' ? state.motion.compId : null)) exitMotion();
          removeComp(id);
          emit('project');
        },
      },
    }, '✕'),
    h('div.meta', {},
      h('div.name', {}, comp.name),
      h('div.sub', {}, h('span', {}, formatDuration(comp.duration)), h('span', {}, `${comp.width}×${comp.height}`)),
    ));
  }));
  // as que acabaram de entrar não esperam
  if ([...compCanvases.values()].some((e) => e.hash === null)) refreshCompThumbs();
}

/** Pede ao usuário o arquivo correspondente a uma mídia ausente. */
export async function relinkOne(media) {
  const [file] = await pickFiles({ accept: MEDIA_ACCEPT });
  if (!file) return false;
  try {
    await attachBlob(media, file);
    media.path = pathForFile(file) || media.path;
    emit('media');
    emit('project');
    return true;
  } catch (err) {
    toast(`Não foi possível abrir ${file.name}: ${err.message}`, 'error');
    return false;
  }
}
