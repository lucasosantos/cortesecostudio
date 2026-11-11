const { contextBridge, ipcRenderer, webUtils } = require('electron');

contextBridge.exposeInMainWorld('native', {
  saveFile: (defaultName, data, filters) => ipcRenderer.invoke('file:save', { defaultName, data, filters }),
  openFile: (filters) => ipcRenderer.invoke('file:open', { filters }),
  readFile: (filePath) => ipcRenderer.invoke('file:read', filePath),
  getPathForFile: (file) => {
    try {
      return webUtils.getPathForFile(file) || null;
    } catch {
      return null;
    }
  },
});
