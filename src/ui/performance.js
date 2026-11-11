// Tela "Desempenho": qualidade do preview, uso da placa de vídeo, exportação rápida, arquivos proxy e medidor.
import { getPref, setPref } from '../prefs.js';
import { perf, setPerf, perfReport } from '../perf.js';
import { isDesktop, getAppConfig, setAppConfig, gpuStatus, relaunchApp, proxyStore } from '../platform/index.js';
import { glRenderer, isSoftwareRenderer } from '../fx/gl.js';
import { previewInfo } from './preview.js';
import { state, historyInfo } from '../state/project.js';
import { refreshProxies } from '../media/proxy.js';
import { h, openModal, toast } from './util.js';

const fmtBytes = (n) => (n >= 1024 ** 3 ? `${(n / 1024 ** 3).toFixed(1)} GB` : `${Math.round(n / 1024 ** 2)} MB`);
const note = (...c) => h('div.insp-note', { style: { padding: 0 } }, ...c);
const option = (value, label, current) => h('option', { value: String(value), selected: String(value) === String(current) }, label);

export async function openPerformance() {
  if (document.querySelector('.perf-modal')) return;
  const [config, gpu, stats] = await Promise.all([
    getAppConfig().catch(() => null), gpuStatus().catch(() => null), proxyStore ? proxyStore.stats().catch(() => null) : null,
  ]);
  const renderer = glRenderer();
  const software = isSoftwareRenderer(renderer) || (gpu && !gpu.enabled);

  // ---- preview
  const previewNote = note();
  const showPreview = () => {
    const p = previewInfo();
    previewNote.textContent = `O preview está sendo desenhado em ${p.width}×${p.height} (${Math.round(p.scale * 100)}% do projeto). A exportação é sempre na resolução cheia.`;
  };
  const quality = h('select', {
    on: { change: (e) => { setPref('previewQuality', e.target.value === 'auto' ? 'auto' : Number(e.target.value)); setTimeout(showPreview, 50); } },
  },
  option('auto', 'Automática (o tamanho em que aparece na tela)', getPref('previewQuality')),
  option(1, 'Cheia (resolução do projeto)', getPref('previewQuality')),
  option(0.5, 'Metade (1/2)', getPref('previewQuality')),
  option(0.25, 'Um quarto (1/4) — a mais leve', getPref('previewQuality')));
  showPreview();

  // ---- placa de vídeo
  const gpuRows = [];
  const status = !renderer ? 'Este ambiente não tem WebGL2: os efeitos em shader ficam desligados.'
    : software ? `O desenho está sendo feito pelo processador (${renderer || 'sem placa de vídeo'}). Efeitos em shader e o preview ficam mais lentos.`
    : `Placa de vídeo em uso: ${renderer}.`;
  gpuRows.push(note(status));
  if (config) {
    let restartNote = null;
    const changed = () => {
      if (restartNote) return;
      restartNote = h('div.perf-restart', {},
        h('span', {}, 'A mudança vale depois de reiniciar o app.'),
        h('button.primary', { on: { click: () => {
          if (state.project.clips.length && !confirm('Reiniciar agora? Alterações não salvas no projeto serão perdidas.')) return;
          relaunchApp();
        } } }, 'Reiniciar agora'));
      gpuBox.append(restartNote);
    };
    const hw = h('input', { type: 'checkbox', checked: !!config.hwVideoDecode, disabled: !config.gpu, on: { change: async (e) => { await setAppConfig({ hwVideoDecode: e.target.checked }); changed(); } } });
    const use = h('input', { type: 'checkbox', checked: !!config.gpu, on: { change: async (e) => { await setAppConfig({ gpu: e.target.checked }); hw.disabled = !e.target.checked; changed(); } } });
    gpuRows.push(
      h('label.toggle-row', { style: { padding: 0 } }, use, 'Usar a placa de vídeo'),
      note('Ligada, a placa desenha o preview, os efeitos e decodifica os vídeos. Desligue se a tela piscar, ficar preta ou o app fechar sozinho: tudo passa a ser feito pelo processador (mais lento, porém estável).'),
    );
    if (gpu?.platform === 'linux') {
      gpuRows.push(
        h('label.toggle-row', { style: { padding: 0 } }, hw, 'Decodificar e codificar vídeo pela placa (experimental)'),
        note('No Linux isso vem desligado porque depende do driver (VA-API). Pode deixar a reprodução e a exportação bem mais leves; se os vídeos ficarem pretos ou travarem, desligue.'),
      );
    }
  } else {
    gpuRows.push(note(isDesktop ? '' : 'Na versão de navegador, o uso da placa de vídeo é controlado pelo próprio navegador (em Configurações → Sistema → aceleração de hardware).'));
  }
  const gpuBox = h('div.perf-group', {}, ...gpuRows);

  // ---- exportação
  const fast = h('input', { type: 'checkbox', checked: getPref('fastExport'), on: { change: (e) => setPref('fastExport', e.target.checked) } });

  // ---- proxy
  const proxyRows = [];
  if (proxyStore) {
    const statsNote = note();
    const showStats = (s) => { statsNote.textContent = s ? `${s.files} arquivo(s) proxy, ${fmtBytes(s.bytes)} em ${s.dir}` : ''; };
    showStats(stats);
    const limit = h('input', { type: 'number', min: 256, step: 256, value: config?.proxyLimitMB ?? 2048, style: { width: '90px' }, on: { change: (e) => setAppConfig({ proxyLimitMB: Number(e.target.value) }) } });
    proxyRows.push(
      h('div.field-row', {},
        h('label.field', {}, h('span', {}, 'Gerar proxy'), h('select', { on: { change: (e) => { setPref('proxyMode', e.target.value); refreshProxies(); } } },
          option('auto', 'Automático (vídeos acima de 720 de altura)', getPref('proxyMode')),
          option('always', 'Para todos os vídeos', getPref('proxyMode')),
          option('never', 'Nunca', getPref('proxyMode')))),
        h('label.field', {}, h('span', {}, 'Altura do proxy'), h('select', { on: { change: (e) => { setPref('proxyHeight', Number(e.target.value)); refreshProxies(); } } },
          option(360, '360 (mais leve)', getPref('proxyHeight')),
          option(540, '540', getPref('proxyHeight')),
          option(720, '720', getPref('proxyHeight')))),
      ),
      note('O proxy é uma cópia leve do vídeo, usada só no preview. Ele é gerado em segundo plano, um vídeo por vez; enquanto não fica pronto, o preview usa o original. A exportação sempre usa o original.'),
      h('div.field-row', {},
        h('label.field', {}, h('span', {}, 'Espaço máximo (MB)'), limit),
        h('button', { on: { click: async () => { await proxyStore.clear(); refreshProxies({ dropped: true }); showStats(await proxyStore.stats()); toast('Proxies apagados'); } } }, 'Limpar proxies'),
      ),
      statsNote,
    );
  } else {
    proxyRows.push(note('Arquivos proxy (cópias leves dos vídeos para o preview) só existem no app desktop, porque precisam ser gravados em disco.'));
  }

  // ---- medidor
  const meter = h('pre.perf-meter', {}, 'Medidor desligado.');
  let timer = 0;
  let last = null;
  const sample = () => {
    const r = perfReport();
    const draws = r.draw?.n || 0;
    const fps = last ? ((draws - last.draws) / ((performance.now() - last.at) / 1000)) : 0;
    last = { draws, at: performance.now() };
    const line = (label, e) => (e ? `${label.padEnd(26)} ${String(e.avg).padStart(7)} ms média · ${String(e.p95).padStart(7)} ms nos piores · ${e.n} vezes` : null);
    const hist = historyInfo();
    meter.textContent = [
      `Quadros desenhados por segundo: ${fps.toFixed(1)}${state.playing ? '' : '  (parado: só desenha quando algo muda)'}`,
      line('Desenho do quadro', r.draw),
      line('Timeline (completa)', r.timeline),
      line('Timeline (só o clipe)', r.timelineFast),
      line('Inspector', r.inspector),
      line('Palco do Motion', r.stageDraw),
      `Desfazer: ${hist.steps} passo(s), ${fmtBytes(hist.chars * 2)}`,
      performance.memory ? `Memória do JavaScript: ${fmtBytes(performance.memory.usedJSHeapSize)}` : null,
    ].filter(Boolean).join('\n');
  };
  const wasOn = perf.on;
  const meterToggle = h('input', {
    type: 'checkbox',
    on: { change: (e) => {
      clearInterval(timer);
      setPerf(e.target.checked);
      last = null;
      if (e.target.checked) { sample(); timer = setInterval(sample, 1000); } else meter.textContent = 'Medidor desligado.';
    } },
  });

  const m = openModal({
    title: 'Desempenho',
    onClose: () => { clearInterval(timer); if (!wasOn) setPerf(false); },
    body: h('div.perf', {},
      h('h4', {}, 'Preview'),
      h('div.perf-group', {}, h('label.field', {}, h('span', {}, 'Qualidade do preview'), quality), previewNote),
      h('h4', {}, 'Placa de vídeo'),
      gpuBox,
      h('h4', {}, 'Exportação'),
      h('div.perf-group', {},
        h('label.toggle-row', { style: { padding: 0 } }, fast, 'Exportação rápida'),
        note('Codifica mais depressa, com um pouco menos de qualidade para o mesmo tamanho de arquivo. Quando a placa de vídeo tem codificador, ele é usado automaticamente.')),
      h('h4', {}, 'Arquivos proxy'),
      h('div.perf-group', {}, ...proxyRows),
      h('h4', {}, 'Medidor'),
      h('div.perf-group', {}, h('label.toggle-row', { style: { padding: 0 } }, meterToggle, 'Medir enquanto uso o editor'), meter),
    ),
    footer: [h('button', { on: { click: () => m.close() } }, 'Fechar')],
  });
  m.el.classList.add('wide', 'perf-modal');
}
