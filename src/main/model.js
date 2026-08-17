'use strict';

/**
 * Domain layer: translate between the UI's button model and the two very different
 * representations the bridge actually uses.
 *
 *   Buttons 1-4 (individual rockers)  -> CLIP v2 `behavior_instance` (Hue Accessories script)
 *   Buttons 5-6 (both-top / both-bottom) -> legacy v1 `rules` on raw `buttonevent` codes
 *
 * Buttons 5 and 6 exist only in v1: CLIP v2's `button` resources stop at control_id 4,
 * which is exactly why the official Hue app cannot offer them.
 *
 * Empirically established constraints (see README):
 *   - `on_repeat` (hold-to-dim) and `on_long_press` are MUTUALLY EXCLUSIVE per button.
 *   - `where` is per-button and drives the bare verbs (all_off, dim_up, dim_down).
 *   - A scene recall carries its own group, so it can target a zone `where` does not.
 *     That is what makes "different zone for short vs long press" possible.
 */

const ACCESSORY_SCRIPT_ID = '67d9395b-4403-42cc-b5f0-740b699d67c6';
const RULE_PREFIX = 'HSS'; // Hue Switch Studio. v1 rule names are limited to 32 chars.

/** The two hidden buttons, discovered by watching raw buttonevent codes. */
const COMBO_BUTTONS = [
  { index: 5, label: 'Both top rockers', pressCode: 100, releaseCode: 101 },
  { index: 6, label: 'Both bottom rockers', pressCode: 98, releaseCode: 99 },
];

const ROCKER_LABELS = {
  1: 'Left top',
  2: 'Left bottom',
  3: 'Right bottom',
  4: 'Right top',
};

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

const legacyId = (idV1) => (typeof idV1 === 'string' ? idV1.split('/').filter(Boolean).pop() : null);

function emptyShort() {
  return { action: 'none', groupId: null, sceneId: null };
}
function emptyHold() {
  return { mode: 'none', action: 'none', groupId: null, sceneId: null };
}

// ---------------------------------------------------------------------------
// Catalog: everything the UI needs to offer as a target
// ---------------------------------------------------------------------------

function buildCatalog({ rooms, zones, scenes, bridgeHome = [] }) {
  const groups = [
    // The whole-home group. The Hue app also uses this, narrowed by a `where[].items`
    // filter, to point a button at one individual light.
    ...bridgeHome.map((h) => ({
      id: h.id, name: 'Whole home (all lights)', rtype: 'bridge_home',
      legacy: legacyId(h.id_v1), lightCount: (h.children || []).length,
    })),
    ...zones.map((z) => ({
      id: z.id, name: z.metadata && z.metadata.name, rtype: 'zone',
      legacy: legacyId(z.id_v1), lightCount: (z.children || []).length,
    })),
    ...rooms.map((r) => ({
      id: r.id, name: r.metadata && r.metadata.name, rtype: 'room',
      legacy: legacyId(r.id_v1), lightCount: (r.children || []).length,
    })),
  ].sort((a, b) => String(a.name).localeCompare(String(b.name)));

  const sceneList = scenes
    .map((s) => ({
      id: s.id,
      name: s.metadata && s.metadata.name,
      groupId: s.group && s.group.rid,
      groupType: s.group && s.group.rtype,
      legacy: legacyId(s.id_v1),
    }))
    .sort((a, b) => String(a.name).localeCompare(String(b.name)));

  return { groups, scenes: sceneList };
}

// ---------------------------------------------------------------------------
// Parse bridge state -> UI model
// ---------------------------------------------------------------------------

function parseShortFromV2(cfg) {
  if (!cfg) return emptyShort();
  if (cfg.action === 'all_off') return { action: 'off', groupId: null, sceneId: null };
  if (cfg.action === 'home_off') return { action: 'off_home', groupId: null, sceneId: null };
  if (cfg.action === 'do_nothing') return emptyShort();
  const ext = cfg.recall_single_extended;
  if (ext) {
    const first = (ext.actions || [])[0];
    const recall = first && first.action && first.action.recall;
    if (recall) {
      return {
        action: ext.with_off && ext.with_off.enabled ? 'toggle_scene' : 'scene',
        sceneId: recall.rid,
        groupId: null,
      };
    }
    // recall_single_extended can also wrap a bare verb rather than a scene recall.
    if (first && first.action === 'all_off') return { action: 'off', groupId: null, sceneId: null };
    if (first && first.action === 'home_off') return { action: 'off_home', groupId: null, sceneId: null };
  }
  return emptyShort();
}

function parseHoldFromV2(button) {
  if (button.on_repeat && button.on_repeat.action) {
    const a = button.on_repeat.action;
    if (a === 'dim_up' || a === 'dim_down') return { mode: a, action: 'none', groupId: null, sceneId: null };
  }
  if (button.on_long_press) {
    const parsed = parseShortFromV2(button.on_long_press);
    if (parsed.action === 'none') return emptyHold();
    return { mode: 'action', action: parsed.action, sceneId: parsed.sceneId, groupId: null };
  }
  return emptyHold();
}

/** Turn one v1 rule into a short-press model, or null if it isn't ours. */
function parseComboRule(rule) {
  const cond = (rule.conditions || []).find((c) => /\/state\/buttonevent$/.test(c.address || '') && c.operator === 'eq');
  if (!cond) return null;
  const action = (rule.actions || [])[0];
  if (!action) return { action: 'none', groupId: null, sceneId: null };
  const groupMatch = /^\/groups\/(\w+)\/action$/.exec(action.address || '');
  const legacyGroup = groupMatch ? groupMatch[1] : null;
  const body = action.body || {};
  if (body.scene) return { action: 'scene', legacyScene: body.scene, legacyGroup };
  if (body.on === false) return { action: 'off', legacyScene: null, legacyGroup };
  return { action: 'none', legacyScene: null, legacyGroup };
}

/**
 * Assemble the full editable model for every switch on the bridge.
 */
function buildSwitchModels({ devices, buttons, instances, rules, catalog }) {
  const byLegacyScene = new Map(catalog.scenes.filter((s) => s.legacy).map((s) => [s.legacy, s]));
  const byLegacyGroup = new Map(catalog.groups.filter((g) => g.legacy).map((g) => [g.legacy, g]));

  const buttonsByOwner = new Map();
  for (const b of buttons) {
    const owner = b.owner && b.owner.rid;
    if (!owner) continue;
    if (!buttonsByOwner.has(owner)) buttonsByOwner.set(owner, []);
    buttonsByOwner.get(owner).push(b);
  }

  const instanceByDevice = new Map();
  for (const inst of instances) {
    if (inst.script_id !== ACCESSORY_SCRIPT_ID) continue;
    const dev = inst.configuration && inst.configuration.device && inst.configuration.device.rid;
    if (dev) instanceByDevice.set(dev, inst);
  }

  const switches = [];
  for (const device of devices) {
    const owned = (buttonsByOwner.get(device.id) || []).sort(
      (a, b) => (a.metadata.control_id || 0) - (b.metadata.control_id || 0)
    );
    if (!owned.length) continue;

    const modelId = (device.product_data && device.product_data.model_id) || '';
    const isFoh = modelId === 'FOHSWITCH';
    const sensorId = legacyId(owned[0].id_v1); // all buttons of a ZGP switch share one v1 sensor
    const instance = instanceByDevice.get(device.id) || null;
    const cfgButtons = (instance && instance.configuration && instance.configuration.buttons) || {};

    const modelButtons = owned.map((b) => {
      const cfg = cfgButtons[b.id] || {};
      const where = ((cfg.where || [])[0] || {}).group || null;
      const short = parseShortFromV2(cfg.on_short_release);
      const hold = parseHoldFromV2(cfg);
      // Bare verbs act on `where`; surface that as the group for those actions.
      if (short.action === 'off') short.groupId = where && where.rid;
      if (hold.mode === 'dim_up' || hold.mode === 'dim_down' || hold.action === 'off') {
        hold.groupId = where && where.rid;
      }
      return {
        index: b.metadata.control_id,
        label: ROCKER_LABELS[b.metadata.control_id] || `Button ${b.metadata.control_id}`,
        kind: 'rocker',
        rid: b.id,
        supportsHold: true,
        short,
        hold,
        whereGroupId: where && where.rid,
        // Preserve per-button fields we don't model, for the same reason as rawConfiguration.
        rawConfig: cfg,
      };
    });

    // Buttons 5 and 6 — v1 rules only, and only on Friends of Hue hardware.
    if (isFoh && sensorId) {
      for (const combo of COMBO_BUTTONS) {
        const ruleName = comboRuleName(sensorId, combo.releaseCode);
        const entry = Object.entries(rules).find(([, r]) => r.name === ruleName);
        let short = emptyShort();
        if (entry) {
          const parsed = parseComboRule(entry[1]);
          if (parsed) {
            if (parsed.action === 'scene' && parsed.legacyScene) {
              const scene = byLegacyScene.get(parsed.legacyScene);
              short = { action: 'scene', sceneId: scene ? scene.id : null, groupId: null };
            } else if (parsed.action === 'off') {
              const group = byLegacyGroup.get(parsed.legacyGroup);
              short = { action: 'off', sceneId: null, groupId: group ? group.id : null };
            }
          }
        }
        modelButtons.push({
          index: combo.index,
          label: combo.label,
          kind: 'combo',
          rid: null,
          pressCode: combo.pressCode,
          releaseCode: combo.releaseCode,
          ruleId: entry ? entry[0] : null,
          supportsHold: false,
          short,
          hold: emptyHold(),
          whereGroupId: null,
        });
      }
    }

    switches.push({
      deviceId: device.id,
      name: device.metadata && device.metadata.name,
      productName: device.product_data && device.product_data.product_name,
      modelId,
      isFoh,
      sensorId,
      instanceId: instance ? instance.id : null,
      // Kept verbatim so fields we don't model (e.g. `brand` on Senic switches) survive a
      // round-trip instead of being silently dropped when we rebuild the configuration.
      rawConfiguration: instance && instance.configuration ? instance.configuration : null,
      buttons: modelButtons,
    });
  }

  return switches.sort((a, b) => String(a.name).localeCompare(String(b.name)));
}

const comboRuleName = (sensorId, releaseCode) => `${RULE_PREFIX}-${sensorId}-${releaseCode}`;

// ---------------------------------------------------------------------------
// UI model -> bridge payloads
// ---------------------------------------------------------------------------

/**
 * Which group must `where` be? Bare verbs (all_off / dim_up / dim_down) act on `where`,
 * so every such action on a button competes for that single slot. Scene recalls don't.
 */
function resolveWhere(button, catalog) {
  const claims = [];
  if (button.short.action === 'off' && button.short.groupId) claims.push(button.short.groupId);
  if ((button.hold.mode === 'dim_up' || button.hold.mode === 'dim_down') && button.hold.groupId) {
    claims.push(button.hold.groupId);
  }
  if (button.hold.mode === 'action' && button.hold.action === 'off' && button.hold.groupId) {
    claims.push(button.hold.groupId);
  }
  const distinct = [...new Set(claims)];
  if (distinct.length > 1) {
    return { groupId: distinct[0], conflict: distinct };
  }
  if (distinct.length === 1) return { groupId: distinct[0], conflict: null };

  // No bare verbs: `where` is unused but the schema requires it. Anchor it to the scene's
  // own group so the value is at least meaningful.
  const sceneId = button.short.sceneId || button.hold.sceneId;
  const scene = sceneId && catalog.scenes.find((s) => s.id === sceneId);
  if (scene && scene.groupId) return { groupId: scene.groupId, conflict: null };
  return { groupId: button.whereGroupId || (catalog.groups[0] && catalog.groups[0].id), conflict: null };
}

function sceneRecall(sceneId, withOff) {
  return {
    recall_single_extended: {
      actions: [{ action: { recall: { rid: sceneId, rtype: 'scene' } } }],
      with_off: { enabled: !!withOff },
    },
  };
}

function buildEventPayload(spec) {
  switch (spec.action) {
    case 'scene':
      return spec.sceneId ? sceneRecall(spec.sceneId, false) : null;
    case 'toggle_scene':
      return spec.sceneId ? sceneRecall(spec.sceneId, true) : null;
    case 'off':
      return { action: 'all_off' };
    case 'off_home':
      return { action: 'home_off' };
    default:
      return null;
  }
}

const sameSpec = (a, b) =>
  !!a && !!b && a.action === b.action && (a.sceneId || null) === (b.sceneId || null);

/**
 * Emit the freshly built payload only if the user actually changed this event; otherwise
 * hand back the bridge's own JSON untouched. The bridge uses shapes we deliberately don't
 * model (a bare verb nested inside recall_single_extended, `where[].items`, whole-home
 * groups), and regenerating those from a lossy model would rewrite config the user never
 * touched. Preserving verbatim keeps saves surgical.
 */
function eventPayloadPreserving(desired, rawEvent) {
  if (rawEvent && sameSpec(desired, parseShortFromV2(rawEvent))) return rawEvent;
  return buildEventPayload(desired);
}

/** Build the full `configuration` object for a switch's v2 behavior_instance. */
function buildV2Configuration(sw, catalog) {
  const buttons = {};
  const issues = [];

  for (const button of sw.buttons) {
    if (button.kind !== 'rocker') continue;

    const where = resolveWhere(button, catalog);
    if (where.conflict) {
      const names = where.conflict.map((id) => groupName(catalog, id)).join(' and ');
      issues.push(
        `${sw.name} / ${button.label}: short press and hold both use an action that follows the button's ` +
        `single zone slot (${names}). Only one zone is possible for those. Use a scene for one of them ` +
        `to target a different zone.`
      );
    }

    // Start from any unmodelled fields on this button, then set the ones we own. The three
    // event keys are cleared first so a mode change can't leave a stale one behind — notably
    // on_repeat and on_long_press, which the bridge refuses to accept together.
    const preserved = { ...(button.rawConfig || {}) };
    delete preserved.where;
    delete preserved.on_short_release;
    delete preserved.on_repeat;
    delete preserved.on_long_press;

    const raw = button.rawConfig || {};
    const rawWhereGroup = (((raw.where || [])[0] || {}).group || {}).rid || null;

    const entry = { ...preserved };
    // Keep the bridge's own `where` when the target hasn't moved — it may carry an `items`
    // array or a bridge_home group that our simplified model would flatten away.
    entry.where = rawWhereGroup && rawWhereGroup === where.groupId
      ? raw.where
      : [{ group: { rid: where.groupId, rtype: groupType(catalog, where.groupId) } }];

    const short = eventPayloadPreserving(button.short, raw.on_short_release);
    if (short) entry.on_short_release = short;

    if (button.hold.mode === 'dim_up' || button.hold.mode === 'dim_down') {
      entry.on_repeat = { action: button.hold.mode };
    } else if (button.hold.mode === 'action') {
      const desired = { action: button.hold.action, sceneId: button.hold.sceneId };
      const long = eventPayloadPreserving(desired, raw.on_long_press);
      // on_long_press and on_repeat are mutually exclusive; we only ever set one.
      entry.on_long_press = long || { action: 'do_nothing' };
    } else if (raw.on_long_press && parseShortFromV2(raw.on_long_press).action === 'none') {
      entry.on_long_press = raw.on_long_press; // e.g. an existing explicit do_nothing
    } else {
      entry.on_long_press = { action: 'do_nothing' };
    }

    if (!entry.on_short_release && !entry.on_repeat && !entry.on_long_press) {
      entry.on_long_press = { action: 'do_nothing' };
    }

    buttons[button.rid] = entry;
  }

  // Same preservation logic at the top level: `brand` on Senic switches, and anything else
  // Hue adds in future firmware, is carried through untouched.
  const preservedTop = { ...(sw.rawConfiguration || {}) };
  delete preservedTop.buttons;

  return {
    configuration: {
      ...preservedTop,
      ...(sw.modelId ? { model_id: sw.modelId } : {}),
      device: { rid: sw.deviceId, rtype: 'device' },
      buttons,
    },
    issues,
  };
}

/**
 * Build v1 rules for buttons 5/6.
 * Returns { creates:[{name, rule}], deletes:[ruleId] }.
 */
function buildComboRules(sw, catalog) {
  const creates = [];
  const deletes = [];
  const issues = [];
  if (!sw.isFoh || !sw.sensorId) return { creates, deletes, issues };

  for (const button of sw.buttons) {
    if (button.kind !== 'combo') continue;
    const name = comboRuleName(sw.sensorId, button.releaseCode);

    if (button.short.action === 'none') {
      if (button.ruleId) deletes.push(button.ruleId);
      continue;
    }

    let action = null;
    if (button.short.action === 'scene' || button.short.action === 'toggle_scene') {
      const scene = catalog.scenes.find((s) => s.id === button.short.sceneId);
      if (!scene || !scene.legacy) {
        issues.push(`${sw.name} / ${button.label}: that scene has no legacy id, so it cannot be used on buttons 5/6.`);
        continue;
      }
      if (button.short.action === 'toggle_scene') {
        issues.push(`${sw.name} / ${button.label}: toggle isn't available on buttons 5/6 (v1 rules can't test state). Saved as a plain scene recall.`);
      }
      const group = catalog.groups.find((g) => g.id === scene.groupId);
      const legacyGroup = group && group.legacy ? group.legacy : '0';
      action = { address: `/groups/${legacyGroup}/action`, method: 'PUT', body: { scene: scene.legacy } };
    } else if (button.short.action === 'off') {
      const group = catalog.groups.find((g) => g.id === button.short.groupId);
      if (!group || !group.legacy) {
        issues.push(`${sw.name} / ${button.label}: pick a zone or room to turn off.`);
        continue;
      }
      action = { address: `/groups/${group.legacy}/action`, method: 'PUT', body: { on: false } };
    } else if (button.short.action === 'off_home') {
      // v1 group 0 is the implicit all-lights group.
      action = { address: '/groups/0/action', method: 'PUT', body: { on: false } };
    }

    if (!action) continue;

    creates.push({
      existingId: button.ruleId,
      name,
      rule: {
        name,
        status: 'enabled',
        conditions: [
          { address: `/sensors/${sw.sensorId}/state/buttonevent`, operator: 'eq', value: String(button.releaseCode) },
          { address: `/sensors/${sw.sensorId}/state/lastupdated`, operator: 'dx' },
        ],
        actions: [action],
      },
    });
  }

  return { creates, deletes, issues };
}

const groupName = (catalog, id) => {
  const g = catalog.groups.find((x) => x.id === id);
  return g ? g.name : id;
};
const groupType = (catalog, id) => {
  const g = catalog.groups.find((x) => x.id === id);
  return g ? g.rtype : 'zone';
};

/** Pre-flight validation surfaced in the UI before anything is written. */
function validate(sw, catalog) {
  const issues = [];
  for (const button of sw.buttons) {
    for (const [label, spec] of [['Short press', button.short], ['Hold', button.hold]]) {
      const act = label === 'Hold' ? (button.hold.mode === 'action' ? button.hold.action : null) : spec.action;
      if (!act) continue;
      if ((act === 'scene' || act === 'toggle_scene') && !spec.sceneId) {
        issues.push(`${sw.name} / ${button.label} / ${label}: pick a scene.`);
      }
      if (act === 'off' && !spec.groupId) {
        issues.push(`${sw.name} / ${button.label} / ${label}: pick a zone or room to turn off.`);
      }
    }
    if (!button.supportsHold && button.hold.mode !== 'none') {
      issues.push(`${sw.name} / ${button.label}: hold isn't available on this button.`);
    }
  }
  const { issues: v2Issues } = buildV2Configuration(sw, catalog);
  const { issues: comboIssues } = buildComboRules(sw, catalog);
  return [...issues, ...v2Issues, ...comboIssues];
}

module.exports = {
  ACCESSORY_SCRIPT_ID,
  RULE_PREFIX,
  COMBO_BUTTONS,
  buildCatalog,
  buildSwitchModels,
  buildV2Configuration,
  buildComboRules,
  comboRuleName,
  validate,
};
