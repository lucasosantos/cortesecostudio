// Tela de extensões: lista de efeitos e transições, editor de código GLSL com pré-visualização ao vivo,
// exportação para arquivo e a tela de instalação de arquivos recebidos de outras pessoas.
import {
  listExtensions, getExtension, isInstalled, installExtension, removeExtension, validateExtension, readExtensionFile, exportExtension,
  freeId, slugify, onExtensionsChange, usedExtensionIds, FORMAT,
} from '../fx/registry.js';
import { buildSource, parseShaderLog, uniformValue, defaultFor, PARAM_GLSL, PARAM_LABELS, isParamName, ANIM_PAD } from '../fx/shader.js';
import { checkShader, runChain, runTransition, glAvailable } from '../fx/gl.js';
import { saveFile, pickFiles } from '../platform/index.js';
import { h, openModal, toast } from './util.js';

const PW = 384;
const PH = 216;

const TEMPLATES = {
  effect: {
    name: 'Meu efeito',
    params: [{ name: 'forca', label: 'Força', type: 'float', default: 0.5, min: 0, max: 1 }],
    glsl: `// Efeito: recebe a posição uv (de 0 a 1; 0,0 é o canto inferior esquerdo)
// e devolve a cor daquele ponto. getColor(uv) lê a imagem original.
//
// Também disponíveis:
//   time        segundos desde o início do clipe
//   progress    0 a 1 ao longo do clipe
//   resolution  tamanho em pixels (vec2)
//   ratio       largura / altura
//   e os parâmetros declarados acima (aqui: forca)

vec4 effect(vec2 uv) {
  // desloca cada linha para os lados, formando uma onda que anda com o tempo
  float onda = sin(uv.y * 30.0 + time * 4.0) * forca * 0.03;
  return getColor(uv + vec2(onda, 0.0));
}`,
  },
  transition: {
    name: 'Minha transição',
    params: [{ name: 'suavidade', label: 'Suavidade', type: 'float', default: 0.1, min: 0.001, max: 0.5 }],
    glsl: `// Transição: progress vai de 0 (só a cena anterior) a 1 (só a cena nova).
// getFromColor(uv) lê a cena anterior e getToColor(uv) a nova.
// O formato é o mesmo do projeto gl-transitions.

vec4 transition(vec2 uv) {
  // uma borda suave que varre a tela da esquerda para a direita
  float p = mix(-suavidade, 1.0 + suavidade, progress);
  float borda = smoothstep(p - suavidade, p + suavidade, uv.x);
  return mix(getToColor(uv), getFromColor(uv), borda);
}`,
  },
  animation: {
    name: 'Minha entrada',
    params: [{ name: 'giro', label: 'Giro (graus)', type: 'float', default: 90, min: -360, max: 360 }],
    glsl: `// Entrada/saída: anima um elemento (clipe, texto, camada) aparecendo ou sumindo.
// uv vai de 0 a 1 dentro da caixa do elemento (0,0 é o canto inferior esquerdo);
// há uma margem em volta, então dá para mover ou crescer o elemento para fora da caixa.
// getColor(uv) lê o elemento (transparente fora da caixa).
//
//   progress    quanto do elemento está visível: 0 → 1 na entrada, 1 → 0 na saída
//               (o mesmo código serve para entrar e para sair, tocado ao contrário)
//   entering    true na entrada, false na saída (para fazer as duas diferentes)
//   time        segundos desde o início do elemento
//   resolution  tamanho do elemento em pixels; ratio = largura / altura

vec4 animate(vec2 uv) {
  // gira e cresce a partir do centro enquanto aparece
  float e = 1.0 - pow(1.0 - progress, 3.0);
  float a = radians(giro) * (1.0 - e);
  vec2 p = (uv - 0.5) * vec2(ratio, 1.0);
  p = mat2(cos(a), sin(a), -sin(a), cos(a)) * p / max(e, 0.001);
  vec4 c = getColor(p / vec2(ratio, 1.0) + 0.5);
  return vec4(c.rgb, c.a * e);
}`,
  },
};

// ---------------------------------------------------------------- imagens de teste
let testImages = null;
function getTestImages() {
  if (testImages) return testImages;
  const make = (letter, top, bottom) => {
    const c = Object.assign(document.createElement('canvas'), { width: PW, height: PH });
    const g = c.getContext('2d');
    const grad = g.createLinearGradient(0, 0, PW, PH);
    grad.addColorStop(0, top);
    grad.addColorStop(1, bottom);
    g.fillStyle = grad;
    g.fillRect(0, 0, PW, PH);
    // barras de cor e um trecho de "fundo verde" para testar chroma key
    ['#ff3b3b', '#ffd24a', '#00d800', '#4f8cff', '#ffffff', '#000000'].forEach((color, i) => {
      g.fillStyle = color;
      g.fillRect(16 + i * 30, PH - 44, 30, 28);
    });
    g.fillStyle = 'rgba(255,255,255,.92)';
    g.font = 'bold 110px Inter, Arial, sans-serif';
    g.textAlign = 'center';
    g.textBaseline = 'middle';
    g.fillText(letter, PW / 2, PH / 2 - 14);
    g.beginPath();
    g.arc(PW - 60, 56, 30, 0, Math.PI * 2);
    g.fillStyle = 'rgba(255,255,255,.5)';
    g.fill();
    return c;
  };
  testImages = { a: make('A', '#243b6b', '#7a2a5e'), b: make('B', '#1f6b48', '#c9a227') };
  return testImages;
}

/** Valores padrão dos parâmetros já no formato dos uniforms. */
function defaultUniforms(ext) {
  const u = {};
  for (const p of ext.params || []) if (PARAM_GLSL[p.type] && isParamName(p.name)) u[p.name] = uniformValue(p, defaultFor(p));
  return u;
}

/** Roda o shader da extensão num quadro de teste. @returns canvas WebGL ou null */
function renderExt(ext, frag, source, seconds) {
  const { a, b } = getTestImages();
  if (ext.kind === 'transition') {
    // ciclo de 3,2 s: segura a cena A, anima, segura a cena B
    const cycle = (seconds % 3.2) / 3.2;
    const progress = Math.max(0, Math.min(1, (cycle - 0.12) / 0.7));
    return runTransition(source || a, b, PW, PH, frag, { ...defaultUniforms(ext), progress, time: seconds });
  }
  if (ext.kind === 'animation') return renderAnimation(ext, frag, source || a, seconds);
  return runChain(source || a, PW, PH, [{ frag, uniforms: { ...defaultUniforms(ext), time: seconds, progress: (seconds % 4) / 4 } }]);
}

let animCanvas = null;
/**
 * Entrada/saída: a imagem vira um elemento no meio do quadro, sobre um fundo xadrez.
 * Ciclo de 4 s: escondido, entra, fica, sai.
 */
function renderAnimation(ext, frag, source, seconds) {
  const EW = Math.round(PW * 0.5);
  const EH = Math.round(PH * 0.5);
  const pw = EW + 2 * Math.round(EW * ANIM_PAD);
  const ph = EH + 2 * Math.round(EH * ANIM_PAD);
  const px = (pw - EW) / 2;
  const py = (ph - EH) / 2;
  const c = (seconds % 4) / 4;
  const DUR = 0.3;
  const entering = c < 0.5;
  const progress = entering ? Math.max(0, Math.min(1, (c - 0.05) / DUR)) : 1 - Math.max(0, Math.min(1, (c - 0.62) / DUR));
  const out = runChain(source, pw, ph, [{
    frag,
    uniforms: {
      ...defaultUniforms(ext), time: seconds % 4, progress, entering: entering ? 1 : 0,
      resolution: [EW, EH], ratio: EW / EH, uBox: [px / pw, py / ph, EW / pw, EH / ph],
    },
  }]);
  if (!out) return null;
  animCanvas ||= Object.assign(document.createElement('canvas'), { width: PW, height: PH });
  const g = animCanvas.getContext('2d');
  for (let y = 0; y < PH; y += 16) {
    for (let x = 0; x < PW; x += 16) {
      g.fillStyle = ((x + y) / 16) % 2 ? '#2a2a30' : '#222227';
      g.fillRect(x, y, 16, 16);
    }
  }
  g.drawImage(out, (PW - pw) / 2, (PH - ph) / 2, pw, ph);
  return animCanvas;
}

let probeCtx = null;
/** Tempo médio (ms) de um quadro da extensão, forçando a GPU a terminar o desenho. */
function timeFrames(ext, frag) {
  probeCtx ||= Object.assign(document.createElement('canvas'), { width: 1, height: 1 }).getContext('2d', { willReadFrequently: true });
  const once = (i) => {
    const out = renderExt(ext, frag, null, i * 0.3);
    if (!out) return false;
    probeCtx.drawImage(out, 0, 0, 1, 1);
    probeCtx.getImageData(0, 0, 1, 1);
    return true;
  };
  // a primeira execução inclui a compilação: não entra na conta
  if (!once(0)) return null;
  const runs = 4;
  const t0 = performance.now();
  for (let i = 1; i <= runs; i++) once(i);
  return (performance.now() - t0) / runs;
}

const PASSTHROUGH = {
  effect: { kind: 'effect', params: [], glsl: 'vec4 effect(vec2 uv) { return getColor(uv); }' },
  transition: { kind: 'transition', params: [], glsl: 'vec4 transition(vec2 uv) { return mix(getFromColor(uv), getToColor(uv), progress); }' },
  animation: { kind: 'animation', params: [], glsl: 'vec4 animate(vec2 uv) { vec4 c = getColor(uv); return vec4(c.rgb, c.a * progress); }' },
};
const baseline = {};

/**
 * Custo da extensão em relação a um shader trivial nesta máquina.
 * (Comparar com um valor fixo acusaria tudo como "pesado" em computadores sem placa de vídeo.)
 * @returns { ms, ratio } ou null
 */
function measureCost(ext, frag) {
  const kind = PASSTHROUGH[ext.kind] ? ext.kind : 'effect';
  baseline[kind] ??= timeFrames(PASSTHROUGH[kind], buildSource(PASSTHROUGH[kind]));
  const ms = timeFrames(ext, frag);
  if (ms == null) return null;
  return { ms, ratio: baseline[kind] ? ms / Math.max(baseline[kind], 0.2) : 1 };
}

/**
 * Pré-visualização animada de uma extensão.
 * @param getExt () => extensão atual (lida a cada quadro, para refletir a edição)
 * @returns { el, stop() }
 */
function createPreview(getExt) {
  const canvas = h('canvas.ext-preview', { width: PW, height: PH });
  const ctx = canvas.getContext('2d');
  let useProject = false;
  let running = true;
  const sourceSel = h('select', { title: 'Imagem usada na pré-visualização', on: { change: (e) => { useProject = e.target.value === 'project'; } } },
    h('option', { value: 'test' }, 'Imagem de teste'), h('option', { value: 'project' }, 'Quadro atual do projeto'));
  const start = performance.now();
  let lastFrag = '';
  let lastSrc = '';

  const frame = () => {
    if (!running) return;
    if (!canvas.isConnected && performance.now() - start > 1000) { running = false; return; }
    requestAnimationFrame(frame);
    const ext = getExt();
    if (!ext) return;
    const key = JSON.stringify([ext.kind, ext.params, ext.glsl]);
    if (key !== lastSrc) {
      lastSrc = key;
      lastFrag = buildSource(ext);
    }
    const seconds = (performance.now() - start) / 1000;
    let source = null;
    if (useProject) {
      // o preview da timeline já tem o quadro atual desenhado
      const pv = document.getElementById('preview-canvas');
      if (pv?.width) {
        const s = scratch();
        s.clearRect(0, 0, PW, PH);
        const k = Math.min(PW / pv.width, PH / pv.height);
        s.drawImage(pv, (PW - pv.width * k) / 2, (PH - pv.height * k) / 2, pv.width * k, pv.height * k);
        source = s.canvas;
      }
    }
    const out = renderExt(ext, lastFrag, source, seconds);
    ctx.clearRect(0, 0, PW, PH);
    ctx.drawImage(out || source || getTestImages().a, 0, 0, PW, PH);
  };
  let scratchCtx = null;
  const scratch = () => (scratchCtx ||= Object.assign(document.createElement('canvas'), { width: PW, height: PH }).getContext('2d'));
  requestAnimationFrame(frame);
  return { el: h('div.ext-preview-box', {}, canvas, sourceSel), stop: () => { running = false; } };
}

/** Compila e devolve { ok, errors: [{ line, message }], cost } para mostrar ao usuário. */
function diagnose(ext) {
  if (!glAvailable()) return { ok: false, errors: [{ line: 0, message: 'WebGL2 não está disponível neste ambiente: não dá para compilar nem pré-visualizar.' }], cost: null };
  const frag = buildSource(ext);
  const r = checkShader(frag);
  if (!r.ok) return { ok: false, errors: parseShaderLog(r.log, ext.glsl.split('\n').length), cost: null };
  return { ok: true, errors: [], cost: measureCost(ext, frag) };
}

function statusEl(diag, onLine) {
  if (!diag.ok) {
    return h('div.ext-errors', {}, ...diag.errors.map((e) => h('button.ext-error', { title: e.line ? 'Ir para a linha' : '', on: { click: () => e.line && onLine?.(e.line) } },
      e.line ? h('b', {}, `Linha ${e.line}: `) : null, e.message)));
  }
  // pesado = bem mais lento que um shader trivial nesta máquina e lento em termos absolutos
  const heavy = !!diag.cost && diag.cost.ratio > 6 && diag.cost.ms > 8;
  return h(`div.ext-ok${heavy ? '.heavy' : ''}`, {}, heavy
    ? `Compila, mas é pesado: cerca de ${diag.cost.ratio.toFixed(0)}× o custo de um efeito simples. Pode travar a pré-visualização e deixar a exportação lenta.`
    : 'Compila sem erros.');
}

const KIND_LABELS = { effect: 'Efeito', transition: 'Transição', animation: 'Entrada/saída' };
const kindLabel = (kind) => KIND_LABELS[kind] || 'Efeito';

// ---------------------------------------------------------------- instalação
/** Lê um arquivo de extensão e abre a tela de instalação. */
export async function installFromFile(file) {
  try {
    const ext = readExtensionFile(await file.text(), file.name);
    openInstallDialog(ext, file.name);
  } catch (err) {
    toast(`Não foi possível ler "${file.name}": ${err.message}`, 'error');
  }
}

export async function pickAndInstall() {
  const files = await pickFiles({ accept: '.json,.glsl,.csfx,application/json', multiple: true });
  for (const file of files) await installFromFile(file);
}

export const isExtensionFile = (name) => /\.(csfx\.json|csfx|glsl)$/i.test(name || '');

/** Tela de instalação: mostra o que a extensão é e faz antes de instalar. */
export function openInstallDialog(ext, fileName = '') {
  const diag = diagnose(ext);
  const existing = isInstalled(ext.id) ? getExtension(ext.id) : null;
  const preview = createPreview(() => ext);
  let keepBoth = false;
  const conflict = existing ? h('div.field', {},
    h('span', {}, `Já existe uma extensão instalada com este id ("${existing.name}").`),
    h('label.toggle-row', { style: { padding: 0 } }, h('input', { type: 'radio', name: 'ext-conflict', checked: true, on: { change: () => { keepBoth = false; } } }), 'Substituir a instalada (clipes que a usam passam a usar esta)'),
    h('label.toggle-row', { style: { padding: 0 } }, h('input', { type: 'radio', name: 'ext-conflict', on: { change: () => { keepBoth = true; } } }), 'Manter as duas (esta entra com outro id)'),
  ) : null;
  const params = (ext.params || []).length
    ? ext.params.map((p) => `${p.label || p.name} (${PARAM_LABELS[p.type] || p.type})`).join(' · ')
    : 'nenhum';
  const info = (label, value) => h('div.ext-info', {}, h('span', {}, label), h('b', {}, value || '—'));

  const m = openModal({
    title: `Instalar ${kindLabel(ext.kind).toLowerCase()}: ${ext.name}`,
    body: [
      h('div.ext-install', {},
        h('div', {},
          info('Tipo', kindLabel(ext.kind)),
          info('Autor', ext.author),
          info('Id', ext.id),
          fileName ? info('Arquivo', fileName) : null,
          info('Parâmetros', params),
          ext.description ? h('div.insp-note', { style: { padding: '6px 0' } }, ext.description) : null,
        ),
        preview.el,
      ),
      statusEl(diag),
      h('label.field', {}, h('span', {}, 'Código (somente leitura)'), h('textarea.ext-code', { readOnly: true, rows: 10, value: ext.glsl, spellcheck: false })),
      conflict,
      h('div.insp-note', { style: { padding: 0 } },
        'Extensões são shaders: só calculam a cor de cada pixel. Não têm acesso a arquivos, à internet nem ao resto do aplicativo.'),
    ],
    footer: [
      h('button', { on: { click: () => m.close() } }, 'Cancelar'),
      h('button.primary', {
        disabled: !diag.ok,
        title: diag.ok ? '' : 'O código não compila neste computador',
        on: {
          click: () => {
            try {
              const installed = installExtension(keepBoth ? { ...ext, id: freeId(ext.id) } : ext);
              m.close();
              toast(`${kindLabel(installed.kind)} "${installed.name}" instalad${installed.kind === 'transition' || installed.kind === 'animation' ? 'a' : 'o'}`);
            } catch (err) {
              toast(`Não foi possível instalar: ${err.message}`, 'error');
            }
          },
        },
      }, 'Instalar'),
    ],
    onClose: () => preview.stop(),
  });
  m.el.classList.add('wide', 'ext-install-modal');
  return m;
}

// ---------------------------------------------------------------- tela de extensões
let screen = null;

/** Abre a tela de extensões (opcionalmente já mostrando uma). */
export function openExtensions(selectId = null) {
  if (screen) return;
  let selectedId = selectId;
  let draft = null; // cópia em edição (extensões instaladas ou novas)
  let dirty = false;
  let preview = null;
  let compileTimer = null;

  const listEl = h('div.ext-list');
  const paneEl = h('div.ext-pane');
  const confirmDiscard = () => !dirty || confirm('Descartar as alterações não salvas desta extensão?');

  const select = (id) => {
    if (!confirmDiscard()) return;
    selectedId = id;
    draft = null;
    dirty = false;
    renderList();
    renderPane();
  };

  const startDraft = (ext, isNew) => {
    draft = { ...JSON.parse(exportExtension(ext)), isNew };
    dirty = isNew;
    selectedId = isNew ? null : ext.id;
    renderList();
    renderPane();
  };

  const newDraft = (kind) => {
    if (!confirmDiscard()) return;
    const t = TEMPLATES[kind];
    startDraft({ format: FORMAT, version: 1, id: freeId(`meu.${slugify(t.name)}`), name: t.name, kind, author: '', description: '', params: t.params, glsl: t.glsl }, true);
  };

  function renderList() {
    const used = new Set(usedExtensionIds());
    const group = (kind, title) => {
      const items = listExtensions(kind);
      return [h('h3', {}, title), ...items.map((e) => {
        const tag = e.builtin ? 'nativo' : isInstalled(e.id) ? (used.has(e.id) ? 'em uso' : '') : 'do projeto';
        return h(`button.ext-item${e.id === selectedId && !draft?.isNew ? '.active' : ''}`, { title: e.description || '', on: { click: () => select(e.id) } },
          h('span.n', {}, e.name), tag ? h('span.tag', {}, tag) : null);
      }), items.length ? null : h('div.insp-note', {}, 'Nenhuma ainda.')];
    };
    listEl.replaceChildren(...[
      h('div.ext-actions', {},
        h('button.primary', { title: 'Instalar um arquivo .csfx.json ou uma transição .glsl do gl-transitions', on: { click: pickAndInstall } }, 'Instalar arquivo…'),
        h('button', { on: { click: () => newDraft('effect') } }, 'Novo efeito'),
        h('button', { on: { click: () => newDraft('transition') } }, 'Nova transição'),
        h('button', { title: 'Animação de um elemento aparecendo ou sumindo (clipes, textos, camadas do Motion)', on: { click: () => newDraft('animation') } }, 'Nova entrada/saída'),
      ),
      draft?.isNew ? h('button.ext-item.active', {}, h('span.n', {}, draft.name || 'Sem nome'), h('span.tag', {}, 'não salvo')) : null,
      ...group('effect', 'Efeitos'),
      ...group('transition', 'Transições'),
      ...group('animation', 'Entrada/saída'),
    ].filter(Boolean)); // replaceChildren escreveria "null" no lugar dos itens ausentes
  }

  function renderPane() {
    preview?.stop();
    preview = null;
    clearTimeout(compileTimer);
    const ext = draft || (selectedId ? getExtension(selectedId) : null);
    if (!ext) {
      paneEl.replaceChildren(h('div.ext-empty', {},
        h('p', {}, 'Efeitos, transições e animações de entrada/saída são pequenos programas em GLSL (shaders) que calculam a cor de cada pixel.'),
        h('p', {}, 'Escolha um na lista para ver o código, crie um novo ou instale um arquivo que alguém compartilhou. Arquivos também podem ser arrastados para a janela.'),
        h('p', {}, 'As transições usam o mesmo formato do projeto aberto gl-transitions: arquivos .glsl de lá podem ser instalados direto.'),
        h('p', {}, 'Entradas e saídas animam um elemento sozinho (um clipe, um texto, uma camada do Motion) aparecendo ou sumindo. Escolha-as em "Entrada" e "Saída" no inspector.')));
      return;
    }
    if (ext.canvas) {
      paneEl.replaceChildren(h('h2', {}, ext.name), h('div.insp-note', { style: { padding: 0 } }, ext.description || ''),
        h('div.insp-note', { style: { padding: '10px 0' } }, 'Este efeito nativo usa o filtro do próprio canvas (precisa desenhar fora da caixa do elemento), então não tem código GLSL para ver ou duplicar.'));
      return;
    }
    const editable = !!draft;
    const current = () => draft || ext;
    preview = createPreview(current);

    const code = h('textarea.ext-code', {
      value: ext.glsl, readOnly: !editable, spellcheck: false, rows: 18,
      on: {
        input: (e) => { draft.glsl = e.target.value; changed(); },
        keydown: (e) => {
          // Tab indenta em vez de sair do campo
          if (e.key !== 'Tab' || !editable) return;
          e.preventDefault();
          const { selectionStart: s, selectionEnd: en, value } = code;
          code.value = `${value.slice(0, s)}  ${value.slice(en)}`;
          code.selectionStart = code.selectionEnd = s + 2;
          draft.glsl = code.value;
          changed();
        },
      },
    });
    const goToLine = (line) => {
      const lines = code.value.split('\n');
      const startPos = lines.slice(0, line - 1).reduce((n, l) => n + l.length + 1, 0);
      code.focus();
      code.setSelectionRange(startPos, startPos + (lines[line - 1] || '').length);
      code.scrollTop = Math.max(0, (line - 4) * 19);
    };
    const status = h('div');
    const check = () => status.replaceChildren(statusEl(diagnose(current()), goToLine));
    const changed = () => {
      dirty = true;
      saveBtn?.classList.add('primary');
      clearTimeout(compileTimer);
      compileTimer = setTimeout(check, 300);
    };

    const field = (label, key, attrs = {}) => h('label.field', {}, h('span', {}, label), h('input', {
      type: 'text', value: ext[key] || '', readOnly: !editable, ...attrs,
      on: { input: (e) => { draft[key] = e.target.value; if (key === 'name') renderList(); changed(); } },
    }));

    let saveBtn = null;
    const buttons = [];
    if (editable) {
      saveBtn = h(`button${dirty ? '.primary' : ''}`, { on: { click: save } }, draft.isNew ? 'Salvar e instalar' : 'Salvar');
      buttons.push(saveBtn);
    }
    if (!editable && isInstalled(ext.id)) buttons.push(h('button.primary', { on: { click: () => startDraft(ext, false) } }, 'Editar'));
    if (!editable && !ext.builtin && !isInstalled(ext.id)) {
      buttons.push(h('button.primary', { title: 'Esta extensão veio dentro do projeto aberto', on: { click: () => openInstallDialog(ext) } }, 'Instalar nesta máquina'));
    }
    buttons.push(h('button', {
      title: 'Cria uma cópia sua para modificar',
      on: {
        click: () => {
          if (!confirmDiscard()) return;
          const src = current();
          startDraft({ ...JSON.parse(exportExtension(src)), id: freeId(`meu.${slugify(src.name)}`), name: `${src.name} (cópia)` }, true);
        },
      },
    }, editable ? 'Duplicar' : 'Duplicar para editar'));
    if (!ext.builtin) {
      buttons.push(h('button', {
        title: 'Salva um arquivo .csfx.json para enviar a outras pessoas',
        on: {
          click: async () => {
            const r = validateExtension(current());
            if (!r.ok) return toast(r.errors[0], 'error');
            const saved = await saveFile(`${slugify(r.ext.name)}.csfx.json`, new TextEncoder().encode(exportExtension(r.ext)), [{ name: 'Extensão do CorteSeco Studio', extensions: ['json'] }]);
            if (saved) toast(`Extensão exportada: ${saved}`);
          },
        },
      }, 'Exportar arquivo…'));
    }
    if (!ext.builtin && isInstalled(ext.id) && !draft?.isNew) {
      buttons.push(h('button', {
        on: {
          click: () => {
            const inUse = usedExtensionIds().includes(ext.id);
            if (!confirm(inUse
              ? `"${ext.name}" está em uso neste projeto. Remover desta máquina? (O projeto guarda uma cópia e continua funcionando.)`
              : `Remover "${ext.name}" desta máquina?`)) return;
            removeExtension(ext.id);
            draft = null;
            dirty = false;
            selectedId = null;
            renderList();
            renderPane();
          },
        },
      }, 'Remover'));
    }

    paneEl.replaceChildren(
      h('div.ext-top', {},
        h('div.ext-meta', {},
          h('div.field-row', {}, field('Nome', 'name'), field('Autor', 'author')),
          h('div.field-row', {},
            field('Id (identifica a extensão nos projetos)', 'id', { readOnly: !editable || !draft?.isNew, title: 'Letras minúsculas, números, ponto e hífen. Não muda depois de salvo.' }),
            h('label.field', { style: { flex: '0 0 110px' } }, h('span', {}, 'Tipo'), h('input', { type: 'text', readOnly: true, value: kindLabel(ext.kind) }))),
          field('Descrição', 'description'),
        ),
        preview.el,
      ),
      h('div.field', {}, h('span', {}, editable ? 'Parâmetros (viram controles no inspector e variáveis no código)' : 'Parâmetros'), paramTable(current(), editable, changed)),
      h('label.field', {}, h('span', {}, editable ? 'Código GLSL' : 'Código GLSL (somente leitura — duplique para modificar)'), code),
      status,
      h('div.ext-buttons', {}, ...buttons),
    );
    check();

    function save() {
      const r = validateExtension(draft);
      if (!r.ok) return toast(r.errors[0], 'error');
      if (draft.isNew && getExtension(r.ext.id)) return toast(`Já existe uma extensão com o id "${r.ext.id}". Escolha outro.`, 'error');
      const compiled = diagnose(r.ext).ok;
      installExtension(r.ext);
      draft = null;
      dirty = false;
      selectedId = r.ext.id;
      renderList();
      renderPane();
      toast(compiled ? `"${r.ext.name}" salvo` : `"${r.ext.name}" salvo, mas o código ainda não compila`, compiled ? '' : 'error');
    }
  }

  const unsubscribe = onExtensionsChange(() => { renderList(); if (!draft) renderPane(); });
  screen = openModal({
    title: 'Extensões: efeitos, transições e entradas/saídas',
    dismissable: false,
    body: h('div.ext-screen', {}, listEl, paneEl),
    footer: [h('button', { on: { click: () => { if (confirmDiscard()) screen.close(); } } }, 'Fechar')],
    onClose: () => {
      preview?.stop();
      clearTimeout(compileTimer);
      unsubscribe();
      screen = null;
    },
  });
  screen.el.classList.add('wide', 'ext-modal');
  renderList();
  renderPane();
}

/** Tabela de parâmetros (editável ou não). */
function paramTable(ext, editable, changed) {
  const box = h('div.ext-params');
  const render = () => {
    const rows = (ext.params || []).map((p, i) => {
      if (!editable) return h('div.ext-param', {}, h('code', {}, p.name), h('span', {}, p.label || p.name), h('span', {}, PARAM_LABELS[p.type] || p.type), h('span', {}, `padrão: ${JSON.stringify(p.default)}`));
      const set = (key, value) => { p[key] = value; changed(); };
      const text = (key, placeholder, width) => h('input', { type: 'text', value: p[key] ?? '', placeholder, style: { width }, on: { input: (e) => set(key, e.target.value) } });
      const number = (key, placeholder) => h('input', {
        type: 'number', step: 'any', value: p[key] ?? '', placeholder, style: { width: '70px' },
        on: { input: (e) => { if (e.target.value === '') delete p[key]; else p[key] = Number(e.target.value); changed(); } },
      });
      let def;
      if (p.type === 'bool') def = h('input', { type: 'checkbox', checked: !!p.default, on: { change: (e) => set('default', e.target.checked) } });
      else if (p.type === 'color' || p.type === 'color3') def = h('input', { type: 'color', value: String(defaultFor(p)).slice(0, 7), on: { input: (e) => set('default', p.type === 'color' ? `${e.target.value}ff` : e.target.value) } });
      else if (p.type === 'vec2' || p.type === 'ivec2') {
        def = h('span', {}, ...[0, 1].map((k) => h('input', {
          type: 'number', step: 'any', value: defaultFor(p)[k], style: { width: '58px' },
          on: { input: (e) => { const v = [...defaultFor(p)]; v[k] = Number(e.target.value) || 0; set('default', v); } },
        })));
      } else def = number('default', 'padrão');
      const ranged = p.type === 'float' || p.type === 'int';
      return h('div.ext-param', {},
        text('name', 'nome no código', '120px'),
        text('label', 'nome exibido', '130px'),
        h('select', { on: { change: (e) => { p.type = e.target.value; p.default = defaultFor({ type: p.type }); changed(); render(); } } },
          ...Object.entries(PARAM_LABELS).map(([v, n]) => h('option', { value: v, selected: v === p.type }, n))),
        def,
        ranged ? number('min', 'mín.') : null,
        ranged ? number('max', 'máx.') : null,
        h('button.icon', { title: 'Remover parâmetro', on: { click: () => { ext.params.splice(i, 1); changed(); render(); } } }, '✕'),
      );
    });
    box.replaceChildren(...[...rows,
      !rows.length ? h('div.insp-note', { style: { padding: 0 } }, 'Nenhum parâmetro.') : null,
      editable ? h('button', {
        on: {
          click: () => {
            ext.params ||= [];
            let n = ext.params.length + 1;
            while (ext.params.some((p) => p.name === `valor${n}`)) n++;
            ext.params.push({ name: `valor${n}`, label: `Valor ${n}`, type: 'float', default: 0.5, min: 0, max: 1 });
            changed();
            render();
          },
        },
      }, '+ Parâmetro') : null].filter(Boolean));
  };
  render();
  return box;
}

