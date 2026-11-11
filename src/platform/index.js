// Camada de plataforma: único ponto que sabe se estamos no Electron ou no navegador.
const native = typeof window !== 'undefined' ? window.native : undefined;

export const isDesktop = !!native;

/** Salva bytes em disco. Retorna o caminho (desktop), o nome (web) ou null se cancelado. */
export async function saveFile(defaultName, data, filters = []) {
  const bytes = data instanceof Blob ? new Uint8Array(await data.arrayBuffer()) : new Uint8Array(data);
  if (native) return native.saveFile(defaultName, bytes, filters);

  const blob = new Blob([bytes]);
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = defaultName;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
  return defaultName;
}

/** Abre um arquivo. Retorna { name, path, data: Uint8Array } ou null. */
export async function openFile(filters = []) {
  if (native) {
    const res = await native.openFile(filters);
    if (!res) return null;
    return { name: res.name, path: res.path, data: new Uint8Array(res.data) };
  }
  const accept = filters.flatMap((f) => f.extensions.map((e) => '.' + e)).join(',');
  const [file] = await pickFiles({ accept });
  if (!file) return null;
  return { name: file.name, path: null, data: new Uint8Array(await file.arrayBuffer()) };
}

/** Lê um arquivo pelo caminho absoluto (somente desktop). */
export async function readFileByPath(filePath) {
  if (!native || !filePath) return null;
  const data = await native.readFile(filePath);
  return data ? new Uint8Array(data) : null;
}

/**
 * URL do protocolo media:// para um arquivo do disco (somente desktop): o vídeo toca e é lido
 * direto do disco, aos pedaços, sem carregar o arquivo inteiro na memória. Null se não disponível.
 */
export async function mediaUrlFor(filePath) {
  if (!native?.mediaUrl || !filePath) return null;
  try {
    return (await native.mediaUrl(filePath)) || null;
  } catch {
    return null;
  }
}

/** O app consegue gravar um arquivo aos poucos (exportação sem montar o vídeo inteiro na memória)? */
export const canStreamToDisk = !!native?.stream;

/** Diálogo "salvar como" que só devolve o caminho escolhido (ou null). */
export async function pickSavePath(defaultName, filters = []) {
  return native?.pickSave ? native.pickSave(defaultName, filters) : null;
}

/** Abre um arquivo para gravação por posição. @returns { write(bytes, posição), close(), abort() } */
export async function openFileWriter(filePath) {
  if (!native?.stream) throw new Error('Gravar aos poucos só funciona no app desktop.');
  const id = await native.stream.open(filePath);
  return {
    write: (data, position) => native.stream.write(id, data, position),
    close: () => native.stream.close(id),
    // cancelado ou com erro: fecha e apaga o arquivo incompleto
    abort: () => native.stream.abort(id),
  };
}

// ---------------------------------------------------------------- desempenho (somente desktop)
/** Configuração de partida do app ({ gpu, hwVideoDecode, proxyLimitMB }) ou null no navegador. */
export const getAppConfig = async () => (native?.config ? native.config.get() : null);
/** Grava a configuração; uso da placa de vídeo só passa a valer depois de reiniciar o app. */
export const setAppConfig = async (patch) => (native?.config ? native.config.set(patch) : null);
/** Estado da aceleração nesta execução: { enabled, hwVideoDecode, features, platform } ou null. */
export const gpuStatus = async () => (native?.gpuStatus ? native.gpuStatus() : null);
export const relaunchApp = () => native?.relaunch?.();

/** Arquivos proxy (cópias leves dos vídeos para o preview), guardados na pasta de dados do app. */
export const proxyStore = native?.proxy && native?.stream ? native.proxy : null;

/** Grava bytes num caminho absoluto, sem diálogo (somente desktop; usado pela conexão de IA). */
export async function writeFileAt(filePath, data) {
  if (!native) throw new Error('Gravar por caminho só funciona no app desktop.');
  return native.writeFile(filePath, data instanceof Uint8Array ? data : new Uint8Array(data));
}

/** Ponte com a IA (servidor MCP) exposta pelo processo principal do Electron, ou null no navegador. */
export const aiBridge = native?.mcp || null;

/** Caminho absoluto de um File (somente desktop). */
export function pathForFile(file) {
  return native ? native.getPathForFile(file) : null;
}

/** Abre o seletor de arquivos do sistema. */
export function pickFiles({ accept = '', multiple = false } = {}) {
  return new Promise((resolve) => {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = accept;
    input.multiple = multiple;
    input.addEventListener('change', () => resolve([...(input.files || [])]));
    input.addEventListener('cancel', () => resolve([]));
    input.click();
  });
}
