// Estado central do editor: projeto serializável + estado de UI + histórico.
import { splitKeyframes, shiftKeyframes } from './keyframes.js';

let idCounter = 0;
export const uid = (p = 'id') => `${p}${Date.now().toString(36)}${(idCounter++).toString(36)}`;

export function newProject() {
  return {
    settings: { width: 1920, height: 1080, fps: 30, background: '#000000' },
    media: [],
    comps: [], // composições de motion design (ver src/motion/model.js)
    tracks: [
      { id: uid('t'), kind: 'visual', name: 'Vídeo 1', hidden: false, muted: false, locked: false },
      { id: uid('t'), kind: 'audio', name: 'Áudio 1', hidden: false, muted: false, locked: false },
    ],
    clips: [],
  };
}

export const state = {
  project: newProject(),
  selection: null, // id do clipe selecionado
  time: 0,
  playing: false,
  zoom: 80, // pixels por segundo
  insertMode: false,
  autoKey: false,
  projectName: 'projeto',
  maskEdit: null, // máscara em edição no preview: { clipId, maskId, sel }
  mode: 'edit', // 'edit' (timeline principal) | 'motion' (workspace de composição)
  rev: 0, // sobe a cada alteração do projeto (para caches)
  exporting: false, // durante a exportação o preview fica parado
  motion: newMotionState(),
};

/** Estado de UI do workspace de motion (não serializado). */
export function newMotionState() {
  return { compId: null, selection: [], time: 0, playing: false, tool: 'select', zoom: 120, keySel: [], expanded: {} };
}

// ---------- eventos ----------
const listeners = new Set();
export function subscribe(fn) {
  listeners.add(fn);
  return () => listeners.delete(fn);
}
/**
 * reason: 'project' | 'time' | 'selection' | 'zoom' | 'play' | 'media' | 'mode' | 'extensions'
 *       | 'motion' (seleção/ferramenta/zoom do workspace de motion) | 'motion-time'
 */
export function emit(reason = 'project') {
  if (reason === 'project') state.rev++;
  for (const fn of listeners) fn(reason);
}

// ---------- histórico ----------
const undoStack = [];
const redoStack = [];
const MAX_HISTORY = 200;
const MAX_HISTORY_CHARS = 20_000_000; // ~40 MB (cada caractere ocupa 2 bytes): projetos grandes guardam menos passos
let undoChars = 0;
/** Mantém a pilha de desfazer dentro dos limites de quantidade e de memória (sempre sobra ao menos um passo). */
function trimHistory() {
  while (undoStack.length > 1 && (undoStack.length > MAX_HISTORY || undoChars > MAX_HISTORY_CHARS)) undoChars -= undoStack.shift().length;
}
/** Quantos passos de desfazer existem e quanto ocupam (para a tela de Desempenho e os testes). */
export const historyInfo = () => ({ steps: undoStack.length, chars: undoChars });

export function checkpoint() {
  pushHistory(JSON.stringify(state.project));
}
/** Registra no histórico uma fotografia (JSON) do projeto tirada antes de uma alteração. */
export function pushHistory(snapshot) {
  undoStack.push(snapshot);
  undoChars += snapshot.length;
  trimHistory();
  redoStack.length = 0;
}
export function undo() {
  if (!undoStack.length) return;
  redoStack.push(JSON.stringify(state.project));
  const snapshot = undoStack.pop();
  undoChars -= snapshot.length;
  state.project = JSON.parse(snapshot);
  fixSelection();
  emit('project');
}
export function redo() {
  if (!redoStack.length) return;
  const current = JSON.stringify(state.project);
  undoStack.push(current);
  undoChars += current.length;
  trimHistory();
  state.project = JSON.parse(redoStack.pop());
  fixSelection();
  emit('project');
}
export function resetHistory() {
  undoChars = 0;
  undoStack.length = 0;
  redoStack.length = 0;
}
function fixSelection() {
  if (state.selection && !getClip(state.selection)) state.selection = null;
  // o workspace de motion pode estar apontando para algo que o desfazer removeu
  const m = state.motion;
  const comp = state.project.comps?.find((c) => c.id === m.compId) || null;
  if (!comp) {
    m.compId = null;
    m.selection = [];
    m.keySel = [];
    if (state.mode === 'motion') {
      state.mode = 'edit';
      emit('mode');
    }
    return;
  }
  m.selection = m.selection.filter((id) => comp.layers.some((l) => l.id === id));
  m.keySel = [];
}

// ---------- consultas ----------
export const getClip = (id) => state.project.clips.find((c) => c.id === id) || null;
export const getTrack = (id) => state.project.tracks.find((t) => t.id === id) || null;
export const getMedia = (id) => state.project.media.find((m) => m.id === id) || null;
export const clipsOnTrack = (trackId) =>
  state.project.clips.filter((c) => c.trackId === trackId).sort((a, b) => a.start - b.start);
export const clipEnd = (c) => c.start + c.duration;
export const trackKindFor = (clipType) => (clipType === 'audio' ? 'audio' : 'visual');

export function projectDuration(project = state.project) {
  let d = 0;
  for (const c of project.clips) d = Math.max(d, c.start + c.duration);
  return d;
}

/** Tracks ordenadas para exibição: visuais primeiro, depois áudio (mantendo ordem relativa). */
export function orderedTracks(project = state.project) {
  return [
    ...project.tracks.filter((t) => t.kind === 'visual'),
    ...project.tracks.filter((t) => t.kind === 'audio'),
  ];
}

export function selectedClip() {
  return state.selection ? getClip(state.selection) : null;
}

/** Tempo local (relativo ao clipe) do playhead, limitado à duração do clipe. */
export function localTime(clip, t = state.time) {
  return Math.min(Math.max(t - clip.start, 0), clip.duration);
}

export function overlaps(trackId, start, end, ignoreId) {
  return state.project.clips.some(
    (c) => c.trackId === trackId && c.id !== ignoreId && c.start < end - 1e-6 && c.start + c.duration > start + 1e-6,
  );
}

// ---------- tracks ----------
export function addTrack(kind) {
  const n = state.project.tracks.filter((t) => t.kind === kind).length + 1;
  const track = {
    id: uid('t'),
    kind,
    name: `${kind === 'visual' ? 'Vídeo' : 'Áudio'} ${n}`,
    hidden: false,
    muted: false,
    locked: false,
  };
  // novas tracks visuais entram no topo (camada da frente); áudio entra no fim
  if (kind === 'visual') state.project.tracks.unshift(track);
  else state.project.tracks.push(track);
  return track;
}

export function removeTrack(id) {
  state.project.tracks = state.project.tracks.filter((t) => t.id !== id);
  state.project.clips = state.project.clips.filter((c) => c.trackId !== id);
  fixSelection();
}

/** Move a track uma posição para cima (-1) ou para baixo (+1) entre as tracks do mesmo tipo. */
export function moveTrack(id, dir) {
  const tracks = state.project.tracks;
  const track = getTrack(id);
  const same = tracks.filter((t) => t.kind === track.kind);
  const i = same.indexOf(track);
  const j = i + dir;
  if (j < 0 || j >= same.length) return;
  const a = tracks.indexOf(same[i]);
  const b = tracks.indexOf(same[j]);
  [tracks[a], tracks[b]] = [tracks[b], tracks[a]];
}

// ---------- clipes ----------
export function defaultVisualProps(srcW, srcH) {
  const { width: W, height: H } = state.project.settings;
  const s = Math.min(W / srcW, H / srcH);
  const w = Math.round(srcW * s);
  const h = Math.round(srcH * s);
  return { x: Math.round((W - w) / 2), y: Math.round((H - h) / 2), width: w, height: h, rotation: 0, opacity: 1, volume: 1 };
}

export function createClipFromMedia(media, trackId, start) {
  const type = media.type;
  const props =
    type === 'audio'
      ? { x: 0, y: 0, width: 0, height: 0, rotation: 0, opacity: 1, volume: 1 }
      : defaultVisualProps(media.width || 1280, media.height || 720);
  const clip = {
    id: uid('c'),
    trackId,
    mediaId: media.id,
    type,
    name: media.name,
    start,
    duration: type === 'image' ? 5 : media.duration || 5,
    inPoint: 0,
    audioDetached: false,
    props,
    keyframes: {},
  };
  state.project.clips.push(clip);
  return clip;
}

/** Clipe que exibe uma composição de motion na timeline principal. */
export function createCompClip(comp, trackId, start) {
  const clip = {
    id: uid('c'),
    trackId,
    mediaId: null,
    compId: comp.id,
    type: 'comp',
    name: comp.name,
    start,
    duration: comp.duration,
    inPoint: 0,
    props: defaultVisualProps(comp.width, comp.height),
    keyframes: {},
  };
  state.project.clips.push(clip);
  return clip;
}

export function createTextClip(trackId, start, text = 'Seu texto') {
  const { width: W, height: H } = state.project.settings;
  const fontSize = Math.round(H / 10);
  const clip = {
    id: uid('c'),
    trackId,
    mediaId: null,
    type: 'text',
    name: 'Texto',
    start,
    duration: 5,
    inPoint: 0,
    text,
    font: { family: 'Inter, Arial, sans-serif', size: fontSize, color: '#ffffff', bold: true, italic: false, align: 'center', stroke: '#000000', strokeWidth: 0 },
    props: { x: 0, y: 0, width: 0, height: 0, rotation: 0, opacity: 1, volume: 1 },
    keyframes: {},
  };
  let { w, h } = measureText(clip);
  // não deixa o texto padrão passar de 90% da largura do quadro
  if (w > W * 0.9) {
    clip.font.size = Math.max(8, Math.floor((clip.font.size * W * 0.9) / w));
    ({ w, h } = measureText(clip));
  }
  Object.assign(clip.props, { width: Math.round(w), height: Math.round(h), x: Math.round((W - w) / 2), y: Math.round((H - h) / 2) });
  state.project.clips.push(clip);
  return clip;
}

let measureCtx;
export function fontString(font) {
  return `${font.italic ? 'italic ' : ''}${font.bold ? 'bold ' : ''}${font.size}px ${font.family}`;
}
/** Linhas do texto como são desenhadas (com a opção de maiúsculas aplicada). */
export function textLines(item) {
  const text = String(item.text || ' ');
  return (item.font?.upper ? text.toLocaleUpperCase() : text).split('\n');
}

/**
 * Margem em volta das letras: respiro, contornos e caixa de fundo.
 * (A sombra pode passar da caixa, como a sombra de qualquer elemento.)
 */
export function textPad(font) {
  return font.size * 0.2 + (font.strokeWidth || 0) + (font.stroke2Width || 0) + (font.bg ? font.bgPad || 0 : 0);
}

/** Tamanho natural (sem escala) do texto do clipe. */
export function measureText(clip) {
  measureCtx ||= document.createElement('canvas').getContext('2d');
  const f = clip.font;
  measureCtx.font = fontString(f);
  measureCtx.letterSpacing = `${f.letterSpacing || 0}px`;
  const lines = textLines(clip);
  const lineH = f.size * (f.lineHeight || 1.2);
  let w = 0;
  // o espaçamento entra depois de cada letra, inclusive da última: não conta essa sobra
  for (const l of lines) w = Math.max(w, measureCtx.measureText(l || ' ').width - (l ? f.letterSpacing || 0 : 0));
  const pad = textPad(f);
  return { w: Math.max(1, w + pad * 2), h: Math.max(1, lines.length * lineH + pad * 2), lineH, pad, lines };
}

export function removeClip(id) {
  state.project.clips = state.project.clips.filter((c) => c.id !== id);
  fixSelection();
}

/** Divide o clipe no tempo absoluto t. Retorna o novo clipe (parte direita) ou null. */
export function splitClip(clip, t) {
  const local = t - clip.start;
  if (local <= 0.01 || local >= clip.duration - 0.01) return null;
  const right = JSON.parse(JSON.stringify(clip));
  right.id = uid('c');
  delete right.transition;
  // preserva a animação na fronteira do corte (do clipe e dos seus efeitos e máscaras)
  const leftParts = animatedParts(clip);
  const rightParts = animatedParts(right);
  leftParts.forEach((part, i) => {
    splitKeyframes(part, rightParts[i], local);
    shiftKeyframes(rightParts[i], -local);
  });
  // efeitos e máscaras da metade direita são objetos novos
  for (const part of rightParts.slice(1)) part.id = uid(part.shape ? 'mk' : 'fx');
  // a entrada fica com a primeira metade e a saída com a segunda (o corte não ganha animação)
  delete clip.animOut;
  delete right.animIn;
  if (clip.textAnim) {
    clip.textAnim = { ...clip.textAnim, out: null };
    right.textAnim = { ...right.textAnim, in: null };
  }
  right.start = t;
  right.inPoint = clip.inPoint + local;
  right.duration = clip.duration - local;
  clip.duration = local;
  state.project.clips.push(right);
  return right;
}

/** Tudo no clipe que tem keyframes próprios: o clipe, seus efeitos e suas máscaras. */
export function animatedParts(clip) {
  return [clip, ...(clip.effects || []), ...(clip.masks || [])];
}

/** Fotografia dos keyframes do clipe e das suas partes (para restaurar durante um arrasto). */
export const snapshotKeyframes = (clip) => JSON.stringify(animatedParts(clip).map((part) => part.keyframes || {}));

/** Restaura a fotografia e desloca tudo por dt. */
export function restoreKeyframes(clip, snapshot, dt = 0) {
  const list = JSON.parse(snapshot);
  animatedParts(clip).forEach((part, i) => {
    part.keyframes = list[i] || {};
    if (dt) shiftKeyframes(part, dt);
  });
}

/** Remove o clipe da sua posição fechando o buraco (ripple) na track de origem. */
export function rippleRemove(clip) {
  const after = clipsOnTrack(clip.trackId).filter((c) => c.id !== clip.id && c.start >= clip.start + clip.duration - 1e-6);
  for (const c of after) c.start -= clip.duration;
}

/** Insere o clipe na track no tempo t empurrando os clipes seguintes. */
export function rippleInsert(clip, trackId, t) {
  const others = clipsOnTrack(trackId).filter((c) => c.id !== clip.id);
  t = insertionTime(trackId, t, clip.id);
  for (const c of others) if (c.start >= t - 1e-6) c.start += clip.duration;
  clip.trackId = trackId;
  clip.start = t;
}

/** Ponto de inserção: se t cai no meio de um clipe, vai para a borda mais próxima dele. */
export function insertionTime(trackId, t, ignoreId) {
  for (const c of clipsOnTrack(trackId)) {
    if (c.id === ignoreId) continue;
    if (t > c.start && t < c.start + c.duration) return t - c.start < c.duration / 2 ? c.start : c.start + c.duration;
  }
  return Math.max(0, t);
}

/** Primeira posição livre >= t numa track para um clipe de duração d. */
export function findFreeSlot(trackId, t, d, ignoreId) {
  let start = Math.max(0, t);
  for (const c of clipsOnTrack(trackId)) {
    if (c.id === ignoreId) continue;
    if (c.start < start + d - 1e-6 && c.start + c.duration > start + 1e-6) start = c.start + c.duration;
  }
  return start;
}

// ---------- serialização ----------
export function serializeProject() {
  return JSON.stringify({ app: 'CorteSeco Studio', version: 1, project: state.project }, null, 2);
}

export function loadProject(json) {
  const data = typeof json === 'string' ? JSON.parse(json) : json;
  if (!data || !data.project || !Array.isArray(data.project.clips)) throw new Error('Arquivo de projeto inválido');
  state.project = data.project;
  state.project.comps ||= []; // projetos salvos antes do módulo de motion
  state.maskEdit = null;
  state.selection = null;
  state.time = 0;
  state.mode = 'edit';
  state.motion = newMotionState();
  resetHistory();
  emit('project');
}
