'use strict';
const fs = require('fs');
const path = require('path');
const { ipcMain, dialog, shell, clipboard, systemPreferences, BrowserWindow, app } = require('electron');
const store = require('./store');
const secrets = require('./secrets');
const transfer = require('./transfer');
const { Session, NeedInput } = require('./session');
const { parseConnectionUrl } = require('./urlimport');

/** webContents.id -> Session */
const sessions = new Map();
/** connections opened straight from a file; they are not in the saved list */
const adhoc = new Map();

function findConnection(id) {
  return adhoc.get(id) || store.getConnection(id);
}

function sessionFor(event) {
  const s = sessions.get(event.sender.id);
  if (!s) throw new Error('This window has no connection');
  return s;
}

function attachSession(webContents, connId) {
  const conn = findConnection(connId);
  if (!conn) throw new Error('The connection no longer exists');
  const emit = (channel, payload) => { if (!webContents.isDestroyed()) webContents.send(channel, payload); };
  const session = new Session(conn, emit);
  sessions.set(webContents.id, session);
  return session;
}

async function detachSession(id) {
  const s = sessions.get(id);
  sessions.delete(id);
  if (s) await s.close();
}

function validateConnection(c) {
  if (!c.name || !String(c.name).trim()) throw new Error('Invalid name');
  if (c.driver === 'sqlite') {
    if (!c.path) throw new Error('Choose a database file');
    return;
  }
  // A MongoDB SRV name resolves to its own hosts and ports, which a tunnel cannot follow.
  const srv = c.driver === 'mongodb' && c.srv;
  if (srv && c.ssh && c.ssh.enabled) throw new Error('Invalid host: an SRV connection cannot go through an SSH tunnel');
  if (c.useSocket) { if (!c.socketPath) throw new Error('Invalid socket'); }
  else {
    if (!c.host || /\s/.test(c.host)) throw new Error('Invalid host');
    const port = Number(c.port);
    if (!srv && !(Number.isInteger(port) && port > 0 && port < 65536)) throw new Error('Invalid port');
  }
  if (c.driver === 'redis' && c.database !== undefined && c.database !== '' && !/^\d+$/.test(String(c.database))) {
    throw new Error('Invalid database: Redis databases are numbered (0, 1, 2…)');
  }
  if ((c.sslMode === 'verify-ca' || c.sslMode === 'verify-full') && c.sslCa && !fs.existsSync(c.sslCa)) {
    throw new Error('Invalid SSL configuration: the CA certificate file does not exist');
  }
  if ((c.sslCert && !c.sslKey) || (!c.sslCert && c.sslKey)) throw new Error('Invalid SSL configuration: a client certificate needs both the certificate and its key');
  if (c.ssh && c.ssh.enabled) {
    if (!c.ssh.host) throw new Error('Invalid host: the SSH server is missing');
    if (c.ssh.auth === 'key' && !c.ssh.keyPath) throw new Error('Choose the SSH private key');
  }
}

function storeSecrets(id, given = {}) {
  if (given.password !== undefined) secrets.setSecret(`${id}:db`, given.password);
  if (given.sshPassword !== undefined) secrets.setSecret(`${id}:ssh`, given.sshPassword);
  if (given.passphrase !== undefined) secrets.setSecret(`${id}:sshkey`, given.passphrase);
}

function publicConnection(c) {
  return {
    ...c,
    hasPassword: secrets.hasSecret(`${c.id}:db`),
    hasSshPassword: secrets.hasSecret(`${c.id}:ssh`),
    hasPassphrase: secrets.hasSecret(`${c.id}:sshkey`),
  };
}

function register({ openWorkspace, broadcast }) {
  const handle = (channel, fn) => {
    ipcMain.handle(channel, async (event, ...args) => {
      try {
        return { ok: true, value: await fn(event, ...args) };
      } catch (e) {
        if (e instanceof NeedInput) return { ok: false, need: e.need, error: e.message };
        return { ok: false, error: e && e.message ? e.message : String(e) };
      }
    });
  };
  const win = (event) => BrowserWindow.fromWebContents(event.sender);

  // ---- app ---------------------------------------------------------------------------------
  handle('app:info', () => ({
    version: app.getVersion(),
    platform: process.platform,
    touchId: process.platform === 'darwin' && systemPreferences.canPromptTouchID(),
    encryption: secrets.available(),
    dataDir: store.dataDir(),
  }));
  handle('settings:get', () => store.getSettings());
  handle('settings:set', (e, patch) => {
    const next = store.setSettings(patch);
    broadcast('settings:changed', next);
    return next;
  });
  handle('clipboard:write', (e, text) => clipboard.writeText(String(text)));
  handle('clipboard:read', () => clipboard.readText());
  handle('dialog:open', async (e, opts) => {
    const r = await dialog.showOpenDialog(win(e), { properties: ['openFile'], ...opts });
    return r.canceled ? null : r.filePaths[0];
  });
  handle('dialog:save', async (e, opts) => {
    const r = await dialog.showSaveDialog(win(e), opts || {});
    return r.canceled ? null : r.filePath;
  });
  handle('shell:showItem', (e, p) => shell.showItemInFolder(p));
  handle('file:readText', (e, p, encoding) => {
    try {
      return new TextDecoder(encoding || 'utf-8', { fatal: true }).decode(fs.readFileSync(p));
    } catch (err) {
      if (err.code) throw err;
      throw new Error(`The file couldn't be opened using text encoding ${encoding || 'UTF-8'}.`);
    }
  });
  handle('file:writeText', (e, p, text) => fs.writeFileSync(p, text, 'utf8'));

  // ---- connections -------------------------------------------------------------------------
  handle('conn:list', () => store.listConnections().map(publicConnection));
  handle('conn:save', (e, { conn, secrets: given }) => {
    validateConnection(conn);
    const { hasPassword, hasSshPassword, hasPassphrase, ...clean } = conn;
    const saved = store.saveConnection(clean);
    storeSecrets(saved.id, given);
    if (saved.passwordMode && saved.passwordMode !== 'store') secrets.setSecret(`${saved.id}:db`, null);
    broadcast('connections:changed');
    return publicConnection(saved);
  });
  handle('conn:setFavorite', (e, id, favorite) => {
    if (!store.getConnection(id)) throw new Error('The connection no longer exists');
    store.saveConnection({ id, favorite: !!favorite });
    broadcast('connections:changed');
  });
  handle('conn:delete', (e, id) => {
    store.deleteConnection(id);
    secrets.deleteAll(id);
    broadcast('connections:changed');
  });
  handle('conn:duplicate', (e, id) => {
    const src = store.getConnection(id);
    if (!src) throw new Error('The connection no longer exists');
    const copy = store.saveConnection({ ...src, id: undefined, name: `${src.name} copy`, lastOpenedAt: undefined });
    secrets.copyAll(id, copy.id);
    broadcast('connections:changed');
    return publicConnection(copy);
  });
  handle('conn:test', async (e, { conn, secrets: given = {} }) => {
    validateConnection(conn);
    const probe = new Session({ ...conn, startupSql: '' }, () => {});
    const cred = {};
    // Typed values win; otherwise fall back to what is stored for this connection.
    if (given.password !== undefined) cred.password = given.password;
    else if (conn.passwordMode === 'ask') cred.password = '';
    if (given.sshPassword !== undefined) cred.sshPassword = given.sshPassword;
    if (given.passphrase !== undefined) cred.passphrase = given.passphrase;
    try {
      const info = await probe.connect(cred);
      return { version: info.version };
    } finally {
      await probe.close();
    }
  });
  handle('conn:parseUrl', (e, url) => parseConnectionUrl(url));
  handle('conn:export', (e, filePath) => {
    const list = store.listConnections().map(({ lastOpenedAt, createdAt, ...c }) => c);
    fs.writeFileSync(filePath, JSON.stringify({ format: 'chairminus-connections', version: 1, connections: list }, null, 2));
    return list.length;
  });
  handle('conn:import', (e, filePath) => {
    const data = JSON.parse(fs.readFileSync(filePath, 'utf8'));
    if (!data || data.format !== 'chairminus-connections' || !Array.isArray(data.connections)) {
      throw new Error('This is not a Chairminus connections file');
    }
    const existing = new Set(store.listConnections().map((c) => c.id));
    let n = 0;
    for (const c of data.connections) {
      if (!c || !c.driver || !c.name) continue;
      // An id that is already taken gets a new one, so nothing is overwritten.
      store.saveConnection({ ...c, id: existing.has(c.id) ? undefined : c.id });
      n++;
    }
    broadcast('connections:changed');
    return n;
  });
  handle('workspace:open', (e, connId) => { openWorkspace(connId); });
  handle('workspace:openFile', (e, filePath) => { openWorkspace(adhocSqlite(filePath)); });
  handle('workspace:setDirty', (e, dirty) => { const w = win(e); if (w) w.dirty = !!dirty; });
  handle('workspace:setTitle', (e, title) => { const w = win(e); if (w) w.setTitle(String(title)); });

  // ---- session -----------------------------------------------------------------------------
  handle('session:connect', (e, given) => sessionFor(e).connect(given));
  handle('session:info', (e) => sessionFor(e).info());
  handle('session:verifyPassword', (e, pw) => {
    const s = sessionFor(e);
    return String(pw) === String(s.credentials.password ?? '');
  });
  handle('session:touchId', async (e, reason) => {
    try { await systemPreferences.promptTouchID(reason); return true; } catch { return false; }
  });

  // ---- database ----------------------------------------------------------------------------
  const db = (channel, fn) => handle(channel, (e, ...args) => {
    const s = sessionFor(e);
    return s.op((d) => fn(d, s, ...args));
  });
  db('db:databases', async (d) => {
    const names = await d.listDatabases();
    return names.map((n) => ({ name: n, system: d.isSystemDatabase ? d.isSystemDatabase(n) : false }));
  });
  db('db:useDatabase', async (d, s, name) => { await d.useDatabase(name); s.currentDatabase = name; return s.info(); });
  db('db:schemas', (d) => d.listSchemas());
  db('db:currentSchema', (d) => (d.currentSchema ? d.currentSchema() : null));
  db('db:objects', (d, s, schema) => d.listObjects(schema));
  db('db:columns', (d, s, schema) => d.listColumns(schema));
  db('db:describe', (d, s, schema, table) => d.describeTable(schema, table));
  db('db:ddl', (d, s, schema, name, kind, extra) => d.ddl(schema, name, kind, extra));
  db('db:processList', (d) => d.processList());
  db('db:kill', (d, s, id) => d.kill(id));
  handle('db:fetchPage', (e, req) => sessionFor(e).fetchPage(req));
  handle('db:count', (e, req) => sessionFor(e).count(req));
  handle('db:filterPreview', (e, req) => sessionFor(e).filterPreview(req));
  handle('db:run', (e, req) => sessionFor(e).run(req));
  handle('db:cancel', (e) => sessionFor(e).cancel());
  handle('db:applyChanges', (e, req) => sessionFor(e).applyChanges(req));

  // ---- transfer ----------------------------------------------------------------------------
  const progress = (e) => (p) => { if (!e.sender.isDestroyed()) e.sender.send('transfer:progress', p); };
  handle('export:rows', (e, req) => transfer.exportRows(req));
  handle('export:table', (e, req) => { const s = sessionFor(e); s.cancelled = false; return transfer.exportTable(s, req, progress(e)); });
  handle('import:preview', (e, req) => transfer.previewFile(req));
  handle('import:run', (e, req) => { const s = sessionFor(e); s.cancelled = false; return transfer.importFile(s, req, progress(e)); });
  handle('import:sql', (e, req) => { const s = sessionFor(e); s.cancelled = false; return transfer.runSqlFile(s, req, progress(e)); });

  // ---- history, favorites, view state ------------------------------------------------------
  handle('history:search', (e, text) => store.searchHistory(sessionFor(e).conn.id, text));
  // Latest queries over every saved connection, for the start window.
  handle('history:recent', (e, text, limit = 200) => store.listConnections()
    .flatMap((c) => store.searchHistory(c.id, text, limit).map((h) => ({ ...h, connId: c.id })))
    .sort((a, b) => b.ts - a.ts)
    .slice(0, limit));
  handle('history:clear', (e) => store.clearHistory(sessionFor(e).conn.id));
  handle('favorites:list', () => store.listFavorites());
  handle('favorites:save', (e, fav) => store.saveFavorite(fav));
  handle('favorites:delete', (e, id) => store.deleteFavorite(id));
  handle('viewstate:get', (e, key) => store.getViewState(`${sessionFor(e).conn.id}/${key}`));
  handle('viewstate:set', (e, key, value) => store.setViewState(`${sessionFor(e).conn.id}/${key}`, value));
}

/** A throwaway connection for a SQLite file opened from the file manager or the Open dialog. */
function adhocSqlite(filePath) {
  const saved = store.listConnections().find((c) => c.driver === 'sqlite' && c.path === filePath);
  if (saved) return saved.id;
  const id = 'file:' + filePath;
  adhoc.set(id, { id, name: path.basename(filePath), driver: 'sqlite', path: filePath, safeMode: store.getSettings().defaultSafeMode });
  return id;
}

module.exports = { register, attachSession, detachSession, findConnection, adhocSqlite, sessions };
