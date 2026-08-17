'use strict';

/**
 * Test preload: exposes the same `window.hue` surface as the real preload, but backed by
 * the JSON fixtures instead of a live bridge. Lets the renderer be driven headlessly.
 */

const fs = require('fs');
const path = require('path');
const { contextBridge } = require('electron');
const model = require('../src/main/model');

const fixture = (n) => JSON.parse(fs.readFileSync(path.join(__dirname, 'fixtures', `${n}.json`), 'utf8'));

const catalog = model.buildCatalog({
  rooms: fixture('room').data,
  zones: fixture('zone').data,
  scenes: fixture('scene').data,
  bridgeHome: fixture('bridge_home').data,
});

const switches = model.buildSwitchModels({
  devices: fixture('device').data,
  buttons: fixture('button').data,
  instances: fixture('behavior_instance').data,
  rules: fixture('v1_rules'),
  catalog,
});

contextBridge.exposeInMainWorld('hue', {
  status: async () => ({ ok: true, data: { connected: true, host: '192.168.0.24', bridgeId: 'TEST', keyEncrypted: true } }),
  load: async () => ({ ok: true, data: { catalog, switches: JSON.parse(JSON.stringify(switches)) } }),
  validate: async (sw) => ({ ok: true, data: { issues: model.validate(sw, catalog) } }),
  save: async () => ({ ok: true, data: { blocked: false, log: ['(test)'] } }),
  backupFull: async () => ({ ok: true, data: { file: '(test)' } }),
  backupReveal: async () => ({ ok: true, data: {} }),
  backupRestore: async () => ({ ok: true, data: { cancelled: true } }),
  discover: async () => ({ ok: true, data: [] }),
  probe: async () => ({ ok: false, error: 'test' }),
  pair: async () => ({ ok: false, error: 'test' }),
  forget: async () => ({ ok: true, data: {} }),
});
