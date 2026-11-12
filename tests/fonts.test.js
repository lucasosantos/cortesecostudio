import { describe, it, expect } from 'vitest';
import { readFontInfo, familyFromFileName, weightFromFileName, familyCss, familyName, familyLabel, usedFamilies } from '../src/fonts.js';

/** Arquivo sfnt mínimo com as tabelas name (família em UTF-16) e OS/2 (peso e itálico). */
function fakeFont({ family, typo, weight, italic }) {
  const names = [[1, family], ...(typo ? [[16, typo]] : [])];
  const strs = names.map(([, s]) => [...s].flatMap((c) => [0, c.charCodeAt(0)]));
  const nameLen = 6 + names.length * 12 + strs.reduce((a, s) => a + s.length, 0);
  const os2Len = 78;
  const dir = 12 + 2 * 16;
  const buf = new ArrayBuffer(dir + nameLen + os2Len);
  const v = new DataView(buf);
  v.setUint32(0, 0x00010000);
  v.setUint16(4, 2);
  const table = (i, tag, off, len) => {
    for (let k = 0; k < 4; k++) v.setUint8(12 + i * 16 + k, tag.charCodeAt(k));
    v.setUint32(12 + i * 16 + 8, off);
    v.setUint32(12 + i * 16 + 12, len);
  };
  table(0, 'name', dir, nameLen);
  table(1, 'OS/2', dir + nameLen, os2Len);
  v.setUint16(dir + 2, names.length);
  v.setUint16(dir + 4, 6 + names.length * 12);
  let strOff = 0;
  names.forEach(([id], i) => {
    const r = dir + 6 + i * 12;
    v.setUint16(r, 3); v.setUint16(r + 2, 1); v.setUint16(r + 4, 0x409); v.setUint16(r + 6, id);
    v.setUint16(r + 8, strs[i].length); v.setUint16(r + 10, strOff);
    strs[i].forEach((b, k) => v.setUint8(dir + 6 + names.length * 12 + strOff + k, b));
    strOff += strs[i].length;
  });
  const os2 = dir + nameLen;
  v.setUint16(os2 + 4, weight);
  v.setUint16(os2 + 62, italic ? 1 : 0);
  return buf;
}

describe('fontes', () => {
  it('lê família, peso e itálico de um TrueType', () => {
    expect(readFontInfo(fakeFont({ family: 'Minha Fonte', weight: 700, italic: true }))).toEqual({ family: 'Minha Fonte', weight: 700, italic: true });
    // a família tipográfica (id 16) tem preferência
    expect(readFontInfo(fakeFont({ family: 'Minha Fonte Light', typo: 'Minha Fonte', weight: 300 })).family).toBe('Minha Fonte');
  });
  it('WOFF ou lixo não são lidos (o nome vem do arquivo)', () => {
    expect(readFontInfo(new TextEncoder().encode('wOF2xxxxxxxxxxxx').buffer)).toBeNull();
    expect(familyFromFileName('RobotoSlab-BoldItalic.woff2')).toBe('Roboto Slab');
    expect(weightFromFileName('Inter-SemiBold.ttf')).toBe(600);
    expect(weightFromFileName('Inter.ttf')).toBe(400);
  });
  it('nomes de família', () => {
    expect(familyCss('Open Sans')).toBe('"Open Sans", sans-serif');
    expect(familyName('"Open Sans", sans-serif')).toBe('Open Sans');
    expect(familyLabel('Georgia, "Times New Roman", serif')).toBe('Serif (Georgia)');
    const used = usedFamilies({ clips: [{ type: 'text', font: { family: '"A", sans-serif' } }, { type: 'video' }], comps: [{ layers: [{ type: 'text', font: { family: 'B' } }] }] });
    expect([...used]).toEqual(['A', 'B']);
  });
});
