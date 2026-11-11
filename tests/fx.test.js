import { describe, it, expect, beforeEach } from 'vitest';
import { state, newProject, splitClip, createTextClip, snapshotKeyframes, restoreKeyframes } from '../src/state/project.js';
import { setKeyframe, valueAt } from '../src/state/keyframes.js';
import {
  buildEffectSource, buildTransitionSource, buildAnimationSource, buildSource, paramUniforms, parseShaderLog, uniformValue, defaultFor, isParamName,
} from '../src/fx/shader.js';
import {
  validateExtension, parseGlTransition, readExtensionFile, exportExtension, createEffect, effectValues, listExtensions, getExtension,
  installExtension, removeExtension, usedExtensionIds, embedUsedExtensions, transitionLabel, transitionKnown, transitionOptions, freeId, slugify,
  animKnown, animationDef, animOptions,
} from '../src/fx/registry.js';
import { animationAt } from '../src/fx/apply.js';
import { BUILTIN } from '../src/fx/builtin.js';
import { createMask, maskPath } from '../src/fx/mask.js';
import { pathBounds } from '../src/motion/geometry.js';

const ext = (over = {}) => ({
  format: 'corteseco-fx', version: 1, id: 'ana.onda', name: 'Onda', kind: 'effect', author: 'Ana',
  params: [{ name: 'forca', label: 'Força', type: 'float', default: 0.5, min: 0, max: 1 }],
  glsl: 'vec4 effect(vec2 uv) {\n  return getColor(uv + vec2(sin(uv.y * 20.0) * forca * 0.05, 0.0));\n}',
  ...over,
});

beforeEach(() => {
  state.project = newProject();
  for (const e of [...listExtensions()]) if (!e.builtin) removeExtension(e.id);
});

describe('montagem do shader', () => {
  it('declara os uniforms dos parâmetros e mantém o código do autor depois de #line 1', () => {
    const src = buildEffectSource(ext());
    expect(src.startsWith('#version 300 es')).toBe(true);
    expect(src).toContain('uniform float forca;');
    const after = src.split('#line 1\n')[1];
    expect(after.startsWith('vec4 effect(vec2 uv)')).toBe(true);
    expect(buildTransitionSource(ext({ kind: 'transition', glsl: 'vec4 transition(vec2 uv){return getToColor(uv);}' }))).toContain('uniform sampler2D uTo;');
  });
  it('cada tipo de parâmetro vira o tipo GLSL certo e nomes reservados ficam de fora', () => {
    const u = paramUniforms([
      { name: 'a', type: 'float' }, { name: 'b', type: 'int' }, { name: 'c', type: 'bool' }, { name: 'd', type: 'color' },
      { name: 'e', type: 'color3' }, { name: 'f', type: 'vec2' }, { name: 'g', type: 'ivec2' }, { name: 'progress', type: 'float' }, { name: 'x', type: 'mat4' },
    ]);
    expect(u.split('\n')).toEqual(['uniform float a;', 'uniform int b;', 'uniform bool c;', 'uniform vec4 d;', 'uniform vec3 e;', 'uniform vec2 f;', 'uniform ivec2 g;']);
    expect(isParamName('gl_Position')).toBe(false);
    expect(isParamName('9x')).toBe(false);
    expect(isParamName('minha_cor')).toBe(true);
  });
  it('erros do compilador apontam a linha do código do autor', () => {
    const log = "ERROR: 0:2: 'forcaa' : undeclared identifier\nERROR: 0:99: '}' : syntax error\n";
    expect(parseShaderLog(log, 3)).toEqual([
      { line: 2, message: "'forcaa' : undeclared identifier" },
      { line: 3, message: "'}' : syntax error" },
    ]);
    expect(parseShaderLog('algo estranho')).toEqual([{ line: 0, message: 'algo estranho' }]);
  });
  it('valores viram uniforms', () => {
    expect(uniformValue({ type: 'bool' }, true)).toBe(1);
    expect(uniformValue({ type: 'int' }, 2.6)).toBe(3);
    expect(uniformValue({ type: 'color' }, '#ff000080')).toEqual([1, 0, 0, 128 / 255]);
    expect(uniformValue({ type: 'color3' }, '#00ff00')).toEqual([0, 1, 0]);
    expect(uniformValue({ type: 'ivec2' }, [1.4, 2.6])).toEqual([1, 3]);
    expect(uniformValue({ type: 'float', default: 0.25 }, undefined)).toBe(0.25);
    expect(defaultFor({ type: 'vec2', default: 'x' })).toEqual([0, 0]);
  });
});

describe('validação de extensões', () => {
  it('aceita uma extensão válida e descarta campos desconhecidos', () => {
    const r = validateExtension({ ...ext(), script: 'alert(1)', params: [{ ...ext().params[0], onload: 'x' }] });
    expect(r.ok).toBe(true);
    expect(r.ext.script).toBeUndefined();
    expect(Object.keys(r.ext.params[0]).sort()).toEqual(['default', 'label', 'max', 'min', 'name', 'type']);
  });
  it('recusa formato, id, tipo, função e parâmetros errados', () => {
    const bad = (over) => validateExtension(ext(over));
    expect(bad({ format: 'outro' }).ok).toBe(false);
    expect(bad({ id: 'Com Espaço' }).ok).toBe(false);
    expect(bad({ id: 'chroma' }).errors.join()).toMatch(/reservado/);
    expect(bad({ id: 'fade' }).ok).toBe(false);
    expect(bad({ kind: 'plugin' }).ok).toBe(false);
    expect(bad({ glsl: 'void nada() {}' }).errors.join()).toMatch(/effect/);
    expect(bad({ kind: 'transition' }).errors.join()).toMatch(/transition/);
    expect(bad({ params: [{ name: 'time', type: 'float' }] }).ok).toBe(false);
    expect(bad({ params: [{ name: 'a', type: 'float' }, { name: 'a', type: 'float' }] }).ok).toBe(false);
    expect(bad({ params: [{ name: 'a', type: 'sampler2D' }] }).ok).toBe(false);
    expect(bad({ glsl: 'vec4 effect(vec2 uv){return vec4(0.);}' + ' '.repeat(200_001) }).ok).toBe(false);
    expect(validateExtension(null).ok).toBe(false);
    expect(validateExtension([]).ok).toBe(false);
  });
  it('exportar e ler de volta dá a mesma extensão', () => {
    const a = validateExtension(ext()).ext;
    expect(readExtensionFile(exportExtension(a), 'onda.csfx.json')).toEqual(a);
    expect(() => readExtensionFile('{ quebrado', 'x.json')).toThrow(/JSON/);
    expect(() => readExtensionFile('{"format":"x"}', 'x.json')).toThrow();
  });
});

describe('gl-transitions', () => {
  const src = `// Author: gre
// License: MIT
uniform float size; // = 0.2
uniform vec3 color;// = vec3(0.0)
uniform ivec2 squares; // = ivec2(10, 10)
uniform bool flip; // = true
uniform vec2 center; // = vec2(0.5, 0.25)
vec4 transition (vec2 uv) {
  return mix(getFromColor(uv), getToColor(uv), progress);
}`;
  it('uniforms viram parâmetros e saem do código', () => {
    const t = parseGlTransition(src, 'meu/Fade Color.glsl');
    expect(t).toMatchObject({ id: 'gl.fade-color', name: 'Fade Color', kind: 'transition', author: 'gre' });
    expect(t.params).toEqual([
      { name: 'size', label: 'size', type: 'float', default: 0.2 },
      { name: 'color', label: 'color', type: 'color3', default: '#000000' },
      { name: 'squares', label: 'squares', type: 'ivec2', default: [10, 10] },
      { name: 'flip', label: 'flip', type: 'bool', default: true },
      { name: 'center', label: 'center', type: 'vec2', default: [0.5, 0.25] },
    ]);
    expect(t.glsl).not.toMatch(/^\s*uniform/m);
    // as linhas continuam no mesmo lugar, para os erros apontarem certo
    expect(t.glsl.split('\n')).toHaveLength(src.split('\n').length);
    expect(validateExtension(t).ok).toBe(true);
    expect(readExtensionFile(src, 'cube.glsl').kind).toBe('transition');
  });
  it('recusa tipos de uniform que não dá para editar', () => {
    expect(() => parseGlTransition('uniform sampler2D mapa;\nvec4 transition(vec2 uv){return getToColor(uv);}')).toThrow(/não suportado/);
  });
});

describe('registro', () => {
  it('lista nativos, instala, encontra e remove', () => {
    expect(listExtensions('effect').map((e) => e.id)).toEqual(BUILTIN.filter((e) => e.kind === 'effect').map((e) => e.id));
    installExtension(ext());
    installExtension(ext({ name: 'Onda 2' })); // mesmo id substitui
    expect(listExtensions().filter((e) => !e.builtin)).toHaveLength(1);
    expect(getExtension('ana.onda').name).toBe('Onda 2');
    expect(freeId('ana.onda')).toBe('ana.onda-2');
    expect(freeId('chroma')).toBe('chroma-2');
    removeExtension('ana.onda');
    expect(getExtension('ana.onda')).toBeNull();
    expect(() => installExtension({})).toThrow();
    expect(slugify('Olá, Mundão!')).toBe('ola-mundao');
  });
  it('instância de efeito nasce com os padrões e parâmetros novos entram com o padrão', () => {
    const fx = createEffect('chroma');
    expect(fx.props).toMatchObject({ key: '#00d800', tolerance: 0.18 });
    setKeyframe(fx, 'tolerance', 0, 0);
    setKeyframe(fx, 'tolerance', 2, 1);
    const def = getExtension('chroma');
    expect(effectValues(fx, def, 1).tolerance).toBe(0.5);
    delete fx.props.spill;
    expect(effectValues(fx, def, 0).spill).toBe(0.5);
  });
  it('transições: nomes e opções incluem as instaladas', () => {
    installExtension(ext({ id: 'gl.cubo', name: 'Cubo', kind: 'transition', glsl: 'vec4 transition(vec2 uv){return getToColor(uv);}' }));
    expect(transitionLabel('fade')).toBe('Combinar');
    expect(transitionLabel('ext:gl.cubo')).toBe('Cubo');
    expect(transitionKnown('ext:gl.cubo')).toBe(true);
    expect(transitionKnown('ext:nao.existe')).toBe(false);
    expect(transitionKnown('ext:chroma')).toBe(false);
    expect(transitionOptions().map((o) => o[0])).toEqual(['fade', 'slide', 'flash', 'ext:gl.cubo']);
  });
  it('o projeto embute as extensões que usa e continua funcionando sem elas instaladas', () => {
    installExtension(ext());
    installExtension(ext({ id: 'gl.cubo', name: 'Cubo', kind: 'transition', glsl: 'vec4 transition(vec2 uv){return getToColor(uv);}' }));
    const track = state.project.tracks[0].id;
    state.project.clips.push({ id: 'c1', trackId: track, type: 'image', start: 0, duration: 2, props: {}, keyframes: {}, effects: [createEffect('ana.onda'), createEffect('color')], transition: { type: 'ext:gl.cubo', duration: 1 } });
    expect(usedExtensionIds().sort()).toEqual(['ana.onda', 'gl.cubo']);
    expect(embedUsedExtensions().map((e) => e.id).sort()).toEqual(['ana.onda', 'gl.cubo']);
    removeExtension('ana.onda');
    removeExtension('gl.cubo');
    expect(getExtension('ana.onda')?.name).toBe('Onda');
    expect(transitionKnown('ext:gl.cubo')).toBe(true);
    // salvar de novo não perde as extensões que só existem no projeto
    expect(embedUsedExtensions()).toHaveLength(2);
  });
});

describe('máscaras', () => {
  it('retângulo e elipse ocupam a fração pedida da caixa', () => {
    const m = createMask('rect');
    Object.assign(m.props, { x: 0.25, y: 0.5, w: 0.5, h: 0.25 });
    const b = pathBounds(maskPath(m, 0, 800, 400));
    expect([b.x, b.y, b.w, b.h]).toEqual([200, 200, 400, 100]);
    const e = createMask('ellipse');
    Object.assign(e.props, { x: 0, y: 0, w: 1, h: 1 });
    const be = pathBounds(maskPath(e, 0, 100, 50));
    expect(be.w).toBeCloseTo(100, 1);
    expect(be.h).toBeCloseTo(50, 1);
  });
  it('forma livre escala os pontos e a máscara anima', () => {
    const p = createMask('path');
    const b = pathBounds(maskPath(p, 0, 1000, 500));
    expect([b.x, b.y, b.w, b.h].map(Math.round)).toEqual([120, 60, 760, 380]);
    const m = createMask('rect');
    setKeyframe(m, 'x', 0, 0);
    setKeyframe(m, 'x', 2, 0.5);
    expect(pathBounds(maskPath(m, 1, 400, 400)).x).toBeCloseTo(100);
  });
  it('arredondamento total num quadrado vira um círculo', () => {
    const m = createMask('rect');
    Object.assign(m.props, { x: 0, y: 0, w: 1, h: 1, radius: 1 });
    expect(maskPath(m, 0, 100, 100).contours[0].pts).toHaveLength(8);
  });
});

describe('dividir e aparar com efeitos animados', () => {
  it('a divisão preserva a animação dos efeitos e máscaras nas duas metades', () => {
    globalThis.document ||= { createElement: () => ({ getContext: () => ({ measureText: () => ({ width: 100 }) }) }) };
    const clip = createTextClip(state.project.tracks[0].id, 0);
    clip.duration = 4;
    const fx = createEffect('color');
    setKeyframe(fx, 'brightness', 0, 0);
    setKeyframe(fx, 'brightness', 4, 1);
    const mask = createMask('rect');
    setKeyframe(mask, 'x', 1, 0);
    setKeyframe(mask, 'x', 3, 0.4);
    clip.effects = [fx];
    clip.masks = [mask];
    const right = splitClip(clip, 2);
    expect(clip.effects[0].keyframes.brightness.map((k) => [k.t, k.v])).toEqual([[0, 0], [2, 0.5]]);
    expect(right.effects[0].keyframes.brightness.map((k) => [k.t, k.v])).toEqual([[0, 0.5], [2, 1]]);
    expect(right.masks[0].keyframes.x.map((k) => [k.t, +k.v.toFixed(3)])).toEqual([[0, 0.2], [1, 0.4]]);
    expect(right.effects[0].id).not.toBe(clip.effects[0].id);
    expect(valueAt(right.effects[0], 'brightness', 1)).toBeCloseTo(0.75);
  });
  it('fotografar e restaurar keyframes cobre clipe, efeitos e máscaras', () => {
    const clip = { props: { x: 0 }, keyframes: {}, effects: [createEffect('color')], masks: [createMask('rect')] };
    setKeyframe(clip, 'x', 1, 5);
    setKeyframe(clip.effects[0], 'contrast', 1, 0.3);
    setKeyframe(clip.masks[0], 'w', 2, 0.9);
    const snap = snapshotKeyframes(clip);
    clip.effects[0].keyframes = {};
    restoreKeyframes(clip, snap, -0.5);
    expect([clip.keyframes.x[0].t, clip.effects[0].keyframes.contrast[0].t, clip.masks[0].keyframes.w[0].t]).toEqual([0.5, 0.5, 1.5]);
  });
});

describe('entrada/saída (extensões "animation")', () => {
  const anim = (over = {}) => ({
    format: 'corteseco-fx', version: 1, id: 'ana.sobe', name: 'Sobe', kind: 'animation',
    params: [], glsl: 'vec4 animate(vec2 uv) { vec4 c = getColor(uv); return vec4(c.rgb, c.a * progress); }', ...over,
  });

  it('valida a função animate e monta o shader com a caixa do elemento', () => {
    expect(validateExtension(anim()).ok).toBe(true);
    const bad = validateExtension(anim({ glsl: 'vec4 effect(vec2 uv) { return getColor(uv); }' }));
    expect(bad.errors.join(' ')).toMatch(/animate/);
    expect(validateExtension(anim({ params: [{ name: 'entering', type: 'bool' }] })).ok).toBe(false);
    const src = buildAnimationSource(anim());
    expect(src).toBe(buildSource(anim()));
    expect(src).toMatch(/uniform bool entering;/);
    expect(src).toMatch(/animate\(\(vUv - uBox.xy\) \/ uBox.zw\)/);
    expect(src.split('#line 1\n')[1].startsWith(anim().glsl)).toBe(true);
  });

  it('nativas são aceitas como entrada/saída de clipe, mas não como transição entre cenas', () => {
    for (const b of BUILTIN.filter((e) => e.kind === 'animation')) expect(validateExtension({ ...b, format: 'corteseco-fx', id: `x${b.id}` }).ok).toBe(true);
    expect(animationDef('ext:anim.zoom').name).toBe('Zoom');
    expect(animKnown('ext:anim.zoom')).toBe(true);
    expect(animKnown('fade')).toBe(true);
    expect(transitionKnown('ext:anim.zoom')).toBe(false);
    expect(animOptions({ layer: true })[0][1].map((o) => o[0])).toContain('ext:anim.reveal');
    expect(animOptions({ layer: true })[0][1].some((o) => o[0] === 'fade')).toBe(false);
  });

  it('calcula o progresso de entrada e saída e encolhe as duas quando não cabem', () => {
    const obj = { animIn: { type: 'ext:anim.zoom', duration: 1 }, animOut: { type: 'ext:anim.reveal', duration: 1 } };
    expect(animationAt(obj, 0.5, 4)).toMatchObject({ progress: 0.5, entering: true });
    expect(animationAt(obj, 2, 4)).toBeNull();
    expect(animationAt(obj, 3.75, 4)).toMatchObject({ progress: 0.25, entering: false });
    // 2 s de animação num elemento de 1 s: cada uma fica com 0,5 s
    expect(animationAt(obj, 0.25, 1).progress).toBeCloseTo(0.5);
    expect(animationAt(obj, 0.75, 1)).toMatchObject({ entering: false });
    expect(animationAt({ animIn: { type: 'fade', duration: 1 } }, 0.5, 4)).toBeNull();
  });

  it('o projeto guarda as entradas/saídas usadas pelas camadas do motion', () => {
    newProject();
    installExtension(anim());
    state.project.comps = [{ id: 'c1', layers: [{ id: 'l1', effects: [], animIn: { type: 'ext:ana.sobe', duration: 0.5 } }] }];
    expect(usedExtensionIds()).toEqual(['ana.sobe']);
    expect(embedUsedExtensions().map((e) => e.kind)).toEqual(['animation']);
    removeExtension('ana.sobe');
  });
});

describe('texto: animação por unidade e divisão do clipe', () => {
  it('duração total da entrada considera a ordem', async () => {
    const { textAnimLength } = await import('../src/engine/text.js');
    expect(textAnimLength({ duration: 0.4, delay: 0.1, order: 'forward' }, 5)).toBeCloseTo(0.8);
    expect(textAnimLength({ duration: 0.4, delay: 0.1, order: 'center' }, 5)).toBeCloseTo(0.6);
    expect(textAnimLength(null, 5)).toBe(0);
  });

  it('dividir deixa a entrada na primeira metade e a saída na segunda', () => {
    newProject();
    const clip = createTextClip(state.project.tracks[0].id, 0, 'Oi');
    clip.animIn = { type: 'fade', duration: 0.5 };
    clip.animOut = { type: 'ext:anim.zoom', duration: 0.5 };
    clip.textAnim = { in: { preset: 'rise' }, out: { preset: 'fade' }, loop: { preset: 'wave' } };
    const right = splitClip(clip, 2);
    expect([!!clip.animIn, !!clip.animOut, !!right.animIn, !!right.animOut]).toEqual([true, false, false, true]);
    expect([!!clip.textAnim.in, !!clip.textAnim.out, !!right.textAnim.in, !!right.textAnim.out]).toEqual([true, false, false, true]);
    expect(right.textAnim.loop.preset).toBe('wave');
  });
});
