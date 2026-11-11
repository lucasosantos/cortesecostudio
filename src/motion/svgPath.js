// Parser do atributo `d` de <path> do SVG → caminho do motion ({ contours: [{ closed, pts }] }).
// Todos os comandos viram segmentos retos ou cúbicas; arcos e quadráticas são convertidos.

const isCommand = (ch) => /[MmLlHhVvCcSsQqTtAaZz]/.test(ch);

/** Leitor sequencial dos números de `d` (aceita "1.5.5", "1-2", "1e-3" e flags de arco coladas). */
function scanner(d) {
  let i = 0;
  const skip = () => { while (i < d.length && /[\s,]/.test(d[i])) i++; };
  return {
    command() {
      skip();
      return i < d.length && isCommand(d[i]) ? d[i++] : null;
    },
    hasNumber() {
      skip();
      return i < d.length && /[-+.\d]/.test(d[i]);
    },
    number() {
      skip();
      const m = /^[-+]?(?:\d+\.?\d*|\.\d+)(?:[eE][-+]?\d+)?/.exec(d.slice(i));
      if (!m) return NaN;
      i += m[0].length;
      return Number(m[0]);
    },
    flag() {
      skip();
      const ch = d[i];
      if (ch !== '0' && ch !== '1') return NaN;
      i++;
      return ch === '1' ? 1 : 0;
    },
    get done() { skip(); return i >= d.length; },
  };
}

/** Converte um arco elíptico do SVG em curvas cúbicas [[c1x, c1y, c2x, c2y, x, y], ...]. */
export function arcToCubics(x1, y1, rx, ry, angle, large, sweep, x2, y2) {
  rx = Math.abs(rx);
  ry = Math.abs(ry);
  if (!rx || !ry || (x1 === x2 && y1 === y2)) return [[x1, y1, x2, y2, x2, y2]];
  const phi = (angle * Math.PI) / 180;
  const cos = Math.cos(phi);
  const sin = Math.sin(phi);
  const dx = (x1 - x2) / 2;
  const dy = (y1 - y2) / 2;
  const xp = cos * dx + sin * dy;
  const yp = -sin * dx + cos * dy;
  // raios pequenos demais são ampliados até o arco alcançar os dois pontos
  const lambda = (xp * xp) / (rx * rx) + (yp * yp) / (ry * ry);
  if (lambda > 1) {
    rx *= Math.sqrt(lambda);
    ry *= Math.sqrt(lambda);
  }
  const num = rx * rx * ry * ry - rx * rx * yp * yp - ry * ry * xp * xp;
  const den = rx * rx * yp * yp + ry * ry * xp * xp;
  const coef = (large === sweep ? -1 : 1) * Math.sqrt(Math.max(0, num / den));
  const cxp = (coef * rx * yp) / ry;
  const cyp = (-coef * ry * xp) / rx;
  const cx = cos * cxp - sin * cyp + (x1 + x2) / 2;
  const cy = sin * cxp + cos * cyp + (y1 + y2) / 2;
  const ang = (ux, uy, vx, vy) => {
    const a = Math.atan2(ux * vy - uy * vx, ux * vx + uy * vy);
    return a;
  };
  const theta1 = ang(1, 0, (xp - cxp) / rx, (yp - cyp) / ry);
  let delta = ang((xp - cxp) / rx, (yp - cyp) / ry, (-xp - cxp) / rx, (-yp - cyp) / ry);
  if (!sweep && delta > 0) delta -= Math.PI * 2;
  if (sweep && delta < 0) delta += Math.PI * 2;

  const n = Math.max(1, Math.ceil(Math.abs(delta) / (Math.PI / 2) - 1e-9));
  const step = delta / n;
  const k = (4 / 3) * Math.tan(step / 4);
  const point = (t) => {
    const ct = Math.cos(t);
    const st = Math.sin(t);
    return {
      x: cx + rx * ct * cos - ry * st * sin,
      y: cy + rx * ct * sin + ry * st * cos,
      dx: -rx * st * cos - ry * ct * sin,
      dy: -rx * st * sin + ry * ct * cos,
    };
  };
  const out = [];
  let a = point(theta1);
  for (let s = 1; s <= n; s++) {
    const b = s === n ? { ...point(theta1 + step * s), x: x2, y: y2 } : point(theta1 + step * s);
    out.push([a.x + k * a.dx, a.y + k * a.dy, b.x - k * b.dx, b.y - k * b.dy, b.x, b.y]);
    a = b;
  }
  return out;
}

export function parseSvgPath(d) {
  const contours = [];
  const s = scanner(String(d || ''));
  let contour = null;
  let x = 0;
  let y = 0;
  let startX = 0;
  let startY = 0;
  let lastCtrl = null; // segundo ponto de controle do último C/S (ou controle do último Q/T)
  let lastKind = '';

  const begin = (px, py) => {
    contour = { closed: false, pts: [{ x: px, y: py, ix: 0, iy: 0, ox: 0, oy: 0 }] };
    contours.push(contour);
    startX = px;
    startY = py;
  };
  const ensure = () => { if (!contour) begin(x, y); };
  const lineTo = (px, py) => {
    ensure();
    contour.pts.push({ x: px, y: py, ix: 0, iy: 0, ox: 0, oy: 0 });
    x = px;
    y = py;
  };
  const cubicTo = (c1x, c1y, c2x, c2y, px, py) => {
    ensure();
    const last = contour.pts[contour.pts.length - 1];
    last.ox = c1x - last.x;
    last.oy = c1y - last.y;
    contour.pts.push({ x: px, y: py, ix: c2x - px, iy: c2y - py, ox: 0, oy: 0 });
    x = px;
    y = py;
  };
  const close = () => {
    if (!contour) return;
    contour.closed = true;
    const pts = contour.pts;
    const first = pts[0];
    const last = pts[pts.length - 1];
    // se o caminho voltou ao ponto inicial, o último ponto é o próprio primeiro
    if (pts.length > 1 && Math.abs(first.x - last.x) < 1e-6 && Math.abs(first.y - last.y) < 1e-6) {
      first.ix = last.ix;
      first.iy = last.iy;
      pts.pop();
    }
    x = startX;
    y = startY;
    contour = null;
  };

  let cmd = s.command();
  while (cmd) {
    const rel = cmd === cmd.toLowerCase();
    const C = cmd.toUpperCase();
    if (C === 'Z') {
      close();
      lastKind = 'Z';
      cmd = s.command();
      continue;
    }
    let first = true;
    // um comando pode ser seguido de vários grupos de argumentos
    while (first || s.hasNumber()) {
      const ox = rel ? x : 0;
      const oy = rel ? y : 0;
      if (C === 'M') {
        const px = s.number() + ox;
        const py = s.number() + oy;
        if (Number.isNaN(px) || Number.isNaN(py)) return { contours: cleanup(contours) };
        // grupos extras depois do primeiro M são linhas
        if (first) { x = px; y = py; begin(px, py); } else lineTo(px, py);
      } else if (C === 'L') {
        lineTo(s.number() + ox, s.number() + oy);
      } else if (C === 'H') {
        lineTo(s.number() + ox, y);
      } else if (C === 'V') {
        lineTo(x, s.number() + oy);
      } else if (C === 'C') {
        const c1x = s.number() + ox;
        const c1y = s.number() + oy;
        const c2x = s.number() + ox;
        const c2y = s.number() + oy;
        cubicTo(c1x, c1y, c2x, c2y, s.number() + ox, s.number() + oy);
        lastCtrl = [c2x, c2y];
      } else if (C === 'S') {
        const c1x = lastKind === 'C' ? 2 * x - lastCtrl[0] : x;
        const c1y = lastKind === 'C' ? 2 * y - lastCtrl[1] : y;
        const c2x = s.number() + ox;
        const c2y = s.number() + oy;
        cubicTo(c1x, c1y, c2x, c2y, s.number() + ox, s.number() + oy);
        lastCtrl = [c2x, c2y];
      } else if (C === 'Q' || C === 'T') {
        let qx;
        let qy;
        if (C === 'Q') {
          qx = s.number() + ox;
          qy = s.number() + oy;
        } else {
          qx = lastKind === 'Q' ? 2 * x - lastCtrl[0] : x;
          qy = lastKind === 'Q' ? 2 * y - lastCtrl[1] : y;
        }
        const px = s.number() + ox;
        const py = s.number() + oy;
        // quadrática → cúbica equivalente
        cubicTo(x + (2 / 3) * (qx - x), y + (2 / 3) * (qy - y), px + (2 / 3) * (qx - px), py + (2 / 3) * (qy - py), px, py);
        lastCtrl = [qx, qy];
      } else if (C === 'A') {
        const rx = s.number();
        const ry = s.number();
        const rot = s.number();
        const large = s.flag();
        const sweep = s.flag();
        const px = s.number() + ox;
        const py = s.number() + oy;
        if ([rx, ry, rot, large, sweep, px, py].some(Number.isNaN)) return { contours: cleanup(contours) };
        if (!rx || !ry) lineTo(px, py);
        else for (const c of arcToCubics(x, y, rx, ry, rot, large, sweep, px, py)) cubicTo(...c);
      }
      if (Number.isNaN(x) || Number.isNaN(y)) return { contours: cleanup(contours) };
      lastKind = C === 'S' ? 'C' : C === 'T' ? 'Q' : C;
      first = false;
    }
    cmd = s.command();
  }
  return { contours: cleanup(contours) };
}

/** Descarta pontos inválidos e contornos sem segmento. */
function cleanup(contours) {
  return contours
    .map((c) => ({ closed: c.closed, pts: c.pts.filter((p) => [p.x, p.y, p.ix, p.iy, p.ox, p.oy].every(Number.isFinite)) }))
    .filter((c) => c.pts.length >= 2);
}

const n = (v) => +(+v).toFixed(4);

/** Formas básicas do SVG como string `d` (para reaproveitar o mesmo parser). */
export function shapeToD(tag, a) {
  const num = (k, def = 0) => { const v = parseFloat(a[k]); return Number.isFinite(v) ? v : def; };
  if (tag === 'rect') {
    const x = num('x');
    const y = num('y');
    const w = num('width');
    const h = num('height');
    if (w <= 0 || h <= 0) return '';
    let rx = a.rx != null ? num('rx') : a.ry != null ? num('ry') : 0;
    let ry = a.ry != null ? num('ry') : rx;
    rx = Math.min(Math.max(0, rx), w / 2);
    ry = Math.min(Math.max(0, ry), h / 2);
    if (!rx || !ry) return `M${n(x)} ${n(y)}h${n(w)}v${n(h)}h${n(-w)}z`;
    return `M${n(x + rx)} ${n(y)}h${n(w - 2 * rx)}a${rx} ${ry} 0 0 1 ${rx} ${ry}v${n(h - 2 * ry)}a${rx} ${ry} 0 0 1 ${-rx} ${ry}h${n(2 * rx - w)}a${rx} ${ry} 0 0 1 ${-rx} ${-ry}v${n(2 * ry - h)}a${rx} ${ry} 0 0 1 ${rx} ${-ry}z`;
  }
  if (tag === 'circle' || tag === 'ellipse') {
    const cx = num('cx');
    const cy = num('cy');
    const rx = tag === 'circle' ? num('r') : num('rx');
    const ry = tag === 'circle' ? num('r') : num('ry');
    if (rx <= 0 || ry <= 0) return '';
    return `M${n(cx - rx)} ${n(cy)}a${rx} ${ry} 0 1 1 ${n(2 * rx)} 0a${rx} ${ry} 0 1 1 ${n(-2 * rx)} 0z`;
  }
  if (tag === 'line') return `M${num('x1')} ${num('y1')}L${num('x2')} ${num('y2')}`;
  if (tag === 'polyline' || tag === 'polygon') {
    const nums = (String(a.points || '').match(/[-+]?(?:\d+\.?\d*|\.\d+)(?:[eE][-+]?\d+)?/g) || []).map(Number);
    if (nums.length < 4) return '';
    let d = '';
    for (let i = 0; i + 1 < nums.length; i += 2) d += `${i ? 'L' : 'M'}${nums[i]} ${nums[i + 1]}`;
    return tag === 'polygon' ? d + 'z' : d;
  }
  return '';
}
