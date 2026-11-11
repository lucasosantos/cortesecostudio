const { app, BrowserWindow, ipcMain, dialog, Menu } = require('electron');
const path = require('node:path');
const fs = require('node:fs/promises');
const crypto = require('node:crypto');
const { startBridge, installServerFiles } = require('./aiBridge.cjs');
const { readConfig, writeConfig } = require('./config.cjs');
const { registerScheme, registerMedia, abortAllStreams } = require('./media.cjs');

// ---------------------------------------------------------------- configuração de partida
// O uso da placa de vídeo só pode ser decidido antes de o app ficar pronto: por isso fica num arquivo
// lido aqui, e trocar a opção pede para reiniciar.
const configFile = path.join(app.getPath('userData'), 'config.json');
let config = readConfig(configFile);
const gpuAtStart = config.gpu;
const hwVideoAtStart = config.gpu && config.hwVideoDecode && process.platform === 'linux';
if (!config.gpu) {
  app.disableHardwareAcceleration();
} else if (config.hwVideoDecode && process.platform === 'linux') {
  // decodificação e codificação de vídeo pela placa (VA-API); os nomes mudaram entre versões do Chromium
  app.commandLine.appendSwitch('enable-features', [
    'AcceleratedVideoDecodeLinuxGL', 'AcceleratedVideoDecodeLinuxZeroCopyGL', 'AcceleratedVideoEncoder',
    'VaapiVideoDecodeLinuxGL', 'VaapiVideoDecoder', 'VaapiVideoEncoder',
  ].join(','));
}
registerScheme();

let mainWindow = null;

function createWindow() {
  const win = new BrowserWindow({
    width: 1600,
    height: 950,
    minWidth: 1100,
    minHeight: 700,
    backgroundColor: '#16171b',
    title: 'CorteSeco Studio',
    icon: path.join(__dirname, '..', 'build', 'icon.png'),
    webPreferences: {
      preload: path.join(__dirname, 'preload.cjs'),
      contextIsolation: true,
      sandbox: true,
      // a IA pode pedir quadros com a janela minimizada: o desenho não pode parar
      backgroundThrottling: false,
    },
  });
  mainWindow = win;
  win.on('closed', () => {
    if (mainWindow === win) mainWindow = null;
    stopAi();
    // exportação ou proxy interrompidos: não deixa arquivo pela metade
    abortAllStreams();
  });
  Menu.setApplicationMenu(null);

  // a página bloqueia o fechamento quando há alterações não salvas
  win.webContents.on('will-prevent-unload', (event) => {
    const choice = dialog.showMessageBoxSync(win, {
      type: 'question',
      buttons: ['Sair sem salvar', 'Cancelar'],
      defaultId: 1,
      cancelId: 1,
      message: 'Há alterações não salvas no projeto. Sair mesmo assim?',
    });
    if (choice === 0) event.preventDefault();
  });

  const devUrl = process.env.VITE_DEV_SERVER_URL;
  if (devUrl) {
    win.loadURL(devUrl);
    win.webContents.on('before-input-event', (_e, input) => {
      if (input.type === 'keyDown' && input.key === 'F12') win.webContents.toggleDevTools();
    });
  } else {
    win.loadFile(path.join(__dirname, '..', 'dist', 'index.html'));
  }
}

ipcMain.handle('file:save', async (event, { defaultName, filters, data }) => {
  const win = BrowserWindow.fromWebContents(event.sender);
  const { canceled, filePath } = await dialog.showSaveDialog(win, { defaultPath: defaultName, filters });
  if (canceled || !filePath) return null;
  await fs.writeFile(filePath, Buffer.from(data));
  return filePath;
});

ipcMain.handle('file:open', async (event, { filters }) => {
  const win = BrowserWindow.fromWebContents(event.sender);
  const { canceled, filePaths } = await dialog.showOpenDialog(win, { properties: ['openFile'], filters });
  if (canceled || !filePaths.length) return null;
  const filePath = filePaths[0];
  const data = await fs.readFile(filePath);
  return { path: filePath, name: path.basename(filePath), data };
});

ipcMain.handle('file:read', async (_event, filePath) => {
  try {
    return await fs.readFile(filePath);
  } catch {
    return null;
  }
});

ipcMain.handle('file:write', async (_event, { path: filePath, data }) => {
  if (typeof filePath !== 'string' || !path.isAbsolute(filePath)) throw new Error('O caminho precisa ser absoluto.');
  await fs.writeFile(filePath, Buffer.from(data));
  return filePath;
});

// ---------------------------------------------------------------- desempenho
ipcMain.handle('config:get', () => config);
ipcMain.handle('config:set', (_event, patch) => {
  config = writeConfig(configFile, patch);
  return config;
});
ipcMain.handle('gpu:status', () => ({
  // o que está valendo nesta execução (a configuração pode ter mudado e ainda pedir reinício)
  enabled: gpuAtStart,
  hwVideoDecode: hwVideoAtStart,
  features: app.getGPUFeatureStatus(),
  platform: process.platform,
}));
ipcMain.handle('app:relaunch', () => {
  app.relaunch();
  app.exit(0);
});

// ---------------------------------------------------------------- conexão de IA (servidor MCP)
let bridge = null;
const pending = new Map(); // id -> { resolve, reject, timer }
const CALL_TIMEOUT = 30 * 60 * 1000;

/** Repassa a chamada à página, que executa a ferramenta no projeto aberto. */
function dispatch(name, args) {
  return new Promise((resolve, reject) => {
    if (!mainWindow || mainWindow.isDestroyed()) return reject(new Error('The CorteSeco Studio window is closed.'));
    const id = crypto.randomUUID();
    const timer = setTimeout(() => {
      pending.delete(id);
      reject(new Error('The editor did not answer in time.'));
    }, CALL_TIMEOUT);
    pending.set(id, { resolve, reject, timer });
    mainWindow.webContents.send('mcp:call', { id, name, args });
  });
}

ipcMain.on('mcp:result', (_event, { id, ok, result, error }) => {
  const p = pending.get(id);
  if (!p) return;
  pending.delete(id);
  clearTimeout(p.timer);
  if (ok) p.resolve(result);
  else p.reject(new Error(error || 'erro'));
});

function stopAi() {
  bridge?.stop();
  bridge = null;
  for (const p of pending.values()) {
    clearTimeout(p.timer);
    p.reject(new Error('The AI connection was turned off.'));
  }
  pending.clear();
}

/** Como o Claude deve iniciar o servidor MCP: com o executável do próprio app no papel de Node. */
function aiStatus(serverPath) {
  return {
    enabled: !!bridge,
    port: bridge?.port || null,
    command: process.env.APPIMAGE || process.execPath,
    args: serverPath ? [serverPath] : [],
    env: { ELECTRON_RUN_AS_NODE: '1' },
  };
}

let serverPath = null;
ipcMain.handle('mcp:enable', async (_event, on) => {
  if (on && !bridge) {
    serverPath = installServerFiles(path.join(__dirname, '..', 'mcp'));
    bridge = await startBridge({ dispatch });
  } else if (!on) {
    stopAi();
  }
  return aiStatus(serverPath);
});

ipcMain.handle('mcp:status', () => {
  if (!serverPath) serverPath = installServerFiles(path.join(__dirname, '..', 'mcp'));
  return aiStatus(serverPath);
});

app.on('before-quit', stopAi);

app.whenReady().then(() => {
  registerMedia(() => config);
  createWindow();
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});
