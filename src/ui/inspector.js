// Inspector: propriedades do clipe selecionado, keyframes por propriedade e opções de texto/áudio.
import {
  state, emit, subscribe, checkpoint, selectedClip, getMedia, getTrack, localTime, measureText,
  orderedTracks, overlaps, addTrack, uid, clipsOnTrack, projectDuration,
} from '../state/project.js';
import { valueAt, setProp, setKeyframe, removeKeyframe, keyframeAt, hasKeyframes, EASINGS, KF_PROPS } from '../state/keyframes.js';
import { seek } from '../engine/player.js';
import { SLIDE_DIRECTIONS } from '../engine/compositor.js';
import { h, clamp, formatTime, formatDuration } from './util.js';
import { getComp } from '../motion/model.js';
import { openComp } from './motion/actions.js';
import { fxKey, effectsSection, masksSection, transitionParamRows } from './fxPanel.js';
import { textStyleRows, textAnimSection } from './textStyle.js';
import { transitionOptions, animOptions, transitionExtId, getExtension } from '../fx/registry.js';
import { icon } from './icons.js';
import { timed } from '../perf.js';

let root;
let builtKey = null;
let bindings = [];
let lastTimeRefresh = 0;
let editing = false; // já criou checkpoint para a edição atual

const FONTS = [
  ['Inter, Arial, sans-serif', 'Sans (Inter/Arial)'],
  ['Georgia, "Times New Roman", serif', 'Serif (Georgia)'],
  ['"Courier New", monospace', 'Mono (Courier)'],
  ['Impact, "Arial Black", sans-serif', 'Impact'],
  ['"Comic Sans MS", cursive', 'Comic'],
  ['Verdana, sans-serif', 'Verdana'],
  ['"Trebuchet MS", sans-serif', 'Trebuchet'],
];

export function initInspector(el) {
  root = el;
  subscribe((reason) => {
    if (reason === 'play' || reason.startsWith('motion') || state.mode !== 'edit') return;
    // tocando, os campos acompanham o playhead umas 10 vezes por segundo (não a cada quadro)
    if (reason === 'time' && state.playing) {
      const now = performance.now();
      if (now - lastTimeRefresh < 100) return;
      lastTimeRefresh = now;
    }
    timed('inspector', () => {
      const key = keyFor();
      if (key !== builtKey) build();
      else refresh();
    });
  });
  build();
}

function keyFor() {
  const clip = selectedClip();
  if (!clip) return 'none:' + JSON.stringify(state.project.settings);
  const media = getMedia(clip.mediaId);
  const comp = clip.type === 'comp' ? getComp(clip.compId) : null;
  return `${clip.id}:${clip.type}:${!!media?.hasAudio}:${!!clip.audioDetached}:${comp ? `${comp.name}/${comp.width}x${comp.height}/${comp.duration}` : ''}:${fxKey(clip)}`;
}

/** Cria checkpoint uma única vez por edição contínua (até o input perder o foco). */
function beginEdit() {
  if (!editing) {
    checkpoint();
    editing = true;
  }
}
function endEdit() {
  editing = false;
}

function build() {
  builtKey = keyFor();
  bindings = [];
  const clip = selectedClip();
  root.replaceChildren(...(clip ? clipPanel(clip) : projectPanel()));
  refresh();
}

function refresh() {
  for (const b of bindings) b();
}

// ---------------------------------------------------------------- sem seleção
function projectPanel() {
  const s = state.project.settings;
  return [
    h('h3', {}, 'Projeto'),
    h('div.insp-section', {},
      h('div.insp-note', {}, `Dimensões: ${s.width}×${s.height} px · ${s.fps} fps`),
      h('div.insp-note', {}, `Duração: ${formatDuration(projectDuration())} · ${state.project.tracks.length} tracks · ${state.project.clips.length} clipes`),
    ),
    h('h3', {}, 'Como usar'),
    h('div.insp-note', {},
      'Importe mídias em ', h('b', {}, 'Mídia'), ' e arraste-as para a timeline. Selecione um clipe para editar posição, tamanho, opacidade e volume. ',
      'O botão ◆ ao lado de cada propriedade grava um keyframe no tempo do playhead; com keyframes, qualquer alteração cria/atualiza o keyframe automaticamente.',
    ),
    h('div.insp-note', {},
      h('kbd', {}, 'Espaço'), ' play · ', h('kbd', {}, 'S'), ' dividir · ', h('kbd', {}, 'Del'), ' excluir · ', h('kbd', {}, 'Shift+Del'), ' excluir e fechar buraco · ',
      h('kbd', {}, '←/→'), ' frame · ', h('kbd', {}, 'Ctrl+C/V'), ' copiar/colar · ', h('kbd', {}, 'Ctrl+Z'), ' desfazer · ', h('kbd', {}, 'Ctrl+roda'), ' zoom · ',
      h('kbd', {}, 'Alt'), ' + arrastar clipe = reordenar empurrando os outros.',
    ),
    h('div.insp-note', {},
      h('kbd', {}, 'B'), ' ferramenta de corte · ', h('kbd', {}, 'A'), ' seleção · ', h('kbd', {}, 'Q'), '/', h('kbd', {}, 'W'), ' apagar antes/depois do playhead · ',
      h('kbd', {}, '↑/↓'), ' cortes · ', h('kbd', {}, '?'), ' todos os atalhos.',
    ),
  ];
}

// ---------------------------------------------------------------- clipe
function clipPanel(clip) {
  const media = getMedia(clip.mediaId);
  const isVisual = clip.type !== 'audio';
  const hasAudio = clip.type === 'audio' || (clip.type === 'video' && media?.hasAudio && !clip.audioDetached);
  const typeName = { video: 'Vídeo', audio: 'Áudio', image: 'Imagem', text: 'Texto', comp: 'Composição' }[clip.type];
  const out = [];

  const autoKey = h('input', { type: 'checkbox', checked: state.autoKey, on: { change: (e) => { state.autoKey = e.target.checked; } } });
  out.push(h('h3', {}, h('span.grow', {}, typeName), h('label.toggle-row', { title: 'Grava keyframe em qualquer alteração, mesmo sem keyframes existentes', style: { padding: 0 } }, autoKey, 'Auto-keyframe')));

  // informações do clipe
  const sec = h('div.insp-section');
  sec.append(row('Nome', h('input', {
    type: 'text', value: clip.name || '',
    on: { focus: beginEdit, blur: endEdit, input: (e) => { clip.name = e.target.value; emit('project'); } },
  })));
  sec.append(timeRow(clip, 'Início', 'start'));
  sec.append(timeRow(clip, 'Duração', 'duration'));
  if (clip.type === 'video' || clip.type === 'audio') {
    const info = h('span.insp-note', { style: { padding: 0 } });
    bindings.push(() => { info.textContent = `${formatTime(clip.inPoint)} de ${formatTime(media?.duration || 0)}`; });
    sec.append(row('Corte', info));
  }
  const outside = h('div.insp-note', { style: { color: '#ffb84d' } }, 'O playhead está fora deste clipe: keyframes serão gravados na borda.');
  bindings.push(() => {
    const t = state.time;
    outside.style.display = t < clip.start || t > clip.start + clip.duration ? '' : 'none';
  });
  sec.append(outside);
  out.push(sec);

  if (isVisual) {
    out.push(h('h3', {}, 'Transformação'));
    const tr = h('div.insp-section');
    tr.append(
      propRow(clip, 'X', 'x', { step: 1, unit: 'px' }),
      propRow(clip, 'Y', 'y', { step: 1, unit: 'px' }),
      propRow(clip, 'Largura', 'width', { step: 1, unit: 'px', min: 1 }),
      propRow(clip, 'Altura', 'height', { step: 1, unit: 'px', min: 1 }),
      propRow(clip, 'Rotação', 'rotation', { step: 1, unit: '°' }),
      propRow(clip, 'Opacidade', 'opacity', { step: 1, scale: 100, min: 0, max: 100, unit: '%', slider: true }),
    );
    const fit = (mode) => () => applyFit(clip, mode);
    tr.append(h('div.insp-actions', {},
      h('button', { on: { click: fit('contain') }, title: 'Caber inteiro no quadro' }, 'Conter'),
      h('button', { on: { click: fit('cover') }, title: 'Cobrir o quadro inteiro' }, 'Cobrir'),
      h('button', { on: { click: fit('fill') }, title: 'Esticar até o quadro' }, 'Esticar'),
      h('button', { on: { click: fit('center') } }, 'Centralizar'),
      clip.type !== 'text' ? h('button', { on: { click: fit('original') }, title: 'Tamanho original da mídia' }, '1:1') : null,
    ));
    out.push(tr);
  }

  if (isVisual) {
    const env = {
      bindings, beginEdit, endEdit,
      getTime: () => localTime(clip),
      seek: (t) => seek(clip.start + t),
      locked: () => !!getTrack(clip.trackId)?.locked,
    };
    out.push(h('h3', {}, 'Efeitos'), effectsSection(clip, env));
    out.push(h('h3', {}, 'Máscaras'), masksSection(clip, env));
  }

  if (isVisual) {
    out.push(h('h3', {}, 'Entrada'), effectSection(clip, 'animIn'));
    out.push(h('h3', {}, 'Saída'), effectSection(clip, 'animOut'));
    out.push(h('h3', {}, 'Transição com a cena anterior'), effectSection(clip, 'transition'));
  }

  if (clip.type === 'text') {
    out.push(h('h3', {}, 'Texto'), textSection(clip));
    out.push(h('h3', {}, 'Animação do texto'), textAnimSection(clip, { beginEdit, endEdit, span: () => clip.duration }));
  }
  if (clip.type === 'comp') {
    const comp = getComp(clip.compId);
    out.push(h('h3', {}, 'Motion'), h('div.insp-section', {},
      h('div.insp-note', {}, comp
        ? `Este clipe mostra a composição "${comp.name}" (${comp.width}×${comp.height}, ${formatDuration(comp.duration)}). Depois do fim dela, o último frame fica congelado.`
        : 'A composição deste clipe não existe mais.'),
      comp ? h('div.insp-actions', {}, h('button.primary', { title: 'Abre o workspace de motion (ou duplo clique no clipe)', on: { click: () => openComp(comp.id) } }, 'Editar composição')) : null,
    ));
  }

  if (hasAudio) {
    out.push(h('h3', {}, 'Áudio'));
    const au = h('div.insp-section');
    au.append(propRow(clip, 'Volume', 'volume', { step: 1, scale: 100, min: 0, max: 200, unit: '%', slider: true }));
    if (clip.type === 'video') {
      au.append(h('div.insp-actions', {}, h('button', { on: { click: () => detachAudio(clip) }, title: 'Cria um clipe de áudio independente numa track de áudio' }, 'Desvincular áudio')));
    }
    out.push(au);
  } else if (clip.type === 'video' && clip.audioDetached) {
    out.push(h('h3', {}, 'Áudio'), h('div.insp-section', {},
      h('div.insp-note', {}, 'O áudio deste vídeo foi desvinculado para uma track de áudio.'),
      h('div.insp-actions', {}, h('button', { on: { click: () => { checkpoint(); clip.audioDetached = false; emit('project'); } } }, 'Reativar áudio no vídeo')),
    ));
  }

  out.push(h('h3', {}, 'Keyframe no playhead'), easingSection(clip));
  return out;
}

function row(label, ...ctrl) {
  return h('div.insp-row', {}, h('label', {}, label), h('div.ctrl', {}, ...ctrl), h('span'));
}

function timeRow(clip, label, key) {
  const input = h('input', {
    type: 'number', step: 0.01, min: key === 'duration' ? 0.04 : 0,
    on: {
      focus: beginEdit, blur: endEdit,
      change: (e) => {
        beginEdit();
        let v = Math.max(0, Number(e.target.value) || 0);
        if (key === 'duration') {
          const media = getMedia(clip.mediaId);
          const max = clip.type === 'video' || clip.type === 'audio' ? (media?.duration || Infinity) - clip.inPoint : Infinity;
          v = clamp(v, 1 / state.project.settings.fps, max);
          const next = clipsOnTrack(clip.trackId).find((c) => c.id !== clip.id && c.start >= clip.start);
          if (next) v = Math.min(v, next.start - clip.start);
        } else if (overlaps(clip.trackId, v, v + clip.duration, clip.id)) {
          e.target.value = clip[key].toFixed(2);
          return;
        }
        clip[key] = v;
        emit('project');
      },
    },
  });
  bindings.push(() => { if (document.activeElement !== input) input.value = clip[key].toFixed(2); });
  return h('div.insp-row', {}, h('label', {}, label), h('div.ctrl', {}, input, h('span.insp-note', { style: { padding: 0 } }, 's')), h('span'));
}

function propRow(clip, label, prop, { step = 1, scale = 1, min = -Infinity, max = Infinity, unit = '', slider = false } = {}) {
  const apply = (raw) => {
    const v = clamp(Number(raw), min, max);
    if (!Number.isFinite(v)) return;
    beginEdit();
    setProp(clip, prop, v / scale, localTime(clip), state.autoKey);
    emit('project');
  };
  const num = h('input', { type: 'number', step, on: { focus: beginEdit, blur: endEdit, input: (e) => e.target.value !== '' && apply(e.target.value) } });
  const range = slider
    ? h('input', { type: 'range', min, max, step, on: { pointerdown: beginEdit, pointerup: endEdit, input: (e) => apply(e.target.value) } })
    : null;
  if (range) num.classList.add('small');

  const kfBtn = h('button.kf-btn', {
    title: 'Adicionar/remover keyframe no playhead',
    on: {
      click: () => {
        checkpoint();
        const t = localTime(clip);
        if (keyframeAt(clip, prop, t)) removeKeyframe(clip, prop, t);
        else setKeyframe(clip, prop, t, valueAt(clip, prop, t));
        emit('project');
      },
    },
  });
  kfBtn.innerHTML = icon('keyframe');
  const nav = (dir) => {
    const b = h('button.kf-nav', {
    title: dir < 0 ? 'Keyframe anterior' : 'Próximo keyframe',
    on: {
      click: () => {
        const t = state.time - clip.start;
        const list = clip.keyframes?.[prop] || [];
        const k = dir < 0 ? [...list].reverse().find((k) => k.t < t - 1e-4) : list.find((k) => k.t > t + 1e-4);
        if (k) seek(clip.start + k.t);
      },
    },
  });
    b.innerHTML = icon(dir < 0 ? 'prev' : 'next');
    return b;
  };
  const prev = nav(-1);
  const next = nav(1);

  bindings.push(() => {
    const t = localTime(clip);
    const v = valueAt(clip, prop, t) * scale;
    const shown = Math.round(v * 100) / 100;
    if (document.activeElement !== num) num.value = shown;
    if (range && document.activeElement !== range) range.value = shown;
    const has = hasKeyframes(clip, prop);
    kfBtn.classList.toggle('has', has);
    kfBtn.classList.toggle('on', !!keyframeAt(clip, prop, t));
    prev.disabled = next.disabled = !has;
  });
  return h('div.insp-row', {}, h('label', { title: unit }, label), h('div.ctrl', {}, range, num), h('div.kf-ctrls', {}, prev, kfBtn, next));
}

function applyFit(clip, mode) {
  checkpoint();
  const { width: W, height: H } = state.project.settings;
  const t = localTime(clip);
  const media = getMedia(clip.mediaId);
  const cur = { width: valueAt(clip, 'width', t), height: valueAt(clip, 'height', t) };
  const comp = clip.type === 'comp' ? getComp(clip.compId) : null;
  const srcW = comp?.width || media?.width || cur.width;
  const srcH = comp?.height || media?.height || cur.height;
  let w = cur.width;
  let hgt = cur.height;
  if (mode === 'contain' || mode === 'cover') {
    const ratio = clip.type === 'text' ? cur.width / cur.height : srcW / srcH; // composição usa a própria proporção
    const fitW = mode === 'contain' ? W / ratio <= H : W / ratio >= H;
    w = fitW ? W : H * ratio;
    hgt = fitW ? W / ratio : H;
  } else if (mode === 'fill') {
    w = W;
    hgt = H;
  } else if (mode === 'original') {
    w = srcW;
    hgt = srcH;
  }
  const set = (p, v) => setProp(clip, p, Math.round(v), t, state.autoKey);
  set('width', w);
  set('height', hgt);
  set('x', (W - w) / 2);
  set('y', (H - hgt) / 2);
  emit('project');
}

function textSection(clip) {
  const sec = h('div.insp-section');
  const f = clip.font;
  // mudanças de texto/fonte mantêm a escala e o centro atuais
  const restyle = (fn) => {
    beginEdit();
    const before = measureText(clip);
    fn();
    const after = measureText(clip);
    if (!hasKeyframes(clip, 'width') && !hasKeyframes(clip, 'height')) {
      const s = clip.props.height / before.h;
      const cx = clip.props.x + clip.props.width / 2;
      const cy = clip.props.y + clip.props.height / 2;
      clip.props.width = Math.round(after.w * s);
      clip.props.height = Math.round(after.h * s);
      if (!hasKeyframes(clip, 'x')) clip.props.x = Math.round(cx - clip.props.width / 2);
      if (!hasKeyframes(clip, 'y')) clip.props.y = Math.round(cy - clip.props.height / 2);
    }
    emit('project');
  };
  const ta = h('textarea.text-input', { value: clip.text, on: { focus: beginEdit, blur: endEdit, input: (e) => restyle(() => { clip.text = e.target.value; }) } });
  sec.append(ta);
  const fontSel = h('select', { on: { change: (e) => { restyle(() => { f.family = e.target.value; }); endEdit(); } } },
    ...FONTS.map(([v, n]) => h('option', { value: v, selected: v === f.family }, n)));
  sec.append(row('Fonte', fontSel));
  sec.append(row('Tamanho', h('input', { type: 'number', min: 4, step: 1, value: f.size, on: { focus: beginEdit, blur: endEdit, input: (e) => Number(e.target.value) > 0 && restyle(() => { f.size = Number(e.target.value); }) } })));
  sec.append(row('Cor', h('input', { type: 'color', value: f.color, on: { focus: beginEdit, blur: endEdit, input: (e) => { beginEdit(); f.color = e.target.value; emit('project'); } } }),
    h('button' + (f.bold ? '.active' : ''), { on: { click: (e) => { restyle(() => { f.bold = !f.bold; }); endEdit(); e.currentTarget.classList.toggle('active', f.bold); } } }, h('b', {}, 'N')),
    h('button' + (f.italic ? '.active' : ''), { on: { click: (e) => { restyle(() => { f.italic = !f.italic; }); endEdit(); e.currentTarget.classList.toggle('active', f.italic); } } }, h('i', {}, 'I')),
  ));
  sec.append(row('Alinhar', h('select', { on: { change: (e) => { beginEdit(); f.align = e.target.value; endEdit(); emit('project'); } } },
    ...[['left', 'Esquerda'], ['center', 'Centro'], ['right', 'Direita']].map(([v, n]) => h('option', { value: v, selected: v === f.align }, n)))));
  sec.append(...textStyleRows(clip, { restyle, beginEdit, endEdit }));
  return sec;
}

function easingSection(clip) {
  const sec = h('div.insp-section');
  const names = { linear: 'Linear', ease: 'Suave (ease in/out)', hold: 'Constante (salto)' };
  const sel = h('select', {
    on: {
      change: (e) => {
        checkpoint();
        const t = localTime(clip);
        for (const p of KF_PROPS) {
          const k = keyframeAt(clip, p, t);
          if (k) k.ease = e.target.value;
        }
        emit('project');
      },
    },
  }, ...EASINGS.map((v) => h('option', { value: v }, names[v])));
  const note = h('div.insp-note');
  const r = row('Transição', sel);
  bindings.push(() => {
    const t = localTime(clip);
    const k = KF_PROPS.map((p) => keyframeAt(clip, p, t)).find(Boolean);
    r.style.display = k ? '' : 'none';
    if (k && document.activeElement !== sel) sel.value = k.ease || 'linear';
    note.textContent = k
      ? 'Define como os valores mudam deste keyframe até o próximo.'
      : 'Nenhum keyframe no playhead. Use ◆ numa propriedade para criar, ou arraste os losangos na timeline para movê-los.';
  });
  sec.append(r, note);
  return sec;
}

function detachAudio(clip) {
  checkpoint();
  const end = clip.start + clip.duration;
  let track = orderedTracks().find((t) => t.kind === 'audio' && !t.locked && !overlaps(t.id, clip.start, end));
  if (!track) track = addTrack('audio');
  const audio = {
    id: uid('c'),
    trackId: track.id,
    mediaId: clip.mediaId,
    type: 'audio',
    name: (clip.name || 'Áudio') + ' (áudio)',
    start: clip.start,
    duration: clip.duration,
    inPoint: clip.inPoint,
    props: { x: 0, y: 0, width: 0, height: 0, rotation: 0, opacity: 1, volume: clip.props.volume },
    keyframes: clip.keyframes?.volume ? { volume: JSON.parse(JSON.stringify(clip.keyframes.volume)) } : {},
  };
  state.project.clips.push(audio);
  clip.audioDetached = true;
  emit('project');
}

/**
 * Editor de efeito do clipe: 'animIn' (entrada), 'animOut' (saída) ou 'transition' (com a cena anterior colada).
 * Todos usam o mesmo formato { type, duration, direction, color }.
 */
function effectSection(clip, key) {
  const sec = h('div.insp-section');
  const spec = () => clip[key] || null;
  const update = (fn) => {
    checkpoint();
    clip[key] ||= { type: 'fade', duration: key === 'transition' ? 1 : 0.5, direction: 'left', color: '#ffffff' };
    fn(clip[key]);
    emit('project');
  };

  const type = h('select', {
    on: {
      change: (e) => {
        if (e.target.value === 'none') {
          checkpoint();
          delete clip[key];
          emit('project');
        } else update((tr) => { tr.type = e.target.value; tr.params = {}; });
      },
    },
  }, h('option', { value: 'none' }, 'Nenhuma'), ...(key === 'transition'
    ? transitionOptions().map(([v, n]) => h('option', { value: v }, n))
    : animOptions().map(([label, list]) => h('optgroup', { label }, ...list.map(([v, n]) => h('option', { value: v }, n))))));
  // parâmetros de uma transição de extensão (a seção é refeita quando o tipo muda)
  const extRows = spec() ? transitionParamRows(spec(), { bindings, beginEdit, endEdit }) : [];
  const missing = spec() && transitionExtId(spec().type) && !getExtension(transitionExtId(spec().type))
    ? h('div.insp-warn', {}, 'Esta extensão não está instalada nesta máquina; a animação não aparece. Instale-a em "Extensões".') : null;
  const dur = h('input', {
    type: 'number', min: 0.1, step: 0.1,
    on: { change: (e) => update((tr) => { tr.duration = clamp(Number(e.target.value) || 0.5, 0.05, 30); }) },
  });
  const dir = h('select', { on: { change: (e) => update((tr) => { tr.direction = e.target.value; }) } },
    ...Object.entries(SLIDE_DIRECTIONS).map(([v, n]) => h('option', { value: v }, n)));
  const color = h('input', { type: 'color', on: { input: (e) => { beginEdit(); clip[key].color = e.target.value; emit('project'); }, change: endEdit } });
  const presets = h('div.ctrl', {}, ...['#ffffff', '#000000', '#ffe14d', '#ff3b3b'].map((c) =>
    h('button.icon', { title: c, style: { background: c, width: '22px', height: '22px', padding: 0 }, on: { click: () => update((tr) => { tr.color = c; }) } })));

  const durRow = row('Duração', dur, h('span.insp-note', { style: { padding: 0 } }, 's'));
  const dirRow = row('Direção', dir);
  const colorRow = row('Cor', color, presets);
  const note = h('div.insp-note');
  sec.append(row('Tipo', type), durRow, dirRow, colorRow, ...extRows, missing, note);

  const adjacent = () => {
    const others = clipsOnTrack(clip.trackId).filter((c) => c.id !== clip.id);
    const end = clip.start + clip.duration;
    return {
      prev: others.find((c) => Math.abs(c.start + c.duration - clip.start) < 0.02) || null,
      next: others.find((c) => Math.abs(c.start - end) < 0.02) || null,
    };
  };

  bindings.push(() => {
    const tr = spec();
    if (document.activeElement !== type) {
      if (tr && ![...type.options].some((o) => o.value === tr.type)) type.append(h('option', { value: tr.type }, 'Não instalada'));
      type.value = tr ? tr.type : 'none';
    }
    durRow.style.display = tr ? '' : 'none';
    dirRow.style.display = tr?.type === 'slide' ? '' : 'none';
    colorRow.style.display = tr?.type === 'flash' ? '' : 'none';
    if (tr) {
      if (document.activeElement !== dur) dur.value = tr.duration;
      if (document.activeElement !== dir) dir.value = tr.direction || 'left';
      if (document.activeElement !== color) color.value = tr.color || '#ffffff';
    }
    const { prev, next } = adjacent();
    let text = '';
    if (key === 'transition') {
      text = !prev
        ? 'Precisa de uma cena colada antes desta na mesma track. Para animar o começo sozinho, use Entrada.'
        : tr
          ? `Entre "${prev.name || 'cena anterior'}" e esta cena, centrada no corte. Substitui a saída da anterior e a entrada desta.`
          : 'Transição entre a cena anterior desta track e esta. Também dá para clicar no ⧓ entre dois clipes colados.';
    } else if (key === 'animIn') {
      text = tr && prev?.id && clip.transition ? 'Ignorada: há uma transição com a cena anterior.' : 'Animação no início da mídia.';
    } else {
      text = tr && next?.transition ? 'Ignorada: a próxima cena tem transição com esta.' : 'Animação no fim da mídia.';
    }
    note.textContent = text;
    note.style.color = text.startsWith('Ignorada') ? '#ffb84d' : '';
  });
  return sec;
}
