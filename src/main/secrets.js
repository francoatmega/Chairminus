'use strict';
// Passwords are encrypted with an OS-protected key (Electron safeStorage: the Keychain on macOS, DPAPI on
// Windows, the Secret Service or KWallet on Linux) and kept
// apart from the connection list. Keys: "<connectionId>:db" | ":ssh" | ":sshkey".
const { safeStorage } = require('electron');
const store = require('./store');

const FILE = 'secrets.json';

function available() {
  // On macOS the key lives in the login Keychain and is always there once the app is ready.
  if (process.platform === 'darwin') return true;
  try { return safeStorage.isEncryptionAvailable(); } catch { return false; }
}

function setSecret(key, value) {
  const all = store.readJson(FILE, {});
  if (value === null || value === undefined || value === '') delete all[key];
  else {
    try {
      if (!available()) throw new Error('unavailable');
      all[key] = safeStorage.encryptString(String(value)).toString('base64');
    } catch {
      throw new Error('Encrypted storage is not available on this system, so the password cannot be saved. Choose "Ask every time".');
    }
  }
  store.writeJson(FILE, all);
}

function getSecret(key) {
  const all = store.readJson(FILE, {});
  if (!all[key]) return null;
  try { return safeStorage.decryptString(Buffer.from(all[key], 'base64')); } catch { return null; }
}

function hasSecret(key) {
  return !!store.readJson(FILE, {})[key];
}

function deleteAll(connId) {
  const all = store.readJson(FILE, {});
  for (const k of Object.keys(all)) if (k.startsWith(connId + ':')) delete all[k];
  store.writeJson(FILE, all);
}

function copyAll(fromId, toId) {
  const all = store.readJson(FILE, {});
  for (const k of Object.keys(all)) {
    if (k.startsWith(fromId + ':')) all[toId + k.slice(fromId.length)] = all[k];
  }
  store.writeJson(FILE, all);
}

module.exports = { available, setSecret, getSecret, hasSecret, deleteAll, copyAll };
