// Configuração do app lida antes de a janela abrir (o que precisa valer desde a partida, como o uso da placa de vídeo).
const fs = require('node:fs');

const DEFAULTS = {
  gpu: true, // usar a placa de vídeo (aceleração por hardware)
  hwVideoDecode: false, // decodificar/codificar vídeo pela placa no Linux (VA-API; experimental)
  proxyLimitMB: 2048, // espaço máximo ocupado pelos arquivos proxy
};

/** Mantém só chaves conhecidas com valores válidos. */
function sanitize(raw) {
  const out = {};
  if (!raw || typeof raw !== 'object') return out;
  if (typeof raw.gpu === 'boolean') out.gpu = raw.gpu;
  if (typeof raw.hwVideoDecode === 'boolean') out.hwVideoDecode = raw.hwVideoDecode;
  if (Number.isFinite(raw.proxyLimitMB)) out.proxyLimitMB = Math.max(256, Math.min(51200, Math.round(raw.proxyLimitMB)));
  return out;
}

function readConfig(file) {
  try {
    return { ...DEFAULTS, ...sanitize(JSON.parse(fs.readFileSync(file, 'utf8'))) };
  } catch {
    // sem arquivo ou arquivo corrompido: vale o padrão
    return { ...DEFAULTS };
  }
}

function writeConfig(file, patch) {
  const next = { ...readConfig(file), ...sanitize(patch) };
  fs.writeFileSync(file, JSON.stringify(next, null, 2));
  return next;
}

module.exports = { DEFAULTS, sanitize, readConfig, writeConfig };
