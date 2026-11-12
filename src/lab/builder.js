// Formulários do modo visual: monta a "spec" de visual.js sem escrever código.
import { h, controlFor } from './ui.js';
import { EFFECT_BLOCKS, STAGES, SHAPES, REVEALS, SECTIONS, effectBlock, withShape, generate } from './visual.js';

/** Limite de parâmetros de uma extensão no app. */
const MAX_PARAMS = 32;

/**
 * Desenha os formulários da montagem em `root`.
 * @param onChange(structural) structural = muda a forma do código (recompila); senão só valores (ajuste ao vivo)
 */
export function renderBuilder(root, spec, onChange) {
  const rerender = () => {
    const y = root.scrollTop;
    renderBuilder(root, spec, onChange);
    root.scrollTop = y;
  };
  const structural = () => { onChange(true); rerender(); };
  const ctx = { onChange, structural, rerender, full: generate(spec).params.length >= MAX_PARAMS };
  if (spec.kind === 'transition') root.replaceChildren(...transitionForm(spec, ctx));
  else if (spec.kind === 'animation') root.replaceChildren(...animationForm(spec, ctx));
  else root.replaceChildren(...effectForm(spec, ctx, root));
}

// ---------------------------------------------------------------- peças
function fieldRows(block, fields, ctx) {
  block.values ||= {};
  block.expose ||= [];
  return h('div.vfields', {}, fields.map((f) => {
    const val = block.values[f.key] ?? f.default;
    let control;
    if (f.type === 'select') {
      control = h('div.ctl', {}, h('select', { 'aria-label': f.label, on: { change: (e) => { block.values[f.key] = e.target.value; ctx.onChange(true); } } },
        Object.entries(f.options).map(([k, label]) => h('option', { value: k, selected: k === val }, label))));
    } else {
      control = controlFor({ type: f.type, label: f.label, default: structuredClone(val), min: f.min, max: f.max, step: f.step }, (v) => {
        block.values[f.key] = v;
        ctx.onChange(false);
      });
    }
    const exposed = block.expose.includes(f.key);
    const blocked = !exposed && ctx.full;
    const expose = f.type === 'select' ? h('span') : h(`button.expose${exposed ? '.on' : ''}`, {
      type: 'button', 'aria-pressed': exposed ? 'true' : 'false', disabled: blocked,
      title: blocked ? `Limite de ${MAX_PARAMS} parâmetros por extensão.` : exposed ? 'É um parâmetro no app (ajustável e animável com keyframes). Clique para fixar no código.'
        : 'Fixo no código. Clique para virar parâmetro no app (ajustável e animável com keyframes).',
      on: {
        click: () => {
          block.expose = exposed ? block.expose.filter((k) => k !== f.key) : [...block.expose, f.key];
          ctx.structural();
        },
      },
    }, exposed ? '◆ App' : '◇ App');
    return h('div.vfield', {}, h('span.vl', {}, f.label, f.hint ? h('small', {}, f.hint) : null), control, expose);
  }));
}

function card({ title, desc, toggle, on = true, onToggle, actions, body, cls = '' }) {
  const head = h('div.vhead', {},
    toggle ? h('label.vtoggle', {}, h('input', { type: 'checkbox', checked: on, on: { change: (e) => onToggle(e.target.checked) } }), h('b', {}, title))
      : h('b', {}, title),
    actions ? h('div.vactions', {}, actions) : null);
  return h(`section.vcard${cls}${on ? '' : '.off'}`, {}, head, desc ? h('p.vdesc', {}, desc) : null, on ? body : null);
}

function chips(options, selected, onPick, label) {
  return h('div.chips', { role: 'radiogroup', 'aria-label': label }, options.map(([key, name, desc]) => h(`button.chip${key === selected ? '.on' : ''}`, {
    type: 'button', role: 'radio', 'aria-checked': key === selected ? 'true' : 'false', title: desc || '',
    on: { click: () => { if (key !== selected) onPick(key); } },
  }, name)));
}

// ---------------------------------------------------------------- efeito
function effectForm(spec, ctx, root) {
  const list = spec.blocks;
  const out = [h('p.vintro', {}, 'Empilhe camadas. Elas são aplicadas nesta ordem: distorção → leitura da imagem → cor. Marque “◇ App” nos campos que devem virar controles no app.')];
  for (const [stage, title] of Object.entries(STAGES)) {
    const blocks = list.filter((b) => EFFECT_BLOCKS[b.type]?.stage === stage);
    if (!blocks.length) continue;
    out.push(h('h3.vstage', {}, title));
    for (const b of blocks) {
      const def = EFFECT_BLOCKS[b.type];
      const move = (dir) => {
        const i = list.indexOf(b);
        let j = i + dir;
        while (j >= 0 && j < list.length && EFFECT_BLOCKS[list[j].type].stage !== stage) j += dir;
        if (j < 0 || j >= list.length) return;
        [list[i], list[j]] = [list[j], list[i]];
        ctx.structural();
      };
      const idx = blocks.indexOf(b);
      out.push(card({
        title: def.label, desc: def.desc, toggle: true, on: b.on !== false,
        onToggle: (v) => { b.on = v; ctx.structural(); },
        actions: [
          h('button', { type: 'button', title: 'Subir', 'aria-label': `Subir ${def.label}`, disabled: idx === 0, on: { click: () => move(-1) } }, '↑'),
          h('button', { type: 'button', title: 'Descer', 'aria-label': `Descer ${def.label}`, disabled: idx === blocks.length - 1, on: { click: () => move(1) } }, '↓'),
          h('button', { type: 'button', title: 'Remover', 'aria-label': `Remover ${def.label}`, on: { click: () => { list.splice(list.indexOf(b), 1); ctx.structural(); } } }, '✕'),
        ],
        body: fieldRows(b, def.fields, ctx),
      }));
    }
  }
  if (!list.length) out.push(h('p.empty', {}, 'Nenhuma camada ainda. Adicione a primeira abaixo.'));

  const picker = h('div.picker', { hidden: root.dataset.picker !== 'open' },
    Object.entries(STAGES).map(([stage, title]) => [
      h('h4', {}, title),
      h('div.picker-grid', {}, Object.entries(EFFECT_BLOCKS).filter(([, d]) => d.stage === stage).map(([type, d]) => h('button', {
        type: 'button',
        on: {
          click: () => {
            list.push(effectBlock(type, list));
            root.dataset.picker = '';
            ctx.structural();
            requestAnimationFrame(() => { root.scrollTop = root.scrollHeight; });
          },
        },
      }, h('b', {}, d.label), h('span', {}, d.desc)))),
    ]));
  out.push(h('button.btn.add-layer', {
    type: 'button', 'aria-expanded': root.dataset.picker === 'open' ? 'true' : 'false',
    on: {
      click: (e) => {
        root.dataset.picker = picker.hidden ? 'open' : '';
        picker.hidden = !picker.hidden;
        e.currentTarget.setAttribute('aria-expanded', String(!picker.hidden));
      },
    },
  }, '+ Adicionar camada'), picker);
  return out;
}

// ---------------------------------------------------------------- transição
function transitionForm(spec, ctx) {
  const type = SHAPES[spec.shape?.type] ? spec.shape.type : 'fade';
  const shape = SHAPES[type];
  const slide = type === 'slide';
  const noEdge = slide || type === 'fade';
  return [
    h('p.vintro', {}, 'Escolha como a cena nova toma o lugar da anterior e ajuste. Marque “◇ App” nos campos que devem virar controles no app.'),
    card({
      title: 'Forma', desc: shape.desc,
      body: h('div', {},
        chips(Object.entries(SHAPES).map(([k, s]) => [k, s.label, s.desc]), type, (k) => { spec.shape = withShape(spec.shape, k); ctx.structural(); }, 'Forma da transição'),
        shape.fields.length ? fieldRows(spec.shape, shape.fields, ctx) : null),
    }),
    card({ title: 'Tempo', desc: 'Curva de aceleração da transição (a duração é definida no app).', body: fieldRows(spec.timing, SECTIONS.timing.fields, ctx) }),
    card({
      title: SECTIONS.motion.label, desc: slide ? 'Não se aplica a “Deslizar”, que já move as cenas.' : SECTIONS.motion.desc,
      toggle: !slide, on: !slide && !!spec.motion.on, onToggle: (v) => { spec.motion.on = v; ctx.structural(); },
      body: fieldRows(spec.motion, SECTIONS.motion.fields, ctx),
    }),
    card({
      title: SECTIONS.edge.label, desc: noEdge ? `Não se aplica a “${shape.label}”, que não tem uma borda de troca.` : SECTIONS.edge.desc,
      toggle: !noEdge, on: !noEdge && !!spec.edge.on, onToggle: (v) => { spec.edge.on = v; ctx.structural(); },
      body: fieldRows(spec.edge, SECTIONS.edge.fields, ctx),
    }),
    card({
      title: SECTIONS.flash.label, desc: SECTIONS.flash.desc, toggle: true, on: !!spec.flash.on,
      onToggle: (v) => { spec.flash.on = v; ctx.structural(); },
      body: fieldRows(spec.flash, SECTIONS.flash.fields, ctx),
    }),
  ];
}

// ---------------------------------------------------------------- entrada/saída
function animationForm(spec, ctx) {
  const type = REVEALS.includes(spec.reveal?.type) ? spec.reveal.type : 'none';
  const options = REVEALS.map((k) => (k === 'none' ? ['none', 'Nenhuma', 'O elemento inteiro aparece de uma vez'] : [k, SHAPES[k].label, SHAPES[k].desc]));
  return [
    h('p.vintro', {}, 'Descreva como o elemento está antes de entrar; o movimento vai desse estado até o normal. A saída usa o mesmo caminho ao contrário.'),
    card({ title: 'Tempo', desc: 'Curva de aceleração (a duração é definida no app, em Entrada/Saída do clipe).', body: fieldRows(spec.timing, SECTIONS.animTiming.fields, ctx) }),
    card({ title: SECTIONS.move.label, desc: SECTIONS.move.desc, body: fieldRows(spec.move, SECTIONS.move.fields, ctx) }),
    card({
      title: 'Revelar com forma', desc: type === 'none' ? 'Opcional: uma forma que vai mostrando o elemento.' : SHAPES[type].desc,
      body: h('div', {},
        chips(options, type, (k) => { spec.reveal = withShape(spec.reveal, k); ctx.structural(); }, 'Forma da revelação'),
        type !== 'none' ? fieldRows(spec.reveal, SHAPES[type].fields, ctx) : null),
    }),
  ];
}
