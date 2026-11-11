import { describe, it, expect, beforeEach } from 'vitest';
import { state, newProject, newMotionState, loadProject, createCompClip, undo, checkpoint } from '../src/state/project.js';
import { setKeyframe } from '../src/state/keyframes.js';
import {
  IDENTITY, mul, trs, invert, apply, decompose, shapePath, flatten, contourLength, pathBounds, trimDash, trace,
} from '../src/motion/geometry.js';
import {
  createComp, createLayer, removeComp, removeLayers, duplicateLayers, moveLayer, setParent, worldMatrix, isDescendant,
  layerPropsAt, localBounds, layerActive, shiftLayer, setCompDuration, getComp,
} from '../src/motion/model.js';

const near = (a, b) => a.forEach((v, i) => expect(v).toBeCloseTo(b[i], 6));

beforeEach(() => {
  state.project = newProject();
  state.motion = newMotionState();
  state.mode = 'edit';
  state.selection = null;
});

describe('matrizes', () => {
  it('trs gira em torno da âncora e a leva até a posição', () => {
    const m = trs({ x: 100, y: 50, ax: 10, ay: 10, sx: 200, sy: 100, rotation: 90 });
    near(apply(m, 10, 10), [100, 50]);
    // 5 px à direita da âncora, escala 2 e rotação de 90° → 10 px para baixo
    near(apply(m, 15, 10), [100, 60]);
  });
  it('inversa desfaz a matriz e mul compõe na ordem certa', () => {
    const m = trs({ x: 30, y: -4, ax: 2, ay: 3, sx: 150, sy: 60, rotation: 33 });
    near(mul(m, invert(m)), IDENTITY);
    const t = trs({ x: 10, y: 0 });
    const r = trs({ rotation: 90 });
    near(apply(mul(t, r), 1, 0), [10, 1]);
    expect(invert([0, 0, 0, 0, 1, 1])).toBeNull();
  });
  it('decompose recupera rotação e escala', () => {
    const d = decompose(trs({ sx: 250, sy: 40, rotation: -70 }));
    expect(d.rotation).toBeCloseTo(-70, 6);
    expect(d.sx).toBeCloseTo(250, 6);
    expect(d.sy).toBeCloseTo(40, 6);
  });
});

describe('formas', () => {
  const shape = (kind, p) => shapePath({ shape: kind }, { w: 100, h: 50, radius: 0, sides: 5, inner: 0.5, ...p });
  it('retângulo, elipse, polígono e estrela ocupam a caixa da camada', () => {
    for (const kind of ['rect', 'ellipse']) {
      const b = pathBounds(shape(kind));
      near([b.x, b.y, b.w, b.h], [0, 0, 100, 50]);
    }
    expect(shape('polygon', { sides: 6 }).contours[0].pts).toHaveLength(6);
    expect(shape('star', { sides: 5 }).contours[0].pts).toHaveLength(10);
    expect(shape('rect', { radius: 10 }).contours[0].pts).toHaveLength(8);
  });
  it('o raio do retângulo é limitado à metade do menor lado', () => {
    const b = pathBounds(shape('rect', { radius: 999 }));
    near([b.w, b.h], [100, 50]);
  });
  it('comprimento: linha, retângulo e círculo', () => {
    expect(contourLength(shape('line', { w: 30, h: 40 }).contours[0])).toBeCloseTo(50, 6);
    expect(contourLength(shape('rect').contours[0])).toBeCloseTo(300, 6);
    const circle = contourLength(shape('ellipse', { w: 100, h: 100 }).contours[0]);
    expect(Math.abs(circle - Math.PI * 100)).toBeLessThan(0.5);
  });
  it('trace emite os comandos do canvas e fecha contornos fechados', () => {
    const calls = [];
    const rec = new Proxy({}, { get: (_, name) => (...args) => calls.push([name, ...args]) });
    trace(rec, shape('rect'));
    expect(calls.map((c) => c[0])).toEqual(['moveTo', 'lineTo', 'lineTo', 'lineTo', 'lineTo', 'closePath']);
    calls.length = 0;
    trace(rec, shape('ellipse'));
    expect(calls.filter((c) => c[0] === 'bezierCurveTo')).toHaveLength(4);
  });
  it('flatten de contorno vazio não quebra', () => {
    expect(flatten({ closed: true, pts: [] })).toEqual([]);
    expect(pathBounds({ contours: [] })).toBeNull();
  });
});

describe('trim do traço', () => {
  it('inteiro, vazio e parcial', () => {
    expect(trimDash(100, 0, 1, 0, false)).toBeNull();
    expect(trimDash(100, 0.3, 0.3, 0, false)).toBe(false);
    const d = trimDash(100, 0.25, 0.75, 0, false);
    expect(d.dash[0]).toBeCloseTo(50);
    expect(d.offset).toBeCloseTo(-25);
    expect(d.dash[1]).toBeGreaterThan(100);
  });
  it('início maior que fim equivale ao trecho invertido', () => {
    expect(trimDash(100, 0.75, 0.25, 0, false).dash[0]).toBeCloseTo(50);
  });
  it('em contorno fechado o padrão tem o período do contorno', () => {
    const d = trimDash(200, 0, 0.25, 0.9, true);
    expect(d.dash[0] + d.dash[1]).toBeCloseTo(200);
    expect(d.offset).toBeCloseTo(-180);
  });
  it('em contorno aberto o trecho que passa do fim reaparece no começo', () => {
    const d = trimDash(100, 0, 0.5, 0.8, false);
    expect(d.dash[0]).toBeCloseTo(30);
    expect(d.dash[2]).toBeCloseTo(20);
  });
});

describe('composições e camadas', () => {
  it('nova composição herda o tamanho do projeto e a camada entra centralizada na frente', () => {
    const comp = createComp({ duration: 4 });
    expect([comp.width, comp.height]).toEqual([1920, 1080]);
    const a = createLayer(comp, 'shape', { shape: 'rect', w: 200, h: 100 });
    const b = createLayer(comp, 'shape', { shape: 'ellipse' });
    expect(comp.layers.map((l) => l.id)).toEqual([b.id, a.id]);
    expect(a.props).toMatchObject({ x: 960, y: 540, ax: 100, ay: 50 });
    expect(a.out).toBe(4);
    near(apply(worldMatrix(comp, a, 0), 100, 50), [960, 540]);
  });
  it('linha nasce só com traço e caminho é guardado relativo à própria caixa', () => {
    const comp = createComp();
    const line = createLayer(comp, 'shape', { shape: 'line', w: 100, h: 0 });
    expect([line.fillOn, line.strokeOn]).toEqual([false, true]);
    const path = { contours: [{ closed: true, pts: [{ x: 100, y: 200 }, { x: 300, y: 200 }, { x: 300, y: 260 }] }] };
    const layer = createLayer(comp, 'shape', { shape: 'path', path });
    expect(layer.props.path.contours[0].pts[0]).toMatchObject({ x: 0, y: 0 });
    // os pontos continuam no mesmo lugar da composição
    near(apply(worldMatrix(comp, layer, 0), 0, 0), [100, 200]);
    expect(localBounds(layer, layerPropsAt(layer, 0))).toMatchObject({ w: 200, h: 60 });
  });
  it('filha acompanha o pai e aparentar não tira a camada do lugar', () => {
    const comp = createComp();
    const parent = createLayer(comp, 'group', { x: 500, y: 300 });
    parent.props.rotation = 90;
    parent.props.sx = 200;
    const child = createLayer(comp, 'shape', { x: 700, y: 300, w: 50, h: 50 });
    const before = apply(worldMatrix(comp, child, 0), 25, 25);
    expect(setParent(comp, child, parent.id, 0)).toBe(true);
    near(apply(worldMatrix(comp, child, 0), 25, 25), before);
    near(apply(worldMatrix(comp, child, 0), 0, 0), apply(mul(trs({ x: 700, y: 300, ax: 25, ay: 25 }), IDENTITY), 0, 0));
    parent.props.x += 40;
    near(apply(worldMatrix(comp, child, 0), 25, 25), [before[0] + 40, before[1]]);
    expect(setParent(comp, child, null, 0)).toBe(true);
    near(apply(worldMatrix(comp, child, 0), 25, 25), [before[0] + 40, before[1]]);
  });
  it('recusa ciclos de parentesco', () => {
    const comp = createComp();
    const a = createLayer(comp, 'group');
    const b = createLayer(comp, 'group');
    const c = createLayer(comp, 'group');
    setParent(comp, b, a.id);
    setParent(comp, c, b.id);
    expect(isDescendant(comp, c, a.id)).toBe(true);
    expect(setParent(comp, a, c.id)).toBe(false);
    expect(setParent(comp, a, a.id)).toBe(false);
    expect(a.parentId).toBeNull();
  });
  it('remover o pai mantém as filhas no lugar e desfaz mattes órfãos', () => {
    const comp = createComp();
    const top = createLayer(comp, 'group', { x: 100, y: 100 });
    const mid = createLayer(comp, 'group', { x: 300, y: 100 });
    const leaf = createLayer(comp, 'shape', { x: 400, y: 400, w: 10, h: 10 });
    setParent(comp, mid, top.id);
    setParent(comp, leaf, mid.id);
    leaf.matte = { layerId: mid.id, inverted: false };
    const before = apply(worldMatrix(comp, leaf, 0), 5, 5);
    state.motion.selection = [mid.id, leaf.id];
    removeLayers(comp, [mid.id]);
    expect(leaf.parentId).toBe(top.id);
    expect(leaf.matte).toBeNull();
    near(apply(worldMatrix(comp, leaf, 0), 5, 5), before);
    expect(state.motion.selection).toEqual([leaf.id]);
  });
  it('duplicar, reordenar e deslocar no tempo', () => {
    const comp = createComp({ duration: 10 });
    const a = createLayer(comp, 'shape');
    const b = createLayer(comp, 'shape');
    const [copy] = duplicateLayers(comp, [a.id]);
    expect(comp.layers.map((l) => l.id)).toEqual([b.id, copy.id, a.id]);
    expect(copy.id).not.toBe(a.id);
    moveLayer(comp, a.id, -1);
    expect(comp.layers.map((l) => l.id)).toEqual([b.id, a.id, copy.id]);
    moveLayer(comp, b.id, -1);
    expect(comp.layers[0].id).toBe(b.id);
    setKeyframe(a, 'x', 1, 5);
    a.in = 1;
    a.out = 3;
    shiftLayer(a, 2);
    expect([a.in, a.out, a.keyframes.x[0].t]).toEqual([3, 5, 3]);
    expect(layerActive(a, 3)).toBe(true);
    expect(layerActive(a, 5)).toBe(false);
  });
  it('mudar a duração leva junto as camadas que iam até o fim', () => {
    const comp = createComp({ duration: 5 });
    const full = createLayer(comp, 'shape');
    const short = createLayer(comp, 'shape');
    short.out = 2;
    setCompDuration(comp, 8);
    expect([full.out, short.out]).toEqual([8, 2]);
    setCompDuration(comp, 1);
    expect([full.out, short.out]).toEqual([1, 1]);
  });
  it('remover a composição remove os clipes que a exibem e desfazer restaura', () => {
    const comp = createComp();
    const clip = createCompClip(comp, state.project.tracks[0].id, 2);
    expect(clip).toMatchObject({ type: 'comp', compId: comp.id, duration: comp.duration });
    state.selection = clip.id;
    state.motion.compId = comp.id;
    checkpoint();
    removeComp(comp.id);
    expect(state.project.clips).toHaveLength(0);
    expect(state.selection).toBeNull();
    expect(state.motion.compId).toBeNull();
    undo();
    expect(getComp(comp.id)).not.toBeNull();
    expect(state.project.clips).toHaveLength(1);
  });
  it('desfazer a criação da composição aberta sai do modo motion', () => {
    checkpoint();
    const comp = createComp();
    state.mode = 'motion';
    state.motion.compId = comp.id;
    undo();
    expect(state.mode).toBe('edit');
    expect(state.motion.compId).toBeNull();
  });
  it('projeto salvo antes do módulo ganha a lista de composições', () => {
    const old = newProject();
    delete old.comps;
    loadProject({ app: 'MineEditor', version: 1, project: old });
    expect(state.project.comps).toEqual([]);
    expect(state.mode).toBe('edit');
  });
});
