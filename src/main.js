import './styles.css';
import {
  state, emit, checkpoint, undo, redo, getClip, getTrack, orderedTracks, overlaps, addTrack, createTextClip,
  findFreeSlot, serializeProject, loadProject, newProject, newMotionState, resetHistory, uid, projectDuration, subscribe,
  setFileExtras,
} from './state/project.js';
import { attachPath, clearRuntime, isMissing } from './media/library.js';
import { togglePlay, pause, seek, releaseAll } from './engine/player.js';
import { saveFile, openFile, isDesktop } from './platform/index.js';
import {
  initTimeline, splitAtPlayhead, deleteSelected, zoomIn, zoomOut, zoomToFit, setTool, getTool, toggleSnap, trimToPlayhead, jumpToEdit,
} from './ui/timeline.js';
import { openShortcuts } from './ui/shortcuts.js';
import { initPreview } from './ui/preview.js';
import { initInspector } from './ui/inspector.js';
import { initMediaPanel, importDialog } from './ui/mediaPanel.js';
import { openSettings, openExport, openMissingMedia, openNewComp } from './ui/dialogs.js';
import { initMotion, enterMotion, exitMotion, handleMotionKey } from './ui/motion/workspace.js';
import { maskKey } from './ui/maskEditor.js';
import { openExtensions, installFromFile, isExtensionFile } from './ui/extensions.js';
import { initAiBridge } from './mcp/bridge.js';
import { initAiPanel, openAiPanel } from './ui/aiPanel.js';
import { embedUsedExtensions, onExtensionsChange } from './fx/registry.js';
import { toast } from './ui/util.js';
import { initLayout } from './ui/layout.js';
import { openPerformance } from './ui/performance.js';
import { initProxies } from './media/proxy.js';
import { setSoftwareRendering } from './ui/preview.js';
import { glRenderer, isSoftwareRenderer } from './fx/gl.js';
import { applyIcons } from './ui/icons.js';
import { initFonts, loadPackedFonts, packFonts } from './fonts.js';

applyIcons();
initLayout();
initMediaPanel(document.getElementById('media-panel'));
initPreview();
initInspector(document.getElementById('inspector'));
initTimeline(document.getElementById('timeline'));
initMotion();
initAiBridge();
initAiPanel();
initProxies();
// fontes instaladas no app: carregam em segundo plano e os textos são redesenhados quando chegam
setFileExtras((project) => {
  const fonts = packFonts(project);
  return fonts.length ? { fonts } : {};
});
initFonts().then(() => emit('project'));
// sem placa de vídeo, a qualidade automática do preview cai pela metade (verificado com a máquina ociosa)
(window.requestIdleCallback || setTimeout)(() => setSoftwareRendering(isSoftwareRenderer(glRenderer())));

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
  extensions: () => openExtensions(),
  ai: openAiPanel,
  performance: openPerformance,
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
  // o projeto leva uma cópia das extensões que usa, para abrir em outra máquina
  embedUsedExtensions();
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
    // as fontes embutidas precisam estar carregadas antes de medir/desenhar os textos
    await loadPackedFonts(data.fonts);
    loadProject(data);
  } catch (err) {
    return toast('Não foi possível abrir o projeto: ' + err.message, 'error');
  }
  state.projectName = file.name.replace(/\.json$/i, '');
  dirty = false;

  // recarrega as mídias pelos caminhos salvos (desktop)
  for (const media of state.project.media) {
    try {
      if (media.path) await attachPath(media, media.path);
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

  if (e.key === '?' || (ctrl && key === '/')) {
    openShortcuts();
    e.preventDefault();
    return;
  }

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

  if (!ctrl && state.maskEdit && maskKey(e, state.selection ? getClip(state.selection) : null)) {
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
  else if (ctrl && key === 'b') splitAtPlayhead();
  else if (ctrl && (key === '=' || key === '+')) zoomIn();
  else if (ctrl && key === '-') zoomOut();
  else if (ctrl) handled = false;
  else if (e.altKey) handled = false;
  else if (key === ' ') togglePlay();
  else if (key === 's') splitAtPlayhead();
  else if (key === 'a') setTool('select');
  else if (key === 'b') setTool('blade');
  else if (key === 'q') trimToPlayhead('left');
  else if (key === 'w') trimToPlayhead('right');
  else if (key === 'n') toggleSnap();
  else if (key === 'z' && e.shiftKey) zoomToFit();
  else if (key === 'arrowup') jumpToEdit(-1);
  else if (key === 'arrowdown') jumpToEdit(1);
  else if (key === 't') addText();
  else if (key === 'delete' || key === 'backspace') deleteSelected(e.shiftKey);
  else if (key === 'arrowleft') seek(state.time - (e.shiftKey ? 1 : 1 / fps));
  else if (key === 'arrowright') seek(state.time + (e.shiftKey ? 1 : 1 / fps));
  else if (key === 'home') seek(0);
  else if (key === 'end') seek(projectDuration());
  else if (key === '+' || key === '=') zoomIn();
  else if (key === '-') zoomOut();
  else if (key === 'escape') {
    if (getTool() !== 'select') setTool('select');
    else { state.selection = null; emit('selection'); }
  }
  else handled = false;

  if (handled) e.preventDefault();
});

// instalar ou remover uma extensão muda as listas de efeitos e transições dos inspectors
onExtensionsChange(() => emit('extensions'));

// arquivos de extensão (.csfx.json, .glsl) soltos em qualquer lugar da janela abrem a tela de instalação
window.addEventListener('drop', (e) => {
  const files = [...(e.dataTransfer?.files || [])].filter((f) => isExtensionFile(f.name));
  if (!files.length) return;
  e.preventDefault();
  e.stopPropagation();
  for (const file of files) installFromFile(file);
}, true);

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
    import('./fx/registry.js'), import('./fx/mask.js'), import('./fx/gl.js'), import('./fx/shader.js'),
    import('./mcp/tools.js'), import('./perf.js'), import('./engine/player.js'), import('./prefs.js'), import('./ui/preview.js'), import('./ui/layout.js'),
  ]).then(([project, keyframes, library, exporter, timeline, model, presets, svg, motionActions, fxRegistry, fxMask, fxGl, fxShader, mcpTools, perfMod, player, prefs, preview, layoutMod]) => {
    window.__mine = {
      ...project, ...keyframes, ...library, ...exporter, placeMedia: timeline.placeMedia, placeComp: timeline.placeComp, saveProject, openProject,
      motion: { ...model, ...presets, ...svg, ...motionActions },
      undo, redo,
      fx: { ...fxRegistry, ...fxMask, ...fxGl, ...fxShader, openExtensions, installFromFile },
      mcp: mcpTools,
      perf: perfMod,
      player,
      prefs,
      preview,
      layout: layoutMod,
    };
  });
}
