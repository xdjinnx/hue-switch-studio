'use strict';

/**
 * Demo mode (`--demo`): a plausible but entirely invented home, so the app can be
 * screenshotted or shown to someone without exposing a real bridge's rooms, scenes and
 * switch names.
 *
 * The invented data is emitted as raw CLIP v2 / v1 resources and then pushed through the
 * *real* model layer, so what you see is exactly what the parser produces from a bridge —
 * not a second, hand-shaped version of the UI model that could drift from the real one.
 *
 * Nothing here touches the network or the credential store: in demo mode the bridge is
 * never constructed, so a save has nothing to write to even if a code path slipped.
 */

const crypto = require('crypto');
const model = require('./model');

// ---------------------------------------------------------------------------
// random helpers
// ---------------------------------------------------------------------------

const uuid = () => crypto.randomUUID();
const rand = (n) => Math.floor(Math.random() * n);
const pick = (arr) => arr[rand(arr.length)];
const shuffle = (arr) => {
  const out = arr.slice();
  for (let i = out.length - 1; i > 0; i--) {
    const j = rand(i + 1);
    [out[i], out[j]] = [out[j], out[i]];
  }
  return out;
};
const some = (arr, min, max) => shuffle(arr).slice(0, min + rand(max - min + 1));

// ---------------------------------------------------------------------------
// vocabulary
// ---------------------------------------------------------------------------

const ROOM_NAMES = [
  'Living room', 'Kitchen', 'Bedroom', 'Office', 'Hallway',
  'Bathroom', 'Dining room', 'Guest room', 'Studio', 'Landing',
];
const ZONE_NAMES = [
  'Downstairs', 'Upstairs', 'TV corner', 'Reading nook',
  'Kitchen counter', 'Evening', 'Terrace', 'Bookshelves',
];
const SCENE_NAMES = [
  'Bright', 'Relax', 'Nightlight', 'Concentrate', 'Energize',
  'Dimmed', 'Read', 'Savanna sunset', 'Arctic aurora', 'Tropical twilight',
  'Golden hour', 'Movie night', 'Rest',
];
const SWITCH_NAMES = [
  'Hallway switch', 'Living room switch', 'Bedside switch', 'Kitchen switch',
  'Front door switch', 'Landing switch', 'Desk switch',
];

// ---------------------------------------------------------------------------
// raw resource generation
// ---------------------------------------------------------------------------

function buildResources() {
  let legacyGroup = 1; // v1 group 0 is the implicit whole-home group
  let legacyScene = 0;
  let legacySensor = 10;
  const nextScene = () => `demo${String(++legacyScene).padStart(4, '0')}`;

  const rooms = some(ROOM_NAMES, 4, 6).map((name) => ({
    id: uuid(),
    id_v1: `/groups/${legacyGroup++}`,
    type: 'room',
    metadata: { name },
    children: Array.from({ length: 1 + rand(4) }, () => ({ rid: uuid(), rtype: 'device' })),
  }));

  const zones = some(ZONE_NAMES, 2, 4).map((name) => ({
    id: uuid(),
    id_v1: `/groups/${legacyGroup++}`,
    type: 'zone',
    metadata: { name },
    children: Array.from({ length: 2 + rand(6) }, () => ({ rid: uuid(), rtype: 'light' })),
  }));

  const bridgeHome = [{
    id: uuid(),
    id_v1: '/groups/0',
    type: 'bridge_home',
    children: [...rooms, ...zones].map((g) => ({ rid: g.id, rtype: g.type })),
  }];

  // Every group gets a handful of scenes, so the zone→scene filtering in the UI has
  // something to filter.
  const scenes = [];
  for (const group of [...rooms, ...zones]) {
    for (const name of some(SCENE_NAMES, 3, 5)) {
      scenes.push({
        id: uuid(),
        id_v1: `/scenes/${nextScene()}`,
        type: 'scene',
        metadata: { name },
        group: { rid: group.id, rtype: group.type },
      });
    }
  }

  // --- switches ------------------------------------------------------------
  const models = shuffle([
    { modelId: 'FOHSWITCH', productName: 'Friends of Hue Switch' },
    { modelId: 'FOHSWITCH', productName: 'Friends of Hue Switch' },
    { modelId: 'RWL022', productName: 'Hue dimmer switch' },
    { modelId: 'RDM002', productName: 'Hue tap dial switch' },
  ]).slice(0, 3 + rand(2));

  const devices = [];
  const buttons = [];
  const instances = [];
  const rules = {};
  const names = shuffle(SWITCH_NAMES);

  models.forEach((product, i) => {
    const deviceId = uuid();
    const sensorId = String(legacySensor++);
    devices.push({
      id: deviceId,
      id_v1: `/sensors/${sensorId}`,
      type: 'device',
      metadata: { name: names[i] || `Switch ${i + 1}` },
      product_data: { model_id: product.modelId, product_name: product.productName },
    });

    const owned = [1, 2, 3, 4].map((controlId) => {
      const b = {
        id: uuid(),
        id_v1: `/sensors/${sensorId}`,
        type: 'button',
        owner: { rid: deviceId, rtype: 'device' },
        metadata: { control_id: controlId },
      };
      buttons.push(b);
      return b;
    });

    instances.push({
      id: uuid(),
      type: 'behavior_instance',
      script_id: model.ACCESSORY_SCRIPT_ID,
      enabled: true,
      metadata: { name: names[i] },
      configuration: {
        device: { rid: deviceId, rtype: 'device' },
        model_id: product.modelId,
        buttons: Object.fromEntries(owned.map((b) => [b.id, buttonConfig([...rooms, ...zones], scenes)])),
      },
    });

    // Buttons 5/6 only exist on Friends of Hue hardware, and only as v1 rules.
    if (product.modelId === 'FOHSWITCH') {
      for (const combo of model.COMBO_BUTTONS) {
        if (Math.random() < 0.4) continue; // leave some unassigned, as a real home would
        const scene = pick(scenes);
        const group = [...rooms, ...zones].find((g) => g.id === scene.group.rid);
        rules[`demo-rule-${uuid().slice(0, 8)}`] = {
          name: model.comboRuleName(sensorId, combo.releaseCode),
          status: 'enabled',
          conditions: [
            { address: `/sensors/${sensorId}/state/buttonevent`, operator: 'eq', value: String(combo.releaseCode) },
            { address: `/sensors/${sensorId}/state/lastupdated`, operator: 'dx' },
          ],
          actions: [{
            address: `/groups/${group.id_v1.split('/').pop()}/action`,
            method: 'PUT',
            body: { scene: scene.id_v1.split('/').pop() },
          }],
        };
      }
    }
  });

  return { devices, buttons, instances, rooms, zones, scenes, bridgeHome, rules };
}

/** One button's slice of a behavior_instance configuration, in the shapes a bridge uses. */
function buttonConfig(groups, scenes) {
  const group = pick(groups);
  const groupScenes = scenes.filter((s) => s.group.rid === group.id);
  const entry = { where: [{ group: { rid: group.id, rtype: group.type } }] };

  const roll = Math.random();
  if (roll < 0.6 && groupScenes.length) {
    entry.on_short_release = {
      recall_single_extended: {
        actions: [{ action: { recall: { rid: pick(groupScenes).id, rtype: 'scene' } } }],
        with_off: { enabled: Math.random() < 0.5 },
      },
    };
  } else if (roll < 0.85) {
    entry.on_short_release = { action: 'all_off' };
  } else {
    entry.on_short_release = { action: 'home_off' };
  }

  // on_repeat and on_long_press are mutually exclusive on the bridge — pick one.
  const hold = Math.random();
  if (hold < 0.45) {
    entry.on_repeat = { action: pick(['dim_up', 'dim_down']) };
  } else if (hold < 0.7 && groupScenes.length) {
    entry.on_long_press = {
      recall_single_extended: {
        actions: [{ action: { recall: { rid: pick(groupScenes).id, rtype: 'scene' } } }],
        with_off: { enabled: false },
      },
    };
  } else {
    entry.on_long_press = { action: 'do_nothing' };
  }

  return entry;
}

// ---------------------------------------------------------------------------
// public surface — one snapshot per app run
// ---------------------------------------------------------------------------

let snapshot = null;

function data() {
  if (!snapshot) {
    const res = buildResources();
    const catalog = model.buildCatalog(res);
    const switches = model.buildSwitchModels({ ...res, catalog });
    snapshot = { catalog, switches, ruleCount: Object.keys(res.rules).length };
  }
  return snapshot;
}

/** Fabricated connection details for the header — no real host or bridge id. */
function status() {
  return {
    connected: true,
    host: '192.0.2.24', // TEST-NET-1: reserved for documentation, never a real bridge
    bridgeId: 'ECB5FA0DEM0',
    pin: 'demo-mode-no-certificate-pin-is-in-use=',
    keyEncrypted: true,
    storePath: '(demo mode — nothing is stored)',
    demo: true,
  };
}

/** Accept an edit into the in-memory snapshot so the UI behaves normally after a save. */
function save(sw) {
  const snap = data();
  const i = snap.switches.findIndex((s) => s.deviceId === sw.deviceId);
  if (i >= 0) snap.switches[i] = JSON.parse(JSON.stringify(sw));
  return { blocked: false, log: ['Demo mode: nothing was written to a bridge.'] };
}

module.exports = { data, status, save };
