import './styles.css';
import {
  state, emit, checkpoint, undo, redo, getClip, getTrack, orderedTracks, overlaps, addTrack, createTextClip,
  findFreeSlot, serializeProject, loadProject, newProject, newMotionState, resetHistory, uid, projectDuration, subscribe,
} from './state/project.js';
import { attachBlob, clearRuntime, isMissing } from './media/library.js';
import { togglePlay, pause, seek, releaseAll } from './engine/player.js';
import { saveFile, openFile, readFileByPath, isDesktop } from './platform/index.js';
import { initTimeline, splitAtPlayhead, deleteSelected, zoomIn, zoomOut } from './ui/timeline.js';
import { initPreview } from './ui/preview.js';
import { initInspector } from './ui/inspector.js';
import { initMediaPanel, importDialog } from './ui/mediaPanel.js';
import { openSettings, openExport, openMissingMedia, openNewComp } from './ui/dialogs.js';
import { initMotion, enterMotion, exitMotion, handleMotionKey } from './ui/motion/workspace.js';
import { toast } from './ui/util.js';
import { initLayout } from './ui/layout.js';
import { applyIcons } from './ui/icons.js';

applyIcons();
initLayout();
initMediaPanel(document.getElementById('media-panel'));
initPreview();
initInspector(document.getElementById('inspector'));
initTimeline(document.getElementById('timeline'));
initMotion();

let dirty = false;
let clipboard = null;

// ---------------------------------------------------------------- ações
const actions = {
  new: () => {
    if (dirty && !confirm('Descartar o projeto atual?')) return;
    pause();
    releaseAll();
    clearRuntime();
    exitMotion();
    state.project = newProject();
    state.selection = null;
    state.time = 0;
    state.motion = newMotionState();
    state.projectName = 'projeto';
    resetHistory();
    dirty = false;
    emit('project');
    emit('media');
  },
  open: openProject,
  save: saveProject,
  undo,
  redo,
  import: importDialog,
  'add-text': addText,
  'new-comp': openNewComp,
  'mode-edit': exitMotion,
  'mode-motion': enterMotion,
  settings: openSettings,
  export: openExport,
  play: togglePlay,
  'to-start': () => seek(0),
  'to-end': () => seek(projectDuration()),
  'prev-frame': () => seek(state.time - 1 / state.project.settings.fps),
  'next-frame': () => seek(state.time + 1 / state.project.settings.fps),
};

document.addEventListener('click', (e) => {
  const btn = e.target.closest('[data-action]');
  if (btn && actions[btn.dataset.action]) actions[btn.dataset.action]();
});

function addText() {
  const t = state.time;
  const sel = state.selection ? getClip(state.selection) : null;
  let track = sel && getTrack(sel.trackId)?.kind === 'visual' ? getTrack(sel.trackId) : null;
  checkpoint();
  if (!track || track.locked || overlaps(track.id, t, t + 5)) {
    track = orderedTracks().find((tr) => tr.kind === 'visual' && !tr.locked && !overlaps(tr.id, t, t + 5)) || addTrack('visual');
  }
  const clip = createTextClip(track.id, t);
  clip.start = findFreeSlot(track.id, t, clip.duration, clip.id);
  state.selection = clip.id;
  emit('project');
}

// ---------------------------------------------------------------- projeto
async function saveProject() {
  const name = `${state.projectName || 'projeto'}.json`;
  const saved = await saveFile(name, new TextEncoder().encode(serializeProject()), [{ name: 'Projeto CorteSeco Studio', extensions: ['json'] }]);
  if (saved) {
    dirty = false;
    state.projectName = String(saved).split(/[\\/]/).pop().replace(/\.json$/i, '');
    toast(`Projeto salvo: ${saved}`);
  }
}

async function openProject() {
  if (dirty && !confirm('Descartar o projeto atual?')) return;
  const file = await openFile([{ name: 'Projeto CorteSeco Studio', extensions: ['json'] }]);
  if (!file) return;
  let data;
  try {
    data = JSON.parse(new TextDecoder().decode(file.data));
    pause();
    releaseAll();
    clearRuntime();
    loadProject(data);
  } catch (err) {
    return toast('Não foi possível abrir o projeto: ' + err.message, 'error');
  }
  state.projectName = file.name.replace(/\.json$/i, '');
  dirty = false;

  // recarrega as mídias pelos caminhos salvos (desktop)
  for (const media of state.project.media) {
    try {
      const bytes = await readFileByPath(media.path);
      if (bytes) await attachBlob(media, new Blob([bytes]));
    } catch (err) {
      console.warn('Falha ao carregar', media.path, err);
    }
  }
  emit('media');
  emit('project');
  const missing = state.project.media.filter((m) => isMissing(m.id));
  if (missing.length) openMissingMedia(missing);
  else if (!isDesktop && state.project.media.length) openMissingMedia(state.project.media);
}

// ---------------------------------------------------------------- área de transferência
function copySelected() {
  const clip = state.selection ? getClip(state.selection) : null;
  if (clip) clipboard = JSON.parse(JSON.stringify(clip));
  return clip;
}

function paste() {
  if (!clipboard) return;
  checkpoint();
  const clip = JSON.parse(JSON.stringify(clipboard));
  clip.id = uid('c');
  let track = getTrack(clip.trackId);
  const kind = clip.type === 'audio' ? 'audio' : 'visual';
  if (!track || track.locked) track = orderedTracks().find((t) => t.kind === kind && !t.locked) || addTrack(kind);
  clip.trackId = track.id;
  clip.start = findFreeSlot(track.id, state.time, clip.duration, clip.id);
  state.project.clips.push(clip);
  state.selection = clip.id;
  emit('project');
}

// ---------------------------------------------------------------- teclado
document.addEventListener('keydown', (e) => {
  if (document.getElementById('modal-root').children.length) return;
  const tag = e.target.tagName;
  if (tag === 'TEXTAREA' || tag === 'SELECT' || (tag === 'INPUT' && !['checkbox', 'radio', 'range', 'color'].includes(e.target.type))) return;
  const ctrl = e.ctrlKey || e.metaKey;
  const key = e.key.toLowerCase();
  const fps = state.project.settings.fps;
  let handled = true;

  if (state.mode === 'motion') {
    // desfazer, salvar e importar valem nos dois modos; o resto é do workspace de motion
    if (ctrl && key === 'z' && !e.shiftKey) undo();
    else if (ctrl && (key === 'y' || (key === 'z' && e.shiftKey))) redo();
    else if (ctrl && key === 's') saveProject();
    else if (ctrl && key === 'i') importDialog();
    else if (!handleMotionKey(e)) return;
    e.preventDefault();
    return;
  }

  if (ctrl && key === 'z' && !e.shiftKey) undo();
  else if (ctrl && (key === 'y' || (key === 'z' && e.shiftKey))) redo();
  else if (ctrl && key === 's') saveProject();
  else if (ctrl && key === 'o') openProject();
  else if (ctrl && key === 'c') copySelected();
  else if (ctrl && key === 'x') { if (copySelected()) deleteSelected(); }
  else if (ctrl && key === 'v') paste();
  else if (ctrl && key === 'd') { if (copySelected()) paste(); }
  else if (ctrl && key === 'e') openExport();
  else if (ctrl && key === 'i') importDialog();
  else if (ctrl) handled = false;
  else if (key === ' ') togglePlay();
  else if (key === 's') splitAtPlayhead();
  else if (key === 't') addText();
  else if (key === 'delete' || key === 'backspace') deleteSelected(e.shiftKey);
  else if (key === 'arrowleft') seek(state.time - (e.shiftKey ? 1 : 1 / fps));
  else if (key === 'arrowright') seek(state.time + (e.shiftKey ? 1 : 1 / fps));
  else if (key === 'home') seek(0);
  else if (key === 'end') seek(projectDuration());
  else if (key === '+' || key === '=') zoomIn();
  else if (key === '-') zoomOut();
  else if (key === 'escape') { state.selection = null; emit('selection'); }
  else handled = false;

  if (handled) e.preventDefault();
});

// impede o navegador de abrir arquivos soltos fora das áreas de drop
window.addEventListener('dragover', (e) => e.preventDefault());
window.addEventListener('drop', (e) => e.preventDefault());

// marca alterações não salvas
subscribe((r) => { if (r === 'project') dirty = true; });
window.addEventListener('beforeunload', (e) => {
  if (dirty && state.project.clips.length) e.preventDefault();
});

emit('project');
dirty = false;

// gancho para testes automatizados (somente com ?test na URL)
if (new URLSearchParams(location.search).has('test')) {
  Promise.all([
    import('./state/project.js'), import('./state/keyframes.js'), import('./media/library.js'),
    import('./engine/exporter.js'), import('./ui/timeline.js'),
    import('./motion/model.js'), import('./motion/presets.js'), import('./motion/svgImport.js'), import('./ui/motion/actions.js'),
  ]).then(([project, keyframes, library, exporter, timeline, model, presets, svg, motionActions]) => {
    window.__mine = {
      ...project, ...keyframes, ...library, ...exporter, placeMedia: timeline.placeMedia, placeComp: timeline.placeComp, saveProject, openProject,
      motion: { ...model, ...presets, ...svg, ...motionActions },
    };
  });
}
