// Recebe as chamadas da IA (vindas do processo principal do Electron) e executa as ferramentas, uma de cada vez.
import { aiBridge } from '../platform/index.js';
import { callTool } from './tools.js';

let queue = Promise.resolve();

export function initAiBridge() {
  if (!aiBridge) return;
  aiBridge.onCall(({ id, name, args }) => {
    // em fila: duas edições nunca se misturam, e cada uma vira um passo de desfazer
    queue = queue.then(async () => {
      try {
        aiBridge.reply({ id, ok: true, result: await callTool(name, args) });
      } catch (err) {
        if (!err?.constructor || err.constructor.name !== 'ToolError') console.error('Ferramenta de IA falhou:', name, err);
        aiBridge.reply({ id, ok: false, error: String(err?.message || err) });
      }
    });
  });
}
