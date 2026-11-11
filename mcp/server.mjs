#!/usr/bin/env node
// Servidor MCP do CorteSeco Studio (transporte stdio, sem dependências).
// O Claude inicia este processo; cada chamada de ferramenta é repassada ao app aberto pela ponte local.
// Pode rodar com Node 18+ ou com o próprio executável do app (variável ELECTRON_RUN_AS_NODE=1).
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import http from 'node:http';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const spec = JSON.parse(fs.readFileSync(path.join(here, 'tools.json'), 'utf8'));
const toolNames = new Set(spec.tools.map((t) => t.name));
const DIR = process.env.CORTESECO_MCP_DIR || path.join(os.homedir(), '.corteseco-studio');
const SUPPORTED = ['2025-11-25', '2025-06-18', '2025-03-26', '2024-11-05'];
const NOT_CONNECTED = 'CorteSeco Studio is not open, or its AI connection is turned off. Ask the user to open the app, click the "IA" button in the top bar and turn on "Permitir conexão de IA", then try again.';

const log = (...args) => process.stderr.write(`[corteseco-mcp] ${args.join(' ')}\n`);
const write = (msg) => process.stdout.write(`${JSON.stringify(msg)}\n`);

function readBridge() {
  try {
    const info = JSON.parse(fs.readFileSync(path.join(DIR, 'bridge.json'), 'utf8'));
    return Number.isInteger(info.port) && typeof info.token === 'string' ? info : null;
  } catch {
    return null;
  }
}

/** Chama a ferramenta no app. @returns { ok, result } | { ok: false, error } */
function callApp(name, args) {
  const bridge = readBridge();
  if (!bridge) return Promise.resolve({ ok: false, error: NOT_CONNECTED });
  const body = JSON.stringify({ name, arguments: args });
  return new Promise((resolve) => {
    const req = http.request({
      host: '127.0.0.1', port: bridge.port, path: '/call', method: 'POST',
      headers: { 'content-type': 'application/json', 'content-length': Buffer.byteLength(body), authorization: `Bearer ${bridge.token}` },
    }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        if (res.statusCode === 401) return resolve({ ok: false, error: `${NOT_CONNECTED} (The connection key changed; it is renewed every time the connection is turned on.)` });
        try {
          resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')));
        } catch {
          resolve({ ok: false, error: `Unexpected reply from CorteSeco Studio (HTTP ${res.statusCode}).` });
        }
      });
    });
    // app fechado sem apagar o arquivo da ponte: conexão recusada
    req.on('error', () => resolve({ ok: false, error: NOT_CONNECTED }));
    req.end(body);
  });
}

/** Converte o resultado da ferramenta em conteúdo MCP (imagens viram blocos de imagem). */
function toContent(result) {
  if (result && typeof result === 'object' && typeof result.image === 'string') {
    const { image, mimeType, ...rest } = result;
    return [{ type: 'image', data: image, mimeType: mimeType || 'image/jpeg' }, { type: 'text', text: JSON.stringify(rest) }];
  }
  return [{ type: 'text', text: JSON.stringify(result ?? null, null, 2) }];
}

async function handle(msg) {
  const { id, method, params } = msg;
  const reply = (result) => id !== undefined && write({ jsonrpc: '2.0', id, result });
  const error = (code, message) => id !== undefined && write({ jsonrpc: '2.0', id, error: { code, message } });

  switch (method) {
    case 'initialize': {
      const asked = params?.protocolVersion;
      return reply({
        protocolVersion: SUPPORTED.includes(asked) ? asked : SUPPORTED[0],
        capabilities: { tools: { listChanged: false } },
        serverInfo: { name: 'corteseco-studio', title: 'CorteSeco Studio', version: '0.1.0' },
        instructions: spec.instructions,
      });
    }
    case 'ping':
      return reply({});
    case 'tools/list':
      return reply({ tools: spec.tools });
    case 'tools/call': {
      const name = params?.name;
      if (!toolNames.has(name)) return error(-32602, `Unknown tool: ${name}`);
      const res = await callApp(name, params.arguments ?? {});
      return reply(res.ok ? { content: toContent(res.result) } : { content: [{ type: 'text', text: res.error }], isError: true });
    }
    default:
      if (typeof method === 'string' && method.startsWith('notifications/')) return undefined;
      return error(-32601, `Method not found: ${method}`);
  }
}

let buffer = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk) => {
  buffer += chunk;
  let nl;
  while ((nl = buffer.indexOf('\n')) >= 0) {
    const line = buffer.slice(0, nl).trim();
    buffer = buffer.slice(nl + 1);
    if (!line) continue;
    let msg;
    try {
      msg = JSON.parse(line);
    } catch {
      write({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } });
      continue;
    }
    for (const m of Array.isArray(msg) ? msg : [msg]) {
      handle(m).catch((err) => {
        log('erro:', err?.stack || err);
        if (m?.id !== undefined) write({ jsonrpc: '2.0', id: m.id, error: { code: -32603, message: String(err?.message || err) } });
      });
    }
  }
});
process.stdin.on('end', () => process.exit(0));
