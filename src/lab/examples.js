// Modelos e exemplos do FX Lab. Os nativos do app (em shader) também entram como exemplo, com outro id,
// porque os ids nativos são reservados.
import { BUILTIN } from '../fx/builtin.js';

export const TEMPLATES = {
  effect: {
    name: 'Meu efeito',
    params: [{ name: 'forca', label: 'Força', type: 'float', default: 0.5, min: 0, max: 1, step: 0.01 }],
    glsl: `// Efeito: recebe a posição uv (de 0 a 1; 0,0 é o canto inferior esquerdo)
// e devolve a cor daquele ponto. getColor(uv) lê a imagem original.

vec4 effect(vec2 uv) {
  // desloca cada linha para os lados, formando uma onda que anda com o tempo
  float onda = sin(uv.y * 30.0 + time * 4.0) * forca * 0.03;
  return getColor(uv + vec2(onda, 0.0));
}
`,
  },
  transition: {
    name: 'Minha transição',
    params: [{ name: 'suavidade', label: 'Suavidade', type: 'float', default: 0.1, min: 0.001, max: 0.5, step: 0.005 }],
    glsl: `// Transição: progress vai de 0 (só a cena anterior) a 1 (só a cena nova).
// getFromColor(uv) lê a cena anterior e getToColor(uv) a nova.

vec4 transition(vec2 uv) {
  // uma borda suave que varre a tela da esquerda para a direita
  float p = mix(-suavidade, 1.0 + suavidade, progress);
  float borda = smoothstep(p - suavidade, p + suavidade, uv.x);
  return mix(getToColor(uv), getFromColor(uv), borda);
}
`,
  },
  animation: {
    name: 'Minha entrada',
    params: [{ name: 'giro', label: 'Giro (graus)', type: 'float', default: 90, min: -360, max: 360, step: 1 }],
    glsl: `// Entrada/saída: progress é quanto do elemento está visível
// (0 → 1 na entrada, 1 → 0 na saída). getColor(uv) é transparente fora da caixa.

vec4 animate(vec2 uv) {
  // gira e cresce a partir do centro enquanto aparece
  float e = 1.0 - pow(1.0 - progress, 3.0);
  float a = radians(giro) * (1.0 - e);
  vec2 p = (uv - 0.5) * vec2(ratio, 1.0);
  p = mat2(cos(a), sin(a), -sin(a), cos(a)) * p / max(e, 0.001);
  vec4 c = getColor(p / vec2(ratio, 1.0) + 0.5);
  return vec4(c.rgb, c.a * e);
}
`,
  },
};

const EXTRA = [
  {
    id: 'rgb-split', name: 'Separação RGB', kind: 'effect',
    description: 'Desloca os canais vermelho e azul, com um tremor opcional.',
    params: [
      { name: 'amount', label: 'Deslocamento', type: 'float', default: 0.01, min: 0, max: 0.05, step: 0.001 },
      { name: 'jitter', label: 'Tremor', type: 'bool', default: true },
    ],
    glsl: `float hash(float n) { return fract(sin(n) * 43758.5453); }

vec4 effect(vec2 uv) {
  float k = amount;
  if (jitter) k *= 0.5 + hash(floor(time * 12.0));
  vec4 c = getColor(uv);
  float r = getColor(uv + vec2(k, 0.0)).r;
  float b = getColor(uv - vec2(k, 0.0)).b;
  return vec4(r, c.g, b, c.a);
}
`,
  },
  {
    id: 'crt', name: 'Tela de tubo (CRT)', kind: 'effect',
    description: 'Linhas de varredura, curvatura e brilho piscando.',
    params: [
      { name: 'lines', label: 'Linhas', type: 'float', default: 240, min: 40, max: 800, step: 1 },
      { name: 'curve', label: 'Curvatura', type: 'float', default: 0.12, min: 0, max: 0.5, step: 0.01 },
      { name: 'tint', label: 'Tom', type: 'color3', default: '#c8ffd8' },
    ],
    glsl: `vec4 effect(vec2 uv) {
  vec2 p = uv * 2.0 - 1.0;
  p *= 1.0 + curve * dot(p.yx, p.yx) * 0.5;
  vec2 q = p * 0.5 + 0.5;
  if (q.x < 0.0 || q.y < 0.0 || q.x > 1.0 || q.y > 1.0) return vec4(0.0, 0.0, 0.0, 1.0);
  vec4 c = getColor(q);
  float scan = 0.75 + 0.25 * sin(q.y * lines * 3.14159);
  float flicker = 0.97 + 0.03 * sin(time * 50.0);
  return vec4(c.rgb * tint * scan * flicker, c.a);
}
`,
  },
  {
    id: 'circle-open', name: 'Círculo abrindo', kind: 'transition',
    description: 'A cena nova aparece num círculo que cresce a partir de um ponto.',
    params: [
      { name: 'center', label: 'Centro', type: 'vec2', default: [0.5, 0.5] },
      { name: 'smoothness', label: 'Suavidade', type: 'float', default: 0.05, min: 0, max: 0.5, step: 0.005 },
    ],
    glsl: `vec4 transition(vec2 uv) {
  vec2 d = (uv - center) * vec2(ratio, 1.0);
  float r = progress * (length(vec2(ratio, 1.0)) + smoothness);
  float m = smoothstep(r - smoothness, r, length(d));
  return mix(getToColor(uv), getFromColor(uv), m);
}
`,
  },
  {
    id: 'zoom-blur', name: 'Zoom com desfoque', kind: 'transition',
    description: 'Aproxima a cena anterior com desfoque radial e entra a nova se afastando.',
    params: [{ name: 'strength', label: 'Força', type: 'float', default: 0.3, min: 0, max: 1, step: 0.01 }],
    glsl: `vec4 sampleZoom(vec2 uv, float s, bool from) {
  vec4 acc = vec4(0.0);
  for (int i = 0; i < 12; i++) {
    float k = 1.0 - s * float(i) / 12.0;
    vec2 p = (uv - 0.5) * k + 0.5;
    acc += from ? getFromColor(p) : getToColor(p);
  }
  return acc / 12.0;
}

vec4 transition(vec2 uv) {
  float t = smoothstep(0.0, 1.0, progress);
  float s = strength * sin(t * 3.14159);
  vec4 a = sampleZoom(uv, s, true);
  vec4 b = sampleZoom(uv, s, false);
  return mix(a, b, t);
}
`,
  },
  {
    id: 'push', name: 'Empurrar', kind: 'transition',
    description: 'A cena nova empurra a anterior para fora.',
    params: [{ name: 'direction', label: 'Direção', type: 'vec2', default: [1, 0] }],
    glsl: `vec4 transition(vec2 uv) {
  float t = progress * progress * (3.0 - 2.0 * progress);
  vec2 d = normalize(direction + 1e-5);
  vec2 pFrom = uv + d * t;
  vec2 pTo = uv + d * (t - 1.0);
  bool inFrom = all(greaterThanEqual(pFrom, vec2(0.0))) && all(lessThanEqual(pFrom, vec2(1.0)));
  return inFrom ? getFromColor(pFrom) : getToColor(pTo);
}
`,
  },
  {
    id: 'glitch', name: 'Falha digital', kind: 'transition',
    description: 'Blocos deslocados e cores separadas no meio da troca.',
    params: [{ name: 'blocks', label: 'Blocos', type: 'float', default: 18, min: 2, max: 60, step: 1 }],
    glsl: `float rnd(vec2 p) { return fract(sin(dot(p, vec2(12.9898, 78.233))) * 43758.5453); }

vec4 transition(vec2 uv) {
  float k = sin(progress * 3.14159);
  float row = floor(uv.y * blocks);
  float shift = (rnd(vec2(row, floor(progress * 20.0))) - 0.5) * 0.3 * k;
  vec2 p = vec2(uv.x + shift, uv.y);
  float m = step(rnd(vec2(row, 7.0)), progress);
  vec4 a = getFromColor(p);
  vec4 b = getToColor(p);
  vec4 c = mix(a, b, m);
  vec2 q = p + vec2(0.02 * k, 0.0);
  c.b = mix(getFromColor(q), getToColor(q), m).b;
  return c;
}
`,
  },
  {
    id: 'anim.iris', name: 'Íris', kind: 'animation',
    description: 'O elemento aparece num círculo que se abre do centro.',
    params: [{ name: 'soft', label: 'Suavidade', type: 'float', default: 0.04, min: 0, max: 0.3, step: 0.005 }],
    glsl: `vec4 animate(vec2 uv) {
  float r = length((uv - 0.5) * vec2(ratio, 1.0));
  float maxR = length(vec2(ratio, 1.0)) * 0.5 + soft;
  float a = 1.0 - smoothstep(progress * maxR - soft, progress * maxR, r);
  vec4 c = getColor(uv);
  return vec4(c.rgb, c.a * a);
}
`,
  },
  {
    id: 'anim.slide-bounce', name: 'Deslizar com quique', kind: 'animation',
    description: 'Entra pela esquerda com quique; na saída vai embora pela direita.',
    params: [{ name: 'bounce', label: 'Quique', type: 'float', default: 1.4, min: 0, max: 4, step: 0.1 }],
    glsl: `vec4 animate(vec2 uv) {
  float t = progress - 1.0;
  float e = t * t * ((bounce + 1.0) * t + bounce) + 1.0;
  float dir = entering ? -1.0 : 1.0;
  vec4 c = getColor(uv - vec2(dir * (1.0 - e) * 1.4, 0.0));
  return vec4(c.rgb, c.a * clamp(progress * 4.0, 0.0, 1.0));
}
`,
  },
];

const KIND_ORDER = { effect: 0, transition: 1, animation: 2 };

/** Exemplos agrupados por tipo: { effect: [...], transition: [...], animation: [...] } */
export function examples() {
  const fromBuiltin = BUILTIN.filter((b) => b.glsl && !b.canvas).map((b) => ({ ...b, builtin: undefined, fromApp: true }));
  const all = [...fromBuiltin, ...EXTRA].sort((a, b) => KIND_ORDER[a.kind] - KIND_ORDER[b.kind]);
  const out = { effect: [], transition: [], animation: [] };
  for (const e of all) out[e.kind]?.push(e);
  return out;
}

/** Referência das variáveis e funções disponíveis em cada tipo. */
export const REFERENCE = {
  effect: {
    entry: 'vec4 effect(vec2 uv)',
    items: [
      ['uv', 'posição do pixel, de 0 a 1 (0,0 é o canto inferior esquerdo)'],
      ['getColor(uv)', 'cor da imagem original naquele ponto (sem alfa pré-multiplicado)'],
      ['time', 'segundos desde o início do clipe'],
      ['progress', '0 a 1 ao longo do clipe'],
      ['resolution', 'tamanho em pixels (vec2)'],
      ['ratio', 'largura ÷ altura'],
    ],
  },
  transition: {
    entry: 'vec4 transition(vec2 uv)',
    items: [
      ['uv', 'posição do pixel, de 0 a 1'],
      ['getFromColor(uv)', 'cor da cena anterior'],
      ['getToColor(uv)', 'cor da cena nova'],
      ['progress', '0 (só a anterior) → 1 (só a nova)'],
      ['time', 'segundos desde o início da transição'],
      ['resolution', 'tamanho em pixels (vec2)'],
      ['ratio', 'largura ÷ altura'],
    ],
  },
  animation: {
    entry: 'vec4 animate(vec2 uv)',
    items: [
      ['uv', '0 a 1 dentro da caixa do elemento; há uma margem de 25% em volta para sair dela'],
      ['getColor(uv)', 'cor do elemento (transparente fora da caixa)'],
      ['progress', 'quanto está visível: 0 → 1 na entrada, 1 → 0 na saída'],
      ['entering', 'true na entrada, false na saída'],
      ['time', 'segundos desde o início do elemento'],
      ['resolution', 'tamanho do elemento em pixels; ratio = largura ÷ altura'],
    ],
  },
};
