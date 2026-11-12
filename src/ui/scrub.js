// Arrastar para ajustar: nos campos numéricos dos inspectors, clicar e arrastar para os lados muda o valor.
// Um clique sem arrastar continua entrando no campo para digitar.
//   Shift = 10× mais rápido · Ctrl/Alt = 10× mais fino
// O campo recebe focus/input/blur como numa edição digitada, então o desfazer agrupa o arrasto inteiro num passo.

const CONTAINERS = '#inspector, #motion-inspector';
const THRESHOLD = 3; // pixels antes de virar arrasto (abaixo disso é um clique)

function decimals(step) {
  const s = String(step);
  if (s.includes('e-')) return Number(s.split('e-')[1]);
  return s.includes('.') ? s.split('.')[1].length : 0;
}

function stepOf(input) {
  const s = Number(input.step);
  return input.step && input.step !== 'any' && s > 0 ? s : 1;
}

const scrubbable = (el) => el instanceof HTMLInputElement && el.type === 'number' && !el.disabled && !el.readOnly && !!el.closest(CONTAINERS);

export function initScrub() {
  document.addEventListener('pointerdown', onPointerDown, true);
}

function onPointerDown(e) {
  const input = e.target;
  if (e.button !== 0 || !scrubbable(input) || document.activeElement === input) return;
  // sem o padrão, o campo não ganha foco nem seleciona texto enquanto se decide se é clique ou arrasto
  e.preventDefault();
  let originX = e.clientX;
  const start = Number(input.value) || 0;
  const step = stepOf(input);
  const places = decimals(step);
  const min = input.min !== '' ? Number(input.min) : -Infinity;
  const max = input.max !== '' ? Number(input.max) : Infinity;
  let dragging = false;
  let travel = 0; // pixels percorridos (com pointer lock, somados pelo movementX)
  let locked = false;
  let last = 0; // travel no evento anterior
  let value = start; // acumulado sem arredondar: trocar Shift/Ctrl no meio não faz o valor pular

  const move = (ev) => {
    travel = locked ? travel + ev.movementX : ev.clientX - originX;
    if (!dragging) {
      if (Math.abs(travel) < THRESHOLD) return;
      dragging = true;
      // conta a partir daqui: o valor não pula os pixels do limiar
      originX = ev.clientX;
      travel = 0;
      last = 0;
      input.focus({ preventScroll: true }); // dispara o focus da edição (ponto de desfazer)
      document.body.classList.add('scrubbing');
      // o ponteiro some e não esbarra na borda da tela: dá para arrastar à vontade
      try { input.requestPointerLock?.()?.catch?.(() => {}); } catch { /* sem pointer lock: usa a posição do mouse */ }
    }
    const speed = ev.shiftKey ? 10 : ev.ctrlKey || ev.altKey || ev.metaKey ? 0.1 : 1;
    value = Math.min(max, Math.max(min, value + (travel - last) * step * speed));
    last = travel;
    const next = Number(value.toFixed(speed < 1 ? places + 1 : places));
    if (String(next) === input.value) return;
    input.value = String(next);
    input.dispatchEvent(new Event('input', { bubbles: true }));
  };

  const end = () => {
    window.removeEventListener('pointermove', move, true);
    window.removeEventListener('pointerup', end, true);
    window.removeEventListener('pointercancel', end, true);
    document.removeEventListener('pointerlockchange', lockChange);
    if (document.pointerLockElement === input) document.exitPointerLock?.();
    document.body.classList.remove('scrubbing');
    if (dragging) {
      input.dispatchEvent(new Event('change', { bubbles: true }));
      input.blur(); // fecha a edição (o próximo ajuste é outro passo de desfazer)
    } else {
      // foi um clique: entra no campo para digitar
      input.focus();
      input.select();
    }
  };
  const lockChange = () => {
    // ao entrar no pointer lock, a contagem passa a ser pelo movementX a partir do ponto atual
    locked = document.pointerLockElement === input;
  };

  document.addEventListener('pointerlockchange', lockChange);
  window.addEventListener('pointermove', move, true);
  window.addEventListener('pointerup', end, true);
  window.addEventListener('pointercancel', end, true);
}
