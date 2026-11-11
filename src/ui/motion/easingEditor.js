// Editor de curva de easing: uma cubic-bezier com duas alças arrastáveis.
import { h } from '../util.js';

const W = 220;
const H = 170;
const PAD = 16;
// o eixo vertical vai além de 0..1 para permitir curvas que passam do ponto
const Y_MIN = -0.4;
const Y_MAX = 1.4;

/**
 * @param onChange (bezier: [x1, y1, x2, y2]) => void — chamado durante o arrasto
 * @param onBegin  () => void — início de uma edição (para criar o ponto de desfazer)
 * @returns { el, set(bezier) }
 */
export function bezierEditor(onChange, onBegin) {
  const canvas = h('canvas.bezier-editor', { width: W, height: H, title: 'Arraste as alças para moldar a aceleração entre este keyframe e o próximo' });
  const ctx = canvas.getContext('2d');
  let value = [0.42, 0, 0.58, 1];

  const px = (x) => PAD + x * (W - PAD * 2);
  const py = (y) => PAD + ((Y_MAX - y) / (Y_MAX - Y_MIN)) * (H - PAD * 2);
  const ux = (sx) => (sx - PAD) / (W - PAD * 2);
  const uy = (sy) => Y_MAX - ((sy - PAD) / (H - PAD * 2)) * (Y_MAX - Y_MIN);

  function draw() {
    ctx.clearRect(0, 0, W, H);
    ctx.lineWidth = 1;
    ctx.strokeStyle = '#30343e';
    ctx.strokeRect(px(0), py(1), px(1) - px(0), py(0) - py(1));
    ctx.setLineDash([3, 4]);
    ctx.beginPath();
    ctx.moveTo(px(0), py(0));
    ctx.lineTo(px(1), py(1));
    ctx.stroke();
    ctx.setLineDash([]);

    const [x1, y1, x2, y2] = value;
    ctx.strokeStyle = '#8c92a3';
    ctx.beginPath();
    ctx.moveTo(px(0), py(0));
    ctx.lineTo(px(x1), py(y1));
    ctx.moveTo(px(1), py(1));
    ctx.lineTo(px(x2), py(y2));
    ctx.stroke();

    ctx.strokeStyle = '#ffd24a';
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.moveTo(px(0), py(0));
    ctx.bezierCurveTo(px(x1), py(y1), px(x2), py(y2), px(1), py(1));
    ctx.stroke();

    for (const [x, y] of [[x1, y1], [x2, y2]]) {
      ctx.fillStyle = '#fff';
      ctx.strokeStyle = '#4f8cff';
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.arc(px(x), py(y), 6, 0, Math.PI * 2);
      ctx.fill();
      ctx.stroke();
    }
  }

  canvas.addEventListener('pointerdown', (e) => {
    const r = canvas.getBoundingClientRect();
    const at = (ev) => [((ev.clientX - r.left) * W) / r.width, ((ev.clientY - r.top) * H) / r.height];
    const [sx, sy] = at(e);
    // pega a alça mais próxima do clique
    const d1 = Math.hypot(px(value[0]) - sx, py(value[1]) - sy);
    const d2 = Math.hypot(px(value[2]) - sx, py(value[3]) - sy);
    const i = d1 <= d2 ? 0 : 2;
    e.preventDefault();
    canvas.setPointerCapture(e.pointerId);
    onBegin?.();
    const move = (ev) => {
      const [mx, my] = at(ev);
      value = [...value];
      value[i] = Math.round(Math.min(1, Math.max(0, ux(mx))) * 1000) / 1000;
      value[i + 1] = Math.round(Math.min(Y_MAX, Math.max(Y_MIN, uy(my))) * 1000) / 1000;
      draw();
      onChange(value);
    };
    const up = () => {
      canvas.removeEventListener('pointermove', move);
      canvas.removeEventListener('pointerup', up);
      canvas.removeEventListener('pointercancel', up);
    };
    canvas.addEventListener('pointermove', move);
    canvas.addEventListener('pointerup', up);
    canvas.addEventListener('pointercancel', up);
    move(e);
  });

  draw();
  return {
    el: canvas,
    set(bezier) {
      if (Array.isArray(bezier) && bezier.length === 4 && bezier.some((v, k) => v !== value[k])) {
        value = [...bezier];
        draw();
      }
    },
  };
}
