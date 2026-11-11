import { describe, it, expect, beforeEach } from 'vitest';
import { createRequire } from 'node:module';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { state, newProject, emit, checkpoint, undo, redo, resetHistory, historyInfo } from '../src/state/project.js';
import { createPeaks, addSamples, clipBlockRange } from '../src/media/peaks.js';
import { sanitize as sanitizePrefs, PREF_DEFAULTS } from '../src/prefs.js';
import { visibleWindow } from '../src/ui/util.js';
import { transitionIndexFor, buildTransitionIndex } from '../src/engine/compositor.js';
import { isSoftwareRenderer } from '../src/fx/gl.js';
import { needsProxy, proxyBitrate } from '../src/media/proxy.js';
import { previewScaleFor } from '../src/ui/preview.js';
import { setPerf, timed, count, addTime, perfReport } from '../src/perf.js';

const require = createRequire(import.meta.url);
const { sanitize: sanitizeConfig, readConfig, writeConfig, DEFAULTS } = require('../electron/config.cjs');
const { parseRange } = require('../electron/media.cjs');

beforeEach(() => {
  state.project = newProject();
  resetHistory();
});

describe('forma de onda por picos', () => {
  it('guarda o maior valor de cada trecho, sem guardar o áudio', () => {
    const peaks = createPeaks(10); // 10 s → 500 trechos
    expect(peaks.n).toBe(500);
    const sr = 1000;
    const samples = new Float32Array(sr); // 1 s de áudio
    samples[500] = -0.8; // pico negativo em 0,5 s do pedaço
    addSamples(peaks, samples, 2, sr, 1); // o pedaço começa em 2 s → pico em 2,5 s
    const at = Math.floor((2.5 / 10) * 500);
    expect(peaks.data[at]).toBeCloseTo(0.8);
    expect(Math.max(...peaks.data.slice(0, at))).toBe(0);
  });

  it('limita a quantidade de trechos e ignora áudio fora da duração', () => {
    expect(createPeaks(3600).n).toBe(4000);
    expect(createPeaks(0.5).n).toBe(200);
    const peaks = createPeaks(1);
    addSamples(peaks, new Float32Array(100).fill(1), 5, 100, 1); // começa depois do fim
    addSamples(peaks, new Float32Array(100).fill(1), -3, 100, 1); // termina antes do início
    expect(Math.max(...peaks.data)).toBe(0);
  });
});

describe('mixagem em blocos', () => {
  const clip = { start: 4, duration: 10, inPoint: 2 };
  it('recorta o trecho do clipe que cai em cada bloco', () => {
    expect(clipBlockRange(clip, 0, 4)).toBeNull();
    expect(clipBlockRange(clip, 0, 5)).toEqual({ when: 4, localFrom: 0, mediaFrom: 2, dur: 1 });
    expect(clipBlockRange(clip, 5, 10)).toEqual({ when: 0, localFrom: 1, mediaFrom: 3, dur: 5 });
    expect(clipBlockRange(clip, 10, 15)).toEqual({ when: 0, localFrom: 6, mediaFrom: 8, dur: 4 });
    expect(clipBlockRange(clip, 15, 20)).toBeNull();
  });
  it('não passa do fim da mídia', () => {
    // a mídia tem 6 s e o clipe começa nela em 2 s: só há 4 s de som
    expect(clipBlockRange(clip, 5, 10, 6)).toEqual({ when: 0, localFrom: 1, mediaFrom: 3, dur: 3 });
    expect(clipBlockRange(clip, 10, 15, 6)).toBeNull();
  });
  it('os blocos somados cobrem o clipe inteiro, sem sobra nem buraco', () => {
    let total = 0;
    for (let b = 0; b < 20; b += 2) total += clipBlockRange(clip, b, b + 2)?.dur || 0;
    expect(total).toBeCloseTo(10);
  });
});

describe('histórico de desfazer', () => {
  it('conta o tamanho e devolve ao desfazer', () => {
    checkpoint();
    const one = historyInfo();
    expect(one.steps).toBe(1);
    expect(one.chars).toBe(JSON.stringify(state.project).length);
    state.project.clips.push({ id: 'c1', trackId: state.project.tracks[0].id, type: 'text', start: 0, duration: 2, props: {}, keyframes: {} });
    checkpoint();
    expect(historyInfo().steps).toBe(2);
    undo();
    expect(historyInfo().steps).toBe(1);
    redo();
    expect(historyInfo().steps).toBe(2);
    resetHistory();
    expect(historyInfo()).toEqual({ steps: 0, chars: 0 });
  });

  it('projeto grande guarda menos passos, mas sempre ao menos um', () => {
    // ~6 milhões de caracteres por fotografia: o limite de 20 milhões comporta 3
    state.project.note = 'x'.repeat(6_000_000);
    for (let i = 0; i < 6; i++) checkpoint();
    const info = historyInfo();
    expect(info.steps).toBe(3);
    expect(info.chars).toBeLessThanOrEqual(20_000_000);
    state.project.note = 'x'.repeat(30_000_000);
    checkpoint();
    expect(historyInfo().steps).toBe(1);
    undo();
    expect(state.project.note.length).toBe(30_000_000);
  });
});

describe('cache do índice de transições', () => {
  it('só refaz quando o projeto muda', () => {
    const a = transitionIndexFor(state.project, state.rev);
    expect(transitionIndexFor(state.project, state.rev)).toBe(a);
    emit('time');
    expect(transitionIndexFor(state.project, state.rev)).toBe(a);
    emit('project');
    const b = transitionIndexFor(state.project, state.rev);
    expect(b).not.toBe(a);
    // outro objeto de projeto (desfazer, exportação) nunca reaproveita o índice
    expect(transitionIndexFor(newProject(), state.rev)).not.toBe(b);
    expect(Object.keys(b)).toEqual(Object.keys(buildTransitionIndex(state.project)));
  });
});

describe('timeline: faixa visível', () => {
  it('cobre a tela mais meia tela de cada lado', () => {
    // 1190 px de largura, 190 de cabeçalho → 1000 px de pista; zoom 100 px/s
    const w = visibleWindow(2000, 1190, 100, 190);
    expect(w.t0).toBeCloseTo(15);
    expect(w.t1).toBeCloseTo(35);
    // só pede novo desenho depois de rolar um quarto de tela
    expect(w.x0).toBe(1750);
    expect(w.x1).toBe(2250);
  });
  it('não começa antes do zero', () => {
    expect(visibleWindow(0, 1190, 100, 190).t0).toBe(0);
  });
});

describe('qualidade do preview', () => {
  it('valor fixo é respeitado', () => {
    expect(previewScaleFor(1, 0.3)).toBe(1);
    expect(previewScaleFor(0.5, 0.9)).toBe(0.5);
    expect(previewScaleFor(0.25, 0.9)).toBe(0.25);
  });
  it('automática usa o tamanho na tela, em degraus, sem passar do projeto', () => {
    expect(previewScaleFor('auto', 0.43)).toBe(0.5);
    expect(previewScaleFor('auto', 0.2)).toBe(0.25);
    expect(previewScaleFor('auto', 0.6)).toBe(0.75);
    expect(previewScaleFor('auto', 0.9)).toBe(1);
    expect(previewScaleFor('auto', 2.5)).toBe(1);
    // tela de alta densidade pede mais pixels
    expect(previewScaleFor('auto', 0.3, 2)).toBe(0.75);
  });
  it('sem placa de vídeo, a automática cai pela metade', () => {
    expect(previewScaleFor('auto', 0.9, 1, true)).toBe(0.5);
    expect(previewScaleFor(1, 0.9, 1, true)).toBe(1);
  });
});

describe('placa de vídeo', () => {
  it('reconhece renderizadores por software', () => {
    expect(isSoftwareRenderer('ANGLE (Google, Vulkan 1.3.0 (SwiftShader Device (Subzero)), SwiftShader driver)')).toBe(true);
    expect(isSoftwareRenderer('llvmpipe (LLVM 15.0.7, 256 bits)')).toBe(true);
    expect(isSoftwareRenderer('Microsoft Basic Render Driver')).toBe(true);
    expect(isSoftwareRenderer('ANGLE (AMD, AMD Radeon(TM) Vega 8 Graphics Direct3D11 vs_5_0 ps_5_0)')).toBe(false);
    expect(isSoftwareRenderer('')).toBe(false);
  });
});

describe('preferências', () => {
  it('descarta chaves desconhecidas e valores inválidos', () => {
    expect(sanitizePrefs({ previewQuality: 0.5, proxyMode: 'always', proxyHeight: 360, fastExport: true, lixo: 1 }))
      .toEqual({ previewQuality: 0.5, proxyMode: 'always', proxyHeight: 360, fastExport: true });
    expect(sanitizePrefs({ previewQuality: 3, proxyMode: 'x', proxyHeight: 1000, fastExport: 'sim' })).toEqual({});
    expect(sanitizePrefs(null)).toEqual({});
    expect(PREF_DEFAULTS.previewQuality).toBe('auto');
  });
});

describe('proxy', () => {
  const video = (height, over = {}) => ({ type: 'video', height, path: '/v/a.mp4', ...over });
  it('automático: só vídeos acima de 720 de altura', () => {
    expect(needsProxy(video(1080), 'auto', 540)).toBe(true);
    expect(needsProxy(video(2160), 'auto', 540)).toBe(true);
    expect(needsProxy(video(720), 'auto', 540)).toBe(false);
  });
  it('sempre: qualquer vídeo maior que o proxy; nunca: nenhum', () => {
    expect(needsProxy(video(720), 'always', 540)).toBe(true);
    expect(needsProxy(video(480), 'always', 540)).toBe(false);
    expect(needsProxy(video(2160), 'never', 540)).toBe(false);
  });
  it('precisa ser vídeo e ter caminho em disco', () => {
    expect(needsProxy(video(1080, { type: 'image' }), 'always', 540)).toBe(false);
    expect(needsProxy(video(1080, { path: null }), 'always', 540)).toBe(false);
    expect(needsProxy(null, 'always', 540)).toBe(false);
  });
  it('taxa de bits proporcional à área', () => {
    expect(proxyBitrate(540)).toBe(1_500_000);
    expect(proxyBitrate(360)).toBeLessThan(proxyBitrate(540));
    expect(proxyBitrate(720)).toBeGreaterThan(proxyBitrate(540));
  });
});

describe('configuração do app desktop', () => {
  it('valida os campos', () => {
    expect(sanitizeConfig({ gpu: false, hwVideoDecode: true, proxyLimitMB: 100, outro: 1 })).toEqual({ gpu: false, hwVideoDecode: true, proxyLimitMB: 256 });
    expect(sanitizeConfig({ gpu: 'não', proxyLimitMB: 'muito' })).toEqual({});
    expect(sanitizeConfig(undefined)).toEqual({});
  });
  it('sem arquivo ou com arquivo corrompido vale o padrão (placa ligada)', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cs-cfg-'));
    const file = path.join(dir, 'config.json');
    expect(readConfig(file)).toEqual(DEFAULTS);
    fs.writeFileSync(file, '{ quebrado');
    expect(readConfig(file)).toEqual(DEFAULTS);
    expect(DEFAULTS.gpu).toBe(true);
    fs.rmSync(dir, { recursive: true });
  });
  it('grava só o que mudou e lê de volta', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cs-cfg-'));
    const file = path.join(dir, 'config.json');
    expect(writeConfig(file, { gpu: false }).gpu).toBe(false);
    expect(writeConfig(file, { hwVideoDecode: true })).toEqual({ ...DEFAULTS, gpu: false, hwVideoDecode: true });
    expect(readConfig(file).gpu).toBe(false);
    fs.rmSync(dir, { recursive: true });
  });
});

describe('protocolo media://: leitura parcial', () => {
  it('interpreta as faixas pedidas pelo player', () => {
    expect(parseRange(null, 1000)).toBeNull();
    expect(parseRange('bytes=0-', 1000)).toEqual({ start: 0, end: 999 });
    expect(parseRange('bytes=100-199', 1000)).toEqual({ start: 100, end: 199 });
    expect(parseRange('bytes=900-5000', 1000)).toEqual({ start: 900, end: 999 });
    expect(parseRange('bytes=-200', 1000)).toEqual({ start: 800, end: 999 });
  });
  it('recusa faixas inválidas', () => {
    expect(parseRange('bytes=1000-', 1000)).toBe(false);
    expect(parseRange('bytes=5-2', 1000)).toBe(false);
    expect(parseRange('bytes=-', 1000)).toBe(false);
    expect(parseRange('linhas=1-2', 1000)).toBe(false);
  });
});

describe('medidor', () => {
  it('desligado não registra nada; ligado resume os tempos', () => {
    setPerf(false);
    expect(timed('x', () => 7)).toBe(7);
    count('y');
    expect(perfReport()).toEqual({});
    setPerf(true);
    for (const ms of [1, 2, 3, 10]) addTime('draw', ms);
    count('raf', 3);
    const r = perfReport();
    expect(r.draw).toMatchObject({ n: 4, avg: 4, max: 10, total: 16 });
    expect(r.draw.p95).toBe(10);
    expect(r.raf.n).toBe(3);
    setPerf(false);
    expect(perfReport()).toEqual({});
  });
});
