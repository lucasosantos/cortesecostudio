// Modo visual do FX Lab: catálogo de blocos montáveis por formulário e gerador do GLSL correspondente.
// Módulo puro (sem DOM): a montagem ("spec") vira { glsl, params } no formato das extensões do app.
import { parseColor } from '../motion/interp.js';

/** Marca no início do código gerado: guarda a montagem para o FX Lab reabrir no modo visual. */
export const VISUAL_TAG = '// fxlab:visual ';

// ---------------------------------------------------------------- campos
const F = (key, label, def, min, max, step, hint) => ({ key, label, type: 'float', default: def, min, max, step, hint });
const B = (key, label, def, hint) => ({ key, label, type: 'bool', default: def, hint });
const C3 = (key, label, def) => ({ key, label, type: 'color3', default: def });
const V2 = (key, label, def, hint) => ({ key, label, type: 'vec2', default: def, hint });
const S = (key, label, options, def) => ({ key, label, type: 'select', options, default: def });

export const EASINGS = {
  linear: 'Linear', smooth: 'Suave', in: 'Acelerando', out: 'Freando', inout: 'Acelera e freia',
  back: 'Com repique', elastic: 'Elástico', bounce: 'Quicando',
};
const EASE_GLSL = {
  linear: 'return t;',
  smooth: 'return t * t * (3.0 - 2.0 * t);',
  in: 'return t * t * t;',
  out: 'float u = 1.0 - t;\n  return 1.0 - u * u * u;',
  inout: 'return t < 0.5 ? 4.0 * t * t * t : 1.0 - pow(-2.0 * t + 2.0, 3.0) / 2.0;',
  back: 'float u = t - 1.0;\n  return u * u * (2.70158 * u + 1.70158) + 1.0;',
  elastic: 'if (t <= 0.0 || t >= 1.0) return t;\n  return pow(2.0, -10.0 * t) * sin((t * 10.0 - 0.75) * 2.0943951) + 1.0;',
  bounce: `float n = 7.5625;
  float d = 2.75;
  if (t < 1.0 / d) return n * t * t;
  if (t < 2.0 / d) { t -= 1.5 / d; return n * t * t + 0.75; }
  if (t < 2.5 / d) { t -= 2.25 / d; return n * t * t + 0.9375; }
  t -= 2.625 / d;
  return n * t * t + 0.984375;`,
};

// ---------------------------------------------------------------- funções auxiliares em GLSL
const HELPERS = {
  hash: 'float fxHash(vec2 p) { return fract(sin(dot(p, vec2(12.9898, 78.233))) * 43758.5453); }',
  noise: `float fxNoise(vec2 p) {
  vec2 i = floor(p);
  vec2 f = fract(p);
  f = f * f * (3.0 - 2.0 * f);
  return mix(mix(fxHash(i), fxHash(i + vec2(1.0, 0.0)), f.x), mix(fxHash(i + vec2(0.0, 1.0)), fxHash(i + 1.0), f.x), f.y);
}`,
  luma: 'float fxLuma(vec3 c) { return dot(c, vec3(0.2126, 0.7152, 0.0722)); }',
  hue: `vec3 fxHue(vec3 c, float deg) {
  float a = radians(deg);
  vec3 k = vec3(0.57735);
  return c * cos(a) + cross(k, c) * sin(a) + k * dot(k, c) * (1.0 - cos(a));
}`,
  chroma: `vec2 fxChroma(vec3 c) {
  return vec2(-0.168736 * c.r - 0.331264 * c.g + 0.5 * c.b, 0.5 * c.r - 0.418688 * c.g - 0.081312 * c.b);
}`,
  inside: 'bool fxInside(vec2 p) { return p.x >= 0.0 && p.y >= 0.0 && p.x <= 1.0 && p.y <= 1.0; }',
  linear: `// 0 numa borda, 1 na oposta, na direção do ângulo
float fxLinear(vec2 uv, float deg) {
  vec2 d = vec2(cos(radians(deg)), sin(radians(deg)));
  float ext = 0.5 * (abs(d.x) * ratio + abs(d.y));
  return dot((uv - 0.5) * vec2(ratio, 1.0), d) / ext * 0.5 + 0.5;
}`,
  circle: `// 0 no centro, 1 no canto mais distante
float fxCircle(vec2 uv, vec2 c) {
  vec2 k = vec2(ratio, 1.0);
  float m = max(max(length(c * k), length((c - vec2(1.0, 0.0)) * k)), max(length((c - vec2(0.0, 1.0)) * k), length((c - 1.0) * k)));
  return length((uv - c) * k) / m;
}`,
};
const HELPER_DEPS = { noise: ['hash'] };

// ---------------------------------------------------------------- blocos de efeito
// stage: 'uv' (distorce a posição p), 'sample' (lê a imagem; recebe a leitura anterior), 'color' (altera a cor c)
export const EFFECT_BLOCKS = {
  wave: {
    stage: 'uv', label: 'Onda', desc: 'Ondula a imagem, andando com o tempo.',
    fields: [F('amp', 'Amplitude', 0.015, 0, 0.1, 0.001), F('freq', 'Frequência', 25, 1, 120, 1), F('speed', 'Velocidade', 4, -20, 20, 0.1),
      S('axis', 'Direção', { x: 'Horizontal', y: 'Vertical' }, 'x')],
    code: (v) => (v.axis === 'y'
      ? `p.y += sin(p.x * ${v.freq} + time * ${v.speed}) * ${v.amp};`
      : `p.x += sin(p.y * ${v.freq} + time * ${v.speed}) * ${v.amp};`),
  },
  pixelate: {
    stage: 'uv', label: 'Pixelizar', desc: 'Blocos quadrados do tamanho escolhido.',
    fields: [F('size', 'Tamanho do bloco (px)', 12, 1, 120, 1)],
    code: (v) => `{\n    vec2 cell = max(${v.size}, 1.0) / resolution;\n    p = (floor(p / cell) + 0.5) * cell;\n  }`,
  },
  mirror: {
    stage: 'uv', label: 'Espelhar', desc: 'Repete metade da imagem refletida.',
    fields: [S('axis', 'Espelho', { x: 'Esquerda ↔ direita', y: 'Baixo ↕ cima', xy: 'Quatro cantos' }, 'x')],
    code: (v) => [v.axis !== 'y' ? 'p.x = 0.5 - abs(p.x - 0.5);' : '', v.axis !== 'x' ? 'p.y = 0.5 - abs(p.y - 0.5);' : ''].filter(Boolean).join('\n  '),
  },
  zoom: {
    stage: 'uv', label: 'Zoom', desc: 'Aproxima ou afasta a partir de um ponto.',
    fields: [F('scale', 'Escala', 1.25, 0.1, 5, 0.01), V2('center', 'Centro', [0.5, 0.5], '0 a 1')],
    code: (v) => `p = (p - ${v.center}) / max(${v.scale}, 0.001) + ${v.center};`,
  },
  rotate: {
    stage: 'uv', label: 'Girar', desc: 'Gira a imagem (pode girar sem parar).',
    fields: [F('angle', 'Ângulo (graus)', 0, -180, 180, 1), F('speed', 'Rotação contínua (graus/s)', 30, -360, 360, 1)],
    code: (v) => `{
    float a = radians(${v.angle} + time * ${v.speed});
    vec2 d = (p - 0.5) * vec2(ratio, 1.0);
    d = mat2(cos(a), sin(a), -sin(a), cos(a)) * d;
    p = d / vec2(ratio, 1.0) + 0.5;
  }`,
  },
  swirl: {
    stage: 'uv', label: 'Redemoinho', desc: 'Torce o centro da imagem.',
    fields: [F('strength', 'Força', 3, -12, 12, 0.1), F('radius', 'Raio', 0.5, 0.05, 1.5, 0.01)],
    code: (v) => `{
    vec2 d = (p - 0.5) * vec2(ratio, 1.0);
    float k = max(0.0, 1.0 - length(d) / max(${v.radius}, 0.001));
    float a = ${v.strength} * k * k;
    d = mat2(cos(a), sin(a), -sin(a), cos(a)) * d;
    p = d / vec2(ratio, 1.0) + 0.5;
  }`,
  },
  lens: {
    stage: 'uv', label: 'Lente (olho de peixe)', desc: 'Curva a imagem como uma lente grande-angular.',
    fields: [F('strength', 'Força', 0.4, -1, 2, 0.01)],
    code: (v) => `{
    vec2 d = p - 0.5;
    vec2 dk = d * vec2(ratio, 1.0);
    p = 0.5 + d * (1.0 + ${v.strength} * dot(dk, dk));
  }`,
  },
  shake: {
    stage: 'uv', label: 'Tremor', desc: 'Sacode a imagem aos solavancos.',
    fields: [F('amount', 'Intensidade', 0.01, 0, 0.1, 0.001), F('speed', 'Solavancos por segundo', 12, 1, 60, 1)],
    helpers: ['hash'],
    code: (v) => `p += (vec2(fxHash(vec2(floor(time * ${v.speed}), 1.0)), fxHash(vec2(floor(time * ${v.speed}), 2.0))) - 0.5) * ${v.amount};`,
  },
  blur: {
    stage: 'sample', label: 'Desfoque', desc: 'Desfoque suave (25 leituras por pixel).', taps: 25,
    fields: [F('radius', 'Raio (px)', 4, 0, 40, 0.5)],
    body: (v, prev) => `vec4 acc = vec4(0.0);
  vec2 px = ${v.radius} / resolution * 0.5;
  for (int x = -2; x <= 2; x++)
    for (int y = -2; y <= 2; y++)
      acc += ${prev}(p + vec2(float(x), float(y)) * px);
  return acc / 25.0;`,
  },
  rgbsplit: {
    stage: 'sample', label: 'Separação RGB', desc: 'Desloca os canais vermelho e azul.', taps: 3,
    fields: [F('amount', 'Deslocamento', 0.008, 0, 0.05, 0.0005), F('angle', 'Ângulo (graus)', 0, -180, 180, 1), B('jitter', 'Tremer', false)],
    helpers: ['hash'],
    body: (v, prev) => `float k = ${v.amount};
  if (${v.jitter}) k *= 0.5 + fxHash(vec2(floor(time * 12.0), 3.0));
  vec2 o = vec2(cos(radians(${v.angle})), sin(radians(${v.angle}))) * k;
  vec4 c = ${prev}(p);
  return vec4(${prev}(p + o).r, c.g, ${prev}(p - o).b, c.a);`,
  },
  glow: {
    stage: 'sample', label: 'Brilho (bloom)', desc: 'As partes claras espalham luz em volta (26 leituras por pixel).', taps: 26,
    fields: [F('threshold', 'A partir de', 0.6, 0, 1, 0.01), F('strength', 'Força', 1, 0, 4, 0.05), F('radius', 'Raio (px)', 8, 1, 40, 0.5)],
    body: (v, prev) => `vec4 c = ${prev}(p);
  vec3 acc = vec3(0.0);
  vec2 px = ${v.radius} / resolution * 0.5;
  for (int x = -2; x <= 2; x++)
    for (int y = -2; y <= 2; y++)
      acc += max(${prev}(p + vec2(float(x), float(y)) * px).rgb - ${v.threshold}, 0.0);
  return vec4(c.rgb + acc / 25.0 * ${v.strength} * 2.0, c.a);`,
  },
  adjust: {
    stage: 'color', label: 'Ajuste de cor', desc: 'Brilho, contraste e saturação.',
    fields: [F('brightness', 'Brilho', 0, -1, 1, 0.01), F('contrast', 'Contraste', 0.1, -1, 1, 0.01), F('saturation', 'Saturação', 0.2, -1, 1, 0.01)],
    helpers: ['luma'],
    code: (v) => `c.rgb += ${v.brightness};
  c.rgb = (c.rgb - 0.5) * (1.0 + ${v.contrast}) + 0.5;
  c.rgb = mix(vec3(fxLuma(c.rgb)), c.rgb, 1.0 + ${v.saturation});`,
  },
  hue: {
    stage: 'color', label: 'Matiz', desc: 'Gira as cores no círculo cromático.',
    fields: [F('shift', 'Deslocamento (graus)', 60, -180, 180, 1), F('speed', 'Girar com o tempo (graus/s)', 0, -360, 360, 1)],
    helpers: ['hue'],
    code: (v) => `c.rgb = fxHue(c.rgb, ${v.shift} + time * ${v.speed});`,
  },
  tint: {
    stage: 'color', label: 'Tonalizar', desc: 'Pinta a imagem com uma cor, mantendo luz e sombra.',
    fields: [C3('color', 'Cor', '#ff9a3c'), F('amount', 'Quantidade', 0.6, 0, 1, 0.01)],
    helpers: ['luma'],
    code: (v) => `c.rgb = mix(c.rgb, vec3(fxLuma(c.rgb)) * ${v.color} * 1.6, ${v.amount});`,
  },
  duotone: {
    stage: 'color', label: 'Duas cores', desc: 'Sombras numa cor, luzes em outra.',
    fields: [C3('dark', 'Sombras', '#1b1446'), C3('light', 'Luzes', '#ffcf5c'), F('amount', 'Quantidade', 1, 0, 1, 0.01)],
    helpers: ['luma'],
    code: (v) => `c.rgb = mix(c.rgb, mix(${v.dark}, ${v.light}, fxLuma(c.rgb)), ${v.amount});`,
  },
  invert: {
    stage: 'color', label: 'Inverter', desc: 'Negativo da imagem.',
    fields: [F('amount', 'Quantidade', 1, 0, 1, 0.01)],
    code: (v) => `c.rgb = mix(c.rgb, 1.0 - c.rgb, ${v.amount});`,
  },
  posterize: {
    stage: 'color', label: 'Posterizar', desc: 'Reduz o número de tons.',
    fields: [F('levels', 'Tons por canal', 5, 2, 32, 1)],
    code: (v) => `{\n    float n = max(${v.levels} - 1.0, 1.0);\n    c.rgb = floor(c.rgb * n + 0.5) / n;\n  }`,
  },
  vignette: {
    stage: 'color', label: 'Vinheta', desc: 'Escurece (ou colore) as bordas.',
    fields: [F('strength', 'Força', 0.7, 0, 1, 0.01), F('radius', 'Início', 0.45, 0, 1, 0.01), F('softness', 'Suavidade', 0.55, 0.01, 1, 0.01), C3('color', 'Cor', '#000000')],
    code: (v) => `{
    float d = length((uv - 0.5) * vec2(ratio, 1.0)) / length(vec2(ratio, 1.0) * 0.5);
    c.rgb = mix(c.rgb, ${v.color}, smoothstep(${v.radius}, ${v.radius} + ${v.softness}, d) * ${v.strength});
  }`,
  },
  scanlines: {
    stage: 'color', label: 'Linhas de TV', desc: 'Linhas horizontais, paradas ou rolando.',
    fields: [F('count', 'Linhas', 240, 20, 1000, 1), F('strength', 'Força', 0.35, 0, 1, 0.01), F('speed', 'Rolagem', 0, -50, 50, 0.5)],
    code: (v) => `c.rgb *= 1.0 - ${v.strength} * (0.5 + 0.5 * sin((uv.y * ${v.count} + time * ${v.speed}) * 6.28318));`,
  },
  grain: {
    stage: 'color', label: 'Granulação', desc: 'Ruído de filme.',
    fields: [F('amount', 'Quantidade', 0.12, 0, 1, 0.01), F('size', 'Tamanho do grão (px)', 1, 1, 10, 0.5), B('animated', 'Animado', true)],
    helpers: ['hash'],
    code: (v) => `c.rgb += (fxHash(floor(uv * resolution / max(${v.size}, 1.0)) + (${v.animated} ? floor(time * 24.0) : 0.0)) - 0.5) * ${v.amount};`,
  },
  chroma: {
    stage: 'color', label: 'Chroma key', desc: 'Deixa transparente uma cor (fundo verde/azul).',
    fields: [C3('key', 'Cor', '#00d800'), F('tolerance', 'Tolerância', 0.18, 0, 1, 0.005), F('softness', 'Suavidade', 0.08, 0, 0.5, 0.005)],
    helpers: ['chroma'],
    code: (v) => `c.a *= smoothstep(${v.tolerance}, ${v.tolerance} + ${v.softness} + 0.0001, distance(fxChroma(c.rgb), fxChroma(${v.key})));`,
  },
  opacity: {
    stage: 'color', label: 'Opacidade', desc: 'Deixa a imagem mais transparente.',
    fields: [F('amount', 'Opacidade', 1, 0, 1, 0.01)],
    code: (v) => `c.a *= ${v.amount};`,
  },
};
export const STAGES = { uv: 'Distorção', sample: 'Leitura da imagem', color: 'Cor' };

// ---------------------------------------------------------------- formas (transições e revelações)
const SOFT = F('soft', 'Suavidade da borda', 0.1, 0, 0.5, 0.005);
const INVERT = B('invert', 'Inverter direção', false);
export const SHAPES = {
  fade: { label: 'Dissolver', desc: 'Uma cena some enquanto a outra aparece.', fields: [] },
  linear: {
    label: 'Cortina', desc: 'Uma borda reta varre a tela.',
    fields: [F('angle', 'Ângulo (graus)', 0, -180, 180, 1, '0 = da esquerda para a direita'), SOFT, INVERT],
    helpers: ['linear'], expr: (v) => `fxLinear(uv, ${v.angle})`,
  },
  circle: {
    label: 'Círculo', desc: 'Um círculo cresce a partir de um ponto.',
    fields: [V2('center', 'Centro', [0.5, 0.5], '0 a 1'), SOFT, INVERT],
    helpers: ['circle'], expr: (v) => `fxCircle(uv, ${v.center})`,
  },
  diamond: {
    label: 'Losango', desc: 'Um losango cresce a partir do centro.',
    fields: [SOFT, INVERT],
    expr: () => '(abs(uv.x - 0.5) * ratio + abs(uv.y - 0.5)) / (0.5 * ratio + 0.5)',
  },
  blinds: {
    label: 'Persiana', desc: 'Várias faixas abrem ao mesmo tempo.',
    fields: [F('count', 'Faixas', 8, 1, 40, 1), F('angle', 'Ângulo (graus)', 0, -180, 180, 1), SOFT, INVERT],
    helpers: ['linear'], expr: (v) => `fract(fxLinear(uv, ${v.angle}) * ${v.count})`,
  },
  squares: {
    label: 'Quadrados', desc: 'Quadrados trocam em ordem aleatória.',
    fields: [F('count', 'Colunas', 14, 2, 80, 1), SOFT],
    helpers: ['hash'], expr: (v) => `fxHash(floor(uv * vec2(${v.count}, ${v.count} / ratio)))`,
  },
  noise: {
    label: 'Manchas', desc: 'Manchas orgânicas de ruído.',
    fields: [F('scale', 'Escala', 5, 0.5, 40, 0.5), SOFT, INVERT],
    helpers: ['noise'], expr: (v) => `fxNoise(uv * vec2(ratio, 1.0) * ${v.scale})`,
  },
  clock: {
    label: 'Relógio', desc: 'Um ponteiro varre a tela em volta do centro.',
    fields: [F('start', 'Começa em (graus)', 90, -180, 180, 1), SOFT, INVERT],
    expr: (v) => `fract((atan(uv.y - 0.5, (uv.x - 0.5) * ratio) - radians(${v.start})) / 6.2831853)`,
  },
  slide: {
    label: 'Deslizar', desc: 'As cenas se movem lateralmente.', transitionOnly: true,
    fields: [S('dir', 'Direção', { right: 'Para a direita →', left: 'Para a esquerda ←', up: 'Para cima ↑', down: 'Para baixo ↓' }, 'left'),
      S('mode', 'Modo', { push: 'Empurrar', cover: 'Cobrir', reveal: 'Descobrir' }, 'push')],
  },
};
export const REVEALS = ['none', 'linear', 'circle', 'diamond', 'blinds', 'squares', 'noise', 'clock'];

// ---------------------------------------------------------------- seções fixas
export const SECTIONS = {
  timing: { label: 'Tempo', fields: [S('easing', 'Curva', EASINGS, 'smooth')] },
  motion: {
    label: 'Movimento das cenas', toggle: true, desc: 'Zoom e deslocamento enquanto a transição acontece.',
    fields: [F('fromScale', 'Zoom final da cena anterior', 1.4, 0.1, 4, 0.01), V2('fromShift', 'Deslocamento da cena anterior', [0, 0], 'fração da tela'),
      F('toScale', 'Zoom inicial da cena nova', 0.7, 0.1, 4, 0.01), V2('toShift', 'Deslocamento inicial da cena nova', [0, 0], 'fração da tela'),
      C3('bg', 'Fundo (fora das cenas)', '#000000')],
  },
  edge: {
    label: 'Borda colorida', toggle: true, desc: 'Uma linha na frente da troca.',
    fields: [C3('color', 'Cor', '#ffffff'), F('width', 'Largura', 0.03, 0.001, 0.3, 0.001)],
  },
  flash: {
    label: 'Clarão', toggle: true, desc: 'A tela clareia no meio da transição.',
    fields: [C3('color', 'Cor', '#ffffff'), F('amount', 'Força', 0.8, 0, 1, 0.01)],
  },
  animTiming: {
    label: 'Tempo',
    fields: [S('easing', 'Curva', EASINGS, 'out'), B('mirror', 'Sair pelo lado oposto', true, 'na saída, inverte deslocamento e giro')],
  },
  move: {
    label: 'Movimento', desc: 'Como o elemento está no começo da entrada (e no fim da saída).',
    fields: [B('fade', 'Aparecer aos poucos (opacidade)', true), V2('shift', 'Deslocamento', [0, -0.2], 'fração do tamanho; y para cima; até ±0,25 fica visível'),
      F('scale', 'Escala', 1, 0, 4, 0.01), F('rotate', 'Giro (graus)', 0, -720, 720, 1), F('pixels', 'Pixelização (px)', 0, 0, 120, 1)],
  },
};

// ---------------------------------------------------------------- montagens iniciais
const valuesOf = (fields, over = {}) => Object.fromEntries(fields.map((f) => [f.key, structuredClone(over[f.key] ?? f.default)]));
const section = (id, key, over, extra = {}) => ({ id, values: valuesOf(SECTIONS[key].fields, over), expose: [], ...extra });
const shapeBlock = (id, type, over = {}) => ({ id, type, values: valuesOf(SHAPES[type]?.fields || [], over), expose: [] });

export function effectBlock(type, existing = [], over = {}) {
  let n = 1;
  while (existing.some((b) => b.id === `${type}${n}`)) n++;
  return { id: `${type}${n}`, type, on: true, values: valuesOf(EFFECT_BLOCKS[type].fields, over), expose: [] };
}

/** Troca a forma de uma seção, mantendo valores de campos com o mesmo nome. */
export function withShape(block, type) {
  const keep = block.values || {};
  return { ...block, type, values: valuesOf(SHAPES[type]?.fields || [], keep), expose: (block.expose || []).filter((k) => (SHAPES[type]?.fields || []).some((f) => f.key === k)) };
}

export function newSpec(kind) {
  if (kind === 'transition') {
    return {
      v: 1, kind, shape: shapeBlock('shape', 'linear'), timing: section('timing', 'timing'),
      motion: section('motion', 'motion', {}, { on: false }), edge: section('edge', 'edge', {}, { on: false }), flash: section('flash', 'flash', {}, { on: false }),
    };
  }
  if (kind === 'animation') {
    return { v: 1, kind, timing: section('timing', 'animTiming'), move: section('move', 'move'), reveal: shapeBlock('reveal', 'none') };
  }
  const blocks = [];
  blocks.push(effectBlock('wave', blocks));
  blocks.push(effectBlock('adjust', blocks));
  return { v: 1, kind: 'effect', blocks };
}

/** Exemplos prontos do modo visual. */
export function visualPresets() {
  const eff = (name, desc, list) => {
    const blocks = [];
    for (const [type, over] of list) blocks.push(effectBlock(type, blocks, over));
    return { name, desc, spec: { v: 1, kind: 'effect', blocks } };
  };
  const tr = (name, desc, type, over, extra = {}) => {
    const s = newSpec('transition');
    s.shape = shapeBlock('shape', type, over);
    for (const [k, vals] of Object.entries(extra)) Object.assign(s[k], k === 'timing' ? {} : { on: true }, { values: { ...s[k].values, ...vals } });
    return { name, desc, spec: s };
  };
  const an = (name, desc, move, timing, reveal = ['none', {}]) => {
    const s = newSpec('animation');
    Object.assign(s.move.values, move);
    Object.assign(s.timing.values, timing);
    s.reveal = shapeBlock('reveal', reveal[0], reveal[1]);
    return { name, desc, spec: s };
  };
  return {
    effect: [
      eff('VHS', 'Onda fina, cores separadas, linhas e grão.', [['wave', { amp: 0.003, freq: 90, speed: 8 }], ['rgbsplit', { amount: 0.005, jitter: true }],
        ['adjust', { saturation: -0.3, contrast: 0.15 }], ['scanlines', { count: 300, strength: 0.25, speed: 2 }], ['grain', { amount: 0.1 }]]),
      eff('Sonho', 'Brilho suave, tom rosado e bordas escuras.', [['blur', { radius: 2 }], ['glow', { threshold: 0.5, strength: 1.4 }], ['tint', { color: '#ff7ab8', amount: 0.25 }], ['vignette', {}]]),
      eff('Pôster', 'Poucos tons em duas cores.', [['posterize', { levels: 4 }], ['duotone', { dark: '#20124d', light: '#ffd84a' }]]),
    ],
    transition: [
      tr('Íris com clarão', 'Círculo com borda branca e um clarão no meio.', 'circle', { soft: 0.02 }, { edge: { width: 0.02 }, flash: { amount: 0.5 } }),
      tr('Persiana', 'Dez faixas verticais.', 'blinds', { count: 10, soft: 0.05 }),
      tr('Empurrar com quique', 'A cena nova empurra a anterior e quica no fim.', 'slide', { dir: 'left', mode: 'push' }, { timing: { easing: 'back' } }),
      tr('Zoom cruzado', 'A cena anterior aproxima enquanto a nova chega de longe.', 'fade', {}, { motion: { fromScale: 1.6, toScale: 0.6 } }),
      tr('Manchas de tinta', 'Ruído orgânico com borda colorida.', 'noise', { scale: 4, soft: 0.04 }, { edge: { color: '#ffd24a', width: 0.03 } }),
    ],
    animation: [
      an('Pop com quique', 'Cresce do nada e passa um pouco do tamanho.', { scale: 0, shift: [0, 0] }, { easing: 'back' }),
      an('Surgir de baixo', 'Sobe e aparece; sai por cima.', { shift: [0, -0.25] }, { easing: 'out' }),
      an('Giro elástico', 'Gira e cresce com efeito de mola.', { scale: 0.3, rotate: 180, shift: [0, 0] }, { easing: 'elastic' }),
      an('Pixels em manchas', 'Pixelizado, revelado por manchas.', { pixels: 40, shift: [0, 0], fade: false }, { easing: 'smooth' }, ['noise', { scale: 6, soft: 0.1 }]),
    ],
  };
}

// ---------------------------------------------------------------- gerador
const PARAM_TYPE = { float: 'float', bool: 'bool', color3: 'color3', vec2: 'vec2' };

function num(n) {
  n = Number(n) || 0;
  let s = Number.isInteger(n) ? n.toFixed(1) : String(+n.toFixed(6));
  if (s.includes('e')) s = n.toFixed(6);
  return n < 0 ? `(${s})` : s;
}

function literal(type, v) {
  switch (type) {
    case 'bool': return v ? 'true' : 'false';
    case 'color3': { const [r, g, b] = parseColor(v); return `vec3(${num(r / 255)}, ${num(g / 255)}, ${num(b / 255)})`; }
    case 'vec2': return `vec2(${num(v?.[0])}, ${num(v?.[1])})`;
    default: return num(v);
  }
}

function makeCtx(allUniforms) {
  const helpers = [];
  const params = [];
  const ctx = {
    params,
    use(name) {
      for (const d of HELPER_DEPS[name] || []) ctx.use(d);
      if (!helpers.includes(name)) helpers.push(name);
    },
    helpersCode: () => helpers.map((n) => HELPERS[n]).join('\n\n'),
    /** Valores do bloco como trechos de GLSL: literal ou nome do uniform (campo exposto). */
    values(block, fields, title) {
      const out = {};
      for (const f of fields) {
        const v = block.values?.[f.key] ?? f.default;
        if (f.type === 'select') { out[f.key] = v; continue; }
        if (allUniforms || block.expose?.includes(f.key)) {
          const name = `${block.id}_${f.key}`;
          const p = { name, label: `${title}: ${f.label}`.slice(0, 60), type: PARAM_TYPE[f.type], default: structuredClone(v) };
          if (f.type === 'float') Object.assign(p, { min: f.min, max: f.max, step: f.step });
          params.push(p);
          out[f.key] = name;
        } else {
          out[f.key] = literal(f.type, v);
        }
      }
      return out;
    },
  };
  return ctx;
}

const easeFn = (easing) => `float fxEase(float t) {\n  ${EASE_GLSL[easing] || EASE_GLSL.linear}\n}`;

function genEffect(spec, ctx) {
  const blocks = (spec.blocks || []).filter((b) => b.on !== false && EFFECT_BLOCKS[b.type]);
  const byStage = (st) => blocks.filter((b) => EFFECT_BLOCKS[b.type].stage === st);
  const fns = [];
  let fetch = 'getColor';
  for (const b of byStage('sample')) {
    const def = EFFECT_BLOCKS[b.type];
    (def.helpers || []).forEach(ctx.use);
    const v = ctx.values(b, def.fields, def.label);
    const name = `fx_${b.id}`;
    fns.push(`// ${def.label}\nvec4 ${name}(vec2 p) {\n  ${def.body(v, fetch)}\n}`);
    fetch = name;
  }
  const lines = (st) => byStage(st).map((b) => {
    const def = EFFECT_BLOCKS[b.type];
    (def.helpers || []).forEach(ctx.use);
    return `  // ${def.label}\n  ${def.code(ctx.values(b, def.fields, def.label))}`;
  });
  const uv = lines('uv');
  const color = lines('color');
  const main = `vec4 effect(vec2 uv) {
  vec2 p = uv;
${uv.join('\n')}${uv.length ? '\n' : ''}  vec4 c = ${fetch}(p);
${color.join('\n')}${color.length ? '\n' : ''}  return c;
}`;
  return [fns.join('\n\n'), main];
}

/** Função fxField(uv) (0 a 1: quando a troca chega naquele ponto) para uma forma, ou '' se não se aplica. */
function fieldFn(block, ctx, title) {
  const shape = SHAPES[block.type];
  if (!shape?.expr) return { code: '', v: null };
  (shape.helpers || []).forEach(ctx.use);
  const v = ctx.values(block, shape.fields, title);
  const inv = v.invert ?? 'false';
  return { code: `float fxField(vec2 uv) {\n  float f = ${shape.expr(v)};\n  return ${inv} ? 1.0 - f : f;\n}`, v };
}

const DIRS = { right: 'vec2(1.0, 0.0)', left: 'vec2(-1.0, 0.0)', up: 'vec2(0.0, 1.0)', down: 'vec2(0.0, -1.0)' };

function genTransition(spec, ctx) {
  const t = ctx.values(spec.timing, SECTIONS.timing.fields, 'Tempo');
  const shapeType = SHAPES[spec.shape?.type] && !SHAPES[spec.shape.type].revealOnly ? spec.shape.type : 'fade';
  const block = { ...spec.shape, type: shapeType };
  const field = fieldFn(block, ctx, `Forma (${SHAPES[shapeType].label})`);
  const parts = [easeFn(t.easing)];
  if (field.code) parts.push(field.code);
  const body = ['  float e = fxEase(progress);', '  float k = clamp(e, 0.0, 1.0);'];

  if (shapeType === 'slide') {
    ctx.use('inside');
    const v = ctx.values(block, SHAPES.slide.fields, 'Forma');
    const moveFrom = v.mode !== 'cover';
    const moveTo = v.mode !== 'reveal';
    body.push(`  vec2 d = ${DIRS[v.dir] || DIRS.left};`,
      `  vec2 qa = ${moveFrom ? 'uv - d * e' : 'uv'};`,
      `  vec2 qb = ${moveTo ? 'uv + d * (1.0 - e)' : 'uv'};`,
      '  vec4 a = getFromColor(qa);',
      '  vec4 b = getToColor(qb);',
      `  float m = ${v.mode === 'reveal' ? 'fxInside(qa) ? 0.0 : 1.0' : 'fxInside(qb) ? 1.0 : 0.0'};`);
  } else {
    if (spec.motion?.on) {
      ctx.use('inside');
      const m = ctx.values(spec.motion, SECTIONS.motion.fields, 'Movimento');
      body.push(`  vec2 qa = (uv - 0.5) / max(mix(1.0, ${m.fromScale}, e), 0.001) + 0.5 - ${m.fromShift} * e;`,
        `  vec2 qb = (uv - 0.5) / max(mix(${m.toScale}, 1.0, e), 0.001) + 0.5 - ${m.toShift} * (1.0 - e);`,
        `  vec4 a = fxInside(qa) ? getFromColor(qa) : vec4(${m.bg}, 1.0);`,
        `  vec4 b = fxInside(qb) ? getToColor(qb) : vec4(${m.bg}, 1.0);`);
    } else {
      body.push('  vec4 a = getFromColor(uv);', '  vec4 b = getToColor(uv);');
    }
    if (field.code) {
      body.push(`  float s = max(${field.v.soft}, 0.0001);`, '  float f = fxField(uv);', '  float q = k * (1.0 + s);', '  float m = smoothstep(f, f + s, q);');
    } else {
      body.push('  float m = k;');
    }
  }
  body.push('  vec4 c = mix(a, b, m);');
  if (spec.edge?.on && field.code) {
    const ed = ctx.values(spec.edge, SECTIONS.edge.fields, 'Borda');
    body.push(`  float band = (1.0 - smoothstep(0.0, max(${ed.width}, 0.0001), abs(q - f - s * 0.5))) * step(0.0001, k) * step(k, 0.9999);`,
      `  c.rgb = mix(c.rgb, ${ed.color}, band);`);
  }
  if (spec.flash?.on) {
    const fl = ctx.values(spec.flash, SECTIONS.flash.fields, 'Clarão');
    body.push(`  c.rgb = mix(c.rgb, ${fl.color}, ${fl.amount} * pow(max(0.0, 1.0 - abs(k * 2.0 - 1.0)), 3.0));`);
  }
  body.push('  return c;');
  parts.push(`vec4 transition(vec2 uv) {\n${body.join('\n')}\n}`);
  return parts;
}

function genAnimation(spec, ctx) {
  const t = ctx.values(spec.timing, SECTIONS.animTiming.fields, 'Tempo');
  const mv = ctx.values(spec.move, SECTIONS.move.fields, 'Movimento');
  const revealType = REVEALS.includes(spec.reveal?.type) ? spec.reveal.type : 'none';
  const field = revealType === 'none' ? { code: '' } : fieldFn(spec.reveal, ctx, `Revelar (${SHAPES[revealType].label})`);
  const parts = [easeFn(t.easing)];
  if (field.code) parts.push(field.code);
  const body = `  float e = fxEase(progress);
  float k = 1.0 - e;
  vec2 sh = ${mv.shift};
  float rot = ${mv.rotate};
  if (${t.mirror} && !entering) { sh = -sh; rot = -rot; }
  vec2 p = uv - sh * k;
  float s = mix(${mv.scale}, 1.0, e);
  if (abs(s) < 0.001) return vec4(0.0);
  vec2 d = (p - 0.5) * vec2(ratio, 1.0);
  float a = radians(rot) * k;
  d = mat2(cos(a), sin(a), -sin(a), cos(a)) * d / s;
  p = d / vec2(ratio, 1.0) + 0.5;
  float b = max(1.0, ${mv.pixels} * k);
  if (b > 1.0) {
    vec2 cell = b / resolution;
    p = (floor(p / cell) + 0.5) * cell;
  }
  vec4 c = getColor(p);
  float alpha = ${mv.fade} ? clamp(e, 0.0, 1.0) : 1.0;
${field.code ? `  float sf = max(${field.v.soft}, 0.0001);
  float f = fxField(uv);
  alpha *= smoothstep(f, f + sf, clamp(e, 0.0, 1.0) * (1.0 + sf));
` : ''}  return vec4(c.rgb, c.a * alpha);`;
  parts.push(`vec4 animate(vec2 uv) {\n${body}\n}`);
  return parts;
}

/**
 * Gera o código e os parâmetros de uma montagem.
 * @param allUniforms true = todo campo vira uniform (pré-visualização instantânea, sem recompilar a cada ajuste);
 *                    false = só os campos marcados como parâmetro do app; o resto vira número fixo no código.
 * @returns { glsl, params }
 */
export function generate(spec, { allUniforms = false } = {}) {
  const ctx = makeCtx(allUniforms);
  const parts = spec.kind === 'transition' ? genTransition(spec, ctx) : spec.kind === 'animation' ? genAnimation(spec, ctx) : genEffect(spec, ctx);
  const tag = `${VISUAL_TAG}${JSON.stringify(spec)}`;
  const head = '// Gerado pelo modo visual do FX Lab. A linha acima guarda a montagem para reabrir no FX Lab.';
  const code = [`${tag}\n${head}`, ctx.helpersCode(), ...parts].filter((s) => s.trim()).join('\n\n');
  return { glsl: `${code}\n`, params: ctx.params };
}

/**
 * Leituras da imagem por pixel numa montagem de efeito. Camadas de leitura se multiplicam
 * (um brilho sobre um desfoque lê 26 × 25 vezes), então poucas já pesam.
 */
export function samplesPerPixel(spec) {
  if (spec?.kind !== 'effect') return 1;
  return (spec.blocks || []).filter((b) => b.on !== false && EFFECT_BLOCKS[b.type]?.stage === 'sample')
    .reduce((n, b) => n * (EFFECT_BLOCKS[b.type].taps || 1), 1);
}

/** Lê a montagem guardada na primeira linha do código (ou null). */
export function readVisualTag(glsl) {
  const first = String(glsl || '').split('\n', 1)[0];
  if (!first.startsWith(VISUAL_TAG)) return null;
  try {
    const spec = JSON.parse(first.slice(VISUAL_TAG.length));
    return spec && ['effect', 'transition', 'animation'].includes(spec.kind) ? spec : null;
  } catch {
    return null;
  }
}

/** Código sem a linha da montagem (ao passar para o modo código). */
export const stripVisualTag = (glsl) => String(glsl || '').split('\n').filter((l, i) => !(i < 2 && (l.startsWith(VISUAL_TAG) || l.startsWith('// Gerado pelo modo visual')))).join('\n').replace(/^\n+/, '');
