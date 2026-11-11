// Animações prontas: só gravam keyframes na camada, que continuam editáveis depois.
import { valueAt, setKeyframe } from '../state/keyframes.js';

export const PRESETS = {
  fadeIn: { label: 'Entrada: aparecer', side: 'in' },
  popIn: { label: 'Entrada: pop', side: 'in' },
  growIn: { label: 'Entrada: crescer', side: 'in' },
  slideInLeft: { label: 'Entrada: vir da esquerda', side: 'in' },
  slideInRight: { label: 'Entrada: vir da direita', side: 'in' },
  slideInTop: { label: 'Entrada: vir de cima', side: 'in' },
  slideInBottom: { label: 'Entrada: vir de baixo', side: 'in' },
  spinIn: { label: 'Entrada: girar', side: 'in' },
  drawOn: { label: 'Entrada: desenhar traço', side: 'in', shapeOnly: true },
  fadeOut: { label: 'Saída: sumir', side: 'out' },
  popOut: { label: 'Saída: encolher', side: 'out' },
  slideOutLeft: { label: 'Saída: sair pela esquerda', side: 'out' },
  slideOutRight: { label: 'Saída: sair pela direita', side: 'out' },
  slideOutTop: { label: 'Saída: sair por cima', side: 'out' },
  slideOutBottom: { label: 'Saída: sair por baixo', side: 'out' },
  drawOff: { label: 'Saída: apagar traço', side: 'out', shapeOnly: true },
};

const SLIDE = { Left: ['x', -1], Right: ['x', 1], Top: ['y', -1], Bottom: ['y', 1] };

/** Presets que fazem sentido para a camada. */
export const presetsFor = (layer) => Object.entries(PRESETS).filter(([, p]) => !p.shapeOnly || layer.type === 'shape');

/**
 * Aplica o preset: entradas começam no início da camada, saídas terminam no fim dela.
 * O valor "de repouso" é o que a propriedade tem hoje naquele instante.
 */
export function applyPreset(comp, layer, id, duration = 0.5) {
  const preset = PRESETS[id];
  if (!preset || (preset.shapeOnly && layer.type !== 'shape')) return false;
  const span = Math.max(1 / 60, Math.min(duration, layer.out - layer.in));
  const entering = preset.side === 'in';
  const t0 = entering ? layer.in : layer.out - span;
  const t1 = t0 + span;
  const restT = entering ? t1 : t0;
  /** Anima prop entre o valor de repouso e `away` (valor fora de cena). */
  const anim = (prop, away, ease) => {
    const rest = valueAt(layer, prop, restT);
    const off = typeof away === 'function' ? away(rest) : away;
    setKeyframe(layer, prop, t0, entering ? off : rest, ease);
    setKeyframe(layer, prop, t1, entering ? rest : off);
  };
  const easeMove = entering ? 'easeOut' : 'easeIn';

  if (id === 'fadeIn' || id === 'fadeOut') {
    anim('opacity', 0, 'linear');
  } else if (id === 'popIn') {
    anim('sx', 0, 'back');
    anim('sy', 0, 'back');
  } else if (id === 'growIn' || id === 'popOut') {
    anim('sx', 0, easeMove);
    anim('sy', 0, easeMove);
  } else if (id === 'spinIn') {
    anim('rotation', (v) => v - 180, 'easeOut');
    anim('sx', 0, 'easeOut');
    anim('sy', 0, 'easeOut');
  } else if (id === 'drawOn' || id === 'drawOff') {
    // o traço precisa existir para ser desenhado
    if (!layer.strokeOn || !(layer.props.strokeWidth > 0)) {
      layer.strokeOn = true;
      if (!(layer.props.strokeWidth > 0)) layer.props.strokeWidth = 6;
    }
    anim('trimEnd', 0, 'easeInOut');
  } else {
    const m = id.match(/^slide(?:In|Out)(Left|Right|Top|Bottom)$/);
    if (!m) return false;
    const [prop, sign] = SLIDE[m[1]];
    const distance = prop === 'x' ? comp.width : comp.height;
    anim(prop, (v) => v + sign * distance, easeMove);
  }
  return true;
}
