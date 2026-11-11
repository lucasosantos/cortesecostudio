// Diálogos: configurações do projeto, exportação e mídias ausentes.
import { state, emit, checkpoint, projectDuration } from '../state/project.js';
import { valueAt } from '../state/keyframes.js';
import { exportProject, exportExtension, ExportCanceled } from '../engine/exporter.js';
import { getPref } from '../prefs.js';
import { pause } from '../engine/player.js';
import { saveFile, canStreamToDisk, pickSavePath, openFileWriter } from '../platform/index.js';
import { isMissing } from '../media/library.js';
import { relinkOne } from './mediaPanel.js';
import { h, openModal, toast, formatDuration } from './util.js';
import { createComp } from '../motion/model.js';
import { openComp } from './motion/actions.js';

const PRESETS = [
  ['1080p 16:9', 1920, 1080],
  ['720p 16:9', 1280, 720],
  ['4K 16:9', 3840, 2160],
  ['Vertical 9:16', 1080, 1920],
  ['Quadrado 1:1', 1080, 1080],
  ['Retrato 4:5', 1080, 1350],
];

// ---------------------------------------------------------------- nova composição
export function openNewComp() {
  const s = state.project.settings;
  const n = (state.project.comps || []).length + 1;
  const name = h('input', { type: 'text', value: `Composição ${n}` });
  const w = h('input', { type: 'number', min: 2, max: 7680, step: 2, value: s.width });
  const hgt = h('input', { type: 'number', min: 2, max: 7680, step: 2, value: s.height });
  const dur = h('input', { type: 'number', min: 0.1, step: 0.5, value: 5 });
  const create = () => {
    checkpoint();
    const comp = createComp({ name: name.value.trim(), width: Number(w.value) || s.width, height: Number(hgt.value) || s.height, duration: Number(dur.value) || 5 });
    m.close();
    emit('project');
    openComp(comp.id);
  };
  const m = openModal({
    title: 'Nova composição de motion',
    body: [
      h('label.field', {}, h('span', {}, 'Nome'), name),
      h('div.field-row', {},
        h('label.field', {}, h('span', {}, 'Largura (px)'), w),
        h('label.field', {}, h('span', {}, 'Altura (px)'), hgt),
        h('label.field', {}, h('span', {}, 'Duração (s)'), dur),
      ),
      h('div.insp-note', { style: { padding: 0 } },
        'A composição é um espaço separado para animar formas, textos, imagens e vetores. Depois de pronta, ela entra na timeline do vídeo como um clipe com fundo transparente.'),
    ],
    footer: [
      h('button', { on: { click: () => m.close() } }, 'Cancelar'),
      h('button.primary', { on: { click: create } }, 'Criar e abrir'),
    ],
  });
  name.addEventListener('keydown', (e) => { if (e.key === 'Enter') create(); });
  setTimeout(() => { name.focus(); name.select(); }, 30);
}

// ---------------------------------------------------------------- configurações
export function openSettings() {
  const s = state.project.settings;
  const w = h('input', { type: 'number', min: 16, max: 7680, step: 2, value: s.width });
  const hgt = h('input', { type: 'number', min: 16, max: 7680, step: 2, value: s.height });
  const fps = h('select', {}, ...[24, 25, 30, 50, 60].map((f) => h('option', { value: f, selected: f === s.fps }, `${f} fps`)));
  const bg = h('input', { type: 'color', value: s.background || '#000000' });
  const rescale = h('input', { type: 'checkbox', checked: true });

  const presets = h('div.presets', {}, ...PRESETS.map(([name, pw, ph]) =>
    h('button', { on: { click: () => { w.value = pw; hgt.value = ph; } } }, `${name} · ${pw}×${ph}`)));

  const m = openModal({
    title: 'Configurações do projeto',
    body: [
      h('div.field', {}, h('span', {}, 'Predefinições'), presets),
      h('div.field-row', {},
        h('label.field', {}, h('span', {}, 'Largura (px)'), w),
        h('label.field', {}, h('span', {}, 'Altura (px)'), hgt),
        h('label.field', {}, h('span', {}, 'Quadros por segundo'), fps),
        h('label.field', {}, h('span', {}, 'Fundo'), bg),
      ),
      h('label.toggle-row', { style: { padding: 0 } }, rescale, 'Reposicionar os clipes proporcionalmente à nova dimensão'),
      h('div.insp-note', { style: { padding: 0 } }, 'Largura e altura são arredondadas para números pares (exigência do H.264).'),
    ],
    footer: [
      h('button', { on: { click: () => m.close() } }, 'Cancelar'),
      h('button.primary', {
        on: {
          click: () => {
            const nw = Math.max(16, Math.round((Number(w.value) || s.width) / 2) * 2);
            const nh = Math.max(16, Math.round((Number(hgt.value) || s.height) / 2) * 2);
            checkpoint();
            if (rescale.checked && (nw !== s.width || nh !== s.height)) rescaleClips(nw / s.width, nh / s.height);
            Object.assign(s, { width: nw, height: nh, fps: Number(fps.value), background: bg.value });
            m.close();
            emit('project');
          },
        },
      }, 'Aplicar'),
    ],
  });
}

function rescaleClips(sx, sy) {
  // tamanho escala uniformemente (menor fator, sem distorcer); o centro escala por eixo
  const su = Math.min(sx, sy);
  for (const clip of state.project.clips) {
    if (clip.type === 'audio') continue;
    const orig = JSON.parse(JSON.stringify(clip));
    const mapX = (t, x) => { const w = valueAt(orig, 'width', t); return (x + w / 2) * sx - (w * su) / 2; };
    const mapY = (t, y) => { const hh = valueAt(orig, 'height', t); return (y + hh / 2) * sy - (hh * su) / 2; };
    clip.props.x = mapX(0, clip.props.x);
    clip.props.y = mapY(0, clip.props.y);
    clip.props.width *= su;
    clip.props.height *= su;
    for (const k of clip.keyframes?.x || []) k.v = mapX(k.t, k.v);
    for (const k of clip.keyframes?.y || []) k.v = mapY(k.t, k.v);
    for (const k of clip.keyframes?.width || []) k.v *= su;
    for (const k of clip.keyframes?.height || []) k.v *= su;
  }
}

// ---------------------------------------------------------------- exportação
export function openExport() {
  pause();
  const duration = projectDuration();
  if (duration <= 0) return toast('Adicione clipes à timeline antes de exportar');
  const missing = state.project.media.filter((m) => isMissing(m.id) && state.project.clips.some((c) => c.mediaId === m.id));

  const s = state.project.settings;
  const fmt = (value, title, sub, checked) =>
    h('label', {}, h('input', { type: 'radio', name: 'fmt', value, checked }), h('b', {}, title), h('small', {}, sub));
  const formats = h('div.radio-cards', {},
    fmt('mp4', 'Vídeo MP4', `${s.width}×${s.height} · ${s.fps}fps · H.264 + AAC`, true),
    fmt('mp3', 'Somente áudio MP3', 'Mixagem de todas as tracks'),
  );
  const quality = h('select', {},
    h('option', { value: 'low' }, 'Baixa (arquivo menor)'),
    h('option', { value: 'medium' }, 'Média'),
    h('option', { value: 'high', selected: true }, 'Alta'),
    h('option', { value: 'veryhigh' }, 'Muito alta'),
  );
  const name = h('input', { type: 'text', value: state.projectName || 'video' });
  const bar = h('div');
  const progress = h('div.progress', { style: { display: 'none' } }, bar);
  const label = h('div.progress-label');
  const startBtn = h('button.primary', {}, 'Exportar');
  const cancelBtn = h('button', {}, 'Fechar');
  let running = null;

  const m = openModal({
    title: 'Exportar',
    dismissable: true,
    onClose: () => { if (running) running.canceled = true; },
    body: [
      formats,
      h('div.field-row', {},
        h('label.field', {}, h('span', {}, 'Nome do arquivo'), name),
        h('label.field', {}, h('span', {}, 'Qualidade'), quality),
      ),
      h('div.insp-note', { style: { padding: 0 } }, `Duração: ${formatDuration(duration)}`),
      missing.length ? h('div.insp-note', { style: { padding: 0, color: '#ff8080' } }, `Atenção: ${missing.length} mídia(s) ausente(s) não aparecerão no resultado.`) : null,
      progress,
      label,
    ],
    footer: [cancelBtn, startBtn],
  });

  cancelBtn.addEventListener('click', () => {
    if (running) running.canceled = true;
    else m.close();
  });

  startBtn.addEventListener('click', async () => {
    const format = formats.querySelector('input:checked').value;
    const baseName = (name.value || 'video').replace(/[\\/:*?"<>|]/g, '_');
    // no desktop o arquivo é escolhido antes e gravado aos poucos: o vídeo não fica inteiro na memória
    let writer = null;
    let savedPath = null;
    if (canStreamToDisk) {
      const ext = await exportExtension(state.project, format);
      savedPath = await pickSavePath(`${baseName}.${ext}`, [{ name: ext.toUpperCase(), extensions: [ext] }]);
      if (!savedPath) return;
      try {
        writer = await openFileWriter(savedPath);
      } catch (err) {
        label.textContent = 'Erro: ' + (err.message || err);
        return;
      }
    }
    running = { canceled: false };
    startBtn.disabled = true;
    cancelBtn.textContent = 'Cancelar';
    progress.style.display = '';
    const t0 = performance.now();
    try {
      const result = await exportProject(state.project, {
        format,
        quality: quality.value,
        signal: running,
        writer,
        hardware: true,
        fast: getPref('fastExport'),
        onProgress: (f, text) => {
          bar.style.width = (f * 100).toFixed(1) + '%';
          const elapsed = (performance.now() - t0) / 1000;
          const eta = f > 0.05 ? Math.max(0, elapsed / f - elapsed) : null;
          label.textContent = `${text} · ${(f * 100).toFixed(0)}%${eta != null ? ` · faltam ~${formatDuration(eta)}` : ''}`;
        },
      });
      label.textContent = 'Salvando arquivo…';
      let saved = savedPath;
      if (writer) {
        await writer.close();
        writer = null;
      } else {
        const filename = `${baseName}.${result.extension}`;
        const filters = [{ name: result.extension.toUpperCase(), extensions: [result.extension] }];
        saved = await saveFile(filename, result.data, filters);
      }
      running = null;
      if (saved) {
        m.close();
        toast(`Exportado: ${saved}${result.note ? ' — ' + result.note : ''}`);
      } else {
        label.textContent = 'Salvamento cancelado.';
        startBtn.disabled = false;
        cancelBtn.textContent = 'Fechar';
      }
    } catch (err) {
      running = null;
      // apaga o arquivo incompleto
      await writer?.abort().catch(() => {});
      startBtn.disabled = false;
      cancelBtn.textContent = 'Fechar';
      if (err instanceof ExportCanceled) {
        label.textContent = 'Exportação cancelada.';
      } else {
        console.error(err);
        label.textContent = 'Erro: ' + (err.message || err);
      }
    }
  });
}

// ---------------------------------------------------------------- mídias ausentes
export function openMissingMedia(list) {
  const items = h('div.missing-list');
  const renderItems = () => {
    items.replaceChildren(...list.map((media) => {
      const ok = !isMissing(media.id);
      return h(`div.item${ok ? '.ok' : ''}`, {},
        h('span.n', { title: media.path || media.name }, media.name),
        ok ? h('span', {}, '✓') : h('button', { on: { click: async () => { if (await relinkOne(media)) renderItems(); } } }, 'Localizar…'));
    }));
  };
  renderItems();
  const m = openModal({
    title: 'Arquivos de mídia não encontrados',
    body: [
      h('div.insp-note', { style: { padding: 0 } }, 'Estes arquivos não foram encontrados no caminho salvo. Localize cada um para reconectá-los ao projeto.'),
      items,
    ],
    footer: [h('button.primary', { on: { click: () => m.close() } }, 'Continuar')],
  });
}
