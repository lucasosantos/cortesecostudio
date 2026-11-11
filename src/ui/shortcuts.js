// Lista de atalhos do teclado (aberta com "?" ou pelo botão "Atalhos" do timeline).
import { h, openModal } from './util.js';

const isMac = typeof navigator !== 'undefined' && /Mac/.test(navigator.platform || '');
const CTRL = isMac ? '⌘' : 'Ctrl';

export const SHORTCUTS = [
  ['Ferramentas', [
    ['A', 'Seleção: arrastar, aparar e selecionar clipes'],
    ['B', 'Corte: clique num clipe para dividi-lo ali (Shift+clique corta todas as tracks)'],
    ['Esc', 'Volta para a Seleção / tira a seleção'],
  ]],
  ['Edição', [
    [`S  ·  ${CTRL}+B`, 'Dividir no playhead'],
    ['Q', 'Apagar a parte do clipe antes do playhead'],
    ['W', 'Apagar a parte do clipe depois do playhead'],
    ['Delete  ·  Backspace', 'Excluir o clipe selecionado'],
    ['Shift+Delete', 'Excluir e fechar o buraco'],
    [`${CTRL}+C  ·  ${CTRL}+X  ·  ${CTRL}+V`, 'Copiar, recortar e colar'],
    [`${CTRL}+D`, 'Duplicar o clipe'],
    ['T', 'Novo texto'],
    ['N', 'Ligar/desligar o ímã'],
    [`${CTRL}+Z  ·  ${CTRL}+Shift+Z`, 'Desfazer e refazer'],
  ]],
  ['Reprodução e navegação', [
    ['Espaço', 'Reproduzir / pausar'],
    ['← →', 'Um quadro para trás / para frente (com Shift: 1 segundo)'],
    ['↑ ↓', 'Corte anterior / próximo corte'],
    ['Home  ·  End', 'Início / fim do projeto'],
  ]],
  ['Timeline', [
    [`+ −  ·  ${CTRL}+=  ${CTRL}+−`, 'Aumentar / diminuir o zoom'],
    [`${CTRL}+roda do mouse`, 'Zoom no ponto do mouse'],
    ['Shift+Z', 'Ajustar o projeto à largura'],
    ['Alt+arrastar', 'Reordenar empurrando os outros clipes'],
  ]],
  ['Projeto', [
    [`${CTRL}+S`, 'Salvar'],
    [`${CTRL}+O`, 'Abrir'],
    [`${CTRL}+I`, 'Importar mídia'],
    [`${CTRL}+E`, 'Exportar'],
    ['?', 'Esta lista'],
  ]],
  ['Motion', [
    ['V  Y  H', 'Seleção, âncora e mão'],
    ['R  O  G  E  L', 'Retângulo, elipse, polígono, estrela e linha'],
    ['T  ·  P', 'Texto e caneta'],
    ['Setas', 'Mover a camada (com Shift: 10 px); sem camada, quadro a quadro'],
    [',  .', 'Quadro anterior / próximo'],
    ['0', 'Enquadrar o palco'],
    [`${CTRL}+A  ·  ${CTRL}+D`, 'Selecionar todas / duplicar'],
  ]],
];

export function openShortcuts() {
  if (document.querySelector('.shortcuts-modal')) return;
  const body = h('div.shortcuts', {}, ...SHORTCUTS.map(([title, list]) => h('section', {},
    h('h4', {}, title),
    ...list.map(([keys, what]) => h('div.shortcut', {}, h('kbd', {}, keys), h('span', {}, what))))));
  const m = openModal({ title: 'Atalhos do teclado', body, footer: [h('button', { on: { click: () => m.close() } }, 'Fechar')] });
  m.el.classList.add('wide', 'shortcuts-modal');
}
