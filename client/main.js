const { app, BrowserWindow, Notification } = require('electron');
const path = require('path');

let mainWindow;

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1100,
    height: 700,
    minWidth: 800,
    minHeight: 500,
    icon: path.join(__dirname, 'icon.ico'), // Убедись, что файл icon.ico лежит в этой же папке
    webPreferences: {
      nodeIntegration: true,
      contextIsolation: false
    }
    // autoHideMenuBar больше не нужен, убираем его
  });

  // ВОТ ЭТА СТРОКА полностью отключает меню и блокирует его вызов по кнопке Alt
  mainWindow.setMenu(null); 

  mainWindow.loadFile('index.html');
}

app.whenReady().then(() => {
  createWindow();
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});