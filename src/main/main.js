'use strict';
const path = require('path');
const fs = require('fs');
const { app, BrowserWindow, Menu, dialog, nativeTheme, shell } = require('electron');

// Lets tests run against a throwaway data folder.
if (process.env.CHAIRMINUS_USER_DATA) app.setPath('userData', process.env.CHAIRMINUS_USER_DATA);

const store = require('./store');
const ipc = require('./ipc');

const INDEX = path.join(__dirname, '..', 'renderer', 'index.html');
const PRELOAD = path.join(__dirname, '..', 'preload', 'preload.js');
const SQLITE_EXT = new Set(['.sqlite', '.sqlite3', '.db', '.db3']);
const IS_MAC = process.platform === 'darwin';
const MOD = IS_MAC ? '⌘' : 'Ctrl+';

let welcome = null;
const pendingFiles = [];

function baseOptions(extra) {
  return {
    show: false,
    backgroundColor: nativeTheme.shouldUseDarkColors ? '#1c1d21' : '#ffffff',
    // macOS keeps the traffic lights over the page; elsewhere the window gets the system frame and menu bar.
    ...(IS_MAC ? { titleBarStyle: 'hiddenInset' } : { autoHideMenuBar: false }),
    webPreferences: { preload: PRELOAD, contextIsolation: true, sandbox: true, nodeIntegration: false, spellcheck: false },
    ...extra,
  };
}

function harden(win) {
  // The UI is a local file; nothing in it should ever navigate away or open windows.
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:\/\//.test(url)) shell.openExternal(url);
    return { action: 'deny' };
  });
  win.webContents.on('will-navigate', (e) => e.preventDefault());
  win.once('ready-to-show', () => win.show());
}

function showWelcome() {
  if (welcome && !welcome.isDestroyed()) { welcome.show(); welcome.focus(); return welcome; }
  welcome = new BrowserWindow(baseOptions({ width: 1040, height: 680, minWidth: 820, minHeight: 500, title: 'Chairminus' }));
  harden(welcome);
  welcome.loadFile(INDEX, { query: { view: 'welcome' } });
  welcome.on('closed', () => { welcome = null; });
  return welcome;
}

function openWorkspace(connId, sqlFile) {
  const conn = ipc.findConnection(connId);
  if (!conn) { dialog.showErrorBox('Chairminus', 'The connection no longer exists.'); return null; }
  const win = new BrowserWindow(baseOptions({ width: 1280, height: 800, minWidth: 860, minHeight: 520, title: conn.name }));
  harden(win);
  const wcId = win.webContents.id;
  ipc.attachSession(win.webContents, connId);
  if (conn.id && !String(conn.id).startsWith('file:')) store.touchConnection(conn.id);
  const query = { view: 'workspace', conn: connId };
  if (sqlFile) query.sql = sqlFile;
  win.loadFile(INDEX, { query });
  win.on('close', (e) => {
    if (!win.dirty) return;
    const choice = dialog.showMessageBoxSync(win, {
      type: 'warning', buttons: ['Discard Changes', 'Cancel'], defaultId: 1, cancelId: 1,
      message: 'Discard all changes?',
      detail: `Some edits have not been committed. You can commit them with ${MOD}S.`,
    });
    if (choice === 1) e.preventDefault();
  });
  win.on('closed', () => {
    ipc.detachSession(wcId);
    if (BrowserWindow.getAllWindows().length === 0 && IS_MAC) showWelcome();
  });
  return win;
}

function openPath(filePath) {
  const ext = path.extname(filePath).toLowerCase();
  if (SQLITE_EXT.has(ext)) { openWorkspace(ipc.adhocSqlite(filePath)); return; }
  if (ext === '.sql') {
    const target = BrowserWindow.getAllWindows().find((w) => w !== welcome && !w.isDestroyed());
    if (target) { target.webContents.send('open-sql-file', filePath); target.focus(); }
    else dialog.showMessageBox({ message: 'Open a connection first', detail: 'A .sql file opens in the query editor of a connected workspace.' });
  }
}

function send(action) {
  return (item, win) => { if (win && !win.isDestroyed()) win.webContents.send('menu', action); };
}

function broadcast(channel, payload) {
  for (const w of BrowserWindow.getAllWindows()) if (!w.isDestroyed()) w.webContents.send(channel, payload);
}

/** Files handed over on the command line (Windows and Linux open documents this way). */
function filesFromArgv(argv) {
  return argv.slice(app.isPackaged ? 1 : 2).filter((a) => !a.startsWith('-')).map((a) => path.resolve(a))
    .filter((p) => (SQLITE_EXT.has(path.extname(p).toLowerCase()) || path.extname(p).toLowerCase() === '.sql') && fs.existsSync(p));
}

function buildMenu() {
  const settingsItem = { label: 'Settings…', accelerator: 'CmdOrCtrl+,', click: send('settings') };
  const template = [
    IS_MAC && {
      label: app.name,
      submenu: [
        { role: 'about' },
        { type: 'separator' },
        settingsItem,
        { type: 'separator' },
        { role: 'services' },
        { type: 'separator' },
        { role: 'hide' }, { role: 'hideOthers' }, { role: 'unhide' },
        { type: 'separator' },
        { role: 'quit' },
      ],
    },
    {
      label: 'File',
      submenu: [
        { label: 'Connections', accelerator: 'CmdOrCtrl+Shift+K', click: () => showWelcome() },
        { label: 'New Query', accelerator: 'CmdOrCtrl+T', click: send('new-query') },
        { label: 'Open Anything…', accelerator: 'CmdOrCtrl+P', click: send('open-anything') },
        { type: 'separator' },
        {
          label: 'Open File…', accelerator: 'CmdOrCtrl+O',
          click: async (item, win) => {
            const r = await dialog.showOpenDialog(win, {
              properties: ['openFile'],
              filters: [{ name: 'SQLite databases and SQL files', extensions: ['sqlite', 'sqlite3', 'db', 'db3', 'sql'] }, { name: 'All files', extensions: ['*'] }],
            });
            if (r.canceled) return;
            const p = r.filePaths[0];
            if (path.extname(p).toLowerCase() === '.sql' && win && win !== welcome) win.webContents.send('open-sql-file', p);
            else openPath(p);
          },
        },
        { label: 'Save Query As…', accelerator: 'CmdOrCtrl+Shift+S', click: send('save-query') },
        { type: 'separator' },
        { label: 'Import…', click: send('import') },
        { label: 'Export…', accelerator: 'CmdOrCtrl+E', click: send('export') },
        { type: 'separator' },
        { label: 'Close Tab', accelerator: 'CmdOrCtrl+W', click: send('close-tab') },
        { label: 'Close Window', accelerator: 'CmdOrCtrl+Shift+W', role: 'close' },
        ...(IS_MAC ? [] : [{ type: 'separator' }, settingsItem, { type: 'separator' }, { role: 'quit', label: 'Exit' }]),
      ],
    },
    {
      label: 'Edit',
      submenu: [
        { role: 'undo' }, { role: 'redo' }, { type: 'separator' },
        { role: 'cut' }, { role: 'copy' }, { role: 'paste' }, { role: 'selectAll' },
        { type: 'separator' },
        { label: 'Find / Filter', accelerator: 'CmdOrCtrl+F', click: send('find') },
        { label: 'Format SQL', accelerator: 'CmdOrCtrl+Shift+F', click: send('format') },
      ],
    },
    {
      label: 'Data',
      submenu: [
        { label: 'Commit Changes', accelerator: 'CmdOrCtrl+S', click: send('commit') },
        { label: 'Preview SQL', accelerator: 'CmdOrCtrl+Shift+P', click: send('preview') },
        { label: 'Discard Changes', accelerator: 'CmdOrCtrl+Shift+Backspace', click: send('discard') },
        { type: 'separator' },
        { label: 'Insert Row', accelerator: 'CmdOrCtrl+I', click: send('insert-row') },
        { label: 'Duplicate Row', accelerator: 'CmdOrCtrl+D', click: send('duplicate-row') },
        { label: 'Delete Row', click: send('delete-row') },
        { type: 'separator' },
        { label: 'Refresh', accelerator: 'CmdOrCtrl+R', click: send('refresh') },
      ],
    },
    {
      label: 'Query',
      submenu: [
        { label: 'Run Current', accelerator: 'CmdOrCtrl+Return', click: send('run-current') },
        { label: 'Run All', accelerator: 'CmdOrCtrl+Shift+Return', click: send('run-all') },
        { label: 'Cancel Query', accelerator: 'CmdOrCtrl+.', click: send('cancel-query') },
        { type: 'separator' },
        { label: 'History & Favorites', accelerator: 'CmdOrCtrl+Y', click: send('history') },
        { label: 'Save as Favorite…', click: send('favorite') },
      ],
    },
    {
      label: 'Connection',
      submenu: [
        { label: 'Reconnect', click: send('reconnect') },
        { label: 'Process List', click: send('process-list') },
        { type: 'separator' },
        { label: 'Switch Database…', accelerator: 'CmdOrCtrl+K', click: send('switch-database') },
      ],
    },
    {
      label: 'View',
      submenu: [
        { label: 'Row Detail', accelerator: 'CmdOrCtrl+Shift+D', click: send('toggle-detail') },
        { label: 'Console Log', accelerator: 'CmdOrCtrl+Shift+C', click: send('toggle-log') },
        { label: 'Structure / Data', accelerator: 'CmdOrCtrl+Shift+T', click: send('toggle-structure') },
        { type: 'separator' },
        { label: 'Next Tab', accelerator: 'Ctrl+Tab', click: send('next-tab') },
        { label: 'Previous Tab', accelerator: 'Ctrl+Shift+Tab', click: send('prev-tab') },
        { type: 'separator' },
        { role: 'togglefullscreen' },
        ...(app.isPackaged ? [] : [{ role: 'toggleDevTools' }, { role: 'forceReload' }]),
      ],
    },
    { role: 'windowMenu' },
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template.filter(Boolean)));
}

app.on('open-file', (event, filePath) => {
  event.preventDefault();
  if (app.isReady()) openPath(filePath); else pendingFiles.push(filePath);
});

if (!app.requestSingleInstanceLock()) {
  // Another copy with the same data folder is running, usually the installed app while developing:
  // it gets focused instead, so say so rather than quitting silently.
  if (!app.isPackaged) console.error('Chairminus is already running (probably the installed app). Quit it first, or set CHAIRMINUS_USER_DATA to use another data folder.');
  app.quit();
} else {
  app.on('second-instance', (event, argv) => {
    const files = filesFromArgv(argv);
    if (files.length) files.forEach(openPath); else showWelcome();
  });
  app.whenReady().then(() => {
    ipc.register({ openWorkspace, broadcast });
    buildMenu();
    try { store.pruneHistory(store.getSettings().historyRetentionDays); } catch { /* best effort */ }
    showWelcome();
    if (!IS_MAC) pendingFiles.push(...filesFromArgv(process.argv));
    for (const f of pendingFiles.splice(0)) openPath(f);
    const smoke = process.env.CHAIRMINUS_SMOKE;
    // Development-only hook for the UI smoke test; never active in a packaged app.
    if (smoke && !app.isPackaged && fs.existsSync(smoke)) require(smoke)({ showWelcome, openWorkspace, ipc });
  });
  app.on('activate', () => { if (BrowserWindow.getAllWindows().length === 0) showWelcome(); });
  app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit(); });
}
