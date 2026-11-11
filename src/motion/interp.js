// Interpolação por tipo de valor: número, cor (#rgb, #rrggbb, #rrggbbaa) e caminho bezier
// ({ contours: [{ closed, pts }] }, ver geometry.js).

const clamp255 = (v) => Math.min(255, Math.max(0, Math.round(v)));
const hex2 = (v) => clamp255(v).toString(16).padStart(2, '0');

export const isColor = (v) => typeof v === 'string' && v[0] === '#';
export const isPath = (v) => !!v && typeof v === 'object' && Array.isArray(v.contours);

/** '#rrggbbaa' → [r, g, b, a] com canais 0..255. */
export function parseColor(c) {
  let s = String(c || '#000').slice(1);
  if (s.length === 3 || s.length === 4) s = [...s].map((ch) => ch + ch).join('');
  if (s.length === 6) s += 'ff';
  const n = (i) => {
    const v = parseInt(s.slice(i, i + 2), 16);
    return Number.isNaN(v) ? (i === 6 ? 255 : 0) : v;
  };
  return [n(0), n(2), n(4), n(6)];
}

export function formatColor([r, g, b, a = 255]) {
  return `#${hex2(r)}${hex2(g)}${hex2(b)}${hex2(a)}`;
}

/** Cor no formato aceito pelo canvas (rgba), para qualquer entrada hex. */
export function cssColor(c) {
  const [r, g, b, a] = parseColor(c);
  return a === 255 ? `rgb(${r},${g},${b})` : `rgba(${r},${g},${b},${+(a / 255).toFixed(4)})`;
}

export function lerpColor(a, b, u) {
  const ca = parseColor(a);
  const cb = parseColor(b);
  return formatColor(ca.map((v, i) => v + (cb[i] - v) * u));
}

/** Caminhos só se misturam quando têm a mesma estrutura; senão vale o de origem. */
export function canMorph(a, b) {
  return isPath(a) && isPath(b) && a.contours.length === b.contours.length
    && a.contours.every((c, i) => c.pts.length === b.contours[i].pts.length && !!c.closed === !!b.contours[i].closed);
}

export function lerpPath(a, b, u) {
  if (!canMorph(a, b)) return a;
  const l = (x, y) => (x || 0) + ((y || 0) - (x || 0)) * u;
  return {
    contours: a.contours.map((c, ci) => ({
      closed: !!c.closed,
      pts: c.pts.map((p, i) => {
        const q = b.contours[ci].pts[i];
        return { x: l(p.x, q.x), y: l(p.y, q.y), ix: l(p.ix, q.ix), iy: l(p.iy, q.iy), ox: l(p.ox, q.ox), oy: l(p.oy, q.oy) };
      }),
    })),
  };
}

export function lerpValue(a, b, u) {
  if (typeof a === 'number' && typeof b === 'number') return a + (b - a) * u;
  if (isColor(a) && isColor(b)) return lerpColor(a, b, u);
  if (isPath(a)) return lerpPath(a, b, u);
  return a;
}

export const cloneValue = (v) => (v && typeof v === 'object' ? JSON.parse(JSON.stringify(v)) : v);
