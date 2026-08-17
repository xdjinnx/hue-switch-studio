'use strict';

const { contextBridge, ipcRenderer } = require('electron');

const call = (channel, payload) => ipcRenderer.invoke(channel, payload);

contextBridge.exposeInMainWorld('hue', {
  status: () => call('bridge:status'),
  discover: () => call('bridge:discover'),
  probe: (host) => call('bridge:probe', host),
  pair: (host) => call('bridge:pair', { host }),
  forget: () => call('bridge:forget'),

  load: () => call('data:load'),
  validate: (sw, catalog) => call('switch:validate', { sw, catalog }),
  save: (sw, catalog) => call('switch:save', { sw, catalog }),

  backupFull: () => call('backup:full'),
  backupReveal: () => call('backup:reveal'),
  backupRestore: () => call('backup:restore'),
});
