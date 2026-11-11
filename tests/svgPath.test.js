import { describe, it, expect } from 'vitest';
import { parseSvgPath, shapeToD, arcToCubics } from '../src/motion/svgPath.js';
import { pathBounds, contourLength } from '../src/motion/geometry.js';

const xy = (c) => c.pts.map((p) => [p.x, p.y]);

describe('parser de path do SVG', () => {
  it('linhas absolutas e relativas, H e V', () => {
    const p = parseSvgPath('M10 10 L20 10 l0 10 H10 v-5');
    expect(p.contours).toHaveLength(1);
    expect(xy(p.contours[0])).toEqual([[10, 10], [20, 10], [20, 20], [10, 20], [10, 15]]);
    expect(p.contours[0].closed).toBe(false);
  });
  it('grupos extras depois de M são linhas e números colados são separados', () => {
    const p = parseSvgPath('M0,0 10,0 10,10z');
    expect(xy(p.contours[0])).toEqual([[0, 0], [10, 0], [10, 10]]);
    expect(p.contours[0].closed).toBe(true);
    expect(xy(parseSvgPath('M1.5.5-2-3').contours[0])).toEqual([[1.5, 0.5], [-2, -3]]);
    expect(xy(parseSvgPath('M0 0l1e1 0').contours[0])).toEqual([[0, 0], [10, 0]]);
  });
  it('cúbica guarda as alças relativas aos pontos', () => {
    const c = parseSvgPath('M0 0 C10 0 20 10 20 20').contours[0];
    expect(c.pts[0]).toMatchObject({ ox: 10, oy: 0 });
    expect(c.pts[1]).toMatchObject({ x: 20, y: 20, ix: 0, iy: -10 });
  });
  it('S espelha o controle anterior e Q vira cúbica equivalente', () => {
    const s = parseSvgPath('M0 0 C0 10 10 10 10 0 S20 -10 20 0').contours[0];
    // controle espelhado de (10,10) em torno de (10,0) é (10,-10)
    expect(s.pts[1]).toMatchObject({ ox: 0, oy: -10 });
    const q = parseSvgPath('M0 0 Q30 30 60 0').contours[0];
    expect(q.pts[0].ox).toBeCloseTo(20);
    expect(q.pts[0].oy).toBeCloseTo(20);
    expect(q.pts[1].ix).toBeCloseTo(-20);
    const t = parseSvgPath('M0 0 Q10 10 20 0 T40 0').contours[0];
    expect(t.pts[1].oy).toBeCloseTo(-20 / 3);
  });
  it('vários subcaminhos e fechamento que volta ao início', () => {
    const p = parseSvgPath('M0 0h10v10h-10z M2 2h6v6h-6V2z');
    expect(p.contours).toHaveLength(2);
    expect(p.contours[1].closed).toBe(true);
    // o último ponto coincidia com o primeiro e foi fundido
    expect(p.contours[1].pts).toHaveLength(4);
  });
  it('depois de Z o ponto atual volta ao início do subcaminho', () => {
    const p = parseSvgPath('M5 5 l10 0 l0 10 z l-3 0');
    expect(xy(p.contours[1])).toEqual([[5, 5], [2, 5]]);
  });
  it('arco: semicírculo tem o comprimento esperado e termina no ponto exato', () => {
    const c = parseSvgPath('M0 0 A50 50 0 0 1 100 0').contours[0];
    const last = c.pts[c.pts.length - 1];
    expect([last.x, last.y]).toEqual([100, 0]);
    expect(Math.abs(contourLength(c) - Math.PI * 50)).toBeLessThan(0.2);
    const b = pathBounds({ contours: [c] });
    expect(b.y).toBeCloseTo(-50, 1);
  });
  it('arco com flags coladas e raio pequeno demais', () => {
    const c = parseSvgPath('M0 0a5 5 0 01 10 0').contours[0];
    expect(c.pts[c.pts.length - 1].x).toBeCloseTo(10);
    // raio 1 não alcança 10 px: é ampliado para um semicírculo de raio 5
    const cubics = arcToCubics(0, 0, 1, 1, 0, 0, 1, 10, 0);
    expect(cubics[cubics.length - 1].slice(4)).toEqual([10, 0]);
  });
  it('entrada inválida não quebra', () => {
    expect(parseSvgPath('').contours).toEqual([]);
    expect(parseSvgPath(null).contours).toEqual([]);
    expect(parseSvgPath('M10 10').contours).toEqual([]);
    expect(parseSvgPath('M0 0 L10 x').contours.length).toBeLessThanOrEqual(1);
  });
});

describe('formas básicas do SVG', () => {
  const bounds = (tag, attrs) => pathBounds(parseSvgPath(shapeToD(tag, attrs)));
  it('rect simples e arredondado', () => {
    expect(bounds('rect', { x: '10', y: '20', width: '30', height: '40' })).toMatchObject({ x: 10, y: 20, w: 30, h: 40 });
    const r = parseSvgPath(shapeToD('rect', { width: '100', height: '50', rx: '10' }));
    expect(r.contours[0].closed).toBe(true);
    const b = pathBounds(r);
    expect(b.w).toBeCloseTo(100, 3);
    expect(b.h).toBeCloseTo(50, 3);
    expect(shapeToD('rect', { width: '0', height: '5' })).toBe('');
  });
  it('circle e ellipse', () => {
    const b = bounds('circle', { cx: '50', cy: '50', r: '20' });
    expect(b.x).toBeCloseTo(30, 1);
    expect(b.w).toBeCloseTo(40, 1);
    const e = bounds('ellipse', { cx: '0', cy: '0', rx: '30', ry: '10' });
    expect(e.w).toBeCloseTo(60, 1);
    expect(e.h).toBeCloseTo(20, 1);
  });
  it('line, polyline e polygon', () => {
    expect(xy(parseSvgPath(shapeToD('line', { x1: '1', y1: '2', x2: '3', y2: '4' })).contours[0])).toEqual([[1, 2], [3, 4]]);
    const pl = parseSvgPath(shapeToD('polyline', { points: '0,0 10,0 10,10' })).contours[0];
    expect(pl.closed).toBe(false);
    const pg = parseSvgPath(shapeToD('polygon', { points: '0,0 10,0 10,10' })).contours[0];
    expect(pg.closed).toBe(true);
    expect(pg.pts).toHaveLength(3);
  });
});
