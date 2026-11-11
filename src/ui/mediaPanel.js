// Biblioteca de mídia: importar, listar, arrastar para a timeline, reapontar arquivos ausentes.
import { state, emit, subscribe, checkpoint } from '../state/project.js';
import { runtime, importFiles, removeMedia, isMissing, MEDIA_ACCEPT, attachBlob } from '../media/library.js';
import { pickFiles, pathForFile } from '../platform/index.js';
import { placeMedia, placeComp, MEDIA_MIME, COMP_MIME } from './timeline.js';
import { h, formatDuration, toast } from './util.js';
import { withIcon } from './icons.js';
import { removeComp, compUsage } from '../motion/model.js';
import { drawComp } from '../motion/render.js';
import { openComp, exitMotion } from './motion/actions.js';
import { openNewComp } from './dialogs.js';

let root, grid, compGrid, compEmpty;

export function initMediaPanel(el) {
  root = el;
  root.classList.add('media-panel-root');
  grid = h('div.media-grid');
  root.append(
    h('h3', {}, h('span.grow', {}, 'Mídia'), h('button', { on: { click: importDialog } }, 'Importar')),
    h('div.media-drop', {}, 'Arraste arquivos de vídeo, áudio ou imagem aqui'),
    grid,
    h('h3', {}, h('span.grow', {}, 'Composições'), h('button', { title: 'Nova composição de motion design', on: { click: openNewComp } }, 'Nova')),
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
    await importFiles([...e.dataTransfer.files]);
  });
  subscribe((r) => { if (r === 'media' || r === 'project' || r === 'mode') render(); });
  render();
}

export async function importDialog() {
  const files = await pickFiles({ accept: MEDIA_ACCEPT, multiple: true });
  if (files.length) await importFiles(files);
}

function render() {
  const icon = { video: '🎬', audio: '♪', image: '🖼' };
  const label = { video: 'VÍDEO', audio: 'ÁUDIO', image: 'IMAGEM' };
  grid.replaceChildren(...state.project.media.map((m) => {
    const rt = runtime.get(m.id);
    const missing = isMissing(m.id);
    const thumb = h('div.thumb', { style: rt?.thumb ? { backgroundImage: `url(${rt.thumb})` } : {} });
    if (missing) thumb.append('Arquivo ausente — clique para localizar');
    else if (!rt?.thumb) thumb.append(m.type === 'audio' && rt?.waveform ? '' : icon[m.type]);
    if (!missing && m.type === 'audio' && rt?.waveform) Object.assign(thumb.style, { backgroundImage: `url(${rt.waveform})`, backgroundSize: '100% 60%' });

    const item = h(`div.media-item${missing ? '.missing' : ''}`, {
      draggable: !missing,
      title: `${m.name}\nDuplo clique: adicionar no playhead`,
      on: {
        dragstart: (e) => {
          e.dataTransfer.setData(MEDIA_MIME, m.id);
          e.dataTransfer.effectAllowed = 'copy';
        },
        dblclick: () => !missing && placeMedia(m, null, state.time),
        click: () => missing && relinkOne(m),
      },
    },
    thumb,
    h('span.badge', {}, label[m.type]),
    withIcon(h('button.remove', {
      title: 'Remover da biblioteca (e da timeline)',
      on: {
        click: (e) => {
          e.stopPropagation();
          const used = state.project.clips.filter((c) => c.mediaId === m.id).length;
          if (used && !confirm(`"${m.name}" é usado em ${used} clipe(s). Remover mesmo assim?`)) return;
          checkpoint();
          removeMedia(m.id);
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
  renderComps();
}

function renderComps() {
  const comps = state.project.comps || [];
  compEmpty.style.display = comps.length ? 'none' : '';
  const openId = state.mode === 'motion' ? state.motion.compId : null;
  compGrid.replaceChildren(...comps.map((comp) => {
    // miniatura: um frame da composição (o do playhead, se ela estiver aberta)
    const canvas = h('canvas', { width: 192, height: 108 });
    const ctx = canvas.getContext('2d');
    const s = Math.min(192 / comp.width, 108 / comp.height);
    ctx.translate((192 - comp.width * s) / 2, (108 - comp.height * s) / 2);
    ctx.scale(s, s);
    try {
      drawComp(ctx, comp, comp.id === openId ? state.motion.time : Math.min(comp.duration / 2, 1), (item) => runtime.get(item.mediaId)?.image || null);
    } catch (err) {
      console.warn('Falha ao desenhar a miniatura de', comp.name, err);
    }
    return h(`div.media-item.comp-item${comp.id === openId ? '.open' : ''}`, {
      draggable: true,
      title: `${comp.name}\nDuplo clique: editar no workspace de motion\nArraste para a timeline para usar no vídeo`,
      on: {
        dragstart: (e) => {
          e.dataTransfer.setData(COMP_MIME, comp.id);
          e.dataTransfer.effectAllowed = 'copy';
        },
        dblclick: () => openComp(comp.id),
      },
    },
    h('div.thumb', {}, canvas),
    h('span.badge', {}, 'MOTION'),
    h('button.remove', {
      title: 'Excluir a composição (e os clipes que a usam)',
      on: {
        click: (e) => {
          e.stopPropagation();
          const used = compUsage(comp.id);
          if (!confirm(used ? `"${comp.name}" é usada em ${used} clipe(s). Excluir mesmo assim?` : `Excluir a composição "${comp.name}"?`)) return;
          checkpoint();
          if (comp.id === openId) exitMotion();
          removeComp(comp.id);
          emit('project');
        },
      },
    }, '✕'),
    h('div.meta', {},
      h('div.name', {}, comp.name),
      h('div.sub', {}, h('span', {}, formatDuration(comp.duration)), h('span', {}, `${comp.width}×${comp.height}`)),
    ));
  }));
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
