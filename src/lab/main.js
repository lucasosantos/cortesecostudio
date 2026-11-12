// FX Lab: editor de extensões (efeitos, transições e entradas/saídas) que roda na página do GitHub Pages.
// Usa o mesmo motor de shaders do app (src/fx), então o que compila e aparece aqui é o que o app instala.
import { FORMAT, validateExtension, exportExtension, readExtensionFile, slugify } from '../fx/registry.js';
import {
  buildSource, parseShaderLog, uniformValue, defaultFor, PARAM_GLSL, PARAM_LABELS, isParamName, ANIM_PAD, ENTRY_FUNCTION,
} from '../fx/shader.js';
import { checkShader, runChain, runTransition, glAvailable } from '../fx/gl.js';
import { TEMPLATES, examples, REFERENCE } from './examples.js';
import { h, controlFor } from './ui.js';
import { generate, newSpec, readVisualTag, stripVisualTag, visualPresets, samplesPerPixel } from './visual.js';
import { renderBuilder } from './builder.js';

const PW = 640;
const PH = 360;
const LINE_H = 21;
const DRAFT_KEY = 'corteseco.lab.draft';
const APP_STORE_KEY = 'corteseco.extensions'; // mesma chave do app web (mesma origem no GitHub Pages)
const KIND_LABELS = { effect: 'Efeito', transition: 'Transição', animation: 'Entrada/saída' };

const $ = (id) => document.getElementById(id);

let toastTimer = 0;
function toast(text, type = '') {
  const el = $('toast');
  el.textContent = text;
  el.className = `toast show ${type}`;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { el.className = 'toast'; }, type === 'error' ? 5000 : 2800);
}

// ---------------------------------------------------------------- estado
let ext = null; // extensão em edição
let idTouched = false; // o usuário editou o id à mão? (se não, ele acompanha o nome)
let codeFrag = ''; // último shader que compilou (a pré-visualização continua com ele enquanto há erro)
let compileOk = false;
let errorLines = new Set();
let mode = 'code'; // 'visual' = os formulários geram o código; 'code' = o código é editado à mão
let visual = null; // montagem do modo visual (fica guardada no modo código para poder voltar)
let visualPreview = null; // { frag, uniforms }: versão com todo campo como uniform (ajuste ao vivo sem recompilar)
let tab = 'visual';

const clone = (o) => JSON.parse(JSON.stringify(o));

function fromTemplate(kind) {
  const t = TEMPLATES[kind];
  return { format: FORMAT, version: 1, id: `meu.${slugify(t.name)}`, name: t.name, kind, author: '', description: '', params: clone(t.params), glsl: t.glsl };
}

function setExtension(next, { touched = true, keepVisual = null } = {}) {
  ext = {
    format: FORMAT, version: 1, id: next.id || 'meu.extensao', name: next.name || 'Sem nome', kind: ENTRY_FUNCTION[next.kind] ? next.kind : 'effect',
    author: next.author || '', description: next.description || '', params: clone(next.params || []), glsl: next.glsl || '',
  };
  idTouched = touched;
  codeFrag = '';
  const spec = readVisualTag(ext.glsl);
  if (spec) {
    visual = spec;
    ext.kind = spec.kind;
    mode = 'visual';
  } else {
    visual = keepVisual;
    mode = 'code';
  }
  syncMeta();
  updateKindUI();
  if (mode === 'visual') regenerate(true);
  else { $('code').value = ext.glsl; renderGutter(); renderParams(); }
  setTab(mode);
  renderModeUI();
  compileNow();
  saveDraft();
}

/** Começa uma extensão nova no modo visual. */
function newVisual(kind, spec = newSpec(kind), name = TEMPLATES[kind].name) {
  const g = generate(spec);
  setExtension({ id: `meu.${slugify(name)}`, name, kind, glsl: g.glsl, params: g.params }, { touched: false });
}

// ---------------------------------------------------------------- metadados
function syncMeta() {
  $('m-name').value = ext.name;
  $('m-kind').value = ext.kind;
  $('m-id').value = ext.id;
  $('m-author').value = ext.author;
  $('m-desc').value = ext.description;
}

const autoId = () => `${slugify(ext.author) === 'extensao' || !ext.author.trim() ? 'meu' : slugify(ext.author)}.${slugify(ext.name)}`.slice(0, 64);

function bindMeta() {
  $('m-name').addEventListener('input', (e) => {
    ext.name = e.target.value;
    if (!idTouched) { ext.id = autoId(); $('m-id').value = ext.id; }
    changed();
  });
  $('m-author').addEventListener('input', (e) => {
    ext.author = e.target.value;
    if (!idTouched) { ext.id = autoId(); $('m-id').value = ext.id; }
    changed();
  });
  $('m-id').addEventListener('input', (e) => { ext.id = e.target.value.trim(); idTouched = true; changed(); });
  $('m-desc').addEventListener('input', (e) => { ext.description = e.target.value; changed(); });
  $('m-kind').addEventListener('change', (e) => {
    const kind = e.target.value;
    if (mode === 'visual') {
      if (!confirm(`Trocar para ${KIND_LABELS[kind].toLowerCase()} recomeça a montagem visual. Continuar?`)) { e.target.value = ext.kind; return; }
      ext.kind = kind;
      visual = newSpec(kind);
      updateKindUI();
      regenerate(true);
      return;
    }
    const fn = ENTRY_FUNCTION[kind];
    const hasEntry = new RegExp(`\\b${fn}\\s*\\(`).test(ext.glsl);
    if (!hasEntry && confirm(`${KIND_LABELS[kind]} precisa da função "vec4 ${fn}(vec2 uv)". Trocar o código e os parâmetros pelo modelo de ${KIND_LABELS[kind].toLowerCase()}?`)) {
      const t = TEMPLATES[kind];
      ext.glsl = t.glsl;
      ext.params = clone(t.params);
      $('code').value = ext.glsl;
      renderGutter();
      renderParams();
    }
    ext.kind = kind;
    if (visual && visual.kind !== kind) visual = null;
    updateKindUI();
    renderModeUI();
    changed(true);
  });
}

function updateKindUI() {
  const ref = REFERENCE[ext.kind];
  $('entry-sig').textContent = ref.entry;
  $('ref').replaceChildren(
    h('dl', {}, ...ref.items.flatMap(([k, v]) => [h('dt', {}, h('code', {}, k)), h('dd', {}, v)])),
    h('p', {}, 'Os parâmetros da lista ao lado viram uniforms com o nome declarado (não declare de novo no código). Tipos: ',
      Object.entries(PARAM_GLSL).map(([t, g]) => `${PARAM_LABELS[t]} → ${g}`).join(' · '), '.'),
  );
  $('src-a-label').textContent = ext.kind === 'transition' ? 'Cena anterior' : ext.kind === 'animation' ? 'Elemento' : 'Imagem';
  $('src-b').hidden = ext.kind !== 'transition';
  $('src-bg').hidden = ext.kind !== 'animation';
  $('duration').closest('.f').hidden = ext.kind === 'effect';
}

// ---------------------------------------------------------------- modo visual
/** Refaz código e parâmetros a partir da montagem. structural = a forma do código mudou (redesenha formulários). */
function regenerate(structural) {
  const out = generate(visual);
  ext.glsl = out.glsl;
  ext.params = out.params;
  const prev = generate(visual, { allUniforms: true });
  const frag = buildSource({ kind: visual.kind, params: prev.params, glsl: stripVisualTag(prev.glsl) });
  const uniforms = {};
  for (const p of prev.params) uniforms[p.name] = uniformValue(p, p.default);
  visualPreview = { frag, uniforms };
  const ta = $('code');
  if (ta.value !== ext.glsl) { ta.value = ext.glsl; renderGutter(); }
  if (structural) {
    renderBuilder($('builder'), visual, onBuilderChange);
    renderParams();
  }
  changed(structural);
}

function onBuilderChange(structural) {
  regenerate(false);
  if (structural) renderParams();
}

function toCode() {
  if (mode !== 'visual') return;
  if (!confirm('Editar o código à mão desliga os formulários desta extensão. Você pode voltar ao visual depois, mas perde o que mudar no código. Continuar?')) return;
  mode = 'code';
  ext.glsl = stripVisualTag(ext.glsl);
  $('code').value = ext.glsl;
  renderGutter();
  renderParams();
  renderModeUI();
  setTab('code');
  $('code').focus();
  changed(true);
}

function toVisual() {
  if (mode === 'visual') return;
  if (visual && visual.kind === ext.kind) {
    if (!confirm('Voltar à montagem visual descarta as alterações feitas no código. Continuar?')) return;
  } else {
    if (!confirm('Começar uma montagem visual substitui o código atual. Continuar?')) return;
    visual = newSpec(ext.kind);
  }
  mode = 'visual';
  regenerate(true);
  renderModeUI();
  setTab('visual');
}

function setTab(next) {
  tab = next;
  for (const b of document.querySelectorAll('.tabs [data-tab]')) {
    const on = b.dataset.tab === tab;
    b.setAttribute('aria-selected', String(on));
    b.tabIndex = on ? 0 : -1;
  }
  $('tab-visual').hidden = tab !== 'visual';
  $('tab-code').hidden = tab !== 'code';
  if (tab === 'code') requestAnimationFrame(renderGutter);
}

function renderModeUI() {
  const isVisual = mode === 'visual';
  $('mode-badge').replaceChildren(isVisual ? h('span', {}, 'Montagem ', h('b', {}, 'visual')) : h('span', {}, 'Escrita em ', h('b', {}, 'código')));
  $('code').readOnly = isVisual;
  $('code-banner').hidden = !isVisual;
  $('code-banner').replaceChildren(h('span', {}, 'Código gerado pelos formulários (somente leitura).'),
    h('button.btn.small', { type: 'button', on: { click: toCode } }, 'Editar o código à mão'));
  $('visual-banner').hidden = isVisual;
  $('builder').hidden = !isVisual;
  const canReturn = visual && visual.kind === ext.kind;
  $('visual-banner').replaceChildren(
    h('span', {}, canReturn ? 'Esta extensão está sendo editada em código.' : 'Esta extensão foi escrita em código, então não tem formulários.'),
    h('button.btn.small', { type: 'button', on: { click: toVisual } }, canReturn ? 'Voltar à montagem visual' : 'Começar montagem visual'));
  $('btn-add-param').hidden = isVisual;
  $('params-hint').textContent = isVisual
    ? 'No modo visual, os parâmetros do app são os campos marcados com “◇ App” nos formulários.'
    : 'Viram controles no inspector do app (e aceitam keyframes). O valor ajustado aqui é o padrão.';
  if (isVisual) renderBuilder($('builder'), visual, onBuilderChange);
  renderParams();
}

function bindTabs() {
  const btns = [...document.querySelectorAll('.tabs [data-tab]')];
  for (const b of btns) {
    b.addEventListener('click', () => setTab(b.dataset.tab));
    b.addEventListener('keydown', (e) => {
      if (e.key !== 'ArrowRight' && e.key !== 'ArrowLeft') return;
      const next = btns[(btns.indexOf(b) + 1) % btns.length];
      setTab(next.dataset.tab);
      next.focus();
    });
  }
}

// ---------------------------------------------------------------- editor de código
function renderGutter() {
  const n = $('code').value.split('\n').length;
  const g = $('gutter');
  const inner = g.firstChild || g.appendChild(h('div'));
  if (inner.childElementCount !== n) {
    inner.replaceChildren(...Array.from({ length: n }, (_, i) => h('div.ln', {}, String(i + 1))));
  }
  [...inner.children].forEach((d, i) => d.classList.toggle('err', errorLines.has(i + 1)));
  syncGutterScroll();
}
const syncGutterScroll = () => { $('gutter').firstChild.style.transform = `translateY(${-$('code').scrollTop}px)`; };

function goToLine(line) {
  const ta = $('code');
  const lines = ta.value.split('\n');
  const start = lines.slice(0, line - 1).reduce((s, l) => s + l.length + 1, 0);
  ta.focus();
  ta.setSelectionRange(start, start + (lines[line - 1]?.length || 0));
  ta.scrollTop = Math.max(0, (line - 4) * LINE_H);
  syncGutterScroll();
}

function bindEditor() {
  const ta = $('code');
  let escaped = false; // depois de Esc, Tab sai do editor (não fica preso no campo)
  ta.addEventListener('input', () => { if (mode !== 'code') return; ext.glsl = ta.value; renderGutter(); changed(); });
  ta.addEventListener('scroll', syncGutterScroll);
  ta.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') { escaped = true; return; }
    if (ta.readOnly) return;
    if (e.key === 'Tab' && !escaped && !e.ctrlKey && !e.altKey && !e.metaKey) {
      e.preventDefault();
      const { selectionStart: s, selectionEnd: end, value } = ta;
      if (e.shiftKey) {
        const lineStart = value.lastIndexOf('\n', s - 1) + 1;
        const cut = value.slice(lineStart, lineStart + 2).match(/^ {1,2}/)?.[0].length || 0;
        if (cut) {
          ta.setRangeText('', lineStart, lineStart + cut, 'preserve');
          ta.setSelectionRange(Math.max(lineStart, s - cut), Math.max(lineStart, end - cut));
        }
      } else {
        ta.setRangeText('  ', s, end, 'end');
      }
      ta.dispatchEvent(new Event('input'));
      return;
    }
    escaped = false;
    if (e.key === 'Enter' && !e.ctrlKey && !e.metaKey) {
      // mantém o recuo da linha atual (e aumenta depois de "{")
      e.preventDefault();
      const { selectionStart: s, selectionEnd: end, value } = ta;
      const lineStart = value.lastIndexOf('\n', s - 1) + 1;
      const indent = value.slice(lineStart, s).match(/^\s*/)[0];
      const extra = /\{\s*$/.test(value.slice(lineStart, s)) ? '  ' : '';
      ta.setRangeText(`\n${indent}${extra}`, s, end, 'end');
      ta.dispatchEvent(new Event('input'));
    }
  });
  $('btn-ref').addEventListener('click', () => {
    const ref = $('ref');
    ref.hidden = !ref.hidden;
    $('btn-ref').textContent = ref.hidden ? 'Referência' : 'Ocultar referência';
  });
}

// ---------------------------------------------------------------- compilação
let compileTimer = 0;
function changed(now = false) {
  clearTimeout(compileTimer);
  compileTimer = setTimeout(compileNow, now ? 0 : 250);
  saveDraftSoon();
}

function compileNow() {
  const status = $('status');
  if (!glAvailable()) {
    compileOk = false;
    status.replaceChildren(h('span.warn', {}, 'WebGL2 não está disponível neste navegador: não dá para compilar nem pré-visualizar.'));
    return;
  }
  const frag = buildSource(ext);
  const r = checkShader(frag);
  compileOk = r.ok;
  const meta = validateExtension(ext).errors.filter((e) => !/GLSL|função/.test(e));
  if (r.ok) {
    codeFrag = frag;
    errorLines = new Set();
    const taps = mode === 'visual' ? samplesPerPixel(visual) : 1;
    status.replaceChildren(...[
      h('span.ok', {}, '✓ Compila sem erros.'),
      taps > 100 ? h('div.warn', {}, `⚠ Pesado: cada pixel lê a imagem ${taps} vezes, porque as camadas de leitura (desfoque, brilho, separação RGB) se multiplicam. Use só uma ou duas delas.`) : null,
      ...meta.map((m) => h('div.warn', {}, `⚠ ${m}`)),
    ].filter(Boolean));
  } else {
    const errs = parseShaderLog(r.log, ext.glsl.split('\n').length);
    errorLines = new Set(errs.map((e) => e.line).filter(Boolean));
    status.replaceChildren(h('div.errs', {},
      ...errs.map((e) => h('button.err-item', { title: e.line ? 'Ir para a linha' : '', on: { click: () => e.line && goToLine(e.line) } },
        e.line ? h('b', {}, `Linha ${e.line}: `) : null, e.message)),
      ...meta.map((m) => h('div.warn', {}, `⚠ ${m}`))));
  }
  renderGutter();
}

// ---------------------------------------------------------------- parâmetros
const NUMERIC = new Set(['float', 'int']);

const openDefs = new Set(); // parâmetros com a definição aberta (sobrevive ao redesenho)

function renderParams() {
  const box = $('params');
  if (mode === 'visual') {
    box.replaceChildren(ext.params.length
      ? h('ul.exposed-list', {}, ext.params.map((p) => h('li', {}, h('span', {}, p.label), h('code', {}, p.name))))
      : h('p.empty', {}, 'Nenhum ainda: tudo fica fixo no código. Marque “◇ App” num campo para poder ajustá-lo e animá-lo no app.'));
    return;
  }
  if (!ext.params.length) {
    box.replaceChildren(h('p.empty', {}, 'Nenhum parâmetro. Use “+ Parâmetro” para criar um controle (força, cor, direção…).'));
    return;
  }
  box.replaceChildren(...ext.params.map((p, i) => {
    const key = p;
    const def = paramDefinition(p, i);
    def.hidden = !openDefs.has(key);
    const toggle = () => {
      def.hidden = !def.hidden;
      if (def.hidden) openDefs.delete(key); else openDefs.add(key);
    };
    return h('div.param', {},
      h('div.param-row', {},
        h('div.pl', { title: p.label }, p.label || p.name, h('small', {}, `${p.name} · ${PARAM_GLSL[p.type] || '?'}`)),
        controlFor(p, saveDraftSoon),
        h('div.param-actions', {},
          h('button', { title: 'Editar definição', 'aria-label': `Editar ${p.label}`, on: { click: toggle } }, '✎'),
          i > 0 ? h('button', { title: 'Subir', 'aria-label': `Subir ${p.label}`, on: { click: () => { ext.params.splice(i - 1, 0, ...ext.params.splice(i, 1)); renderParams(); changed(); } } }, '↑') : null,
          h('button', { title: 'Remover', 'aria-label': `Remover ${p.label}`, on: { click: () => { ext.params.splice(i, 1); renderParams(); changed(true); } } }, '✕'),
        )),
      def);
  }));
}

function paramDefinition(p) {
  const field = (label, input) => h('label.f', {}, h('span', {}, label), input);
  const nameOk = (n) => isParamName(n) && ext.params.filter((q) => q.name === n).length <= 1;
  const name = h('input', {
    value: p.name, spellcheck: false, class: nameOk(p.name) ? '' : 'bad',
    on: {
      input: (e) => {
        p.name = e.target.value.trim();
        e.target.classList.toggle('bad', !nameOk(p.name));
        changed();
      },
      change: () => renderParams(),
    },
  });
  const label = h('input', { value: p.label, on: { input: (e) => { p.label = e.target.value; saveDraftSoon(); }, change: () => renderParams() } });
  const type = h('select', {
    on: {
      change: (e) => {
        p.type = e.target.value;
        p.default = defaultFor({ type: p.type });
        if (!NUMERIC.has(p.type)) { delete p.min; delete p.max; delete p.step; }
        renderParams();
        changed(true);
      },
    },
  }, ...Object.keys(PARAM_GLSL).map((t) => h('option', { value: t, selected: t === p.type }, `${PARAM_LABELS[t]} (${PARAM_GLSL[t]})`)));
  const num = (k) => h('input', {
    type: 'number', value: Number.isFinite(p[k]) ? p[k] : '', placeholder: 'auto',
    on: {
      change: (e) => {
        const v = e.target.value === '' ? undefined : Number(e.target.value);
        if (v === undefined || !Number.isFinite(v)) delete p[k]; else p[k] = v;
        renderParams();
        saveDraftSoon();
      },
    },
  });
  return h('div.param-def', {},
    field('Nome no código', name), field('Rótulo', label), field('Tipo', type),
    ...(NUMERIC.has(p.type) ? [field('Mínimo', num('min')), field('Máximo', num('max')), field('Passo', num('step'))] : []));
}

function addParam() {
  const used = new Set(ext.params.map((p) => p.name));
  let n = 1;
  while (used.has(`valor${n}`)) n++;
  const p = { name: `valor${n}`, label: `Valor ${n}`, type: 'float', default: 0.5, min: 0, max: 1, step: 0.01 };
  ext.params.push(p);
  openDefs.add(p);
  renderParams();
  changed(true);
}

/** Valores dos parâmetros válidos no formato dos uniforms. */
function paramUniformValues() {
  const u = {};
  for (const p of ext.params) if (PARAM_GLSL[p.type] && isParamName(p.name)) u[p.name] = uniformValue(p, p.default);
  return u;
}

// ---------------------------------------------------------------- imagens de origem
function makeTestImage(letter, top, bottom) {
  const c = Object.assign(document.createElement('canvas'), { width: PW, height: PH });
  const g = c.getContext('2d');
  const k = PW / 384;
  const grad = g.createLinearGradient(0, 0, PW, PH);
  grad.addColorStop(0, top);
  grad.addColorStop(1, bottom);
  g.fillStyle = grad;
  g.fillRect(0, 0, PW, PH);
  ['#ff3b3b', '#ffd24a', '#00d800', '#4f8cff', '#ffffff', '#000000'].forEach((color, i) => {
    g.fillStyle = color;
    g.fillRect((16 + i * 30) * k, PH - 44 * k, 30 * k, 28 * k);
  });
  g.fillStyle = 'rgba(255,255,255,.92)';
  g.font = `bold ${Math.round(110 * k)}px Inter, Arial, sans-serif`;
  g.textAlign = 'center';
  g.textBaseline = 'middle';
  g.fillText(letter, PW / 2, PH / 2 - 14 * k);
  g.beginPath();
  g.arc(PW - 60 * k, 56 * k, 30 * k, 0, Math.PI * 2);
  g.fillStyle = 'rgba(255,255,255,.5)';
  g.fill();
  return c;
}

const TEST = { a: makeTestImage('A', '#243b6b', '#7a2a5e'), b: makeTestImage('B', '#1f6b48', '#c9a227') };
/** Mídia escolhida pelo usuário em cada entrada: { el, canvas, video } */
const user = { a: null, b: null };
const sourceMode = { a: 'test', b: 'test' };

function drawCover(g, el, w, h) {
  const sw = el.videoWidth || el.naturalWidth || el.width;
  const sh = el.videoHeight || el.naturalHeight || el.height;
  if (!sw || !sh) return;
  const k = Math.max(w / sw, h / sh);
  g.clearRect(0, 0, w, h);
  g.drawImage(el, (w - sw * k) / 2, (h - sh * k) / 2, sw * k, sh * k);
}

function source(slot) {
  const u = sourceMode[slot] === 'user' ? user[slot] : null;
  if (!u) return TEST[slot];
  if (u.video && u.video.readyState >= 2) drawCover(u.canvas.getContext('2d'), u.video, PW, PH);
  return u.canvas;
}

let pendingSlot = 'a';
function bindSources() {
  for (const sel of document.querySelectorAll('select[data-src]')) {
    sel.addEventListener('change', () => {
      const slot = sel.dataset.src;
      if (sel.value === 'file') {
        sel.value = sourceMode[slot];
        pendingSlot = slot;
        $('media-input').click();
        return;
      }
      sourceMode[slot] = sel.value;
    });
  }
  $('media-input').addEventListener('change', async (e) => {
    const file = e.target.files[0];
    e.target.value = '';
    if (file) await loadMedia(file, pendingSlot);
  });
}

async function loadMedia(file, slot) {
  const url = URL.createObjectURL(file);
  const canvas = Object.assign(document.createElement('canvas'), { width: PW, height: PH });
  const old = user[slot];
  try {
    if (file.type.startsWith('video/')) {
      const video = Object.assign(document.createElement('video'), { src: url, muted: true, loop: true, playsInline: true });
      await new Promise((ok, fail) => { video.onloadeddata = ok; video.onerror = () => fail(new Error('vídeo')); });
      await video.play().catch(() => {});
      user[slot] = { canvas, video, url };
    } else {
      const img = new Image();
      img.src = url;
      await img.decode();
      drawCover(canvas.getContext('2d'), img, PW, PH);
      user[slot] = { canvas, url };
    }
  } catch {
    URL.revokeObjectURL(url);
    toast(`Não foi possível abrir "${file.name}" neste navegador.`, 'error');
    return;
  }
  if (old) { old.video?.pause(); URL.revokeObjectURL(old.url); }
  sourceMode[slot] = 'user';
  const sel = document.querySelector(`select[data-src="${slot}"]`);
  sel.querySelector('option[value="user"]')?.remove();
  sel.insertBefore(h('option', { value: 'user' }, file.name.length > 28 ? `${file.name.slice(0, 26)}…` : file.name), sel.querySelector('option[value="file"]'));
  sel.value = 'user';
}

// ---------------------------------------------------------------- pré-visualização
let playing = true;
let clock = 0; // segundos dentro do ciclo
let lastNow = performance.now();

const duration = () => Number($('duration').value) || 1;
const clamp01 = (v) => Math.max(0, Math.min(1, v));

/** Duração do ciclo da pré-visualização para o tipo atual. */
function cycleLength() {
  const d = duration();
  if (ext.kind === 'transition') return d + 1.2;
  if (ext.kind === 'animation') return 2 * d + 1.8;
  return 4;
}

/** Tempo, progress e entering no ponto `pos` do ciclo. */
function timing(pos) {
  const d = duration();
  if (ext.kind === 'transition') return { time: pos, progress: clamp01((pos - 0.6) / d) };
  if (ext.kind === 'animation') {
    const entering = pos < 0.3 + d + 0.6;
    const progress = entering ? clamp01((pos - 0.3) / d) : 1 - clamp01((pos - (0.3 + d + 1.2)) / d);
    return { time: pos, progress, entering };
  }
  return { time: pos, progress: pos / 4 };
}

let checker = null;
function background(g) {
  if ($('anim-bg').value === 'b') { g.drawImage(TEST.b, 0, 0, PW, PH); return; }
  if (!checker) {
    checker = Object.assign(document.createElement('canvas'), { width: PW, height: PH });
    const c = checker.getContext('2d');
    for (let y = 0; y < PH; y += 20) {
      for (let x = 0; x < PW; x += 20) {
        c.fillStyle = ((x + y) / 20) % 2 ? '#2a2a30' : '#222227';
        c.fillRect(x, y, 20, 20);
      }
    }
  }
  g.drawImage(checker, 0, 0);
}

function renderFrame(g, t) {
  const vis = mode === 'visual' && visualPreview;
  const uniforms = vis ? visualPreview.uniforms : paramUniformValues();
  const goodFrag = vis ? visualPreview.frag : codeFrag;
  if (!goodFrag) {
    g.drawImage(source('a'), 0, 0, PW, PH);
    return;
  }
  if (ext.kind === 'transition') {
    const out = runTransition(source('a'), source('b'), PW, PH, goodFrag, { ...uniforms, progress: t.progress, time: t.time });
    if (out) g.drawImage(out, 0, 0, PW, PH);
    return;
  }
  if (ext.kind === 'animation') {
    // o elemento ocupa metade do quadro, com a margem de ANIM_PAD em volta (igual ao app)
    const EW = PW / 2;
    const EH = PH / 2;
    const pw = EW + 2 * Math.round(EW * ANIM_PAD);
    const ph = EH + 2 * Math.round(EH * ANIM_PAD);
    const out = runChain(source('a'), pw, ph, [{
      frag: goodFrag,
      uniforms: {
        ...uniforms, time: t.time, progress: t.progress, entering: t.entering ? 1 : 0,
        resolution: [EW, EH], ratio: EW / EH, uBox: [(pw - EW) / 2 / pw, (ph - EH) / 2 / ph, EW / pw, EH / ph],
      },
    }]);
    background(g);
    if (out) g.drawImage(out, (PW - pw) / 2, (PH - ph) / 2, pw, ph);
    return;
  }
  const out = runChain(source('a'), PW, PH, [{ frag: goodFrag, uniforms: { ...uniforms, time: t.time, progress: t.progress } }]);
  if (out) g.drawImage(out, 0, 0, PW, PH);
}

function startPreview() {
  const canvas = $('preview');
  const g = canvas.getContext('2d');
  const scrub = $('scrub');
  const playBtn = $('btn-play');
  const setPlaying = (v) => {
    playing = v;
    playBtn.textContent = v ? '❚❚' : '▶';
    playBtn.setAttribute('aria-label', v ? 'Pausar' : 'Tocar');
  };
  setPlaying(true);
  playBtn.addEventListener('click', () => setPlaying(!playing));
  scrub.addEventListener('input', () => {
    setPlaying(false);
    clock = (scrub.value / 1000) * cycleLength();
  });
  $('duration').addEventListener('change', () => { clock = Math.min(clock, cycleLength()); });
  document.addEventListener('keydown', (e) => {
    if (e.key !== ' ' || e.target.closest('input, textarea, select, button')) return;
    e.preventDefault();
    setPlaying(!playing);
  });

  const frame = (now) => {
    requestAnimationFrame(frame);
    const dt = Math.min(0.1, (now - lastNow) / 1000);
    lastNow = now;
    const len = cycleLength();
    if (playing) clock = (clock + dt) % len;
    const t = timing(clock);
    g.clearRect(0, 0, PW, PH);
    renderFrame(g, t);
    if (playing) scrub.value = Math.round((clock / len) * 1000);
    $('readout').textContent = `progress ${t.progress.toFixed(2)} · time ${t.time.toFixed(2)} s${ext.kind === 'animation' ? ` · ${t.entering ? 'entrando' : 'saindo'}` : ''}`;
  };
  requestAnimationFrame(frame);
}

// ---------------------------------------------------------------- arquivos e links
function validated() {
  const r = validateExtension(ext);
  if (!r.ok) { toast(r.errors[0], 'error'); return null; }
  if (!compileOk) { toast('O código não compila: corrija os erros antes de exportar.', 'error'); return null; }
  return r.ext;
}

function download() {
  const ok = validated();
  if (!ok) return;
  const blob = new Blob([exportExtension(ok)], { type: 'application/json' });
  const a = h('a', { href: URL.createObjectURL(blob), download: `${ok.id}.csfx.json` });
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
  toast(`Baixado ${ok.id}.csfx.json — arraste o arquivo para o CorteSeco Studio para instalar.`);
}

function installInWebApp() {
  const ok = validated();
  if (!ok) return;
  try {
    const list = JSON.parse(localStorage.getItem(APP_STORE_KEY) || '[]');
    const next = (Array.isArray(list) ? list : []).filter((e) => e?.id !== ok.id);
    next.push(JSON.parse(exportExtension(ok)));
    localStorage.setItem(APP_STORE_KEY, JSON.stringify(next));
  } catch {
    toast('O navegador bloqueou o armazenamento local: baixe o arquivo e instale pelo app.', 'error');
    return;
  }
  toast(`"${ok.name}" instalad${ok.kind === 'effect' ? 'o' : 'a'} no app web. Se o editor já estava aberto, recarregue a página dele.`);
  window.open('../app/', 'corteseco-app');
}

const b64url = (bytes) => btoa(String.fromCharCode(...bytes)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const fromB64url = (s) => Uint8Array.from(atob(s.replace(/-/g, '+').replace(/_/g, '/')), (c) => c.charCodeAt(0));

async function pipe(bytes, stream) {
  return new Uint8Array(await new Response(new Blob([bytes]).stream().pipeThrough(stream)).arrayBuffer());
}

async function shareLink() {
  const json = new TextEncoder().encode(exportExtension(ext));
  let hash;
  if (typeof CompressionStream !== 'undefined') hash = `z=${b64url(await pipe(json, new CompressionStream('deflate-raw')))}`;
  else hash = `j=${b64url(json)}`;
  const url = `${location.origin}${location.pathname}#${hash}`;
  try {
    await navigator.clipboard.writeText(url);
    toast(url.length > 8000 ? 'Link copiado (é longo: alguns apps de mensagem podem cortar).' : 'Link copiado: quem abrir verá esta extensão no FX Lab.');
  } catch {
    history.replaceState(null, '', `#${hash}`);
    toast('Não deu para copiar: o link está na barra de endereço.');
  }
}

async function readHash() {
  const m = /^#([zj])=(.+)$/.exec(location.hash);
  if (!m) return null;
  history.replaceState(null, '', location.pathname + location.search);
  try {
    let bytes = fromB64url(m[2]);
    if (m[1] === 'z') bytes = await pipe(bytes, new DecompressionStream('deflate-raw'));
    return JSON.parse(new TextDecoder().decode(bytes));
  } catch {
    toast('O link está incompleto ou corrompido.', 'error');
    return null;
  }
}

async function openFile(file) {
  if (/^(image|video)\//.test(file.type)) { await loadMedia(file, 'a'); return; }
  try {
    const loaded = readExtensionFile(await file.text(), file.name);
    setExtension(loaded, { touched: true });
    toast(`Aberto: ${loaded.name} (${KIND_LABELS[loaded.kind].toLowerCase()})`);
  } catch (err) {
    toast(`Não foi possível abrir "${file.name}": ${err.message}`, 'error');
  }
}

// ---------------------------------------------------------------- rascunho
let draftTimer = 0;
function saveDraftSoon() {
  clearTimeout(draftTimer);
  draftTimer = setTimeout(saveDraft, 400);
}
function saveDraft() {
  try { localStorage.setItem(DRAFT_KEY, JSON.stringify({ ext, idTouched, visual: mode === 'code' ? visual : null })); } catch { /* sem armazenamento */ }
}
function loadDraft() {
  try {
    const d = JSON.parse(localStorage.getItem(DRAFT_KEY) || 'null');
    return d?.ext?.glsl ? d : null;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------- menus
function bindMenus() {
  const menus = [...document.querySelectorAll('.menu')];
  const closeAll = () => menus.forEach((m) => m.classList.remove('open'));
  for (const m of menus) {
    m.querySelector('.btn').addEventListener('click', (e) => {
      e.stopPropagation();
      const open = !m.classList.contains('open');
      closeAll();
      m.classList.toggle('open', open);
      if (open) m.querySelector('.menu-pop button')?.focus();
    });
  }
  document.addEventListener('click', closeAll);
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape') closeAll(); });

  const confirmReplace = () => confirm('Substituir a extensão em edição? (O rascunho atual será perdido; baixe ou copie o link antes, se quiser guardar.)');
  for (const b of document.querySelectorAll('[data-new]')) {
    b.addEventListener('click', () => {
      if (!confirmReplace()) return;
      if (b.dataset.mode === 'visual') newVisual(b.dataset.new);
      else setExtension(fromTemplate(b.dataset.new), { touched: false });
    });
  }
  const pop = document.querySelector('#menu-examples .menu-pop');
  const groups = examples();
  const presets = visualPresets();
  for (const kind of ['effect', 'transition', 'animation']) {
    pop.append(h('h3', {}, KIND_LABELS[kind]));
    for (const pr of presets[kind]) {
      pop.append(h('button', {
        role: 'menuitem',
        on: { click: () => { if (confirmReplace()) newVisual(kind, structuredClone(pr.spec), pr.name); } },
      }, h('b', {}, `${pr.name} · visual`), h('span', {}, pr.desc)));
    }
    for (const ex of groups[kind]) {
      pop.append(h('button', {
        role: 'menuitem',
        on: {
          click: () => {
            if (!confirmReplace()) return;
            const copy = { ...clone(ex), id: ex.fromApp ? `meu.${ex.id.replace(/^anim\./, '')}` : ex.id };
            setExtension(copy, { touched: !ex.fromApp });
          },
        },
      }, h('b', {}, `${ex.name} · código${ex.fromApp ? ' (nativo)' : ''}`), h('span', {}, ex.description || '')));
    }
  }
}

// ---------------------------------------------------------------- início
async function init() {
  bindMeta();
  bindEditor();
  bindSources();
  bindMenus();
  bindTabs();
  $('btn-add-param').addEventListener('click', addParam);
  $('btn-download').addEventListener('click', download);
  $('btn-install-web').addEventListener('click', installInWebApp);
  $('btn-share').addEventListener('click', shareLink);
  $('btn-open').addEventListener('click', () => $('file-input').click());
  $('file-input').addEventListener('change', async (e) => {
    const f = e.target.files[0];
    e.target.value = '';
    if (f) await openFile(f);
  });
  document.addEventListener('keydown', (e) => {
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 's') { e.preventDefault(); download(); }
  });
  let dragDepth = 0;
  document.addEventListener('dragenter', (e) => { if (e.dataTransfer?.types.includes('Files')) { dragDepth++; document.body.classList.add('dragging'); } });
  document.addEventListener('dragleave', () => { if (--dragDepth <= 0) { dragDepth = 0; document.body.classList.remove('dragging'); } });
  document.addEventListener('dragover', (e) => e.preventDefault());
  document.addEventListener('drop', async (e) => {
    e.preventDefault();
    dragDepth = 0;
    document.body.classList.remove('dragging');
    const f = e.dataTransfer?.files?.[0];
    if (f) await openFile(f);
  });

  const shared = await readHash();
  const draft = loadDraft();
  if (shared) {
    const r = validateExtension(shared);
    setExtension(r.ext || shared, { touched: true });
    toast(`Extensão recebida por link: ${ext.name}`);
  } else if (draft) {
    setExtension(draft.ext, { touched: !!draft.idTouched, keepVisual: draft.visual || null });
  } else {
    newVisual('effect');
  }
  startPreview();
}

init();
