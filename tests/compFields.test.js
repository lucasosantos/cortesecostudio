import { describe, it, expect, beforeEach } from 'vitest';
import { state, newProject, newMotionState } from '../src/state/project.js';
import { setKeyframe } from '../src/state/keyframes.js';
import { createComp, createLayer, removeLayers } from '../src/motion/model.js';
import { packComp, instantiateComp } from '../src/motion/compFile.js';
import {
  addField, removeField, compFields, fieldFor, fieldDefault, fieldValue, applyFields, coerceFieldValue, fieldSummary, clearFieldMedia,
} from '../src/motion/fields.js';

// canvas falso: cada letra mede 10 px
globalThis.document ||= {};
const realCreate = globalThis.document.createElement;
globalThis.document.createElement = () => ({ getContext: () => ({ measureText: (s) => ({ width: String(s).length * 10 }) }) });

beforeEach(() => {
  state.project = newProject();
  state.motion = newMotionState();
});

function setup() {
  const comp = createComp({ name: 'Nome', width: 1920, height: 1080, duration: 5 });
  const text = createLayer(comp, 'text', { text: 'Fulano', name: 'Nome' });
  const bar = createLayer(comp, 'shape', { name: 'Faixa' });
  return { comp, text, bar };
}

describe('campos editáveis das composições', () => {
  it('marca e desmarca propriedades da camada como campos', () => {
    const { comp, text, bar } = setup();
    const f = addField(comp, text, 'text');
    expect(addField(comp, text, 'text')).toBe(f);
    addField(comp, bar, 'fill', 'Cor da faixa');
    expect(compFields(comp).map((x) => [x.prop, x.label])).toEqual([['text', 'Nome'], ['fill', 'Cor da faixa']]);
    expect(() => addField(comp, bar, 'text')).toThrow();
    removeField(comp, f.id);
    expect(fieldFor(comp, text.id, 'text')).toBeNull();
  });

  it('o padrão é o valor da composição; o clipe pode trocar', () => {
    const { comp, text, bar } = setup();
    const name = addField(comp, text, 'text');
    const color = addField(comp, bar, 'fill');
    expect(fieldDefault(comp, name)).toBe('Fulano');
    expect(fieldDefault(comp, color)).toBe('#4f8cffff');
    expect(fieldValue(comp, name, {})).toBe('Fulano');
    expect(fieldValue(comp, name, { [name.id]: 'Ciclana' })).toBe('Ciclana');
  });

  it('applyFields troca só as camadas afetadas, sem alterar a composição', () => {
    const { comp, text, bar } = setup();
    const name = addField(comp, text, 'text');
    const color = addField(comp, bar, 'fill');
    setKeyframe(bar, 'fill', 0, '#ff0000ff');
    setKeyframe(bar, 'fill', 1, '#00ff00ff');
    expect(applyFields(comp, {})).toBe(comp);
    expect(applyFields(comp, undefined)).toBe(comp);
    const out = applyFields(comp, { [name.id]: 'Maria Silva', [color.id]: '#123456ff' });
    expect(out).not.toBe(comp);
    const t2 = out.layers.find((l) => l.id === text.id);
    const b2 = out.layers.find((l) => l.id === bar.id);
    expect(t2.text).toBe('Maria Silva');
    expect(b2.props.fill).toBe('#123456ff');
    expect(b2.keyframes.fill).toBeUndefined(); // a cor do clipe vale para a camada toda
    expect(text.text).toBe('Fulano');
    expect(bar.keyframes.fill).toHaveLength(2);
  });

  it('texto maior mantém a âncora no centro', () => {
    const { comp, text } = setup();
    const name = addField(comp, text, 'text');
    const before = text.props.ax;
    const t2 = applyFields(comp, { [name.id]: 'Fulano de Tal Souza' }).layers.find((l) => l.id === text.id);
    expect(t2.props.ax).toBeGreaterThan(before);
    // centro continua centro: âncora / largura igual antes e depois
    expect(t2.props.ax / (19 * 10 + 2 * text.font.size * 0.2)).toBeCloseTo(before / (6 * 10 + 2 * text.font.size * 0.2), 6);
  });

  it('cor do texto e imagem', () => {
    const comp = createComp({ duration: 5 });
    const text = createLayer(comp, 'text', { text: 'Oi' });
    const img = createLayer(comp, 'image', { media: { id: 'm1', width: 100, height: 100, name: 'a.png' } });
    const c = addField(comp, text, 'textColor');
    const i = addField(comp, img, 'image');
    const out = applyFields(comp, { [c.id]: '#ff0000ff', [i.id]: 'm2' });
    expect(out.layers.find((l) => l.id === text.id).font.color).toBe('#ff0000');
    const im = out.layers.find((l) => l.id === img.id);
    expect([im.mediaId, im.fit]).toEqual(['m2', 'contain']);
  });

  it('valida valores', () => {
    const color = { prop: 'fill', label: 'Cor' };
    expect(coerceFieldValue(color, '#ABCDEF')).toBe('#abcdefff');
    expect(() => coerceFieldValue(color, 'vermelho')).toThrow(/Cor inválida/);
    expect(coerceFieldValue({ prop: 'text' }, 42)).toBe('42');
  });

  it('camada removida leva o campo junto; mídia removida volta ao padrão', () => {
    const { comp, text } = setup();
    const img = createLayer(comp, 'image', { media: { id: 'm1', width: 10, height: 10 } });
    addField(comp, text, 'text');
    const i = addField(comp, img, 'image');
    state.project.comps = [comp];
    state.project.clips = [{ id: 'c1', type: 'comp', compId: comp.id, fieldValues: { [i.id]: 'm9' } }];
    clearFieldMedia(state.project, 'm9');
    expect(state.project.clips[0].fieldValues).toEqual({});
    removeLayers(comp, [text.id]);
    expect(comp.fields.map((f) => f.prop)).toEqual(['image']);
  });

  it('resumo para o rótulo do clipe e cópia por arquivo .csmotion', () => {
    const { comp, text } = setup();
    const f = addField(comp, text, 'text');
    expect(fieldSummary(comp, { [f.id]: 'Ana\nDiretora' })).toBe('Ana');
    expect(fieldSummary(comp, {})).toBe('');
    const copy = instantiateComp(packComp(comp));
    expect(copy.fields).toHaveLength(1);
    expect(copy.fields[0].layerId).toBe(copy.layers.find((l) => l.text === 'Fulano').id);
    expect(copy.fields[0].id).not.toBe(f.id);
  });
});

if (realCreate) globalThis.document.createElement = realCreate;
