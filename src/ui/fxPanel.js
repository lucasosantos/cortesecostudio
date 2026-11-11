// Seções "Efeitos" e "Máscaras" dos inspectors (clipe da timeline e camada do motion).
// Cada efeito e cada máscara é um objeto { props, keyframes }, então os keyframes usam o mesmo mecanismo dos clipes.
import { state, emit, checkpoint } from '../state/project.js';
import { valueAt, setProp, setKeyframe, removeKeyframe, keyframeAt, hasKeyframes } from '../state/keyframes.js';
import { parseColor, formatColor } from '../motion/interp.js';
import { listExtensions, getExtension, createEffect, extensionsVersion, transitionExtId, animOptions } from '../fx/registry.js';
import { defaultFor } from '../fx/shader.js';
import { glAvailable, shaderError } from '../fx/gl.js';
import { effectSource } from '../fx/apply.js';
import { createMask, MASK_SHAPES } from '../fx/mask.js';
import { h, clamp } from './util.js';

/** Assinatura do que muda a estrutura das seções (para o inspector saber quando reconstruir). */
export function fxKey(obj) {
  const fx = (obj.effects || []).map((e) => `${e.id}/${e.type}/${e.enabled !== false}/${getExtension(e.type)?.params?.length ?? 'x'}`).join(',');
  const mk = (obj.masks || []).map((m) => `${m.id}/${m.shape}/${m.enabled !== false}/${m.inverted}`).join(',');
  const edit = state.maskEdit ? `${state.maskEdit.clipId}/${state.maskEdit.maskId}` : '';
  const tr = ['transition', 'animIn', 'animOut'].map((k) => obj[k]?.type || '').join('/');
  return `fx[${fx}]mk[${mk}]${edit}|${tr}|v${extensionsVersion()}`;
}

/**
 * Controles de parâmetro para um objeto { props, keyframes }.
 * env: { bindings, getTime, beginEdit, endEdit, seek(t), locked() }
 */
function rows(env) {
  const time = () => env.getTime();
  const locked = () => !!env.locked?.();
  // parâmetros sem animação (os de transição) são gravados direto, sem passar pelos keyframes
  const write = (target, prop, v) => {
    if (env.noKeyframes) target.props[prop] = v;
    else setProp(target, prop, v, time(), state.autoKey);
  };

  const kf = (target, prop) => {
    if (env.noKeyframes) return h('span');
    const btn = h('button.kf-btn', {
      title: 'Adicionar/remover keyframe no playhead',
      on: {
        click: () => {
          if (locked()) return;
          checkpoint();
          const t = time();
          if (keyframeAt(target, prop, t)) removeKeyframe(target, prop, t);
          else setKeyframe(target, prop, t, valueAt(target, prop, t));
          emit('project');
        },
      },
    }, '◆');
    const nav = (dir) => h('button.kf-nav', {
      title: dir < 0 ? 'Keyframe anterior' : 'Próximo keyframe',
      on: {
        click: () => {
          const t = time();
          const list = target.keyframes?.[prop] || [];
          const k = dir < 0 ? [...list].reverse().find((x) => x.t < t - 1e-4) : list.find((x) => x.t > t + 1e-4);
          if (k) env.seek(k.t);
        },
      },
    }, dir < 0 ? '◀' : '▶');
    const prev = nav(-1);
    const next = nav(1);
    env.bindings.push(() => {
      const has = hasKeyframes(target, prop);
      btn.classList.toggle('has', has);
      btn.classList.toggle('on', !!keyframeAt(target, prop, time()));
      prev.disabled = next.disabled = !has;
    });
    return h('div.kf-ctrls', {}, prev, btn, next);
  };

  const num = (target, label, prop, { step = 1, scale = 1, min = -Infinity, max = Infinity, slider = false, integer = false, title = '' } = {}) => {
    const apply = (raw) => {
      let v = clamp(Number(raw), min, max);
      if (!Number.isFinite(v) || locked()) return;
      if (integer) v = Math.round(v);
      env.beginEdit();
      write(target, prop, v / scale);
      emit('project');
    };
    const input = h('input', { type: 'number', step, on: { focus: env.beginEdit, blur: env.endEdit, input: (e) => e.target.value !== '' && apply(e.target.value) } });
    const range = slider ? h('input', { type: 'range', min, max, step, on: { pointerdown: env.beginEdit, pointerup: env.endEdit, input: (e) => apply(e.target.value) } }) : null;
    if (range) input.classList.add('small');
    env.bindings.push(() => {
      const shown = Math.round((Number(valueAt(target, prop, time())) || 0) * scale * 1000) / 1000;
      if (document.activeElement !== input) input.value = shown;
      if (range && document.activeElement !== range) range.value = shown;
    });
    return h('div.insp-row', {}, h('label', { title }, label), h('div.ctrl', {}, range, input), kf(target, prop));
  };

  const color = (target, label, prop, { alpha = true } = {}) => {
    const set = (hex6, a) => {
      if (locked()) return;
      env.beginEdit();
      const [r, g, b] = parseColor(hex6);
      write(target, prop, alpha ? formatColor([r, g, b, Math.round(a * 255)]) : formatColor([r, g, b]).slice(0, 7));
      emit('project');
    };
    const input = h('input', { type: 'color', on: { focus: env.beginEdit, blur: env.endEdit, input: (e) => set(e.target.value, alphaInput ? Number(alphaInput.value) / 100 : 1) } });
    const alphaInput = alpha ? h('input', {
      type: 'range', min: 0, max: 100, step: 1, title: 'Transparência',
      on: { pointerdown: env.beginEdit, pointerup: env.endEdit, input: (e) => set(input.value, Number(e.target.value) / 100) },
    }) : null;
    // conta-gotas: pega a cor de qualquer ponto da tela (útil para o chroma key)
    const dropper = 'EyeDropper' in window ? h('button.icon', {
      title: 'Conta-gotas: clique em qualquer ponto da tela para pegar a cor',
      on: {
        click: async () => {
          try {
            const picked = await new window.EyeDropper().open();
            checkpoint();
            set(picked.sRGBHex, alphaInput ? Number(alphaInput.value) / 100 : 1);
            env.endEdit();
          } catch {
            /* cancelado pelo usuário */
          }
        },
      },
    }, '⌖') : null;
    env.bindings.push(() => {
      const [r, g, b, a] = parseColor(valueAt(target, prop, time()));
      if (document.activeElement !== input) input.value = formatColor([r, g, b]).slice(0, 7);
      if (alphaInput && document.activeElement !== alphaInput) alphaInput.value = Math.round((a / 255) * 100);
    });
    return h('div.insp-row', {}, h('label', {}, label), h('div.ctrl', {}, h('div.color-ctrl', {}, input, dropper, alphaInput)), kf(target, prop));
  };

  const bool = (target, label, prop) => {
    const input = h('input', {
      type: 'checkbox',
      on: { change: (e) => { if (locked()) return; checkpoint(); target.props[prop] = e.target.checked; emit('project'); } },
    });
    env.bindings.push(() => { input.checked = !!target.props[prop]; });
    return h('div.insp-row', {}, h('label', {}, label), h('div.ctrl', {}, input), h('span'));
  };

  const pair = (target, label, prop, integer) => {
    const inputs = [0, 1].map((i) => h('input', {
      type: 'number', step: integer ? 1 : 0.01,
      on: {
        focus: env.beginEdit, blur: env.endEdit,
        input: (e) => {
          if (e.target.value === '' || locked()) return;
          env.beginEdit();
          const cur = Array.isArray(target.props[prop]) ? [...target.props[prop]] : [0, 0];
          cur[i] = integer ? Math.round(Number(e.target.value)) : Number(e.target.value);
          target.props[prop] = cur;
          emit('project');
        },
      },
    }));
    env.bindings.push(() => inputs.forEach((input, i) => { if (document.activeElement !== input) input.value = target.props[prop]?.[i] ?? 0; }));
    return h('div.insp-row', {}, h('label', {}, label), h('div.ctrl', {}, ...inputs), h('span'));
  };

  return { num, color, bool, pair, kf };
}

function paramRow(r, effect, p) {
  // instâncias criadas antes de a definição ganhar o parâmetro recebem o padrão ao serem editadas
  if (!(p.name in effect.props)) effect.props[p.name] = defaultFor(p);
  const label = p.label || p.name;
  const ranged = Number.isFinite(p.min) && Number.isFinite(p.max);
  switch (p.type) {
    case 'bool': return r.bool(effect, label, p.name);
    case 'color': return r.color(effect, label, p.name, { alpha: true });
    case 'color3': return r.color(effect, label, p.name, { alpha: false });
    case 'vec2': return r.pair(effect, label, p.name, false);
    case 'ivec2': return r.pair(effect, label, p.name, true);
    case 'int': return r.num(effect, label, p.name, { step: 1, min: p.min ?? -Infinity, max: p.max ?? Infinity, slider: ranged, integer: true });
    default: {
      const step = p.step ?? (ranged ? Math.max((p.max - p.min) / 200, 0.001) : 0.01);
      return r.num(effect, label, p.name, { step, min: p.min ?? -Infinity, max: p.max ?? Infinity, slider: ranged });
    }
  }
}

const move = (list, i, dir) => {
  const j = i + dir;
  if (j < 0 || j >= list.length) return;
  [list[i], list[j]] = [list[j], list[i]];
};

/** Seção "Efeitos" de um clipe ou de uma camada. */
export function effectsSection(owner, env) {
  const sec = h('div.insp-section');
  const r = rows(env);
  const defs = listExtensions('effect');
  const add = h('select', {
    title: 'Adicionar um efeito',
    on: {
      change: (e) => {
        const id = e.target.value;
        e.target.value = '';
        if (!id || env.locked?.()) return;
        checkpoint();
        owner.effects ||= [];
        owner.effects.push(createEffect(id));
        emit('project');
      },
    },
  },
  h('option', { value: '' }, '+ Adicionar efeito…'),
  h('optgroup', { label: 'Nativos' }, ...defs.filter((d) => d.builtin).map((d) => h('option', { value: d.id, title: d.description || '' }, d.name))),
  defs.some((d) => !d.builtin) ? h('optgroup', { label: 'Instalados' }, ...defs.filter((d) => !d.builtin).map((d) => h('option', { value: d.id, title: d.description || '' }, d.name))) : null);
  sec.append(h('div.insp-row', {}, h('label', {}, 'Efeito'), h('div.ctrl', {}, add), h('span')));

  const list = owner.effects || [];
  if (list.some((e) => !getExtension(e.type)?.canvas) && !glAvailable()) {
    sec.append(h('div.insp-warn', {}, 'Este ambiente não tem WebGL2: efeitos de cor e chroma key não serão aplicados.'));
  }
  list.forEach((effect, i) => {
    const def = getExtension(effect.type);
    const toggle = h('input', {
      type: 'checkbox', checked: effect.enabled !== false, title: 'Ligar/desligar o efeito',
      on: { change: (e) => { checkpoint(); effect.enabled = e.target.checked; emit('project'); } },
    });
    const act = (title, text, fn) => h('button.icon', { title, on: { click: () => { if (env.locked?.()) return; checkpoint(); fn(); emit('project'); } } }, text);
    sec.append(h('div.fx-head', {},
      toggle,
      h('span.fx-name', { title: def?.description || '' }, def ? def.name : `Não instalado: ${effect.type}`),
      act('Aplicar antes', '↑', () => move(list, i, -1)),
      act('Aplicar depois', '↓', () => move(list, i, 1)),
      act('Remover efeito', '✕', () => list.splice(i, 1)),
    ));
    if (!def) {
      sec.append(h('div.insp-warn', {}, 'Este efeito não está instalado nesta máquina e não veio junto com o projeto. Instale a extensão em "Extensões" para ele voltar a funcionar.'));
      return;
    }
    if (effect.enabled === false) return;
    for (const p of def.params || []) sec.append(paramRow(r, effect, p));
    if (!def.canvas) {
      const warn = h('div.insp-warn');
      env.bindings.push(() => {
        const err = shaderError(effectSource(def));
        warn.style.display = err ? '' : 'none';
        if (err) warn.textContent = `O código deste efeito não compila e ele está sendo ignorado: ${err.split('\n')[0]}`;
      });
      sec.append(warn);
    }
  });
  if (list.some((e) => getExtension(e.type)?.canvas) && list.some((e) => getExtension(e.type) && !getExtension(e.type).canvas)) {
    sec.append(h('div.insp-note', {}, 'Sombra, brilho externo e desfoque são sempre aplicados por último, depois dos outros efeitos e das máscaras.'));
  }
  return sec;
}

/**
 * Linhas dos parâmetros de uma transição de extensão (entrada, saída ou transição entre cenas).
 * Os valores ficam em spec.params e não são animáveis.
 */
export function transitionParamRows(spec, env) {
  const def = getExtension(transitionExtId(spec?.type));
  if (!def) return [];
  spec.params ||= {};
  const target = { props: spec.params, keyframes: {} };
  const r = rows({ ...env, noKeyframes: true, getTime: () => 0, seek: () => {} });
  return (def.params || []).map((p) => paramRow(r, target, p));
}

/**
 * Seção "Entrada" ou "Saída" de uma camada do motion (key = 'animIn' | 'animOut').
 * Usa as extensões de entrada/saída; a animação começa em layer.in ou termina em layer.out.
 * env: { bindings, beginEdit, endEdit, locked() }
 */
export function layerAnimSection(layer, key, env) {
  const sec = h('div.insp-section');
  const spec = () => layer[key] || null;
  const update = (fn) => {
    if (env.locked?.()) return;
    checkpoint();
    layer[key] ||= { type: 'ext:anim.reveal', duration: 0.5, params: {} };
    fn(layer[key]);
    emit('project');
  };
  const type = h('select', {
    on: {
      change: (e) => {
        if (env.locked?.()) return;
        if (e.target.value === 'none') {
          checkpoint();
          delete layer[key];
          emit('project');
        } else update((a) => { a.type = e.target.value; a.params = {}; });
      },
    },
  }, h('option', { value: 'none' }, 'Nenhuma'),
  ...animOptions({ layer: true }).map(([label, list]) => h('optgroup', { label }, ...list.map(([v, n]) => h('option', { value: v }, n)))));
  const dur = h('input', {
    type: 'number', min: 0.05, step: 0.05,
    on: { change: (e) => update((a) => { a.duration = clamp(Number(e.target.value) || 0.5, 0.05, 30); }) },
  });
  const durRow = h('div.insp-row', {}, h('label', {}, 'Duração'), h('div.ctrl', {}, dur, h('span.insp-note', { style: { padding: 0 } }, 's')));
  const params = spec() ? transitionParamRows(spec(), env) : [];
  const missing = spec() && !getExtension(transitionExtId(spec().type))
    ? h('div.insp-warn', {}, 'Esta extensão não está instalada nesta máquina; a animação não aparece. Instale-a em "Extensões".') : null;
  sec.append(h('div.insp-row', {}, h('label', {}, 'Tipo'), h('div.ctrl', {}, type)), durRow, ...params, missing,
    h('div.insp-note', {}, key === 'animIn' ? 'Toca a partir do início da camada ("Visível de").' : 'Termina no fim da camada ("até").'));
  env.bindings.push(() => {
    const a = spec();
    if (document.activeElement !== type) {
      if (a && ![...type.options].some((o) => o.value === a.type)) type.append(h('option', { value: a.type }, 'Não instalada'));
      type.value = a ? a.type : 'none';
    }
    durRow.style.display = a ? '' : 'none';
    if (a && document.activeElement !== dur) dur.value = a.duration;
  });
  return sec;
}

/** Seção "Máscaras" de um clipe da timeline. */
export function masksSection(clip, env) {
  const sec = h('div.insp-section');
  const r = rows(env);
  const addMask = (shape) => () => {
    if (env.locked?.()) return;
    checkpoint();
    const mask = createMask(shape);
    clip.masks ||= [];
    clip.masks.push(mask);
    state.maskEdit = { clipId: clip.id, maskId: mask.id, sel: [] };
    emit('project');
  };
  sec.append(h('div.insp-actions', {},
    h('button', { on: { click: addMask('rect') } }, '+ Retângulo'),
    h('button', { on: { click: addMask('ellipse') } }, '+ Elipse'),
    h('button', { title: 'Forma desenhada ponto a ponto', on: { click: addMask('path') } }, '+ Forma livre'),
  ));
  const list = clip.masks || [];
  if (!list.length) sec.append(h('div.insp-note', {}, 'A máscara recorta o clipe: só aparece o que está dentro dela (ou fora, se invertida).'));
  list.forEach((mask, i) => {
    const editing = state.maskEdit?.clipId === clip.id && state.maskEdit?.maskId === mask.id;
    const check = (key, title) => h('input', {
      type: 'checkbox', checked: key === 'enabled' ? mask.enabled !== false : !!mask[key], title,
      on: { change: (e) => { checkpoint(); mask[key] = e.target.checked; emit('project'); } },
    });
    sec.append(h('div.fx-head', {},
      check('enabled', 'Ligar/desligar a máscara'),
      h('span.fx-name', {}, MASK_SHAPES[mask.shape] || 'Máscara'),
      h('label.toggle-row', { style: { padding: 0 }, title: 'Mostra o que está fora da forma' }, check('inverted', 'Inverter'), 'Inverter'),
      h(`button${editing ? '.active' : ''}`, {
        title: 'Mostra as alças da máscara no preview para arrastar',
        on: {
          click: () => {
            state.maskEdit = editing ? null : { clipId: clip.id, maskId: mask.id, sel: [] };
            emit('selection');
          },
        },
      }, editing ? 'Concluir' : 'Editar'),
      h('button.icon', {
        title: 'Remover máscara',
        on: {
          click: () => {
            checkpoint();
            list.splice(i, 1);
            if (editing) state.maskEdit = null;
            emit('project');
          },
        },
      }, '✕'),
    ));
    if (mask.enabled === false) return;
    const pct = { scale: 100, step: 0.5 };
    if (mask.shape !== 'path') {
      sec.append(
        r.num(mask, 'X', 'x', { ...pct, title: '% da largura do clipe' }),
        r.num(mask, 'Y', 'y', { ...pct, title: '% da altura do clipe' }),
        r.num(mask, 'Largura', 'w', { ...pct, min: 0 }),
        r.num(mask, 'Altura', 'h', { ...pct, min: 0 }),
      );
      if (mask.shape === 'rect') sec.append(r.num(mask, 'Arredondar', 'radius', { scale: 100, step: 1, min: 0, max: 100, slider: true }));
    } else {
      sec.append(h('div.insp-row', {}, h('label', {}, 'Pontos'), h('div.ctrl', {},
        h('span.insp-note', { style: { padding: 0 } }, editing ? 'Arraste os pontos no preview' : 'Clique em "Editar"')), r.kf(mask, 'path')));
    }
    sec.append(r.num(mask, 'Suavizar', 'feather', { step: 1, min: 0, max: 400, slider: true, title: 'Borda suave, em pixels' }));
    if (editing) {
      sec.append(h('div.insp-note', {}, mask.shape === 'path'
        ? 'No preview: arraste pontos e alças · clique na linha cria ponto · Alt+clique alterna canto/curva · Del remove · Esc conclui.'
        : 'No preview: arraste a forma para mover e as alças para redimensionar · Esc conclui.'));
    }
  });
  return sec;
}

