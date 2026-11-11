// Servidor MCP (stdio) + ponte local, com um "app" simulado no lugar do editor.
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';

const require = createRequire(import.meta.url);
const root = path.resolve(import.meta.dirname, '..');
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'corteseco-mcp-'));
process.env.CORTESECO_MCP_DIR = dir;
const { startBridge, installServerFiles, bridgeFile } = require('../electron/aiBridge.cjs');
const spec = JSON.parse(fs.readFileSync(path.join(root, 'mcp/tools.json'), 'utf8'));

/** Inicia o servidor MCP e devolve uma função para mandar pedidos JSON-RPC. */
function startServer(serverPath = path.join(root, 'mcp/server.mjs')) {
  const proc = spawn(process.execPath, [serverPath], { env: { ...process.env, CORTESECO_MCP_DIR: dir }, stdio: ['pipe', 'pipe', 'pipe'] });
  const waiting = new Map();
  let buf = '';
  proc.stdout.on('data', (d) => {
    buf += d;
    let nl;
    while ((nl = buf.indexOf('\n')) >= 0) {
      const msg = JSON.parse(buf.slice(0, nl));
      buf = buf.slice(nl + 1);
      waiting.get(msg.id)?.(msg);
      waiting.delete(msg.id);
    }
  });
  let seq = 0;
  const request = (method, params) => new Promise((resolve) => {
    const id = ++seq;
    waiting.set(id, resolve);
    proc.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`);
  });
  const notify = (method) => proc.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', method })}\n`);
  return { request, notify, stop: () => proc.kill() };
}

const calls = [];
async function dispatch(name, args) {
  calls.push([name, args]);
  if (name === 'get_frame') return { image: 'aGVsbG8=', mimeType: 'image/jpeg', width: 2, height: 1, time: 1.5 };
  if (name === 'delete_track') throw new Error('No track with id "x".');
  return { echo: name, args };
}

let server;
let bridge;
beforeAll(() => { server = startServer(); });
afterAll(() => {
  server?.stop();
  bridge?.stop();
  fs.rmSync(dir, { recursive: true, force: true });
});

describe('servidor MCP', () => {
  it('negocia a versão do protocolo e informa as ferramentas', async () => {
    const init = await server.request('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'teste', version: '1' } });
    expect(init.result.protocolVersion).toBe('2025-06-18');
    expect(init.result.capabilities.tools).toBeDefined();
    expect(init.result.instructions).toMatch(/get_project/);
    const other = await server.request('initialize', { protocolVersion: '1999-01-01' });
    expect(other.result.protocolVersion).toBe('2025-11-25');
    server.notify('notifications/initialized');
    const list = await server.request('tools/list', {});
    expect(list.result.tools.map((t) => t.name)).toEqual(spec.tools.map((t) => t.name));
    for (const t of list.result.tools) expect(t.inputSchema.type).toBe('object');
    expect((await server.request('ping')).result).toEqual({});
    expect((await server.request('nao/existe')).error.code).toBe(-32601);
  });

  it('com o app fechado, explica como ligar a conexão', async () => {
    const r = await server.request('tools/call', { name: 'get_project', arguments: {} });
    expect(r.result.isError).toBe(true);
    expect(r.result.content[0].text).toMatch(/Permitir conexão de IA/);
    expect((await server.request('tools/call', { name: 'apagar_tudo', arguments: {} })).error.code).toBe(-32602);
  });

  it('repassa a chamada ao app, devolve imagens como imagem e erros como erro', async () => {
    bridge = await startBridge({ dispatch });
    const ok = await server.request('tools/call', { name: 'add_track', arguments: { kind: 'audio' } });
    expect(ok.result.isError).toBeUndefined();
    expect(JSON.parse(ok.result.content[0].text)).toEqual({ echo: 'add_track', args: { kind: 'audio' } });
    expect(calls.at(-1)).toEqual(['add_track', { kind: 'audio' }]);

    const img = await server.request('tools/call', { name: 'get_frame', arguments: { time: 1.5 } });
    expect(img.result.content[0]).toEqual({ type: 'image', data: 'aGVsbG8=', mimeType: 'image/jpeg' });
    expect(JSON.parse(img.result.content[1].text)).toEqual({ width: 2, height: 1, time: 1.5 });

    const bad = await server.request('tools/call', { name: 'delete_track', arguments: { trackId: 'x' } });
    expect(bad.result.isError).toBe(true);
    expect(bad.result.content[0].text).toBe('No track with id "x".');
  });

  it('a ponte só aceita quem tem a senha, do próprio computador, fora do navegador', async () => {
    const { port, token } = JSON.parse(fs.readFileSync(bridgeFile(), 'utf8'));
    if (process.platform !== 'win32') expect(fs.statSync(bridgeFile()).mode & 0o077).toBe(0);
    const post = (headers, body = '{"name":"get_project","arguments":{}}') => new Promise((resolve) => {
      const req = http.request({ host: '127.0.0.1', port, path: '/call', method: 'POST', headers: { 'content-type': 'application/json', ...headers } }, (res) => {
        res.resume();
        res.on('end', () => resolve(res.statusCode));
      });
      req.end(body);
    });
    const before = calls.length;
    expect(await post({})).toBe(401);
    expect(await post({ authorization: 'Bearer errado' })).toBe(401);
    expect(await post({ authorization: `Bearer ${token}`, origin: 'https://site-malicioso.example' })).toBe(403);
    expect(await post({ authorization: `Bearer ${token}`, host: 'malicioso.example:80' })).toBe(403);
    expect(await post({ authorization: `Bearer ${token}` }, 'não é json')).toBe(400);
    expect(calls.length).toBe(before);
    expect(await post({ authorization: `Bearer ${token}` })).toBe(200);
    expect(calls.length).toBe(before + 1);
  });

  it('desligar apaga o arquivo da ponte e as chamadas voltam a pedir para ligar', async () => {
    bridge.stop();
    bridge = null;
    expect(fs.existsSync(bridgeFile())).toBe(false);
    const r = await server.request('tools/call', { name: 'get_project', arguments: {} });
    expect(r.result.isError).toBe(true);
    expect(r.result.content[0].text).toMatch(/not open/);
  });

  it('a cópia instalada fora do pacote funciona sozinha', async () => {
    const copied = installServerFiles(path.join(root, 'mcp'));
    expect(copied).toBe(path.join(dir, 'mcp', 'server.mjs'));
    const s2 = startServer(copied);
    try {
      const list = await s2.request('tools/list', {});
      expect(list.result.tools).toHaveLength(spec.tools.length);
    } finally {
      s2.stop();
    }
  });
});

describe('definições das ferramentas', () => {
  it('cada ferramenta do JSON tem implementação e vice-versa', async () => {
    const src = fs.readFileSync(path.join(root, 'src/mcp/tools.js'), 'utf8');
    const body = src.slice(src.indexOf('export const TOOLS = {'));
    const implemented = [...body.matchAll(/^ {2}(?:async )?([a-z_]+)\(/gm)].map((m) => m[1]);
    expect(implemented.sort()).toEqual(spec.tools.map((t) => t.name).sort());
  });
});
