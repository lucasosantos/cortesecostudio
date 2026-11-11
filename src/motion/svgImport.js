// Importa um SVG como camadas de uma composição: cada forma vira uma camada de caminho,
// cada <g> vira um grupo pai. Usa o DOM do navegador para resolver estilos (inclusive <style> e herança).
import { createLayer, getLayer } from './model.js';
import { parseSvgPath, shapeToD } from './svgPath.js';
import { transformPath, pathBounds, mul, IDENTITY } from './geometry.js';

const SHAPE_TAGS = new Set(['path', 'rect', 'circle', 'ellipse', 'line', 'polyline', 'polygon']);
const SKIP_TAGS = new Set(['defs', 'clippath', 'mask', 'symbol', 'marker', 'pattern', 'lineargradient', 'radialgradient', 'filter', 'style', 'title', 'desc', 'metadata']);
const MAX_SHAPES = 600;

const hex2 = (v) => Math.max(0, Math.min(255, Math.round(v))).toString(16).padStart(2, '0');

/** 'rgb(1, 2, 3)' / 'rgba(1, 2, 3, .5)' / '#abc' → '#rrggbbaa' (com opacidade extra), ou null. */
function toHex(color, opacity = 1) {
  const c = String(color || '').trim();
  let r;
  let g;
  let b;
  let a = 1;
  const m = /^rgba?\(([^)]+)\)/i.exec(c);
  if (m) {
    const parts = m[1].split(/[\s,/]+/).filter(Boolean).map(parseFloat);
    [r, g, b] = parts;
    if (parts.length > 3) a = parts[3];
  } else if (/^#[0-9a-f]{3,8}$/i.test(c)) {
    let s = c.slice(1);
    if (s.length <= 4) s = [...s].map((ch) => ch + ch).join('');
    r = parseInt(s.slice(0, 2), 16);
    g = parseInt(s.slice(2, 4), 16);
    b = parseInt(s.slice(4, 6), 16);
    if (s.length === 8) a = parseInt(s.slice(6, 8), 16) / 255;
  } else {
    return null;
  }
  if (![r, g, b].every(Number.isFinite)) return null;
  return `#${hex2(r)}${hex2(g)}${hex2(b)}${hex2(a * opacity * 255)}`;
}

/** Remove o que não deve ser executado nem carregado ao anexar o SVG ao documento. */
function sanitize(svg) {
  for (const el of [...svg.querySelectorAll('script, foreignObject, iframe, image, audio, video')]) el.remove();
  for (const el of [svg, ...svg.querySelectorAll('*')]) {
    for (const attr of [...el.attributes]) {
      if (/^on/i.test(attr.name)) el.removeAttribute(attr.name);
    }
  }
}

/** Substitui <use> por uma cópia do elemento referenciado (casos simples, sem <symbol>). */
function expandUses(svg) {
  for (let pass = 0; pass < 4; pass++) {
    const uses = [...svg.querySelectorAll('use')];
    if (!uses.length) return;
    for (const use of uses) {
      const ref = (use.getAttribute('href') || use.getAttribute('xlink:href') || '').replace(/^#/, '');
      const target = ref ? svg.querySelector(`[id="${CSS.escape(ref)}"]`) : null;
      const g = svg.ownerDocument.createElementNS('http://www.w3.org/2000/svg', 'g');
      if (target && target.tagName.toLowerCase() !== 'symbol' && !target.contains(use)) {
        const copy = target.cloneNode(true);
        copy.removeAttribute('id');
        g.append(copy);
      }
      const x = parseFloat(use.getAttribute('x')) || 0;
      const y = parseFloat(use.getAttribute('y')) || 0;
      const own = use.getAttribute('transform') || '';
      g.setAttribute('transform', `${own} translate(${x} ${y})`.trim());
      for (const attr of use.attributes) {
        if (!['href', 'xlink:href', 'x', 'y', 'transform', 'width', 'height'].includes(attr.name)) g.setAttribute(attr.name, attr.value);
      }
      use.replaceWith(g);
    }
  }
}

function ownMatrix(el) {
  const t = el.transform?.baseVal;
  const c = t && t.numberOfItems ? t.consolidate() : null;
  return c ? [c.matrix.a, c.matrix.b, c.matrix.c, c.matrix.d, c.matrix.e, c.matrix.f] : IDENTITY;
}

function viewBoxOf(svg) {
  const vb = (svg.getAttribute('viewBox') || '').split(/[\s,]+/).map(Number);
  if (vb.length === 4 && vb.every(Number.isFinite) && vb[2] > 0 && vb[3] > 0) return { x: vb[0], y: vb[1], w: vb[2], h: vb[3] };
  const w = parseFloat(svg.getAttribute('width'));
  const h = parseFloat(svg.getAttribute('height'));
  return w > 0 && h > 0 ? { x: 0, y: 0, w, h } : null;
}

/**
 * Cria as camadas do SVG na frente da composição.
 * @returns { root, layers, shapes, warnings: string[] }
 */
export function importSvg(comp, text, name = 'SVG') {
  const doc = new DOMParser().parseFromString(text, 'image/svg+xml');
  const parsed = doc.documentElement;
  if (!parsed || parsed.tagName.toLowerCase() !== 'svg' || doc.querySelector('parsererror')) throw new Error('arquivo SVG inválido');
  sanitize(parsed);
  expandUses(parsed);

  // o SVG precisa estar no documento para o navegador calcular os estilos
  // (fora da tela, mas sem visibility:hidden — as formas herdariam e seriam tratadas como ocultas)
  const host = document.createElement('div');
  host.style.cssText = 'position:fixed;left:-100000px;top:0;width:10px;height:10px;overflow:hidden;opacity:0;pointer-events:none';
  const svg = document.importNode(parsed, true);
  host.append(svg);
  document.body.append(host);

  const counts = { gradient: 0, text: 0, clipped: 0, other: 0 };
  const created = [];
  let shapes = 0;
  let truncated = false;

  try {
    let vb = viewBoxOf(svg);
    const root = createLayer(comp, 'group', { name: name.replace(/\.svg$/i, '') || 'SVG' });
    created.push(root);

    /** Primeira cor de parada de um gradiente/padrão, usada como cor sólida de reserva. */
    const paint = (value, opacity) => {
      const v = String(value || '').trim();
      if (!v || v === 'none') return null;
      const url = /url\(["']?#([^"')]+)["']?\)/.exec(v);
      if (url) {
        counts.gradient++;
        const stop = svg.querySelector(`[id="${CSS.escape(url[1])}"] stop`);
        const st = stop ? getComputedStyle(stop) : null;
        return (st && toHex(st.stopColor, opacity * (parseFloat(st.stopOpacity) || 1))) || toHex('#888888', opacity);
      }
      return toHex(v, opacity);
    };

    const walk = (el, parentLayer, matrix, opacity) => {
      for (const child of el.children) {
        const tag = child.tagName.toLowerCase();
        if (SKIP_TAGS.has(tag)) continue;
        const cs = getComputedStyle(child);
        if (cs.display === 'none' || cs.visibility === 'hidden') continue;
        const m = mul(matrix, ownMatrix(child));
        const op = opacity * (Number.isFinite(parseFloat(cs.opacity)) ? parseFloat(cs.opacity) : 1);
        if (child.hasAttribute('clip-path') || child.hasAttribute('mask') || child.hasAttribute('filter')) counts.clipped++;

        if (tag === 'g' || tag === 'a' || tag === 'switch' || tag === 'svg') {
          const before = created.length;
          const group = createLayer(comp, 'group', { name: child.id || 'Grupo' });
          group.parentId = parentLayer.id;
          created.push(group);
          walk(child, group, m, op);
          const kids = created.slice(before + 1).filter((l) => l.parentId === group.id);
          if (!kids.length) {
            // grupo sem nada desenhável
            comp.layers = comp.layers.filter((l) => l !== group);
            created.splice(created.indexOf(group), 1);
          } else if (kids.length === 1 && !child.id) {
            // grupo com um filho só: o filho sobe um nível
            kids[0].parentId = parentLayer.id;
            comp.layers = comp.layers.filter((l) => l !== group);
            created.splice(created.indexOf(group), 1);
          } else {
            placeGroup(comp, group, kids);
          }
          continue;
        }
        if (tag === 'text' || tag === 'tspan') { counts.text++; continue; }
        if (!SHAPE_TAGS.has(tag)) { counts.other++; continue; }
        if (shapes >= MAX_SHAPES) { truncated = true; continue; }

        const attrs = {};
        for (const attr of child.attributes) attrs[attr.name] = attr.value;
        const raw = parseSvgPath(tag === 'path' ? attrs.d : shapeToD(tag, attrs));
        if (!raw.contours.length) continue;
        const path = transformPath(raw, m);

        const fill = tag === 'line' ? null : paint(cs.fill, op * (parseFloat(cs.fillOpacity) || (cs.fillOpacity === '0' ? 0 : 1)));
        const stroke = paint(cs.stroke, op * (parseFloat(cs.strokeOpacity) || (cs.strokeOpacity === '0' ? 0 : 1)));
        // a espessura acompanha a escala acumulada das transformações
        const scale = Math.sqrt(Math.abs(m[0] * m[3] - m[1] * m[2])) || 1;
        const width = (parseFloat(cs.strokeWidth) || 0) * scale;
        if (!fill && !(stroke && width > 0)) continue;

        const layer = createLayer(comp, 'shape', {
          shape: 'path', path, name: child.id || tag, fillOn: !!fill, strokeOn: !!stroke && width > 0,
          fillRule: cs.fillRule === 'evenodd' ? 'evenodd' : 'nonzero',
        });
        layer.parentId = parentLayer.id;
        layer.lineCap = ['butt', 'round', 'square'].includes(cs.strokeLinecap) ? cs.strokeLinecap : 'butt';
        layer.lineJoin = ['miter', 'round', 'bevel'].includes(cs.strokeLinejoin) ? cs.strokeLinejoin : 'miter';
        if (fill) layer.props.fill = fill;
        if (stroke) layer.props.stroke = stroke;
        layer.props.strokeWidth = layer.strokeOn ? Math.round(width * 1000) / 1000 : 0;
        created.push(layer);
        shapes++;
      }
    };
    walk(svg, root, IDENTITY, 1);

    if (!shapes) {
      comp.layers = comp.layers.filter((l) => !created.includes(l));
      throw new Error('nenhuma forma vetorial encontrada no SVG');
    }
    // sem viewBox, a área do desenho é a união das formas
    vb ||= unionBounds(comp, created.filter((l) => l.type === 'shape')) || { x: 0, y: 0, w: 100, h: 100 };
    // o grupo raiz centraliza o desenho na composição, ocupando até 80% dela
    const fit = Math.min((comp.width * 0.8) / vb.w, (comp.height * 0.8) / vb.h);
    Object.assign(root.props, {
      ax: vb.x + vb.w / 2, ay: vb.y + vb.h / 2, w: vb.w, h: vb.h,
      x: comp.width / 2, y: comp.height / 2, sx: Math.round(fit * 10000) / 100, sy: Math.round(fit * 10000) / 100,
    });
    // o grupo raiz fica no topo da lista, acima dos filhos
    comp.layers = [root, ...comp.layers.filter((l) => l !== root)];

    const warnings = [];
    if (counts.gradient) warnings.push(`${counts.gradient} gradiente(s) viraram cor sólida`);
    if (counts.text) warnings.push(`${counts.text} texto(s) ignorado(s) — converta em curvas antes de exportar o SVG`);
    if (counts.clipped) warnings.push(`${counts.clipped} recorte(s)/máscara(s)/filtro(s) ignorado(s)`);
    if (truncated) warnings.push(`só as primeiras ${MAX_SHAPES} formas foram importadas`);
    return { root, layers: created.filter((l) => getLayer(comp, l.id)), shapes, warnings };
  } finally {
    host.remove();
  }
}

/** União das caixas das camadas de forma (em coordenadas do pai, que aqui é sempre identidade). */
function unionBounds(comp, layers) {
  let x0 = Infinity;
  let y0 = Infinity;
  let x1 = -Infinity;
  let y1 = -Infinity;
  for (const l of layers) {
    const b = pathBounds(l.props.path);
    if (!b) continue;
    const left = l.props.x - l.props.ax + b.x;
    const top = l.props.y - l.props.ay + b.y;
    x0 = Math.min(x0, left);
    y0 = Math.min(y0, top);
    x1 = Math.max(x1, left + b.w);
    y1 = Math.max(y1, top + b.h);
  }
  return x0 === Infinity ? null : { x: x0, y: y0, w: Math.max(1, x1 - x0), h: Math.max(1, y1 - y0) };
}

/** Põe a âncora do grupo no centro dos filhos sem mover nada (posição = âncora → transformação identidade). */
function placeGroup(comp, group, kids) {
  const all = [];
  const collect = (layer) => {
    if (layer.type === 'shape') all.push(layer);
    for (const l of comp.layers) if (l.parentId === layer.id) collect(l);
  };
  for (const k of kids) collect(k);
  const b = unionBounds(comp, all);
  if (!b) return;
  const cx = b.x + b.w / 2;
  const cy = b.y + b.h / 2;
  Object.assign(group.props, { ax: cx, ay: cy, x: cx, y: cy, w: b.w, h: b.h });
  // o grupo fica logo acima dos filhos na lista de camadas
  comp.layers = [group, ...comp.layers.filter((l) => l !== group)];
}
