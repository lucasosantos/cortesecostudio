// Ponte local entre o servidor MCP (iniciado pelo Claude) e o app aberto.
// Só aceita conexões do próprio computador (127.0.0.1), com uma senha gerada a cada vez que é ligada.
// Porta e senha ficam num arquivo que só o usuário lê; o servidor MCP lê esse arquivo a cada chamada.
const http = require('node:http');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');

const MAX_BODY = 20 * 1024 * 1024;

/** Pasta dos arquivos da conexão de IA (pode ser trocada por variável de ambiente, para testes). */
const bridgeDir = () => process.env.CORTESECO_MCP_DIR || path.join(os.homedir(), '.corteseco-studio');
const bridgeFile = () => path.join(bridgeDir(), 'bridge.json');

function sameSecret(a, b) {
  const x = Buffer.from(String(a));
  const y = Buffer.from(String(b));
  return x.length === y.length && crypto.timingSafeEqual(x, y);
}

/**
 * Liga a ponte.
 * @param dispatch async (nomeDaFerramenta, argumentos) => resultado
 * @returns { port, stop() }
 */
async function startBridge({ dispatch }) {
  const token = crypto.randomBytes(32).toString('hex');
  const server = http.createServer((req, res) => {
    const send = (code, body) => {
      res.writeHead(code, { 'content-type': 'application/json', 'cache-control': 'no-store' });
      res.end(JSON.stringify(body));
    };
    // páginas da web não podem usar a ponte, nem por DNS apontando para 127.0.0.1
    if (req.headers.origin) return send(403, { ok: false, error: 'forbidden' });
    if (!/^(127\.0\.0\.1|localhost):\d+$/.test(String(req.headers.host || ''))) return send(403, { ok: false, error: 'forbidden' });
    if (req.method !== 'POST' || req.url !== '/call') return send(404, { ok: false, error: 'not found' });
    if (!sameSecret(req.headers.authorization || '', `Bearer ${token}`)) return send(401, { ok: false, error: 'unauthorized' });

    let size = 0;
    const chunks = [];
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > MAX_BODY) {
        send(413, { ok: false, error: 'request too large' });
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', async () => {
      if (res.writableEnded) return;
      let msg;
      try {
        msg = JSON.parse(Buffer.concat(chunks).toString('utf8'));
      } catch {
        return send(400, { ok: false, error: 'invalid JSON' });
      }
      if (!msg || typeof msg.name !== 'string') return send(400, { ok: false, error: 'missing tool name' });
      try {
        send(200, { ok: true, result: await dispatch(msg.name, msg.arguments ?? {}) });
      } catch (err) {
        send(200, { ok: false, error: String(err?.message || err) });
      }
    });
  });
  // exportar um vídeo longo pode demorar bem mais que o limite padrão
  server.requestTimeout = 0;
  server.timeout = 0;
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const { port } = server.address();

  fs.mkdirSync(bridgeDir(), { recursive: true, mode: 0o700 });
  const file = bridgeFile();
  fs.writeFileSync(file, JSON.stringify({ port, token, pid: process.pid }), { mode: 0o600 });
  fs.chmodSync(file, 0o600);

  return {
    port,
    stop() {
      server.close();
      server.closeAllConnections?.();
      // só apaga o arquivo se ele ainda for desta ponte (outro app aberto pode ter ligado a dele)
      try {
        const current = JSON.parse(fs.readFileSync(file, 'utf8'));
        if (current.token === token) fs.unlinkSync(file);
      } catch {
        /* já não existe */
      }
    },
  };
}

/**
 * Copia o servidor MCP para a pasta da conexão de IA, fora do pacote do app
 * (o caminho do AppImage montado muda a cada execução). Retorna o caminho do server.mjs.
 */
function installServerFiles(sourceDir) {
  const target = path.join(bridgeDir(), 'mcp');
  fs.mkdirSync(target, { recursive: true, mode: 0o700 });
  for (const name of ['server.mjs', 'tools.json']) fs.writeFileSync(path.join(target, name), fs.readFileSync(path.join(sourceDir, name)));
  return path.join(target, 'server.mjs');
}

module.exports = { startBridge, installServerFiles, bridgeDir, bridgeFile };
