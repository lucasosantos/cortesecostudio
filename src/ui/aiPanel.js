// Tela "IA": liga/desliga a conexão com o Claude (servidor MCP), mostra como configurar e o que a IA fez.
import { aiBridge, isDesktop } from '../platform/index.js';
import { onAiAction } from '../mcp/tools.js';
import { h, openModal, toast } from './util.js';

const LABELS = {
  add_clip: 'adicionou um clipe', update_clip: 'alterou um clipe', split_clip: 'dividiu um clipe', delete_clips: 'apagou clipes',
  set_effects: 'mudou os efeitos', set_masks: 'mudou as máscaras', add_track: 'criou uma track', update_track: 'alterou uma track',
  delete_track: 'apagou uma track', set_project_settings: 'mudou as configurações', create_composition: 'criou uma composição',
  add_layer: 'adicionou uma camada', update_layer: 'alterou uma camada', delete_layers: 'apagou camadas', import_svg: 'importou um SVG',
  install_extension: 'instalou uma extensão',
};

let status = { enabled: false };
const history = [];
let button = null;

export function initAiPanel() {
  button = document.querySelector('[data-action="ai"]');
  onAiAction((label) => {
    history.unshift({ label: LABELS[label] || label, at: new Date() });
    history.length = Math.min(history.length, 12);
    toast(`IA ${LABELS[label] || label} · Ctrl+Z desfaz`);
  });
  syncButton();
}

function syncButton() {
  if (!button) return;
  button.classList.toggle('active', !!status.enabled);
  button.title = status.enabled ? 'Conexão de IA ligada: o Claude pode ler e editar este projeto' : 'Conectar o Claude (ou outra IA via MCP) a este editor';
}

const quote = (s) => (/[\s"']/.test(s) ? `"${s.replace(/"/g, '\\"')}"` : s);

function configs(st) {
  const desktop = JSON.stringify({ mcpServers: { 'corteseco-studio': { command: st.command, args: st.args, env: st.env } } }, null, 2);
  const code = `claude mcp add corteseco-studio --env ELECTRON_RUN_AS_NODE=1 -- ${quote(st.command)} ${st.args.map(quote).join(' ')}`;
  return { desktop, code };
}

function copyBlock(title, text) {
  return h('div.field', {},
    h('span', {}, title),
    h('div.ai-copy', {},
      h('pre', {}, text),
      h('button', {
        on: {
          click: async () => {
            try {
              await navigator.clipboard.writeText(text);
              toast('Copiado');
            } catch {
              toast('Não foi possível copiar; selecione o texto e copie manualmente', 'error');
            }
          },
        },
      }, 'Copiar'),
    ));
}

export async function openAiPanel() {
  if (!isDesktop || !aiBridge) {
    openModal({
      title: 'Conexão com IA',
      body: [h('div.insp-note', { style: { padding: 0 } },
        'A conexão com o Claude (servidor MCP) só funciona no aplicativo desktop: ela abre uma porta local no seu computador, o que o navegador não permite.')],
      footer: [h('button', { on: { click: (e) => e.target.closest('.modal-backdrop').remove() } }, 'Fechar')],
    });
    return;
  }
  try {
    status = await aiBridge.status();
  } catch (err) {
    toast(`Não foi possível consultar a conexão de IA: ${err.message}`, 'error');
    return;
  }
  const body = h('div.ai-panel');
  const render = () => {
    const { desktop, code } = configs(status);
    const toggle = h('input', {
      type: 'checkbox', checked: status.enabled,
      on: {
        change: async (e) => {
          e.target.disabled = true;
          try {
            status = await aiBridge.setEnabled(e.target.checked);
            toast(status.enabled ? 'Conexão de IA ligada' : 'Conexão de IA desligada');
          } catch (err) {
            toast(`Não foi possível ${e.target.checked ? 'ligar' : 'desligar'} a conexão: ${err.message}`, 'error');
          }
          syncButton();
          render();
        },
      },
    });
    body.replaceChildren(...[
      h('label.ai-toggle', {}, toggle, h('div', {},
        h('b', {}, 'Permitir conexão de IA'),
        h('div.insp-note', { style: { padding: 0 } }, status.enabled
          ? `Ligada (porta local ${status.port}). O Claude pode ler o projeto, editar a timeline, os efeitos e as composições, importar arquivos, salvar e exportar.`
          : 'Desligada. Nenhum programa consegue controlar o editor.'))),
      h('div.insp-note', { style: { padding: 0 } },
        'Só programas deste computador conseguem se conectar, e a senha da conexão muda cada vez que ela é ligada. Cada alteração feita pela IA aparece na hora e pode ser desfeita com Ctrl+Z.'),
      h('h4', {}, 'Configurar o Claude (uma vez só)'),
      copyBlock('Claude Code: rode no terminal', code),
      copyBlock('Claude Desktop: acrescente em claude_desktop_config.json (Configurações → Desenvolvedor → Editar configuração) e reinicie o Claude', desktop),
      h('div.insp-note', { style: { padding: 0 } },
        'Depois é só pedir em linguagem natural, por exemplo: "monte um vídeo com os arquivos da pasta ~/Vídeos/viagem, com título animado e trilha" ou "tire o fundo verde do segundo clipe".'),
      history.length ? h('h4', {}, 'O que a IA fez nesta sessão') : null,
      history.length ? h('ul.ai-history', {}, ...history.map((x) => h('li', {}, `${x.at.toLocaleTimeString()} · ${x.label}`))) : null,
    ].filter(Boolean)); // replaceChildren escreveria "null" no lugar dos itens ausentes
  };
  render();
  const m = openModal({ title: 'Conexão com IA (Claude via MCP)', body, footer: [h('button', { on: { click: () => m.close() } }, 'Fechar')] });
  m.el.classList.add('wide', 'ai-modal');
}
