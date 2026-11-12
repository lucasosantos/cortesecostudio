import { describe, it, expect } from 'vitest';
import {
  generate, newSpec, visualPresets, readVisualTag, stripVisualTag, effectBlock, withShape, samplesPerPixel,
  EFFECT_BLOCKS, SHAPES, REVEALS,
} from '../src/lab/visual.js';
import { validateExtension } from '../src/fx/registry.js';

const asExt = (spec, out = generate(spec)) => ({ format: 'corteseco-fx', id: 'teste.visual', name: 'Teste', kind: spec.kind, params: out.params, glsl: out.glsl });

describe('FX Lab: modo visual', () => {
  it('gera extensões válidas para os três tipos e para todos os exemplos', () => {
    const specs = ['effect', 'transition', 'animation'].map(newSpec);
    for (const list of Object.values(visualPresets())) specs.push(...list.map((p) => p.spec));
    for (const spec of specs) {
      const r = validateExtension(asExt(spec));
      expect(r.errors).toEqual([]);
    }
  });

  it('campos fixos viram números no código; campos marcados viram parâmetros', () => {
    const spec = { v: 1, kind: 'effect', blocks: [effectBlock('vignette', [], { strength: 0.5, color: '#ff0000' })] };
    let out = generate(spec);
    expect(out.params).toEqual([]);
    expect(out.glsl).toContain('vec3(1.0, 0.0, 0.0)');
    spec.blocks[0].expose = ['strength', 'color'];
    out = generate(spec);
    expect(out.params.map((p) => [p.name, p.type, p.default])).toEqual([['vignette1_strength', 'float', 0.5], ['vignette1_color', 'color3', '#ff0000']]);
    expect(out.glsl).toContain('* vignette1_strength');
    expect(validateExtension(asExt(spec, out)).ok).toBe(true);
  });

  it('números negativos ficam entre parênteses (evita "--" no GLSL)', () => {
    const spec = { v: 1, kind: 'effect', blocks: [effectBlock('wave', [], { speed: -3 })] };
    expect(generate(spec).glsl).toContain('time * (-3.0)');
  });

  it('allUniforms expõe todo campo (menos as listas de escolha) sem mudar a estrutura', () => {
    const spec = newSpec('transition');
    const a = generate(spec, { allUniforms: true });
    spec.shape.values.angle = 45;
    const b = generate(spec, { allUniforms: true });
    expect(stripVisualTag(a.glsl)).toBe(stripVisualTag(b.glsl));
    expect(a.params.some((p) => p.name === 'timing_easing')).toBe(false);
  });

  it('guarda a montagem na primeira linha e a recupera', () => {
    const spec = visualPresets().transition[0].spec;
    const { glsl } = generate(spec);
    expect(readVisualTag(glsl)).toEqual(spec);
    expect(readVisualTag(stripVisualTag(glsl))).toBeNull();
    expect(stripVisualTag(glsl)).toMatch(/^float|^\/\//);
  });

  it('cobre todas as camadas, formas e revelações', () => {
    const blocks = [];
    for (const type of Object.keys(EFFECT_BLOCKS)) blocks.push(effectBlock(type, blocks));
    expect(validateExtension(asExt({ v: 1, kind: 'effect', blocks })).errors).toEqual([]);
    for (const type of Object.keys(SHAPES)) {
      const spec = newSpec('transition');
      spec.shape = withShape(spec.shape, type);
      spec.motion.on = spec.edge.on = spec.flash.on = true;
      expect(validateExtension(asExt(spec)).errors).toEqual([]);
    }
    for (const type of REVEALS) {
      const spec = newSpec('animation');
      spec.reveal = withShape(spec.reveal, type);
      expect(validateExtension(asExt(spec)).errors).toEqual([]);
    }
  });

  it('conta as leituras por pixel das camadas de leitura empilhadas', () => {
    const blocks = [];
    blocks.push(effectBlock('blur', blocks), effectBlock('glow', blocks));
    expect(samplesPerPixel({ kind: 'effect', blocks })).toBe(25 * 26);
    blocks[1].on = false;
    expect(samplesPerPixel({ kind: 'effect', blocks })).toBe(25);
  });
});
