'use strict';

/**
 * Credential + settings store.
 *
 * The application key is a bearer token for full control of the lighting system, so it is
 * encrypted at rest with Electron's safeStorage (DPAPI on Windows) whenever the OS makes
 * that available. If it isn't, we fall back to plaintext but record that fact so the UI
 * can say so rather than quietly pretending the key is protected.
 */

const fs = require('fs');
const path = require('path');
const { app, safeStorage } = require('electron');

const FILE = () => path.join(app.getPath('userData'), 'bridge.json');

function read() {
  try {
    return JSON.parse(fs.readFileSync(FILE(), 'utf8'));
  } catch {
    return null;
  }
}

function write(data) {
  const file = FILE();
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(data, null, 2), { mode: 0o600 });
}

function load() {
  const raw = read();
  if (!raw) return null;

  let appKey = null;
  let encrypted = false;
  if (raw.appKeyEncrypted) {
    try {
      appKey = safeStorage.decryptString(Buffer.from(raw.appKeyEncrypted, 'base64'));
      encrypted = true;
    } catch {
      appKey = null; // key was encrypted under a different OS profile
    }
  } else if (raw.appKey) {
    appKey = raw.appKey;
  }

  return { host: raw.host, pin: raw.pin, pinAlg: raw.pinAlg || null, bridgeId: raw.bridgeId, appKey, encrypted };
}

function save({ host, pin, pinAlg, bridgeId, appKey }) {
  const data = { host, pin, pinAlg, bridgeId };
  let encrypted = false;
  if (appKey) {
    if (safeStorage.isEncryptionAvailable()) {
      data.appKeyEncrypted = safeStorage.encryptString(appKey).toString('base64');
      encrypted = true;
    } else {
      data.appKey = appKey;
    }
  }
  write(data);
  return { encrypted, path: FILE() };
}

function clear() {
  try {
    fs.unlinkSync(FILE());
  } catch {
    /* already gone */
  }
}

module.exports = { load, save, clear, storePath: FILE };
