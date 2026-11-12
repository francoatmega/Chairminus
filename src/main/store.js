'use strict';
// JSON files under the app's userData folder. Passwords never go in here (see secrets.js).
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { app } = require('electron');

const dataDir = () => path.join(app.getPath('userData'), 'Data');

function file(name) {
  fs.mkdirSync(dataDir(), { recursive: true });
  return path.join(dataDir(), name);
}

function readJson(name, fallback) {
  try {
    return JSON.parse(fs.readFileSync(file(name), 'utf8'));
  } catch {
    return fallback;
  }
}

function writeJson(name, value) {
  const target = file(name);
  const tmp = target + '.' + process.pid + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(value, null, 2));
  fs.renameSync(tmp, target);
}

const DEFAULT_SETTINGS = {
  theme: 'auto', // auto | light | dark
  defaultSafeMode: 0,
  touchIdForSafeMode: false,
  limitRows: 300,
  limitQueryRows: 1000,
  variableFormat: 'colon', // colon | dollar | braces
  variablesInStrings: false,
  uppercaseKeywords: true,
  indent: '  ',
  historyRetentionDays: 365, // 0 = forever
  logOriginalValues: false,
  alternateRows: true,
  estimateThreshold: 100000,
};

function getSettings() {
  return { ...DEFAULT_SETTINGS, ...readJson('settings.json', {}) };
}

function setSettings(patch) {
  const next = { ...getSettings(), ...patch };
  writeJson('settings.json', next);
  return next;
}

const newId = () => crypto.randomUUID();
const historyFile = (connId) => file(`history-${String(connId).replace(/[^A-Za-z0-9_-]/g, '_')}.jsonl`);

const DEFAULT_PORTS = { postgres: 5432, mysql: 3306, mariadb: 3306, mongodb: 27017, redis: 6379, elasticsearch: 9200, opensearch: 9200, neo4j: 7687 };

function listConnections() {
  return readJson('connections.json', []);
}

function getConnection(id) {
  return listConnections().find((c) => c.id === id) || null;
}

function saveConnection(conn) {
  const all = listConnections();
  const clean = { ...conn };
  if (!clean.id) clean.id = newId();
  const i = all.findIndex((c) => c.id === clean.id);
  if (i === -1) { clean.createdAt = Date.now(); all.push(clean); } else all[i] = { ...all[i], ...clean };
  writeJson('connections.json', all);
  return i === -1 ? clean : all[i];
}

function deleteConnection(id) {
  writeJson('connections.json', listConnections().filter((c) => c.id !== id));
  try { fs.rmSync(historyFile(id), { force: true }); } catch { /* nothing to remove */ }
}

function touchConnection(id) {
  const all = listConnections();
  const c = all.find((x) => x.id === id);
  if (c) { c.lastOpenedAt = Date.now(); writeJson('connections.json', all); }
}

// ---- query history: one JSON-lines file per connection ---------------------------------

function appendHistory(connId, entry) {
  fs.appendFileSync(historyFile(connId), JSON.stringify(entry) + '\n');
}

function readHistory(connId) {
  let text;
  try { text = fs.readFileSync(historyFile(connId), 'utf8'); } catch { return []; }
  const out = [];
  for (const line of text.split('\n')) {
    if (!line) continue;
    try { out.push(JSON.parse(line)); } catch { /* skip a torn line */ }
  }
  return out;
}

function searchHistory(connId, text, limit = 300) {
  const needle = String(text || '').toLowerCase();
  const all = readHistory(connId);
  const out = [];
  for (let i = all.length - 1; i >= 0 && out.length < limit; i--) {
    if (!needle || all[i].sql.toLowerCase().includes(needle)) out.push(all[i]);
  }
  return out;
}

function clearHistory(connId) {
  fs.rmSync(historyFile(connId), { force: true });
}

/** Drop history entries older than the retention setting. Returns how many were removed. */
function pruneHistory(days) {
  if (!days) return 0;
  const cutoff = Date.now() - days * 86400000;
  let removed = 0;
  for (const name of fs.readdirSync(dataDir())) {
    const m = /^history-(.+)\.jsonl$/.exec(name);
    if (!m) continue;
    const all = readHistory(m[1]);
    const keep = all.filter((e) => e.ts >= cutoff);
    if (keep.length === all.length) continue;
    removed += all.length - keep.length;
    fs.writeFileSync(file(name), keep.map((e) => JSON.stringify(e)).join('\n') + (keep.length ? '\n' : ''));
  }
  return removed;
}

// ---- favorites and per-table view state -----------------------------------------------

function listFavorites() { return readJson('favorites.json', []); }

function saveFavorite(fav) {
  const all = listFavorites();
  const item = { ...fav };
  if (!item.id) { item.id = newId(); item.createdAt = Date.now(); all.push(item); }
  else {
    const i = all.findIndex((f) => f.id === item.id);
    if (i === -1) all.push(item); else all[i] = { ...all[i], ...item };
  }
  writeJson('favorites.json', all);
  return item;
}

function deleteFavorite(id) {
  writeJson('favorites.json', listFavorites().filter((f) => f.id !== id));
}

function getViewState(key) { return readJson('viewstate.json', {})[key] || null; }

function setViewState(key, value) {
  const all = readJson('viewstate.json', {});
  if (value === null) delete all[key]; else all[key] = value;
  writeJson('viewstate.json', all);
}

module.exports = {
  dataDir, readJson, writeJson, newId, DEFAULT_PORTS, DEFAULT_SETTINGS,
  getSettings, setSettings,
  listConnections, getConnection, saveConnection, deleteConnection, touchConnection,
  appendHistory, searchHistory, clearHistory, pruneHistory,
  listFavorites, saveFavorite, deleteFavorite, getViewState, setViewState,
};
