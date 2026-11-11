// Efeitos nativos. Os de shader usam exatamente o mesmo formato das extensões (servem de exemplo no editor);
// os de "canvas" (sombra, brilho externo, desfoque) usam o filtro nativo do canvas, porque desenham fora da caixa.
import { parseColor } from '../motion/interp.js';

const rgba = (hex, opacity = 1) => {
  const [r, g, b, a] = parseColor(hex);
  return `rgba(${r},${g},${b},${+((a / 255) * opacity).toFixed(4)})`;
};
const px = (v) => `${Math.max(0, +v.toFixed(2))}px`;

export const BUILTIN = [
  {
    id: 'color', name: 'Ajuste de cor', kind: 'effect', builtin: true,
    description: 'Brilho, contraste, saturação e matiz.',
    params: [
      { name: 'brightness', label: 'Brilho', type: 'float', default: 0, min: -1, max: 1, step: 0.01 },
      { name: 'contrast', label: 'Contraste', type: 'float', default: 0, min: -1, max: 1, step: 0.01 },
      { name: 'saturation', label: 'Saturação', type: 'float', default: 0, min: -1, max: 1, step: 0.01 },
      { name: 'hue', label: 'Matiz', type: 'float', default: 0, min: -180, max: 180, step: 1 },
    ],
    glsl: `vec4 effect(vec2 uv) {
  vec4 c = getColor(uv);
  vec3 rgb = c.rgb;
  // gira o matiz em torno do eixo de cinza
  float a = radians(hue);
  vec3 k = vec3(0.57735);
  rgb = rgb * cos(a) + cross(k, rgb) * sin(a) + k * dot(k, rgb) * (1.0 - cos(a));
  rgb += brightness;
  rgb = (rgb - 0.5) * (1.0 + contrast) + 0.5;
  float l = dot(rgb, vec3(0.2126, 0.7152, 0.0722));
  rgb = mix(vec3(l), rgb, 1.0 + saturation);
  return vec4(rgb, c.a);
}`,
  },
  {
    id: 'chroma', name: 'Chroma key', kind: 'effect', builtin: true,
    description: 'Torna transparente a cor escolhida (fundo verde ou azul).',
    params: [
      { name: 'key', label: 'Cor', type: 'color3', default: '#00d800' },
      { name: 'tolerance', label: 'Tolerância', type: 'float', default: 0.18, min: 0, max: 1, step: 0.005 },
      { name: 'softness', label: 'Suavidade', type: 'float', default: 0.08, min: 0, max: 0.5, step: 0.005 },
      { name: 'spill', label: 'Tirar reflexo', type: 'float', default: 0.5, min: 0, max: 1, step: 0.01 },
    ],
    glsl: `// distância medida só na cor (croma), ignorando o quanto o pixel é claro ou escuro
vec2 chroma(vec3 c) {
  return vec2(-0.168736 * c.r - 0.331264 * c.g + 0.5 * c.b, 0.5 * c.r - 0.418688 * c.g - 0.081312 * c.b);
}
vec4 effect(vec2 uv) {
  vec4 c = getColor(uv);
  float d = distance(chroma(c.rgb), chroma(key));
  float alpha = smoothstep(tolerance, tolerance + softness + 0.0001, d);
  // perto da cor-chave, tira a cor que sobra nas bordas (reflexo do fundo)
  float near = 1.0 - smoothstep(tolerance, tolerance + softness + 0.25, d);
  float l = dot(c.rgb, vec3(0.2126, 0.7152, 0.0722));
  vec3 rgb = mix(c.rgb, vec3(l), near * spill);
  return vec4(rgb, c.a * alpha);
}`,
  },
  {
    id: 'mono', name: 'Preto e branco / tonalizar', kind: 'effect', builtin: true,
    description: 'Tira a cor e, se quiser, tinge com uma cor (sépia, azulado…).',
    params: [
      { name: 'amount', label: 'Intensidade', type: 'float', default: 1, min: 0, max: 1, step: 0.01 },
      { name: 'tint', label: 'Tom', type: 'color3', default: '#ffffff' },
    ],
    glsl: `vec4 effect(vec2 uv) {
  vec4 c = getColor(uv);
  float l = dot(c.rgb, vec3(0.2126, 0.7152, 0.0722));
  return vec4(mix(c.rgb, l * tint, amount), c.a);
}`,
  },
  {
    id: 'vignette', name: 'Vinheta', kind: 'effect', builtin: true,
    description: 'Escurece as bordas.',
    params: [
      { name: 'amount', label: 'Intensidade', type: 'float', default: 0.6, min: 0, max: 1, step: 0.01 },
      { name: 'size', label: 'Tamanho', type: 'float', default: 0.5, min: 0, max: 1, step: 0.01 },
      { name: 'softness', label: 'Suavidade', type: 'float', default: 0.5, min: 0.01, max: 1, step: 0.01 },
    ],
    glsl: `vec4 effect(vec2 uv) {
  vec4 c = getColor(uv);
  float d = distance(uv, vec2(0.5)) * 1.41421;
  float v = smoothstep(size, size + softness, d);
  return vec4(c.rgb * (1.0 - v * amount), c.a);
}`,
  },
  {
    id: 'pixelate', name: 'Pixelizar', kind: 'effect', builtin: true,
    description: 'Blocos grandes (mosaico).',
    params: [{ name: 'size', label: 'Tamanho', type: 'float', default: 16, min: 1, max: 200, step: 1 }],
    glsl: `vec4 effect(vec2 uv) {
  vec2 cells = resolution / max(size, 1.0);
  return getColor((floor(uv * cells) + 0.5) / cells);
}`,
  },

  // ---- filtros de canvas: aplicados depois dos shaders e das máscaras
  {
    id: 'shadow', name: 'Sombra', kind: 'effect', builtin: true, canvas: true,
    description: 'Sombra projetada atrás do elemento.',
    params: [
      { name: 'color', label: 'Cor', type: 'color', default: '#000000b3' },
      { name: 'distance', label: 'Distância', type: 'float', default: 16, min: 0, max: 300, step: 1 },
      { name: 'angle', label: 'Ângulo', type: 'float', default: 45, min: -180, max: 180, step: 1 },
      { name: 'blur', label: 'Desfoque', type: 'float', default: 12, min: 0, max: 200, step: 1 },
    ],
    filter(v, scale) {
      const a = (v.angle * Math.PI) / 180;
      const dx = Math.cos(a) * v.distance * scale;
      const dy = Math.sin(a) * v.distance * scale;
      return `drop-shadow(${dx.toFixed(2)}px ${dy.toFixed(2)}px ${px(v.blur * scale)} ${rgba(v.color)})`;
    },
  },
  {
    id: 'glow', name: 'Brilho externo', kind: 'effect', builtin: true, canvas: true,
    description: 'Halo luminoso em volta do elemento.',
    params: [
      { name: 'color', label: 'Cor', type: 'color', default: '#ffffffff' },
      { name: 'radius', label: 'Raio', type: 'float', default: 20, min: 0, max: 200, step: 1 },
      { name: 'strength', label: 'Força', type: 'float', default: 2, min: 1, max: 4, step: 1 },
    ],
    filter(v, scale) {
      // empilhar o mesmo halo reforça o brilho
      const one = `drop-shadow(0 0 ${px(v.radius * scale)} ${rgba(v.color)})`;
      return Array.from({ length: Math.max(1, Math.min(4, Math.round(v.strength))) }, () => one).join(' ');
    },
  },
  {
    id: 'blur', name: 'Desfoque', kind: 'effect', builtin: true, canvas: true,
    description: 'Desfoca o elemento inteiro.',
    params: [{ name: 'radius', label: 'Raio', type: 'float', default: 8, min: 0, max: 200, step: 0.5 }],
    filter: (v, scale) => (v.radius > 0 ? `blur(${px(v.radius * scale)})` : ''),
  },
  // ---------------------------------------------------------------- entrada/saída
  // progress = quanto do elemento está visível (0 → 1 na entrada; 1 → 0 na saída).
  {
    id: 'anim.reveal', name: 'Revelar', kind: 'animation', builtin: true,
    description: 'Uma borda suave revela o elemento.',
    params: [
      { name: 'direction', label: 'Direção (0 →, 1 ←, 2 ↑, 3 ↓)', type: 'int', default: 0, min: 0, max: 3, step: 1 },
      { name: 'softness', label: 'Suavidade', type: 'float', default: 0.08, min: 0.001, max: 0.5, step: 0.01 },
    ],
    glsl: `vec4 animate(vec2 uv) {
  float x = direction == 0 ? uv.x : direction == 1 ? 1.0 - uv.x : direction == 2 ? uv.y : 1.0 - uv.y;
  float edge = progress * (1.0 + softness);
  float a = 1.0 - smoothstep(edge - softness, edge, x);
  vec4 c = getColor(uv);
  return vec4(c.rgb, c.a * a);
}`,
  },
  {
    id: 'anim.dissolve', name: 'Dissolver', kind: 'animation', builtin: true,
    description: 'O elemento aparece em grãos.',
    params: [{ name: 'grain', label: 'Tamanho do grão (px)', type: 'float', default: 3, min: 1, max: 40, step: 1 }],
    glsl: `float noise(vec2 p) { return fract(sin(dot(p, vec2(12.9898, 78.233))) * 43758.5453); }
vec4 animate(vec2 uv) {
  float n = noise(floor(uv * resolution / grain));
  float a = smoothstep(n - 0.1, n, progress * 1.1);
  vec4 c = getColor(uv);
  return vec4(c.rgb, c.a * a);
}`,
  },
  {
    id: 'anim.zoom', name: 'Zoom', kind: 'animation', builtin: true,
    description: 'Cresce a partir do centro, com um leve repique.',
    params: [
      { name: 'startScale', label: 'Escala inicial', type: 'float', default: 0, min: 0, max: 3, step: 0.05 },
      { name: 'overshoot', label: 'Repique', type: 'float', default: 1.7, min: 0, max: 4, step: 0.1 },
    ],
    glsl: `vec4 animate(vec2 uv) {
  float t = progress - 1.0;
  float e = t * t * ((overshoot + 1.0) * t + overshoot) + 1.0;
  float s = mix(startScale, 1.0, e);
  if (abs(s) < 0.001) return vec4(0.0);
  vec4 c = getColor((uv - 0.5) / s + 0.5);
  return vec4(c.rgb, c.a * clamp(progress * 3.0, 0.0, 1.0));
}`,
  },
  {
    id: 'anim.pixels', name: 'Pixels', kind: 'animation', builtin: true,
    description: 'Começa em blocos grandes que vão ficando nítidos.',
    params: [{ name: 'size', label: 'Bloco máximo (px)', type: 'float', default: 40, min: 2, max: 200, step: 1 }],
    glsl: `vec4 animate(vec2 uv) {
  float b = max(1.0, size * (1.0 - progress));
  vec2 cell = b / resolution;
  vec4 c = getColor(b > 1.0 ? (floor(uv / cell) + 0.5) * cell : uv);
  return vec4(c.rgb, c.a * smoothstep(0.0, 0.3, progress));
}`,
  },
  {
    id: 'anim.rise', name: 'Subir e aparecer', kind: 'animation', builtin: true,
    description: 'Sobe um pouco enquanto aparece (na saída, desce e some).',
    params: [{ name: 'distance', label: 'Distância (fração da altura)', type: 'float', default: 0.2, min: 0, max: 0.25, step: 0.01 }],
    glsl: `vec4 animate(vec2 uv) {
  float e = 1.0 - pow(1.0 - progress, 3.0);
  vec4 c = getColor(uv + vec2(0.0, (1.0 - e) * distance));
  return vec4(c.rgb, c.a * e);
}`,
  },
];
