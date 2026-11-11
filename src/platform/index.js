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
