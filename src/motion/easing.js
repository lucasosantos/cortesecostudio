// Curvas de easing: nomeadas ou cubic-bezier [x1, y1, x2, y2].

export const EASING_LABELS = {
  linear: 'Linear',
  ease: 'Suave',
  easeIn: 'Acelerar',
  easeOut: 'Desacelerar',
  easeInOut: 'Acelerar e desacelerar',
  back: 'Passar do ponto',
  bounce: 'Quicar',
  elastic: 'Elástico',
  hold: 'Constante',
};

/** Equivalente bezier aproximado das curvas nomeadas (ponto de partida do editor de curva). */
export const EASING_BEZIER = {
  linear: [0, 0, 1, 1],
  ease: [0.42, 0, 0.58, 1],
  easeIn: [0.42, 0, 1, 1],
  easeOut: [0, 0, 0.58, 1],
  easeInOut: [0.65, 0, 0.35, 1],
  back: [0.34, 1.56, 0.64, 1],
};

function bounceOut(u) {
  const n = 7.5625;
  const d = 2.75;
  if (u < 1 / d) return n * u * u;
  if (u < 2 / d) return n * (u -= 1.5 / d) * u + 0.75;
  if (u < 2.5 / d) return n * (u -= 2.25 / d) * u + 0.9375;
  return n * (u -= 2.625 / d) * u + 0.984375;
}

const NAMED = {
  linear: (u) => u,
  ease: (u) => u * u * (3 - 2 * u),
  easeIn: (u) => u * u * u,
  easeOut: (u) => 1 - (1 - u) ** 3,
  easeInOut: (u) => (u < 0.5 ? 4 * u * u * u : 1 - (-2 * u + 2) ** 3 / 2),
  back: (u) => 1 + 2.70158 * (u - 1) ** 3 + 1.70158 * (u - 1) ** 2,
  bounce: bounceOut,
  elastic: (u) => (u === 0 || u === 1 ? u : 2 ** (-10 * u) * Math.sin(((u * 10 - 0.75) * 2 * Math.PI) / 3) + 1),
  hold: () => 0,
};

/** Resolve y(x) de uma cubic-bezier com extremos (0,0) e (1,1). */
export function cubicBezier(x1, y1, x2, y2, x) {
  if (x <= 0) return 0;
  if (x >= 1) return 1;
  x1 = Math.min(1, Math.max(0, x1));
  x2 = Math.min(1, Math.max(0, x2));
  const bx = (s) => 3 * (1 - s) * (1 - s) * s * x1 + 3 * (1 - s) * s * s * x2 + s * s * s;
  const dbx = (s) => 3 * (1 - s) * (1 - s) * x1 + 6 * (1 - s) * s * (x2 - x1) + 3 * s * s * (1 - x2);
  let s = x;
  for (let i = 0; i < 8; i++) {
    const err = bx(s) - x;
    if (Math.abs(err) < 1e-6) break;
    const d = dbx(s);
    if (Math.abs(d) < 1e-6) break;
    s -= err / d;
  }
  if (!(s >= 0 && s <= 1) || Math.abs(bx(s) - x) > 1e-4) {
    // Newton não convergiu: bisseção (bx é monótona com x1, x2 em [0, 1])
    let lo = 0;
    let hi = 1;
    for (let i = 0; i < 40; i++) {
      s = (lo + hi) / 2;
      if (bx(s) < x) lo = s;
      else hi = s;
    }
  }
  return 3 * (1 - s) * (1 - s) * s * y1 + 3 * (1 - s) * s * s * y2 + s * s * s;
}

/** Progresso u (0..1) transformado pela curva `mode` (nome ou [x1, y1, x2, y2]). */
export function applyEasing(u, mode) {
  if (Array.isArray(mode)) return cubicBezier(mode[0], mode[1], mode[2], mode[3], u);
  return (NAMED[mode] || NAMED.linear)(u);
}

export const isHold = (mode) => mode === 'hold';
