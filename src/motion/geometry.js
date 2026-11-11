// Geometria do motion: matrizes afins 2D e formas convertidas em caminhos bezier.
//
// Matriz: [a, b, c, d, e, f]  →  x' = a·x + c·y + e ;  y' = b·x + d·y + f  (mesma ordem do canvas).
// Caminho: { contours: [{ closed, pts: [{ x, y, ix, iy, ox, oy }] }] }
//   ix/iy e ox/oy são as alças de entrada e saída, relativas ao ponto (0 = canto reto).

export const IDENTITY = [1, 0, 0, 1, 0, 0];
const KAPPA = 0.5522847498;

/** m · n: aplica n primeiro, depois m. */
export function mul(m, n) {
  return [
    m[0] * n[0] + m[2] * n[1],
    m[1] * n[0] + m[3] * n[1],
    m[0] * n[2] + m[2] * n[3],
    m[1] * n[2] + m[3] * n[3],
    m[0] * n[4] + m[2] * n[5] + m[4],
    m[1] * n[4] + m[3] * n[5] + m[5],
  ];
}

/** T(x, y) · R(rotation°) · S(sx%, sy%) · T(-ax, -ay) */
export function trs(p) {
  const r = ((p.rotation || 0) * Math.PI) / 180;
  const cos = Math.cos(r);
  const sin = Math.sin(r);
  const sx = (p.sx ?? 100) / 100;
  const sy = (p.sy ?? 100) / 100;
  const a = cos * sx;
  const b = sin * sx;
  const c = -sin * sy;
  const d = cos * sy;
  const ax = p.ax || 0;
  const ay = p.ay || 0;
  return [a, b, c, d, (p.x || 0) - (a * ax + c * ay), (p.y || 0) - (b * ax + d * ay)];
}

export function invert(m) {
  const det = m[0] * m[3] - m[1] * m[2];
  if (Math.abs(det) < 1e-12) return null;
  const a = m[3] / det;
  const b = -m[1] / det;
  const c = -m[2] / det;
  const d = m[0] / det;
  return [a, b, c, d, -(a * m[4] + c * m[5]), -(b * m[4] + d * m[5])];
}

export const apply = (m, x, y) => [m[0] * x + m[2] * y + m[4], m[1] * x + m[3] * y + m[5]];
/** Só a parte linear (para deslocamentos, sem translação). */
export const applyVec = (m, x, y) => [m[0] * x + m[2] * y, m[1] * x + m[3] * y];

/** Decompõe a parte linear em rotação (graus) e escala (%), ignorando inclinação. */
export function decompose(m) {
  const sx = Math.hypot(m[0], m[1]);
  const det = m[0] * m[3] - m[1] * m[2];
  const sy = sx ? det / sx : 0;
  return { rotation: (Math.atan2(m[1], m[0]) * 180) / Math.PI, sx: sx * 100, sy: sy * 100 };
}

// ---------------------------------------------------------------- formas
const pt = (x, y, ix = 0, iy = 0, ox = 0, oy = 0) => ({ x, y, ix, iy, ox, oy });
const single = (closed, pts) => ({ contours: [{ closed, pts }] });

function rectPath(w, h, radius) {
  const r = Math.max(0, Math.min(radius || 0, Math.abs(w) / 2, Math.abs(h) / 2));
  if (r < 0.01) return single(true, [pt(0, 0), pt(w, 0), pt(w, h), pt(0, h)]);
  const k = r * KAPPA;
  // o raio acompanha o sinal de w/h para a forma continuar válida quando espelhada
  const rx = w < 0 ? -r : r;
  const ry = h < 0 ? -r : r;
  const kx = w < 0 ? -k : k;
  const ky = h < 0 ? -k : k;
  return single(true, [
    pt(rx, 0, -kx, 0), pt(w - rx, 0, 0, 0, kx, 0),
    pt(w, ry, 0, -ky), pt(w, h - ry, 0, 0, 0, ky),
    pt(w - rx, h, kx, 0), pt(rx, h, 0, 0, -kx, 0),
    pt(0, h - ry, 0, ky), pt(0, ry, 0, 0, 0, -ky),
  ]);
}

function ellipsePath(w, h) {
  const rx = w / 2;
  const ry = h / 2;
  const kx = rx * KAPPA;
  const ky = ry * KAPPA;
  return single(true, [
    pt(rx, 0, -kx, 0, kx, 0), pt(w, ry, 0, -ky, 0, ky),
    pt(rx, h, kx, 0, -kx, 0), pt(0, ry, 0, ky, 0, -ky),
  ]);
}

function polygonPath(w, h, sides, inner) {
  const n = Math.max(3, Math.round(sides || 3));
  const rx = w / 2;
  const ry = h / 2;
  const pts = [];
  const count = inner == null ? n : n * 2;
  for (let i = 0; i < count; i++) {
    const a = -Math.PI / 2 + (i * 2 * Math.PI) / count;
    const k = inner != null && i % 2 ? Math.max(0.01, Math.min(1, inner)) : 1;
    pts.push(pt(rx + rx * k * Math.cos(a), ry + ry * k * Math.sin(a)));
  }
  return single(true, pts);
}

/** Caminho (em coordenadas locais) de uma camada de forma com as propriedades p. */
export function shapePath(layer, p) {
  switch (layer.shape) {
    case 'ellipse': return ellipsePath(p.w, p.h);
    case 'polygon': return polygonPath(p.w, p.h, p.sides, null);
    case 'star': return polygonPath(p.w, p.h, p.sides, p.inner ?? 0.5);
    case 'line': return single(false, [pt(0, 0), pt(p.w, p.h)]);
    case 'path': return p.path?.contours ? p.path : { contours: [] };
    default: return rectPath(p.w, p.h, p.radius);
  }
}

const isStraight = (a, b) => !a.ox && !a.oy && !b.ix && !b.iy;

/** Segmentos [a, b] de um contorno, incluindo o de fechamento. */
export function segments(contour) {
  const { pts, closed } = contour;
  const out = [];
  for (let i = 0; i + 1 < pts.length; i++) out.push([pts[i], pts[i + 1]]);
  if (closed && pts.length > 1) out.push([pts[pts.length - 1], pts[0]]);
  return out;
}

/** Desenha o caminho em qualquer alvo com a API de caminho do canvas (contexto ou Path2D). */
export function trace(target, path) {
  for (const contour of path.contours || []) traceContour(target, contour);
}

export function traceContour(target, contour) {
  const { pts } = contour;
  if (!pts.length) return;
  target.moveTo(pts[0].x, pts[0].y);
  for (const [a, b] of segments(contour)) {
    if (isStraight(a, b)) target.lineTo(b.x, b.y);
    else target.bezierCurveTo(a.x + (a.ox || 0), a.y + (a.oy || 0), b.x + (b.ix || 0), b.y + (b.iy || 0), b.x, b.y);
  }
  if (contour.closed) target.closePath();
}

/** Ponto da curva do segmento [a, b] no parâmetro u (0..1). */
export function segmentPoint(a, b, u) {
  if (isStraight(a, b)) return [a.x + (b.x - a.x) * u, a.y + (b.y - a.y) * u];
  const v = 1 - u;
  const c1x = a.x + (a.ox || 0);
  const c1y = a.y + (a.oy || 0);
  const c2x = b.x + (b.ix || 0);
  const c2y = b.y + (b.iy || 0);
  return [
    v * v * v * a.x + 3 * v * v * u * c1x + 3 * v * u * u * c2x + u * u * u * b.x,
    v * v * v * a.y + 3 * v * v * u * c1y + 3 * v * u * u * c2y + u * u * u * b.y,
  ];
}

/** Aproxima o contorno por uma poligonal. */
export function flatten(contour, steps = 16) {
  const { pts } = contour;
  if (!pts.length) return [];
  const out = [[pts[0].x, pts[0].y]];
  for (const [a, b] of segments(contour)) {
    if (isStraight(a, b)) out.push([b.x, b.y]);
    else for (let i = 1; i <= steps; i++) out.push(segmentPoint(a, b, i / steps));
  }
  return out;
}

export function contourLength(contour) {
  const poly = flatten(contour);
  let len = 0;
  for (let i = 1; i < poly.length; i++) len += Math.hypot(poly[i][0] - poly[i - 1][0], poly[i][1] - poly[i - 1][1]);
  return len;
}

/** Caixa delimitadora { x, y, w, h } do caminho, ou null se vazio. */
export function pathBounds(path) {
  let x0 = Infinity;
  let y0 = Infinity;
  let x1 = -Infinity;
  let y1 = -Infinity;
  for (const contour of path?.contours || []) {
    for (const [x, y] of flatten(contour)) {
      if (x < x0) x0 = x;
      if (y < y0) y0 = y;
      if (x > x1) x1 = x;
      if (y > y1) y1 = y;
    }
  }
  return x0 === Infinity ? null : { x: x0, y: y0, w: x1 - x0, h: y1 - y0 };
}

/** Desloca todos os pontos do caminho (devolve um caminho novo). */
export function translatePath(path, dx, dy) {
  return {
    contours: path.contours.map((c) => ({ closed: c.closed, pts: c.pts.map((p) => ({ ...p, x: p.x + dx, y: p.y + dy })) })),
  };
}

/** Aplica uma matriz a todos os pontos e alças (devolve um caminho novo). */
export function transformPath(path, m) {
  return {
    contours: path.contours.map((c) => ({
      closed: c.closed,
      pts: c.pts.map((p) => {
        const [x, y] = apply(m, p.x, p.y);
        const [ix, iy] = applyVec(m, p.ix || 0, p.iy || 0);
        const [ox, oy] = applyVec(m, p.ox || 0, p.oy || 0);
        return { x, y, ix, iy, ox, oy };
      }),
    })),
  };
}

/**
 * Padrão de tracejado que deixa visível só o trecho [start, end] (0..1, com deslocamento) de um contorno.
 * Retorna null para "traço inteiro", false para "nada visível" ou { dash, offset }.
 */
export function trimDash(length, start, end, offset, closed) {
  let s = Math.min(start, end);
  let e = Math.max(start, end);
  s = Math.max(0, Math.min(1, s));
  e = Math.max(0, Math.min(1, e));
  const frac = e - s;
  if (frac <= 1e-6 || length <= 0) return false;
  if (frac >= 1 - 1e-6) return null;
  const vis = frac * length;
  const from = (((s + offset) % 1) + 1) % 1;
  if (closed) return { dash: [vis, length - vis], offset: -from * length };
  if (from + frac <= 1 + 1e-9) return { dash: [vis, length * 2 + 10], offset: -from * length };
  // trecho que dá a volta num caminho aberto: fim do caminho + começo do caminho
  const head = (from + frac - 1) * length;
  return { dash: [head, length - vis, (1 - from) * length, length * 2 + 10], offset: 0 };
}
