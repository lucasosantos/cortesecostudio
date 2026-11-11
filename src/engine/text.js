// Desenho de texto compartilhado entre os clipes de texto e as camadas de texto do motion.
import { measureText, fontString } from '../state/project.js';

/** Desenha o texto de `item` ({ text, font }) esticado na caixa (x, y, w, h). */
export function drawText(ctx, item, x, y, w, h) {
  const m = measureText(item);
  const f = item.font;
  ctx.translate(x, y);
  ctx.scale(w / m.w, h / m.h);
  ctx.font = fontString(f);
  ctx.textBaseline = 'middle';
  ctx.textAlign = f.align || 'center';
  const ax = f.align === 'left' ? m.pad : f.align === 'right' ? m.w - m.pad : m.w / 2;
  ctx.lineJoin = 'round';
  m.lines.forEach((line, i) => {
    const ly = m.pad + m.lineH * (i + 0.5);
    if (f.strokeWidth > 0) {
      ctx.strokeStyle = f.stroke || '#000';
      ctx.lineWidth = f.strokeWidth * 2;
      ctx.strokeText(line, ax, ly);
    }
    ctx.fillStyle = f.color || '#fff';
    ctx.fillText(line, ax, ly);
  });
}
