'use strict';

/**
 * Fidelity test against real bridge data.
 *
 * The critical property: parsing a switch's existing configuration into the UI model and
 * then rebuilding it — with no edits — must reproduce the original configuration. Any
 * difference means opening the app and hitting Save would silently change your lights.
 *
 * Run with: node test/roundtrip.js
 */

const fs = require('fs');
const path = require('path');
const model = require('../src/main/model');

const fixture = (name) => JSON.parse(fs.readFileSync(path.join(__dirname, 'fixtures', `${name}.json`), 'utf8'));

const devices = fixture('device').data;
const buttons = fixture('button').data;
const instances = fixture('behavior_instance').data;
const rooms = fixture('room').data;
const zones = fixture('zone').data;
const scenes = fixture('scene').data;
const bridgeHome = fixture('bridge_home').data;
const rules = fixture('v1_rules');

const catalog = model.buildCatalog({ rooms, zones, scenes, bridgeHome });
const switches = model.buildSwitchModels({ devices, buttons, instances, rules, catalog });

const instanceByDevice = new Map();
for (const inst of instances) {
  if (inst.script_id !== model.ACCESSORY_SCRIPT_ID) continue;
  const dev = inst.configuration && inst.configuration.device && inst.configuration.device.rid;
  if (dev) instanceByDevice.set(dev, inst);
}

/** Order-insensitive deep comparison, returning human-readable paths that differ. */
function diff(a, b, at = '', out = []) {
  const ta = a === null ? 'null' : Array.isArray(a) ? 'array' : typeof a;
  const tb = b === null ? 'null' : Array.isArray(b) ? 'array' : typeof b;
  if (ta !== tb) {
    out.push(`${at || '(root)'}: ${ta} vs ${tb}`);
    return out;
  }
  if (ta === 'object') {
    const keys = new Set([...Object.keys(a), ...Object.keys(b)]);
    for (const k of keys) {
      if (!(k in a)) out.push(`${at}.${k}: MISSING in rebuilt`);
      else if (!(k in b)) out.push(`${at}.${k}: ADDED by rebuild`);
      else diff(a[k], b[k], `${at}.${k}`, out);
    }
  } else if (ta === 'array') {
    if (a.length !== b.length) out.push(`${at}: length ${a.length} vs ${b.length}`);
    else a.forEach((v, i) => diff(v, b[i], `${at}[${i}]`, out));
  } else if (a !== b) {
    out.push(`${at}: ${JSON.stringify(a)} vs ${JSON.stringify(b)}`);
  }
  return out;
}

let failures = 0;
let checked = 0;

console.log(`Found ${switches.length} switches, catalog has ${catalog.groups.length} groups / ${catalog.scenes.length} scenes.\n`);

for (const sw of switches) {
  const original = instanceByDevice.get(sw.deviceId);
  if (!original) {
    console.log(`- ${sw.name}: no existing behavior_instance, skipping round-trip.`);
    continue;
  }
  checked++;
  const { configuration, issues } = model.buildV2Configuration(sw, catalog);
  const differences = diff(original.configuration, configuration);

  const comboCount = sw.buttons.filter((b) => b.kind === 'combo').length;
  const label = `${sw.name} [${sw.modelId}] ${sw.buttons.length} buttons (${comboCount} hidden)`;

  if (differences.length === 0 && issues.length === 0) {
    console.log(`  OK   ${label}`);
  } else {
    failures++;
    console.log(`  FAIL ${label}`);
    for (const d of differences) console.log(`         drift: ${d}`);
    for (const i of issues) console.log(`         issue: ${i}`);
  }
}

// --- button inventory -------------------------------------------------------
console.log('\nButton inventory:');
for (const sw of switches) {
  const parts = sw.buttons.map((b) => `${b.index}${b.kind === 'combo' ? '*' : ''}`).join(' ');
  console.log(`  ${String(sw.name).padEnd(22)} ${parts}`);
}
console.log('  (* = hidden button, v1 rules only)');

console.log(`\n${checked - failures}/${checked} switches round-trip cleanly.`);
process.exit(failures ? 1 : 0);
