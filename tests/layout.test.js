import { describe, it, expect } from 'vitest';
import { gridFor, sanitizeLayout, DEFAULT_LAYOUT, PRESETS } from '../src/ui/layout.js';

const L = (over = {}) => sanitizeLayout({ ...DEFAULT_LAYOUT, ...over });

describe('arranjo dos painéis', () => {
  it('padrão: três colunas em cima e a timeline embaixo', () => {
    const g = gridFor(L());
    expect(g.areas).toBe("'top top top' 'media preview insp' 'tl tl tl'");
    expect(g.columns).toBe('var(--media-w, 260px) minmax(0, 1fr) var(--insp-w, 300px)');
    expect(g.rows).toBe('46px minmax(160px, 1fr) var(--tl-h, 340px)');
  });

  it('painel oculto some da grade e a última coluna ocupa a sobra quando não há preview', () => {
    expect(gridFor(L({ hidden: { media: true } })).areas).toBe("'top top' 'preview insp' 'tl tl'");
    const g = gridFor(L({ hidden: { preview: true } }));
    expect(g.areas).toBe("'top top' 'media insp' 'tl tl'");
    expect(g.columns).toBe('var(--media-w, 260px) minmax(0, 1fr)');
  });

  it('a ordem das colunas é livre', () => {
    expect(gridFor(L({ order: ['insp', 'media', 'preview'] })).areas).toBe("'top top top' 'insp media preview' 'tl tl tl'");
  });

  it('altura inteira: o painel desce ao lado da timeline', () => {
    const g = gridFor(L(PRESETS['vertical-right'][1]));
    expect(g.areas).toBe("'top top top' 'media insp preview' 'tl tl preview'");
    expect(g.tall).toBe('preview');
    expect(gridFor(L({ tall: 'media' })).areas).toBe("'top top top' 'media preview insp' 'media tl tl'");
  });

  it('altura inteira é ignorada sem timeline ou sem outra coluna', () => {
    expect(gridFor(L({ tall: 'preview', hidden: { tl: true } })).tall).toBeNull();
    expect(gridFor(L({ tall: 'preview', hidden: { media: true, insp: true } })).tall).toBeNull();
    expect(gridFor(L({ tall: 'preview', hidden: { preview: true } })).tall).toBeNull();
  });

  it('timeline em cima troca as linhas', () => {
    const g = gridFor(L({ tlPos: 'top' }));
    expect(g.areas).toBe("'top top top' 'tl tl tl' 'media preview insp'");
    expect(g.rows).toBe('46px var(--tl-h, 340px) minmax(160px, 1fr)');
  });

  it('sem timeline os painéis ocupam tudo; só a timeline também', () => {
    expect(gridFor(L({ hidden: { tl: true } })).rows).toBe('46px minmax(0, 1fr)');
    const only = gridFor(L({ hidden: { media: true, preview: true, insp: true } }));
    expect(only.areas).toBe("'top' 'tl'");
    expect(only.rows).toBe('46px minmax(0, 1fr)');
    expect(gridFor(L({ hidden: { media: true, preview: true, insp: true, tl: true } })).areas).toBe("'top'");
  });

  it('dados salvos inválidos voltam ao padrão', () => {
    expect(sanitizeLayout(null)).toEqual({ ...DEFAULT_LAYOUT, hidden: {} });
    const s = sanitizeLayout({ order: ['media', 'media', 'x'], tall: 'tl', tlPos: 'lado', tlH: 'calc(1px)', pvW: '300px', hidden: { insp: 1, outro: 1 } });
    expect(s.order).toEqual(DEFAULT_LAYOUT.order);
    expect(s.tall).toBeNull();
    expect(s.tlPos).toBe('bottom');
    expect(s.tlH).toBeNull();
    expect(s.pvW).toBe('300px');
    expect(s.hidden).toEqual({ insp: true });
  });
});
