// Inspector do workspace de motion: propriedades da composição, da camada e dos keyframes.
import { state, emit, subscribe, checkpoint, measureText } from '../../state/project.js';
import { valueAt, setProp, keyframeAt, hasKeyframes } from '../../state/keyframes.js';
import {
  currentComp, getLayer, selectedLayers, layerPropsAt, localBounds, recenterAnchor, convertToPath, removeComp, compUsage,
  setCompDuration, LAYER_TYPES, SHAPES, PROP_LABELS,
} from '../../motion/model.js';
import { parseColor, formatColor } from '../../motion/interp.js';
import { EASING_LABELS, EASING_BEZIER } from '../../motion/easing.js';
import { presetsFor, applyPreset, PRESETS } from '../../motion/presets.js';
import { importSvg } from '../../motion/svgImport.js';
import { pickFiles } from '../../platform/index.js';
import {
  M, fps, seekMotion, pauseMotion, toggleKeyframe, targetKeyframes, exitMotion, selectLayers,
} from './actions.js';
import * as pen from './penTool.js';
import { bezierEditor } from './easingEditor.js';
import { placeComp } from '../timeline.js';
import { h, clamp, toast } from '../util.js';

const FONTS = [
  ['Inter, Arial, sans-serif', 'Sans (Inter/Arial)'],
  ['Georgia, "Times New Roman", serif', 'Serif (Georgia)'],
  ['"Courier New", monospace', 'Mono (Courier)'],
  ['Impact, "Arial Black", sans-serif', 'Impact'],
  ['"Comic Sans MS", cursive', 'Comic'],
  ['Verdana, sans-serif', 'Verdana'],
  ['"Trebuchet MS", sans-serif', 'Trebuchet'],
];

let root;
let builtKey = null;
let bindings = [];
let editing = false;
let linkScale = true;
let presetDuration = 0.5;

export function initMotionInspector(el) {
  root = el;
  subscribe((reason) => {
    if (state.mode !== 'motion') return;
    if (!['project', 'motion', 'motion-time', 'mode', 'media'].includes(reason)) return;
    const key = keyFor();
    if (key !== builtKey) build();
    else refresh();
  });
}

function keyFor() {
  const comp = currentComp();
  if (!comp) return 'none';
  const sel = selectedLayers(comp);
  const sig = sel.map((l) => `${l.id}/${l.type}/${l.shape || ''}/${l.fillOn}/${l.strokeOn}/${!!l.matte}/${l.locked}`).join(',');
  return `${comp.id}|${sig}|${comp.layers.length}|${!!M().pathEdit}|${comp.background ? 1 : 0}`;
}

/** Cria o ponto de desfazer uma única vez por edição contínua (até o controle perder o foco). */
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
  const comp = currentComp();
  if (!comp) return root.replaceChildren(h('div.insp-note', {}, 'Nenhuma composição aberta.'));
  const sel = selectedLayers(comp);
  root.replaceChildren(...(sel.length === 1 ? layerPanel(comp, sel[0]) : sel.length > 1 ? multiPanel(comp, sel) : compPanel(comp)));
  refresh();
}

function refresh() {
  for (const b of bindings) b();
}

const row = (label, ...ctrl) => h('div.insp-row', {}, h('label', {}, label), h('div.ctrl', {}, ...ctrl), h('span'));
const section = (...children) => h('div.insp-section', {}, ...children);

// ---------------------------------------------------------------- composição
function compPanel(comp) {
  const num = (key, opts, apply) => {
    const input = h('input', {
      type: 'number', ...opts,
      on: {
        focus: beginEdit, blur: endEdit,
        change: (e) => { const v = Number(e.target.value); if (v > 0) { beginEdit(); apply(v); emit('project'); } },
      },
    });
    bindings.push(() => { if (document.activeElement !== input) input.value = Math.round(comp[key] * 100) / 100; });
    return input;
  };
  const name = h('input', { type: 'text', on: { focus: beginEdit, blur: endEdit, input: (e) => { comp.name = e.target.value; emit('project'); } } });
  bindings.push(() => { if (document.activeElement !== name) name.value = comp.name; });

  const bgOn = h('input', {
    type: 'checkbox', checked: !!comp.background,
    on: { change: (e) => { checkpoint(); comp.background = e.target.checked ? '#000000ff' : null; emit('project'); } },
  });
  const bgColor = h('input', {
    type: 'color', value: comp.background ? comp.background.slice(0, 7) : '#000000', disabled: !comp.background,
    on: { focus: beginEdit, blur: endEdit, input: (e) => { beginEdit(); comp.background = e.target.value + 'ff'; emit('project'); } },
  });
  const usage = h('div.insp-note');
  bindings.push(() => {
    const n = compUsage(comp.id);
    usage.textContent = n ? `Usada em ${n} clipe(s) da timeline.` : 'Ainda não está na timeline do vídeo.';
  });

  return [
    h('h3', {}, 'Composição'),
    section(
      row('Nome', name),
      row('Largura', num('width', { min: 2, step: 2 }, (v) => { comp.width = Math.round(v); }), h('span.insp-note', { style: { padding: 0 } }, 'px')),
      row('Altura', num('height', { min: 2, step: 2 }, (v) => { comp.height = Math.round(v); }), h('span.insp-note', { style: { padding: 0 } }, 'px')),
      row('Duração', num('duration', { min: 0.1, step: 0.1 }, (v) => { setCompDuration(comp, v); if (M().time > v) M().time = v; }), h('span.insp-note', { style: { padding: 0 } }, 's')),
      row('Fundo', h('label.toggle-row', { style: { padding: 0 } }, bgOn, 'Cor sólida'), bgColor),
      h('div.insp-note', {}, 'Sem fundo, a composição é transparente e pode ficar por cima do vídeo.'),
      usage,
      h('div.insp-actions', {},
        h('button.primary', { title: 'Coloca a composição na timeline do vídeo, no playhead', on: { click: () => addToTimeline(comp) } }, 'Usar na timeline'),
        h('button', { title: 'Cada forma do SVG vira uma camada animável', on: { click: () => importSvgDialog(comp) } }, 'Importar SVG…'),
        h('button', {
          on: {
            click: () => {
              const n = compUsage(comp.id);
              if (!confirm(n ? `Excluir "${comp.name}" e os ${n} clipe(s) que a usam?` : `Excluir a composição "${comp.name}"?`)) return;
              checkpoint();
              exitMotion();
              removeComp(comp.id);
              emit('project');
            },
          },
        }, 'Excluir composição'),
      ),
    ),
    h('h3', {}, 'Como usar'),
    h('div.insp-note', {},
      'Desenhe com as ferramentas acima do palco, selecione uma camada e use ', h('b', {}, '◆'), ' ao lado de uma propriedade para gravar um keyframe no playhead. ',
      'Mova o playhead, mude o valor e a animação está feita. Em "Keyframes" você escolhe a curva de aceleração.',
    ),
    h('div.insp-note', {},
      h('kbd', {}, 'Espaço'), ' play · ', h('kbd', {}, 'V'), ' selecionar · ', h('kbd', {}, 'R'), ' retângulo · ', h('kbd', {}, 'O'), ' elipse · ',
      h('kbd', {}, 'T'), ' texto · ', h('kbd', {}, 'P'), ' caneta · ', h('kbd', {}, 'Y'), ' âncora · ', h('kbd', {}, ', .'), ' frame · ',
      h('kbd', {}, 'setas'), ' mover 1 px · ', h('kbd', {}, 'Ctrl+D'), ' duplicar · ', h('kbd', {}, 'Del'), ' excluir · ', h('kbd', {}, 'Esc'), ' voltar.',
    ),
  ];
}

function addToTimeline(comp) {
  exitMotion();
  placeComp(comp, null, state.time);
  toast(`"${comp.name}" adicionada à timeline`);
}

export async function importSvgDialog(comp = currentComp()) {
  if (!comp) return;
  const [file] = await pickFiles({ accept: '.svg,image/svg+xml' });
  if (!file) return;
  let text;
  try {
    text = await file.text();
  } catch (err) {
    return toast(`Não foi possível ler ${file.name}: ${err.message}`, 'error');
  }
  checkpoint();
  try {
    const result = importSvg(comp, text, file.name);
    selectLayers([result.root.id]);
    emit('project');
    toast(`${result.shapes} forma(s) importada(s)${result.warnings.length ? ' · ' + result.warnings.join(' · ') : ''}`);
  } catch (err) {
    toast(`Não foi possível importar ${file.name}: ${err.message}`, 'error');
  }
}

// ---------------------------------------------------------------- várias camadas
function multiPanel(comp, layers) {
  return [
    h('h3', {}, `${layers.length} camadas`),
    section(h('div.insp-note', {}, 'Arraste no palco para mover todas juntas. Selecione uma só para editar as propriedades.')),
    h('h3', {}, 'Animações prontas'), presetSection(comp),
    h('h3', {}, 'Keyframes'), easingSection(),
  ];
}

// ---------------------------------------------------------------- camada
function layerPanel(comp, layer) {
  const out = [];
  const typeName = layer.type === 'shape' ? SHAPES[layer.shape] || 'Forma' : LAYER_TYPES[layer.type];
  const autoKey = h('input', { type: 'checkbox', checked: state.autoKey, on: { change: (e) => { state.autoKey = e.target.checked; } } });
  out.push(h('h3', {}, h('span.grow', {}, typeName),
    h('label.toggle-row', { title: 'Grava keyframe em qualquer alteração, mesmo em propriedades ainda sem keyframes', style: { padding: 0 } }, autoKey, 'Auto-keyframe')));

  if (layer.locked) out.push(h('div.insp-warn', {}, 'Camada travada: destrave no cadeado da timeline para editar.'));

  const frame = 1 / fps();
  const timeInput = (key) => {
    const input = h('input', {
      type: 'number', step: 0.01, min: 0,
      on: {
        focus: beginEdit, blur: endEdit,
        change: (e) => {
          beginEdit();
          const v = Number(e.target.value) || 0;
          if (key === 'in') layer.in = clamp(v, 0, layer.out - frame);
          else layer.out = clamp(v, layer.in + frame, comp.duration);
          emit('project');
        },
      },
    });
    bindings.push(() => { if (document.activeElement !== input) input.value = layer[key].toFixed(2); });
    return input;
  };
  const name = h('input', { type: 'text', value: layer.name, on: { focus: beginEdit, blur: endEdit, input: (e) => { layer.name = e.target.value; emit('project'); } } });
  out.push(section(
    row('Nome', name),
    row('Visível de', timeInput('in'), h('span.insp-note', { style: { padding: 0 } }, 'até'), timeInput('out')),
    matteRow(comp, layer),
  ));

  out.push(h('h3', {}, 'Transformação'));
  const tr = section(
    numRow(layer, 'Posição X', 'x', { unit: 'px' }),
    numRow(layer, 'Posição Y', 'y', { unit: 'px' }),
    numRow(layer, 'Escala X', 'sx', { unit: '%', linked: 'sy' }),
    numRow(layer, 'Escala Y', 'sy', { unit: '%', linked: 'sx' }),
    h('label.toggle-row', {}, h('input', { type: 'checkbox', checked: linkScale, on: { change: (e) => { linkScale = e.target.checked; } } }), 'Escala proporcional'),
    numRow(layer, 'Rotação', 'rotation', { unit: '°' }),
    numRow(layer, 'Opacidade', 'opacity', { scale: 100, min: 0, max: 100, unit: '%', slider: true }),
    numRow(layer, 'Âncora X', 'ax', { unit: 'px' }),
    numRow(layer, 'Âncora Y', 'ay', { unit: 'px' }),
    h('div.insp-actions', {},
      h('button', { title: 'Leva a âncora da camada para o centro da composição', on: { click: () => centerLayer(comp, layer) } }, 'Centralizar'),
      h('button', { title: 'Põe o ponto de rotação/escala no centro da camada, sem movê-la', on: { click: () => centerAnchor(layer) } }, 'Âncora no centro'),
    ),
  );
  out.push(tr);

  if (layer.type === 'shape') out.push(h('h3', {}, 'Forma'), shapeSection(layer));
  if (layer.type === 'text') out.push(h('h3', {}, 'Texto'), textSection(layer));
  if (layer.type === 'group') out.push(section(h('div.insp-note', {}, 'Grupos não aparecem no vídeo: servem de pai para mover, girar e escalar várias camadas juntas (escolha o pai na timeline).')));

  out.push(h('h3', {}, 'Animações prontas'), presetSection(comp));
  out.push(h('h3', {}, 'Keyframes'), easingSection());
  return out;
}

function matteRow(comp, layer) {
  const others = comp.layers.filter((l) => l.id !== layer.id && l.type !== 'group');
  const sel = h('select', {
    title: 'A camada só aparece onde a camada-máscara tem conteúdo. A máscara em si deixa de ser desenhada.',
    on: {
      change: (e) => {
        checkpoint();
        layer.matte = e.target.value ? { layerId: e.target.value, inverted: !!layer.matte?.inverted } : null;
        emit('project');
      },
    },
  }, h('option', { value: '' }, 'Nenhuma'), ...others.map((l) => h('option', { value: l.id, selected: l.id === layer.matte?.layerId }, l.name)));
  const inv = h('label.toggle-row', { style: { padding: 0 }, title: 'Mostra a camada onde a máscara NÃO tem conteúdo' },
    h('input', {
      type: 'checkbox', checked: !!layer.matte?.inverted, disabled: !layer.matte,
      on: { change: (e) => { checkpoint(); layer.matte.inverted = e.target.checked; emit('project'); } },
    }), 'Inv.');
  return row('Máscara', sel, inv);
}

/** Linha de propriedade numérica com keyframe: campo, slider opcional e ◀ ◆ ▶. */
function numRow(layer, label, prop, { step = 1, scale = 1, min = -Infinity, max = Infinity, unit = '', slider = false, linked = null, after = null } = {}) {
  const apply = (raw) => {
    const v = clamp(Number(raw), min, max);
    if (!Number.isFinite(v) || layer.locked) return;
    beginEdit();
    const t = M().time;
    const before = layerPropsAt(layer, t);
    setProp(layer, prop, v / scale, t, state.autoKey);
    if (linked && linkScale && before[prop]) {
      // escala proporcional: a outra dimensão acompanha na mesma razão
      setProp(layer, linked, Math.round(before[linked] * (v / scale / before[prop]) * 100) / 100, t, state.autoKey);
    }
    after?.(before);
    emit('project');
  };
  const num = h('input', { type: 'number', step, on: { focus: beginEdit, blur: endEdit, input: (e) => e.target.value !== '' && apply(e.target.value) } });
  const range = slider ? h('input', { type: 'range', min, max, step, on: { pointerdown: beginEdit, pointerup: endEdit, input: (e) => apply(e.target.value) } }) : null;
  if (range) num.classList.add('small');
  const kf = kfControls(layer, prop);
  bindings.push(() => {
    const shown = Math.round(valueAt(layer, prop, M().time) * scale * 100) / 100;
    if (document.activeElement !== num) num.value = shown;
    if (range && document.activeElement !== range) range.value = shown;
  });
  return h('div.insp-row', {}, h('label', { title: unit }, label), h('div.ctrl', {}, range, num), kf);
}

function kfControls(layer, prop) {
  const btn = h('button.kf-btn', { title: 'Adicionar/remover keyframe no playhead', on: { click: () => !layer.locked && toggleKeyframe(layer, prop) } }, '◆');
  const nav = (dir) => h('button.kf-nav', {
    title: dir < 0 ? 'Keyframe anterior' : 'Próximo keyframe',
    on: {
      click: () => {
        const t = M().time;
        const list = layer.keyframes?.[prop] || [];
        const k = dir < 0 ? [...list].reverse().find((x) => x.t < t - 1e-4) : list.find((x) => x.t > t + 1e-4);
        if (k) { pauseMotion(); seekMotion(k.t); }
      },
    },
  }, dir < 0 ? '◀' : '▶');
  const prev = nav(-1);
  const next = nav(1);
  bindings.push(() => {
    const has = hasKeyframes(layer, prop);
    btn.classList.toggle('has', has);
    btn.classList.toggle('on', !!keyframeAt(layer, prop, M().time));
    prev.disabled = next.disabled = !has;
  });
  return h('div.kf-ctrls', {}, prev, btn, next);
}

/** Linha de cor animável: liga/desliga, cor e transparência. */
function colorRow(layer, label, prop, toggleKey) {
  const set = (hex6, alpha) => {
    if (layer.locked) return;
    beginEdit();
    const [r, g, b] = parseColor(hex6);
    setProp(layer, prop, formatColor([r, g, b, Math.round(alpha * 255)]), M().time, state.autoKey);
    emit('project');
  };
  const on = h('input', {
    type: 'checkbox', checked: !!layer[toggleKey], title: `Ligar/desligar ${label.toLowerCase()}`,
    on: {
      change: (e) => {
        checkpoint();
        layer[toggleKey] = e.target.checked;
        // ligar o traço sem espessura não mostraria nada
        if (toggleKey === 'strokeOn' && e.target.checked && !(valueAt(layer, 'strokeWidth', M().time) > 0)) layer.props.strokeWidth = 6;
        emit('project');
      },
    },
  });
  const color = h('input', { type: 'color', on: { focus: beginEdit, blur: endEdit, input: (e) => set(e.target.value, Number(alpha.value) / 100) } });
  const alpha = h('input', {
    type: 'range', min: 0, max: 100, step: 1, title: 'Transparência da cor',
    on: { pointerdown: beginEdit, pointerup: endEdit, input: (e) => set(color.value, Number(e.target.value) / 100) },
  });
  bindings.push(() => {
    const [r, g, b, a] = parseColor(valueAt(layer, prop, M().time));
    const hex = formatColor([r, g, b]).slice(0, 7);
    if (document.activeElement !== color) color.value = hex;
    if (document.activeElement !== alpha) alpha.value = Math.round((a / 255) * 100);
  });
  return h('div.insp-row', {}, h('label', {}, label), h('div.ctrl', {}, on, h('div.color-ctrl', {}, color, alpha)), kfControls(layer, prop));
}

function shapeSection(layer) {
  const sec = section();
  const parametric = !['path', 'line'].includes(layer.shape);
  // redimensionar pelo inspector mantém a âncora no centro, como no palco
  const recenter = (before) => {
    const t = M().time;
    const after = layerPropsAt(layer, t);
    recenterAnchor(layer, { x: 0, y: 0, w: before.w, h: before.h }, { x: 0, y: 0, w: after.w, h: after.h });
  };
  if (layer.shape !== 'path') {
    sec.append(
      numRow(layer, layer.shape === 'line' ? 'Fim X' : 'Largura', 'w', { unit: 'px', min: parametric ? 1 : -Infinity, after: recenter }),
      numRow(layer, layer.shape === 'line' ? 'Fim Y' : 'Altura', 'h', { unit: 'px', min: parametric ? 1 : -Infinity, after: recenter }),
    );
  }
  if (layer.shape === 'rect') sec.append(numRow(layer, 'Arredondar', 'radius', { unit: 'px', min: 0 }));
  if (layer.shape === 'polygon' || layer.shape === 'star') sec.append(numRow(layer, 'Pontas', 'sides', { min: 3, max: 60 }));
  if (layer.shape === 'star') sec.append(numRow(layer, 'Raio interno', 'inner', { scale: 100, min: 1, max: 100, unit: '%', slider: true }));

  if (layer.shape !== 'line') sec.append(colorRow(layer, 'Preencher', 'fill', 'fillOn'));
  sec.append(colorRow(layer, 'Traço', 'stroke', 'strokeOn'));
  if (layer.strokeOn) {
    sec.append(numRow(layer, 'Espessura', 'strokeWidth', { unit: 'px', min: 0, step: 0.5 }));
    sec.append(row('Pontas',
      h('select', { title: 'Acabamento das extremidades do traço', on: { change: (e) => { checkpoint(); layer.lineCap = e.target.value; emit('project'); } } },
        ...[['round', 'Redondas'], ['butt', 'Retas'], ['square', 'Quadradas']].map(([v, n]) => h('option', { value: v, selected: v === layer.lineCap }, n))),
      h('select', { title: 'Acabamento dos cantos do traço', on: { change: (e) => { checkpoint(); layer.lineJoin = e.target.value; emit('project'); } } },
        ...[['round', 'Canto redondo'], ['miter', 'Canto vivo'], ['bevel', 'Canto chanfrado']].map(([v, n]) => h('option', { value: v, selected: v === layer.lineJoin }, n))),
    ));
    sec.append(
      numRow(layer, 'Aparar início', 'trimStart', { min: 0, max: 100, unit: '%', slider: true }),
      numRow(layer, 'Aparar fim', 'trimEnd', { min: 0, max: 100, unit: '%', slider: true }),
      numRow(layer, 'Deslocar', 'trimOffset', { unit: '%' }),
      h('div.insp-note', {}, 'Anime "Aparar fim" de 0 a 100 para o traço se desenhar sozinho.'),
    );
  }

  if (layer.shape === 'path') {
    const warn = h('div.insp-warn', {}, 'Os keyframes do caminho têm quantidades de pontos diferentes: em vez de transformar suavemente, a forma vai saltar. Adicione ou remova pontos antes de criar os keyframes.');
    bindings.push(() => { warn.style.display = pen.morphMismatch(layer) ? '' : 'none'; });
    const editBtn = h('button', {
      title: 'Mostra os pontos do caminho para arrastar (ou duplo clique na forma)',
      on: { click: () => (M().pathEdit ? pen.exitEdit() : pen.enterEdit(layer)) },
    }, M().pathEdit ? 'Concluir edição' : 'Editar pontos');
    sec.append(
      h('div.insp-row', {}, h('label', {}, 'Caminho'), h('div.ctrl', {}, editBtn), kfControls(layer, 'path')),
      warn,
      h('div.insp-note', {}, 'Com ◆ ligado em "Caminho", mover os pontos em outro instante cria a transformação (morph) entre as formas.'),
    );
  } else if (layer.shape !== 'line') {
    sec.append(h('div.insp-actions', {}, h('button', {
      title: 'Troca a forma por pontos editáveis; largura, altura e arredondamento deixam de existir',
      on: { click: () => { checkpoint(); convertToPath(layer, M().time); emit('project'); pen.enterEdit(layer); } },
    }, 'Converter em caminho')));
  }
  return sec;
}

function textSection(layer) {
  const sec = section();
  const f = layer.font;
  const size = () => { const m = measureText(layer); return { x: 0, y: 0, w: m.w, h: m.h }; };
  // mudar o texto muda o tamanho natural: a âncora continua no centro
  const restyle = (fn) => {
    if (layer.locked) return;
    beginEdit();
    const before = size();
    fn();
    recenterAnchor(layer, before, size());
    emit('project');
  };
  sec.append(h('textarea.text-input', { value: layer.text, on: { focus: beginEdit, blur: endEdit, input: (e) => restyle(() => { layer.text = e.target.value; }) } }));
  sec.append(row('Fonte', h('select', { on: { change: (e) => { restyle(() => { f.family = e.target.value; }); endEdit(); } } },
    ...FONTS.map(([v, n]) => h('option', { value: v, selected: v === f.family }, n)))));
  sec.append(row('Tamanho', h('input', {
    type: 'number', min: 4, step: 1, value: f.size,
    on: { focus: beginEdit, blur: endEdit, input: (e) => Number(e.target.value) > 0 && restyle(() => { f.size = Number(e.target.value); }) },
  })));
  sec.append(row('Cor',
    h('input', { type: 'color', value: f.color, on: { focus: beginEdit, blur: endEdit, input: (e) => { beginEdit(); f.color = e.target.value; emit('project'); } } }),
    h('button' + (f.bold ? '.active' : ''), { on: { click: (e) => { restyle(() => { f.bold = !f.bold; }); endEdit(); e.currentTarget.classList.toggle('active', f.bold); } } }, h('b', {}, 'N')),
    h('button' + (f.italic ? '.active' : ''), { on: { click: (e) => { restyle(() => { f.italic = !f.italic; }); endEdit(); e.currentTarget.classList.toggle('active', f.italic); } } }, h('i', {}, 'I')),
  ));
  sec.append(row('Alinhar', h('select', { on: { change: (e) => { beginEdit(); f.align = e.target.value; endEdit(); emit('project'); } } },
    ...[['left', 'Esquerda'], ['center', 'Centro'], ['right', 'Direita']].map(([v, n]) => h('option', { value: v, selected: v === f.align }, n)))));
  sec.append(row('Contorno',
    h('input', { type: 'color', value: f.stroke || '#000000', on: { focus: beginEdit, blur: endEdit, input: (e) => { beginEdit(); f.stroke = e.target.value; emit('project'); } } }),
    h('input', { type: 'number', min: 0, step: 1, value: f.strokeWidth || 0, on: { focus: beginEdit, blur: endEdit, input: (e) => restyle(() => { f.strokeWidth = Math.max(0, Number(e.target.value) || 0); }) } }),
  ));
  return sec;
}

function centerLayer(comp, layer) {
  if (layer.locked) return;
  // a posição é relativa ao pai; só sem pai ela é a posição na composição
  if (layer.parentId && getLayer(comp, layer.parentId)) {
    toast('Camada com pai: a posição é relativa ao pai. Remova o pai para centralizar na composição.');
    return;
  }
  checkpoint();
  const t = M().time;
  setProp(layer, 'x', comp.width / 2, t, state.autoKey);
  setProp(layer, 'y', comp.height / 2, t, state.autoKey);
  emit('project');
}

function centerAnchor(layer) {
  if (layer.locked) return;
  checkpoint();
  const t = M().time;
  const p = layerPropsAt(layer, t);
  const b = localBounds(layer, p);
  const ax = b.x + b.w / 2;
  const ay = b.y + b.h / 2;
  // desloca a posição pelo mesmo vetor (já rotacionado e escalado) para a camada não sair do lugar
  const r = (p.rotation * Math.PI) / 180;
  const dx = ((ax - p.ax) * p.sx) / 100;
  const dy = ((ay - p.ay) * p.sy) / 100;
  setProp(layer, 'ax', ax, t, state.autoKey);
  setProp(layer, 'ay', ay, t, state.autoKey);
  setProp(layer, 'x', Math.round((p.x + dx * Math.cos(r) - dy * Math.sin(r)) * 100) / 100, t, state.autoKey);
  setProp(layer, 'y', Math.round((p.y + dx * Math.sin(r) + dy * Math.cos(r)) * 100) / 100, t, state.autoKey);
  emit('project');
}

// ---------------------------------------------------------------- presets e easing
function presetSection(comp) {
  const layers = selectedLayers(comp);
  // só os presets que servem para todas as camadas selecionadas
  const ids = Object.keys(PRESETS).filter((id) => layers.every((l) => presetsFor(l).some(([pid]) => pid === id)));
  const sel = h('select', {}, ...ids.map((id) => h('option', { value: id }, PRESETS[id].label)));
  const dur = h('input.small', { type: 'number', min: 0.05, step: 0.05, value: presetDuration, title: 'Duração da animação (s)', on: { change: (e) => { presetDuration = Math.max(0.05, Number(e.target.value) || 0.5); } } });
  const applyBtn = h('button', {
    title: 'Grava os keyframes da animação; depois você pode ajustá-los à vontade',
    on: {
      click: () => {
        const targets = selectedLayers(comp).filter((l) => !l.locked);
        if (!targets.length) return;
        checkpoint();
        for (const l of targets) applyPreset(comp, l, sel.value, presetDuration);
        emit('project');
        emit('motion');
      },
    },
  }, 'Aplicar');
  return section(
    h('div.insp-row', {}, h('label', {}, 'Animação'), h('div.ctrl', {}, sel), h('span')),
    h('div.insp-row', {}, h('label', {}, 'Duração'), h('div.ctrl', {}, dur, h('span.insp-note', { style: { padding: 0 } }, 's'), applyBtn), h('span')),
    h('div.insp-note', {}, 'Entradas começam no início da camada; saídas terminam no fim dela.'),
  );
}

const sameEase = (a, b) => (Array.isArray(a) && Array.isArray(b) ? a.every((v, i) => v === b[i]) : a === b);

function easingSection() {
  const sec = section();
  const sel = h('select', {
    on: {
      change: (e) => {
        const targets = targetKeyframes();
        if (!targets.length) return;
        checkpoint();
        for (const { kf } of targets) {
          const cur = kf.ease || 'linear';
          kf.ease = e.target.value === 'custom' ? (Array.isArray(cur) ? cur : [...(EASING_BEZIER[cur] || EASING_BEZIER.ease)]) : e.target.value;
        }
        emit('project');
      },
    },
  }, ...Object.entries(EASING_LABELS).map(([v, n]) => h('option', { value: v }, n)), h('option', { value: 'custom' }, 'Curva personalizada'));
  const editor = bezierEditor((bezier) => {
    for (const { kf } of targetKeyframes()) kf.ease = [...bezier];
    emit('project');
  }, checkpoint);
  const info = h('div.insp-note');
  const ctrl = row('Curva', sel);
  sec.append(info, ctrl, editor.el);
  bindings.push(() => {
    const targets = targetKeyframes();
    const has = targets.length > 0;
    ctrl.style.display = has ? '' : 'none';
    if (!has) {
      editor.el.style.display = 'none';
      info.textContent = 'Selecione keyframes na timeline (ou pare o playhead sobre um) para escolher a curva de aceleração.';
      return;
    }
    const first = targets[0].kf.ease || 'linear';
    const mixed = targets.some((x) => !sameEase(x.kf.ease || 'linear', first));
    const props = [...new Set(targets.map((x) => PROP_LABELS[x.prop] || x.prop))];
    info.textContent = `${targets.length} keyframe(s): ${props.slice(0, 3).join(', ')}${props.length > 3 ? '…' : ''}. A curva vale deste keyframe até o próximo.${mixed ? ' (curvas diferentes)' : ''}`;
    if (document.activeElement !== sel) sel.value = Array.isArray(first) ? 'custom' : first;
    editor.el.style.display = Array.isArray(first) ? '' : 'none';
    if (Array.isArray(first)) editor.set(first);
  });
  return sec;
}
