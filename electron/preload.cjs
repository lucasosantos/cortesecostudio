const { contextBridge, ipcRenderer, webUtils } = require('electron');

contextBridge.exposeInMainWorld('native', {
  saveFile: (defaultName, data, filters) => ipcRenderer.invoke('file:save', { defaultName, data, filters }),
  openFile: (filters) => ipcRenderer.invoke('file:open', { filters }),
  readFile: (filePath) => ipcRenderer.invoke('file:read', filePath),
  writeFile: (filePath, data) => ipcRenderer.invoke('file:write', { path: filePath, data }),
  // mídia lida direto do disco (protocolo media://) e gravação de arquivos aos poucos
  mediaUrl: (filePath) => ipcRenderer.invoke('media:url', filePath),
  pickSave: (defaultName, filters) => ipcRenderer.invoke('file:pickSave', { defaultName, filters }),
  stream: {
    open: (filePath) => ipcRenderer.invoke('stream:open', filePath),
    write: (id, data, position) => ipcRenderer.invoke('stream:write', { id, data, position }),
    close: (id) => ipcRenderer.invoke('stream:close', id),
    abort: (id) => ipcRenderer.invoke('stream:abort', id),
  },
  proxy: {
    locate: (source, height) => ipcRenderer.invoke('proxy:locate', { source, height }),
    commit: (key) => ipcRenderer.invoke('proxy:commit', key),
    stats: () => ipcRenderer.invoke('proxy:stats'),
    clear: () => ipcRenderer.invoke('proxy:clear'),
  },
  // desempenho: configuração de partida (placa de vídeo) e diagnóstico
  config: {
    get: () => ipcRenderer.invoke('config:get'),
    set: (patch) => ipcRenderer.invoke('config:set', patch),
  },
  gpuStatus: () => ipcRenderer.invoke('gpu:status'),
  relaunch: () => ipcRenderer.invoke('app:relaunch'),
  mcp: {
    setEnabled: (on) => ipcRenderer.invoke('mcp:enable', !!on),
    status: () => ipcRenderer.invoke('mcp:status'),
    onCall: (fn) => ipcRenderer.on('mcp:call', (_event, msg) => fn(msg)),
    reply: (msg) => ipcRenderer.send('mcp:result', msg),
  },
  getPathForFile: (file) => {
    try {
      return webUtils.getPathForFile(file) || null;
    } catch {
      return null;
    }
  },
});
