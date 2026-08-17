'use strict';

const path = require('path');
const fs = require('fs');
const { app, BrowserWindow, ipcMain, shell, dialog } = require('electron');

const { Bridge, discoverViaCloud, probeConfig, PinMismatchError, PIN_ALG } = require('./bridge');
const store = require('./store');
const model = require('./model');
const demo = require('./demo');

/**
 * Demo mode: serve an invented home instead of the real bridge, so the app can be
 * screenshotted without showing anyone's actual rooms, scenes and switches. It also
 * makes every write a no-op — the bridge is never even constructed.
 */
const DEMO = process.argv.includes('--demo');

let win = null;
let bridge = null;
let bridgeId = null;

// ---------------------------------------------------------------------------
// window
// ---------------------------------------------------------------------------

function createWindow() {
  win = new BrowserWindow({
    width: 1280,
    height: 900,
    minWidth: 960,
    minHeight: 640,
    backgroundColor: '#12141a',
    title: DEMO ? 'Hue Switch Studio — demo data' : 'Hue Switch Studio',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });
  win.removeMenu();

  // Surface renderer errors in the terminal. A silent exception mid-render leaves a
  // half-drawn card that looks like a broken control rather than a crash.
  win.webContents.on('console-message', (_event, level, message, line, sourceId) => {
    const tag = ['debug', 'info', 'warn', 'error'][level] || level;
    const where = sourceId ? ` (${String(sourceId).split(/[\\/]/).pop()}:${line})` : '';
    console.log(`[renderer/${tag}] ${message}${where}`);
  });

  win.loadFile(path.join(__dirname, '..', 'renderer', 'index.html'));
  if (process.argv.includes('--dev')) win.webContents.openDevTools({ mode: 'detach' });
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

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

const ok = (data) => ({ ok: true, data });
const fail = (err) => ({
  ok: false,
  error: err && err.message ? err.message : String(err),
  kind: err instanceof PinMismatchError ? 'pin-mismatch' : (err && err.hueType === 101 ? 'link-button' : 'error'),
});

function requireBridge() {
  if (!bridge || !bridge.appKey) throw new Error('Not connected to a bridge yet.');
  return bridge;
}

function backupDir() {
  const dir = path.join(app.getPath('userData'), 'backups');
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function stamp() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
}

// ---------------------------------------------------------------------------
// connection
// ---------------------------------------------------------------------------

ipcMain.handle('bridge:status', async () => {
  if (DEMO) return ok(demo.status());

  const saved = store.load();
  if (!saved) return ok({ connected: false });
  bridge = new Bridge({ host: saved.host, pin: saved.pin, appKey: saved.appKey });
  bridgeId = saved.bridgeId;

  // A pin stored under an older algorithm can't be compared against a freshly computed one,
  // so re-learn it rather than reporting a bogus mismatch. The app key is unaffected.
  if (saved.appKey && saved.pinAlg !== PIN_ALG) {
    try {
      bridge.pin = null;
      const { pin } = await bridge.learnPin();
      store.save({ host: saved.host, pin, pinAlg: PIN_ALG, bridgeId: saved.bridgeId, appKey: saved.appKey });
      saved.pin = pin;
      console.log('Re-learned bridge certificate pin under', PIN_ALG);
    } catch (err) {
      return fail(err);
    }
  }

  return ok({
    connected: !!saved.appKey,
    host: saved.host,
    bridgeId: saved.bridgeId,
    pin: saved.pin,
    keyEncrypted: saved.encrypted,
    storePath: store.storePath(),
  });
});

ipcMain.handle('bridge:discover', async () => {
  try {
    const found = await discoverViaCloud();
    const detailed = [];
    for (const entry of found) {
      try {
        const cfg = await probeConfig(entry.internalipaddress);
        detailed.push({ host: entry.internalipaddress, bridgeId: cfg.bridgeid, name: cfg.name, modelId: cfg.modelid });
      } catch {
        detailed.push({ host: entry.internalipaddress, bridgeId: entry.id, name: 'Hue Bridge', modelId: null });
      }
    }
    return ok(detailed);
  } catch (err) {
    return fail(err);
  }
});

ipcMain.handle('bridge:probe', async (_e, host) => {
  try {
    const cfg = await probeConfig(host);
    return ok({ host, bridgeId: cfg.bridgeid, name: cfg.name, modelId: cfg.modelid, apiVersion: cfg.apiversion });
  } catch (err) {
    return fail(err);
  }
});

/**
 * Pair with the bridge. Learns and stores the certificate pin (trust on first use),
 * verifying that the certificate's CN matches the bridge id we were told to expect.
 */
ipcMain.handle('bridge:pair', async (_e, { host }) => {
  try {
    const candidate = new Bridge({ host });
    const { pin, config } = await candidate.learnPin();
    const { appKey } = await candidate.pair('hue_switch_studio', require('os').hostname().slice(0, 19));

    bridge = candidate;
    bridgeId = config && config.bridgeid;
    const saved = store.save({ host, pin, pinAlg: PIN_ALG, bridgeId, appKey });
    return ok({ host, bridgeId, pin, keyEncrypted: saved.encrypted, storePath: saved.path });
  } catch (err) {
    return fail(err);
  }
});

ipcMain.handle('bridge:forget', async () => {
  store.clear();
  bridge = null;
  return ok({});
});

// ---------------------------------------------------------------------------
// data
// ---------------------------------------------------------------------------

ipcMain.handle('data:load', async () => {
  try {
    if (DEMO) return ok(demo.data());

    const b = requireBridge();
    const [devices, buttons, instances, rooms, zones, scenes, bridgeHome] = await Promise.all([
      b.v2('/resource/device'),
      b.v2('/resource/button'),
      b.v2('/resource/behavior_instance'),
      b.v2('/resource/room'),
      b.v2('/resource/zone'),
      b.v2('/resource/scene'),
      b.v2('/resource/bridge_home'),
    ]);
    const rules = (await b.v1('/rules')) || {};

    const catalog = model.buildCatalog({ rooms, zones, scenes, bridgeHome });
    const switches = model.buildSwitchModels({ devices, buttons, instances, rules, catalog });

    return ok({ catalog, switches, ruleCount: Object.keys(rules).length });
  } catch (err) {
    return fail(err);
  }
});

// ---------------------------------------------------------------------------
// writing
// ---------------------------------------------------------------------------

ipcMain.handle('switch:validate', async (_e, { sw, catalog }) => {
  try {
    return ok({ issues: model.validate(sw, catalog) });
  } catch (err) {
    return fail(err);
  }
});

/**
 * Persist one switch. Buttons 1-4 go to the v2 behavior_instance; buttons 5-6 become
 * v1 rules. Every write is preceded by an automatic backup of what is being replaced.
 */
ipcMain.handle('switch:save', async (_e, { sw, catalog }) => {
  try {
    if (DEMO) return ok(demo.save(sw));

    const b = requireBridge();
    const log = [];

    // --- automatic backup of the affected resources -------------------------
    const before = { savedAt: new Date().toISOString(), switch: sw.name, deviceId: sw.deviceId };
    if (sw.instanceId) {
      const inst = await b.v2(`/resource/behavior_instance/${sw.instanceId}`);
      before.behaviorInstance = inst && inst[0];
    }
    before.rules = await b.v1('/rules');
    const backupFile = path.join(backupDir(), `${stamp()}-${sw.deviceId.slice(0, 8)}.json`);
    fs.writeFileSync(backupFile, JSON.stringify(before, null, 2));
    log.push(`Backed up to ${path.basename(backupFile)}`);

    // --- buttons 1-4 : CLIP v2 behavior_instance ---------------------------
    const { configuration, issues } = model.buildV2Configuration(sw, catalog);
    if (issues.length) return ok({ blocked: true, issues, log });

    if (Object.keys(configuration.buttons).length) {
      if (sw.instanceId) {
        await b.v2(`/resource/behavior_instance/${sw.instanceId}`, 'PUT', { configuration });
        log.push('Updated buttons 1-4 (behavior_instance).');
      } else {
        await b.v2('/resource/behavior_instance', 'POST', {
          type: 'behavior_instance',
          script_id: model.ACCESSORY_SCRIPT_ID,
          enabled: true,
          configuration,
          metadata: { name: sw.name },
        });
        log.push('Created behavior_instance for buttons 1-4.');
      }
    }

    // --- buttons 5-6 : legacy v1 rules -------------------------------------
    const combo = model.buildComboRules(sw, catalog);
    for (const id of combo.deletes) {
      await b.v1(`/rules/${id}`, 'DELETE');
      log.push(`Removed rule ${id} (button cleared).`);
    }
    for (const item of combo.creates) {
      if (item.existingId) {
        await b.v1(`/rules/${item.existingId}`, 'PUT', {
          name: item.rule.name,
          conditions: item.rule.conditions,
          actions: item.rule.actions,
          status: 'enabled',
        });
        log.push(`Updated rule ${item.name}.`);
      } else {
        const res = await b.v1('/rules', 'POST', item.rule);
        const created = Array.isArray(res) && res[0] && res[0].success;
        log.push(`Created rule ${item.name}${created ? ` (id ${created.id})` : ''}.`);
      }
    }
    if (combo.issues.length) log.push(...combo.issues.map((i) => `Note: ${i}`));

    return ok({ blocked: false, log, backupFile });
  } catch (err) {
    return fail(err);
  }
});

// ---------------------------------------------------------------------------
// backups
// ---------------------------------------------------------------------------

// In demo mode the backup actions are inert: there is nothing real to back up, and opening
// the backup folder would put real file names on screen — the one thing demo mode avoids.
const DEMO_BACKUP = { ok: false, error: 'Demo mode: backup and restore are disabled.', kind: 'error' };

ipcMain.handle('backup:full', async () => {
  try {
    if (DEMO) return DEMO_BACKUP;

    const b = requireBridge();
    const [instances, rules] = await Promise.all([b.v2('/resource/behavior_instance'), b.v1('/rules')]);
    const file = path.join(backupDir(), `${stamp()}-full.json`);
    fs.writeFileSync(file, JSON.stringify({ savedAt: new Date().toISOString(), bridgeId, instances, rules }, null, 2));
    return ok({ file });
  } catch (err) {
    return fail(err);
  }
});

ipcMain.handle('backup:reveal', async () => {
  if (DEMO) return DEMO_BACKUP;
  await shell.openPath(backupDir());
  return ok({ dir: backupDir() });
});

ipcMain.handle('backup:restore', async () => {
  try {
    if (DEMO) return DEMO_BACKUP;

    const b = requireBridge();
    const picked = await dialog.showOpenDialog(win, {
      title: 'Restore a backup',
      defaultPath: backupDir(),
      filters: [{ name: 'Backup', extensions: ['json'] }],
      properties: ['openFile'],
    });
    if (picked.canceled || !picked.filePaths.length) return ok({ cancelled: true });

    const data = JSON.parse(fs.readFileSync(picked.filePaths[0], 'utf8'));
    const log = [];

    const instances = data.instances || (data.behaviorInstance ? [data.behaviorInstance] : []);
    for (const inst of instances) {
      if (!inst || inst.script_id !== model.ACCESSORY_SCRIPT_ID) continue;
      await b.v2(`/resource/behavior_instance/${inst.id}`, 'PUT', { configuration: inst.configuration });
      log.push(`Restored ${inst.metadata ? inst.metadata.name : inst.id}.`);
    }

    if (data.rules) {
      const current = (await b.v1('/rules')) || {};
      // Only touch rules this app owns, so nothing else on the bridge is disturbed.
      for (const [id, rule] of Object.entries(current)) {
        if (rule.name && rule.name.startsWith(`${model.RULE_PREFIX}-`) && !Object.values(data.rules).some((r) => r.name === rule.name)) {
          await b.v1(`/rules/${id}`, 'DELETE');
          log.push(`Removed ${rule.name}.`);
        }
      }
      for (const rule of Object.values(data.rules)) {
        if (!rule.name || !rule.name.startsWith(`${model.RULE_PREFIX}-`)) continue;
        const existing = Object.entries(current).find(([, r]) => r.name === rule.name);
        const body = { name: rule.name, conditions: rule.conditions, actions: rule.actions, status: 'enabled' };
        if (existing) await b.v1(`/rules/${existing[0]}`, 'PUT', body);
        else await b.v1('/rules', 'POST', body);
        log.push(`Restored ${rule.name}.`);
      }
    }

    return ok({ log, file: picked.filePaths[0] });
  } catch (err) {
    return fail(err);
  }
});
