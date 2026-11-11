// Arquivos de mídia no processo principal:
// - protocolo media:// (a página toca e lê os vídeos direto do disco, aos pedaços, sem carregá-los na memória);
// - gravação de arquivos por posição (exportação e proxies gravados aos poucos);
// - pasta de arquivos proxy (cópias leves dos vídeos, usadas só no preview).
const { protocol, ipcMain, dialog, BrowserWindow, app } = require('electron');
const path = require('node:path');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const crypto = require('node:crypto');
const { Readable } = require('node:stream');

const MIME = {
  mp4: 'video/mp4', m4v: 'video/mp4', mov: 'video/quicktime', webm: 'video/webm', mkv: 'video/x-matroska', avi: 'video/x-msvideo', ogv: 'video/ogg',
  mp3: 'audio/mpeg', wav: 'audio/wav', ogg: 'audio/ogg', oga: 'audio/ogg', m4a: 'audio/mp4', aac: 'audio/aac', flac: 'audio/flac', opus: 'audio/ogg', weba: 'audio/webm',
  png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', webp: 'image/webp', gif: 'image/gif', bmp: 'image/bmp', svg: 'image/svg+xml',
};
const extOf = (p) => path.extname(p).slice(1).toLowerCase();

// só os arquivos que o app pediu para abrir são servidos
const allowed = new Set();
const urlFor = (filePath) => `media://local/${encodeURIComponent(filePath)}`;

/** Precisa rodar antes de o app ficar pronto. */
function registerScheme() {
  protocol.registerSchemesAsPrivileged([
    { scheme: 'media', privileges: { standard: true, secure: true, supportFetchAPI: true, corsEnabled: true, stream: true } },
  ]);
}

/** Interpreta "bytes=a-b" para um arquivo de `size` bytes. @returns { start, end } | null (sem faixa) | false (inválida) */
function parseRange(header, size) {
  if (!header) return null;
  const m = /^bytes=(\d*)-(\d*)$/.exec(String(header).trim());
  if (!m || (m[1] === '' && m[2] === '')) return false;
  let start;
  let end;
  if (m[1] === '') {
    // sufixo: os últimos N bytes
    start = Math.max(0, size - Number(m[2]));
    end = size - 1;
  } else {
    start = Number(m[1]);
    end = m[2] === '' ? size - 1 : Math.min(Number(m[2]), size - 1);
  }
  if (!(start <= end) || start >= size) return false;
  return { start, end };
}

async function serve(request) {
  const cors = { 'Access-Control-Allow-Origin': '*' };
  let filePath;
  try {
    filePath = decodeURIComponent(new URL(request.url).pathname.slice(1));
  } catch {
    return new Response('bad request', { status: 400, headers: cors });
  }
  if (!allowed.has(filePath)) return new Response('forbidden', { status: 403, headers: cors });
  let stat;
  try {
    stat = await fsp.stat(filePath);
  } catch {
    return new Response('not found', { status: 404, headers: cors });
  }
  const headers = { ...cors, 'Content-Type': MIME[extOf(filePath)] || 'application/octet-stream', 'Accept-Ranges': 'bytes', 'Cache-Control': 'no-store' };
  const range = parseRange(request.headers.get('range'), stat.size);
  if (range === false) return new Response(null, { status: 416, headers: { ...headers, 'Content-Range': `bytes */${stat.size}` } });
  const start = range ? range.start : 0;
  const end = range ? range.end : stat.size - 1;
  headers['Content-Length'] = String(Math.max(0, end - start + 1));
  if (range) headers['Content-Range'] = `bytes ${start}-${end}/${stat.size}`;
  if (request.method === 'HEAD' || stat.size === 0) return new Response(null, { status: range ? 206 : 200, headers });
  const body = Readable.toWeb(fs.createReadStream(filePath, { start, end }));
  return new Response(body, { status: range ? 206 : 200, headers });
}

// ---------------------------------------------------------------- gravação por posição
const streams = new Map(); // id → { handle, filePath }

async function abortStream(id) {
  const s = streams.get(id);
  if (!s) return;
  streams.delete(id);
  await s.handle.close().catch(() => {});
  await fsp.unlink(s.filePath).catch(() => {});
}

/** Fecha e apaga tudo o que ficou aberto (janela fechada no meio de uma exportação). */
async function abortAllStreams() {
  for (const id of [...streams.keys()]) await abortStream(id);
}

// ---------------------------------------------------------------- proxies
const proxyDir = () => path.join(app.getPath('userData'), 'proxies');
const proxyFile = (key) => path.join(proxyDir(), `${key}.mp4`);
const validKey = (key) => typeof key === 'string' && /^[a-f0-9]{40}$/.test(key);

async function listProxies() {
  let names = [];
  try {
    names = await fsp.readdir(proxyDir());
  } catch {
    return [];
  }
  const out = [];
  for (const name of names) {
    const file = path.join(proxyDir(), name);
    try {
      const st = await fsp.stat(file);
      if (st.isFile()) out.push({ file, size: st.size, used: st.mtimeMs, part: name.endsWith('.part') });
    } catch {
      /* apagado nesse meio tempo */
    }
  }
  return out;
}

/** Apaga os proxies usados há mais tempo até caber no limite (e restos de conversões interrompidas). */
async function trimProxies(limitBytes, keep = null) {
  const open = new Set([...streams.values()].map((s) => s.filePath));
  const files = (await listProxies()).filter((f) => !open.has(f.file));
  for (const f of files.filter((x) => x.part)) await fsp.unlink(f.file).catch(() => {});
  const done = files.filter((x) => !x.part).sort((a, b) => b.used - a.used);
  let total = 0;
  for (const f of done) {
    total += f.size;
    if (total > limitBytes && f.file !== keep) {
      allowed.delete(f.file);
      await fsp.unlink(f.file).catch(() => {});
    }
  }
}

/**
 * @param getConfig () => configuração atual (para o limite de espaço dos proxies)
 */
function registerMedia(getConfig) {
  protocol.handle('media', serve);

  ipcMain.handle('media:url', async (_event, filePath) => {
    if (typeof filePath !== 'string' || !path.isAbsolute(filePath) || !MIME[extOf(filePath)]) return null;
    try {
      if (!(await fsp.stat(filePath)).isFile()) return null;
    } catch {
      return null;
    }
    allowed.add(filePath);
    return urlFor(filePath);
  });

  ipcMain.handle('file:pickSave', async (event, { defaultName, filters }) => {
    const win = BrowserWindow.fromWebContents(event.sender);
    const { canceled, filePath } = await dialog.showSaveDialog(win, { defaultPath: defaultName, filters });
    return canceled || !filePath ? null : filePath;
  });

  ipcMain.handle('stream:open', async (_event, filePath) => {
    if (typeof filePath !== 'string' || !path.isAbsolute(filePath)) throw new Error('O caminho precisa ser absoluto.');
    await fsp.mkdir(path.dirname(filePath), { recursive: true });
    const handle = await fsp.open(filePath, 'w');
    const id = crypto.randomUUID();
    streams.set(id, { handle, filePath });
    return id;
  });
  ipcMain.handle('stream:write', async (_event, { id, data, position }) => {
    const s = streams.get(id);
    if (!s) throw new Error('Arquivo de saída fechado.');
    const buf = Buffer.from(data.buffer, data.byteOffset, data.byteLength);
    await s.handle.write(buf, 0, buf.length, position);
  });
  ipcMain.handle('stream:close', async (_event, id) => {
    const s = streams.get(id);
    if (!s) return;
    streams.delete(id);
    await s.handle.close();
  });
  ipcMain.handle('stream:abort', (_event, id) => abortStream(id));

  // proxy de um vídeo: a chave muda se o arquivo original ou a altura pedida mudarem
  ipcMain.handle('proxy:locate', async (_event, { source, height }) => {
    if (typeof source !== 'string' || !path.isAbsolute(source)) return null;
    let st;
    try {
      st = await fsp.stat(source);
    } catch {
      return null;
    }
    const key = crypto.createHash('sha1').update(`${source}|${st.size}|${Math.round(st.mtimeMs)}|${Number(height) || 0}`).digest('hex');
    const file = proxyFile(key);
    try {
      await fsp.access(file);
      // marca o uso, para a limpeza apagar primeiro os mais antigos
      const now = new Date();
      await fsp.utimes(file, now, now).catch(() => {});
      allowed.add(file);
      return { key, url: urlFor(file), partPath: null };
    } catch {
      await fsp.mkdir(proxyDir(), { recursive: true });
      return { key, url: null, partPath: `${file}.part` };
    }
  });
  ipcMain.handle('proxy:commit', async (_event, key) => {
    if (!validKey(key)) return null;
    const file = proxyFile(key);
    await fsp.rename(`${file}.part`, file);
    allowed.add(file);
    await trimProxies((getConfig().proxyLimitMB || 2048) * 1024 * 1024, file);
    return urlFor(file);
  });
  ipcMain.handle('proxy:stats', async () => {
    const files = (await listProxies()).filter((f) => !f.part);
    return { files: files.length, bytes: files.reduce((n, f) => n + f.size, 0), dir: proxyDir() };
  });
  ipcMain.handle('proxy:clear', async () => {
    const open = new Set([...streams.values()].map((s) => s.filePath));
    for (const f of await listProxies()) {
      if (open.has(f.file)) continue;
      allowed.delete(f.file);
      await fsp.unlink(f.file).catch(() => {});
    }
    return true;
  });
}

module.exports = { registerScheme, registerMedia, abortAllStreams, parseRange };
