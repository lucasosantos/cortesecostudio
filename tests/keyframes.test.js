import { describe, it, expect } from 'vitest';
import { applyEasing, cubicBezier } from '../src/motion/easing.js';
import { parseColor, lerpColor, lerpPath, lerpValue, cssColor } from '../src/motion/interp.js';
import {
  valueAt, setKeyframe, setProp, removeKeyframe, keyframeTimes, moveKeyframesAt, removeKeyframesAt, shiftKeyframes, propsAt,
} from '../src/state/keyframes.js';

const clip = () => ({ props: { x: 10, y: 0, width: 100, height: 50, rotation: 0, opacity: 1, volume: 1 }, keyframes: {} });

describe('easing', () => {
  it('mantém os extremos em todas as curvas contínuas', () => {
    for (const m of ['linear', 'ease', 'easeIn', 'easeOut', 'easeInOut', 'back', 'bounce', 'elastic', [0.2, 0.8, 0.4, 1]]) {
      expect(applyEasing(0, m)).toBeCloseTo(0, 5);
      expect(applyEasing(1, m)).toBeCloseTo(1, 5);
    }
  });
  it('hold fica no valor de origem e curva desconhecida vira linear', () => {
    expect(applyEasing(0.9, 'hold')).toBe(0);
    expect(applyEasing(0.3, 'nada')).toBe(0.3);
  });
  it('cubic-bezier linear é a identidade e ease-in fica abaixo da diagonal', () => {
    expect(cubicBezier(0, 0, 1, 1, 0.37)).toBeCloseTo(0.37, 4);
    expect(cubicBezier(0.42, 0, 1, 1, 0.5)).toBeLessThan(0.5);
    expect(cubicBezier(0.25, 0.1, 0.25, 1, 0.5)).toBeCloseTo(0.8024, 3);
  });
  it('back ultrapassa 1 no meio do caminho', () => {
    expect(applyEasing(0.7, 'back')).toBeGreaterThan(1);
  });
});

describe('interpolação', () => {
  it('lê cores curtas, longas e com alfa', () => {
    expect(parseColor('#f00')).toEqual([255, 0, 0, 255]);
    expect(parseColor('#00ff0080')).toEqual([0, 255, 0, 128]);
    expect(cssColor('#ff0000')).toBe('rgb(255,0,0)');
  });
  it('mistura cores canal a canal', () => {
    expect(lerpColor('#000000', '#ffffff', 0.5)).toBe('#808080ff');
    expect(lerpValue('#ff0000', '#0000ff', 1)).toBe('#0000ffff');
  });
  it('mistura caminhos com a mesma estrutura e mantém a origem quando diferem', () => {
    const a = { contours: [{ closed: true, pts: [{ x: 0, y: 0 }, { x: 10, y: 0, ox: 2 }] }] };
    const b = { contours: [{ closed: true, pts: [{ x: 10, y: 10 }, { x: 20, y: 0, ox: 4 }] }] };
    const m = lerpPath(a, b, 0.5);
    expect(m.contours[0].pts[0]).toMatchObject({ x: 5, y: 5 });
    expect(m.contours[0].pts[1].ox).toBe(3);
    expect(lerpPath(a, { contours: [{ closed: true, pts: [{ x: 1, y: 1 }] }] }, 0.5)).toBe(a);
  });
});

describe('keyframes', () => {
  it('sem keyframes devolve o valor estático', () => {
    expect(valueAt(clip(), 'x', 3)).toBe(10);
  });
  it('interpola linear, suave e constante como antes', () => {
    const c = clip();
    setKeyframe(c, 'x', 0, 0);
    setKeyframe(c, 'x', 2, 100);
    expect(valueAt(c, 'x', -1)).toBe(0);
    expect(valueAt(c, 'x', 1)).toBe(50);
    expect(valueAt(c, 'x', 5)).toBe(100);
    c.keyframes.x[0].ease = 'ease';
    expect(valueAt(c, 'x', 0.5)).toBeCloseTo(15.625, 5);
    c.keyframes.x[0].ease = 'hold';
    expect(valueAt(c, 'x', 1.9)).toBe(0);
  });
  it('aceita curva bezier por keyframe', () => {
    const c = clip();
    setKeyframe(c, 'x', 0, 0, [0.42, 0, 1, 1]);
    setKeyframe(c, 'x', 1, 100);
    expect(valueAt(c, 'x', 0.5)).toBeLessThan(50);
  });
  it('anima cor e guarda cópia de valores-objeto', () => {
    const layer = { props: { fill: '#000000', path: null }, keyframes: {} };
    setKeyframe(layer, 'fill', 0, '#000000');
    setKeyframe(layer, 'fill', 1, '#ffffff');
    expect(valueAt(layer, 'fill', 0.5)).toBe('#808080ff');
    const path = { contours: [{ closed: false, pts: [{ x: 0, y: 0 }] }] };
    setKeyframe(layer, 'path', 0, path);
    path.contours[0].pts[0].x = 99;
    expect(layer.keyframes.path[0].v.contours[0].pts[0].x).toBe(0);
  });
  it('em cima de um keyframe vale o valor dele, mesmo quando os vizinhos não se misturam', () => {
    const tri = { contours: [{ closed: true, pts: [{ x: 0, y: 0 }, { x: 1, y: 0 }, { x: 0, y: 1 }] }] };
    const quad = { contours: [{ closed: true, pts: [{ x: 0, y: 0 }, { x: 1, y: 0 }, { x: 1, y: 1 }, { x: 0, y: 1 }] }] };
    const layer = { props: { path: tri }, keyframes: {} };
    setKeyframe(layer, 'path', 0, tri);
    setKeyframe(layer, 'path', 1, quad);
    setKeyframe(layer, 'path', 2, tri);
    expect(valueAt(layer, 'path', 0.5).contours[0].pts).toHaveLength(3);
    expect(valueAt(layer, 'path', 1).contours[0].pts).toHaveLength(4);
    expect(valueAt(layer, 'path', 1.5).contours[0].pts).toHaveLength(4);
    expect(valueAt(layer, 'path', 2).contours[0].pts).toHaveLength(3);
  });
  it('setProp só grava keyframe quando a propriedade já é animada ou com autoKey', () => {
    const c = clip();
    setProp(c, 'y', 5, 1);
    expect(c.props.y).toBe(5);
    expect(c.keyframes.y).toBeUndefined();
    setProp(c, 'y', 9, 1, true);
    expect(c.keyframes.y).toHaveLength(1);
  });
  it('remover o último keyframe fixa o valor atual', () => {
    const c = clip();
    setKeyframe(c, 'x', 1, 42);
    removeKeyframe(c, 'x', 1);
    expect(c.keyframes.x).toBeUndefined();
    expect(c.props.x).toBe(42);
  });
  it('operações em lote alcançam qualquer propriedade animada, não só as dos clipes', () => {
    const layer = { props: { sx: 100, fill: '#fff' }, keyframes: {} };
    setKeyframe(layer, 'sx', 1, 50);
    setKeyframe(layer, 'fill', 1, '#000000');
    setKeyframe(layer, 'fill', 2, '#ffffff');
    expect(keyframeTimes(layer)).toEqual([1, 2]);
    moveKeyframesAt(layer, 1, 0.5);
    expect(layer.keyframes.sx[0].t).toBe(0.5);
    expect(layer.keyframes.fill[0].t).toBe(0.5);
    shiftKeyframes(layer, 1);
    expect(keyframeTimes(layer)).toEqual([1.5, 3]);
    removeKeyframesAt(layer, 1.5);
    expect(layer.keyframes.sx).toBeUndefined();
    expect(layer.keyframes.fill).toHaveLength(1);
  });
  it('propsAt continua devolvendo as sete propriedades do clipe', () => {
    expect(Object.keys(propsAt(clip(), 0))).toEqual(['x', 'y', 'width', 'height', 'rotation', 'opacity', 'volume']);
  });
});
