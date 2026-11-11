const { app, BrowserWindow, ipcMain, dialog, Menu } = require('electron');
const path = require('node:path');
const fs = require('node:fs/promises');

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
    },
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

app.whenReady().then(() => {
  createWindow();
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});
