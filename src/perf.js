// Medidor de desempenho: contadores e tempos por nome.
// Desligado (o normal), cada chamada custa só um teste de booleano.
// Liga com ?perf na URL ou pela tela de Desempenho.
const MAX_SAMPLES = 600;
const stats = new Map();

export const perf = {
  on: typeof location !== 'undefined' && new URLSearchParams(location.search).has('perf'),
};

export function setPerf(on) {
  perf.on = !!on;
  stats.clear();
}

function entry(name) {
  let e = stats.get(name);
  if (!e) stats.set(name, (e = { n: 0, total: 0, max: 0, samples: [] }));
  return e;
}

/** Conta uma ocorrência (sem tempo). */
export function count(name, by = 1) {
  if (perf.on) entry(name).n += by;
}

/** Registra uma duração em milissegundos. */
export function addTime(name, ms) {
  if (!perf.on) return;
  const e = entry(name);
  e.n++;
  e.total += ms;
  if (ms > e.max) e.max = ms;
  if (e.samples.length >= MAX_SAMPLES) e.samples.shift();
  e.samples.push(ms);
}

/** Executa fn medindo o tempo sob `name`. */
export function timed(name, fn) {
  if (!perf.on) return fn();
  const t0 = performance.now();
  try {
    return fn();
  } finally {
    addTime(name, performance.now() - t0);
  }
}

/** Resumo: { nome: { n, avg, p95, max, total } } (tempos em ms). */
export function perfReport() {
  const out = {};
  const r = (v) => Math.round(v * 100) / 100;
  for (const [name, e] of stats) {
    const sorted = [...e.samples].sort((a, b) => a - b);
    const p95 = sorted.length ? sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * 0.95))] : 0;
    out[name] = { n: e.n, avg: r(e.samples.length ? e.total / e.n : 0), p95: r(p95), max: r(e.max), total: r(e.total) };
  }
  return out;
}

export function perfReset() {
  stats.clear();
}
