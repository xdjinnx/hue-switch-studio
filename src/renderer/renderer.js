'use strict';

/**
 * Renderer. Holds the editable switch models, renders one switch at a time, and hands
 * whole models back to the main process to translate into bridge writes.
 *
 * Rendering rule: never rebuild a control the user is interacting with. A `change` handler
 * mutates state, then repaints only the smallest region affected, and does so on a later
 * task (setTimeout 0) so the native <select> popup has finished its own lifecycle first.
 * Tearing down the select inside its own change handler is what makes a dropdown feel like
 * it "won't let you pick anything".
 */

const $ = (sel) => document.querySelector(sel);
const el = (tag, props = {}, children = []) => {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(props)) {
    if (k === 'class') node.className = v;
    else if (k === 'text') node.textContent = v;
    else if (k.startsWith('on')) node.addEventListener(k.slice(2).toLowerCase(), v);
    else node.setAttribute(k, v);
  }
  for (const c of [].concat(children)) if (c) node.appendChild(c);
  return node;
};

/** Run a DOM rebuild after the current event finishes unwinding. */
const soon = (fn) => setTimeout(fn, 0);

const state = {
  catalog: null,
  switches: [],   // live, edited
  pristine: [],   // deep copy as loaded, for revert + dirty check
  selected: null,
  connection: null,
};

const clone = (v) => JSON.parse(JSON.stringify(v));

// ---------------------------------------------------------------------------
// action vocabulary
// ---------------------------------------------------------------------------

const SHORT_ACTIONS = [
  { value: 'none', label: 'Do nothing' },
  { value: 'scene', label: 'Activate scene' },
  { value: 'toggle_scene', label: 'Toggle scene (press again = off)' },
  { value: 'off', label: 'Turn off a zone' },
  { value: 'off_home', label: 'Turn off everything (whole home)' },
];

const HOLD_MODES = [
  { value: 'none', label: 'Do nothing' },
  { value: 'dim_up', label: 'Dim up while held' },
  { value: 'dim_down', label: 'Dim down while held' },
  { value: 'action', label: 'Run an action…' },
];

// Buttons 5/6 are v1 rules, which cannot express a toggle (no state test).
const COMBO_ACTIONS = SHORT_ACTIONS.filter((a) => a.value !== 'toggle_scene');

function toast(message, kind = '') {
  const node = $('#toast');
  node.textContent = message;
  node.className = `toast ${kind}`;
  clearTimeout(toast._t);
  toast._t = setTimeout(() => node.classList.add('hidden'), 4200);
}

// ---------------------------------------------------------------------------
// connect screen
// ---------------------------------------------------------------------------

function showConnectError(message) {
  const node = $('#connect-error');
  node.textContent = message;
  node.classList.remove('hidden');
}

async function boot() {
  try {
    const res = await window.hue.status();
    if (res.ok && res.data.connected) {
      state.connection = res.data;
      await enterEditor();
    } else {
      $('#connect').classList.remove('hidden');
    }
  } catch (err) {
    $('#connect').classList.remove('hidden');
    showConnectError(`Startup failed: ${err && err.message ? err.message : err}`);
  }
}

$('#btn-discover').addEventListener('click', async () => {
  $('#connect-error').classList.add('hidden');
  const btn = $('#btn-discover');
  btn.disabled = true;
  btn.textContent = 'Searching…';
  const res = await window.hue.discover();
  btn.disabled = false;
  btn.textContent = 'Find my bridge';

  const list = $('#discover-list');
  list.textContent = '';
  if (!res.ok || !res.data.length) {
    showConnectError('No bridge found automatically. Enter its IP address instead — the Hue app shows it under Settings → Bridge.');
    return;
  }
  for (const b of res.data) {
    list.appendChild(
      el('li', {}, [
        el('div', {}, [
          el('div', { text: b.name || 'Hue Bridge' }),
          el('div', { class: 'mono muted', text: `${b.host}${b.modelId ? ` · ${b.modelId}` : ''}` }),
        ]),
        el('button', { class: 'primary', onclick: () => beginPair(b) }, [document.createTextNode('Select')]),
      ])
    );
  }
});

$('#btn-probe').addEventListener('click', async () => {
  const host = $('#input-host').value.trim();
  if (!host) return;
  $('#connect-error').classList.add('hidden');
  const res = await window.hue.probe(host);
  if (!res.ok) return showConnectError(`Couldn't reach a Hue bridge at ${host}.\n${res.error}`);
  beginPair(res.data);
});

function beginPair(target) {
  $('#pair-name').textContent = target.name || 'Hue Bridge';
  $('#pair-host').textContent = `${target.host}${target.bridgeId ? ` · ${target.bridgeId}` : ''}`;
  $('#btn-pair').dataset.host = target.host;
  $('#connect-step-find').classList.add('hidden');
  $('#connect-step-pair').classList.remove('hidden');
  $('#connect-error').classList.add('hidden');
}

$('#btn-pair-back').addEventListener('click', () => {
  $('#connect-step-pair').classList.add('hidden');
  $('#connect-step-find').classList.remove('hidden');
});

$('#btn-pair').addEventListener('click', async () => {
  const host = $('#btn-pair').dataset.host;
  $('#btn-pair').disabled = true;
  const res = await window.hue.pair(host);
  $('#btn-pair').disabled = false;

  if (!res.ok) {
    showConnectError(
      res.kind === 'link-button'
        ? "The bridge says the link button wasn't pressed. Press it, then try again within 30 seconds."
        : res.error
    );
    return;
  }
  state.connection = res.data;
  $('#connect').classList.add('hidden');
  await enterEditor();
});

// ---------------------------------------------------------------------------
// editor
// ---------------------------------------------------------------------------

async function enterEditor() {
  $('#connect').classList.add('hidden');
  $('#editor').classList.remove('hidden');
  await loadData();
}

async function loadData() {
  const res = await window.hue.load();
  if (!res.ok) return toast(res.error, 'bad');

  state.catalog = res.data.catalog;
  state.switches = res.data.switches;
  state.pristine = clone(res.data.switches);
  if (!state.selected || !state.switches.some((s) => s.deviceId === state.selected)) {
    state.selected = state.switches.length ? state.switches[0].deviceId : null;
  }
  renderConnInfo();
  renderSwitchList();
  renderSwitch();
}

function renderConnInfo() {
  const c = state.connection || {};
  $('#conn-info').textContent =
    `${c.host || '?'}\n${c.bridgeId || ''}\nkey ${c.keyEncrypted ? 'encrypted (DPAPI)' : 'stored in plaintext'}`;
}

const current = () => state.switches.find((s) => s.deviceId === state.selected) || null;
const pristineOf = (id) => state.pristine.find((s) => s.deviceId === id) || null;
const isDirty = (sw) => !!sw && JSON.stringify(sw) !== JSON.stringify(pristineOf(sw.deviceId));

function renderSwitchList() {
  const list = $('#switch-list');
  list.textContent = '';
  for (const sw of state.switches) {
    list.appendChild(
      el('li', {
        class: `${sw.deviceId === state.selected ? 'active' : ''} ${isDirty(sw) ? 'has-dirty' : ''}`,
        onclick: () => {
          if (sw.deviceId === state.selected) return;
          state.selected = sw.deviceId;
          renderSwitchList();
          renderSwitch();
        },
      }, [
        el('span', { class: 'sw-name', text: sw.name || '(unnamed)' }),
        el('span', { class: 'sw-sub', text: `${sw.buttons.length} buttons · ${sw.modelId}` }),
      ])
    );
  }
  if (!state.switches.length) {
    list.appendChild(el('li', { class: 'muted', text: 'No switches found on this bridge.' }));
  }
}

// ── catalog lookups ────────────────────────────────────────────────────────

const scenesForGroup = (groupId) =>
  !groupId ? state.catalog.scenes : state.catalog.scenes.filter((s) => s.groupId === groupId);

function groupOfScene(sceneId) {
  const s = state.catalog.scenes.find((x) => x.id === sceneId);
  return s ? s.groupId : null;
}

function nameOfGroup(id) {
  const g = state.catalog.groups.find((x) => x.id === id);
  return g ? g.name : '?';
}

const groupOptions = () =>
  state.catalog.groups.map((g) => ({ value: g.id, label: `${g.name} (${g.rtype})` }));

function selectEl(options, value, onChange, { placeholder = null } = {}) {
  const sel = el('select');
  if (placeholder) sel.appendChild(el('option', { value: '', text: placeholder }));
  for (const opt of options) sel.appendChild(el('option', { value: opt.value, text: opt.label }));
  sel.value = value == null ? '' : String(value);
  // 'change' fires once the native popup has committed a choice.
  sel.addEventListener('change', () => onChange(sel.value));
  return sel;
}

const field = (labelText, control) => el('div', { class: 'field' }, [el('label', { text: labelText }), control]);

// ── one event editor (short press, or the hold action) ─────────────────────

/**
 * Paints the controls for a single event into `host`. `spec` is mutated in place.
 * `repaint` re-runs this function; `notify` refreshes badges/validation only.
 */
function paintEventFields(host, spec, { actions, zoneLabel, repaint, notify }) {
  host.textContent = '';

  host.appendChild(
    field('Action', selectEl(actions, spec.action, (value) => {
      spec.action = value;
      if (value === 'off' || value === 'off_home' || value === 'none') spec.sceneId = null;
      if (value === 'none' || value === 'off_home') spec.groupId = null;
      notify();
      soon(repaint); // the set of visible fields depends on the action
    }))
  );

  if (spec.action === 'scene' || spec.action === 'toggle_scene') {
    const zoneValue = spec.groupId || groupOfScene(spec.sceneId) || '';

    host.appendChild(
      field(zoneLabel, selectEl(groupOptions(), zoneValue, (value) => {
        spec.groupId = value || null;
        // Drop a scene that no longer belongs to the chosen zone.
        if (spec.sceneId && groupOfScene(spec.sceneId) !== value) spec.sceneId = null;
        notify();
        soon(repaint); // the scene list is filtered by this
      }, { placeholder: 'All zones and rooms…' }))
    );

    const options = scenesForGroup(zoneValue).map((s) => ({
      value: s.id,
      label: zoneValue ? s.name : `${s.name} — ${nameOfGroup(s.groupId)}`,
    }));
    host.appendChild(
      field('Scene', selectEl(options, spec.sceneId || '', (value) => {
        spec.sceneId = value || null;
        notify(); // nothing else depends on this, so no repaint at all
      }, { placeholder: options.length ? 'Pick a scene…' : 'No scenes in this zone' }))
    );
  } else if (spec.action === 'off') {
    host.appendChild(
      field('Zone or room to turn off', selectEl(groupOptions(), spec.groupId || '', (value) => {
        spec.groupId = value || null;
        notify();
      }, { placeholder: 'Pick a zone…' }))
    );
  }
}

function renderButtonCard(sw, button) {
  const shortBadge = el('span', { class: 'zone-badge' });
  const holdBadge = el('span', { class: 'zone-badge' });
  const shortHost = el('div', { class: 'event-body' });
  const holdHost = el('div', { class: 'event-body' });

  const notify = () => {
    shortBadge.textContent = describeTarget(button.short);
    holdBadge.textContent = button.supportsHold ? describeHold(button.hold) : 'not available';
    refreshStatus();
  };

  const paintShort = () =>
    paintEventFields(shortHost, button.short, {
      actions: button.kind === 'combo' ? COMBO_ACTIONS : SHORT_ACTIONS,
      zoneLabel: 'Zone (the scene’s own zone — this is the target)',
      repaint: paintShort,
      notify,
    });

  // The hold column owns a mode select plus, optionally, a nested event editor.
  const paintHold = () => {
    holdHost.textContent = '';

    if (!button.supportsHold) {
      holdHost.appendChild(
        el('p', {
          class: 'unsupported',
          text:
            'Hold isn’t available on this button. Buttons 5 and 6 are driven by legacy rules that ' +
            'match a single event code — telling a hold apart from a tap would need a timer state ' +
            'machine on the bridge, which this version doesn’t build.',
        })
      );
      return;
    }

    holdHost.appendChild(
      field('While held', selectEl(HOLD_MODES, button.hold.mode, (value) => {
        button.hold.mode = value;
        if (value !== 'action') { button.hold.action = 'none'; button.hold.sceneId = null; }
        if (value === 'action' && button.hold.action === 'none') button.hold.action = 'scene';
        if (value === 'none') button.hold.groupId = null;
        notify();
        soon(paintHold);
      }))
    );

    if (button.hold.mode === 'dim_up' || button.hold.mode === 'dim_down') {
      holdHost.appendChild(
        field('Zone or room to dim', selectEl(groupOptions(), button.hold.groupId || '', (value) => {
          button.hold.groupId = value || null;
          notify();
        }, { placeholder: 'Pick a zone…' }))
      );
    } else if (button.hold.mode === 'action') {
      // Present hold.{action,groupId,sceneId} through the same shape as a short press.
      const holdSpec = {
        get action() { return button.hold.action; },
        set action(v) { button.hold.action = v; },
        get groupId() { return button.hold.groupId; },
        set groupId(v) { button.hold.groupId = v; },
        get sceneId() { return button.hold.sceneId; },
        set sceneId(v) { button.hold.sceneId = v; },
      };
      const nested = el('div', { class: 'event-body' });
      holdHost.appendChild(nested);
      const paintNested = () =>
        paintEventFields(nested, holdSpec, {
          actions: SHORT_ACTIONS.filter((a) => a.value !== 'none'),
          zoneLabel: 'Zone (can differ from short press)',
          repaint: paintNested,
          notify,
        });
      paintNested();
    }
  };

  paintShort();
  paintHold();
  notify();

  return el('div', { class: `btn-card ${button.kind === 'combo' ? 'combo' : ''}` }, [
    el('div', { class: 'btn-card-head' }, [
      el('span', { class: 'btn-index', text: String(button.index) }),
      el('span', { class: 'btn-title', text: button.label }),
      el('span', {
        class: 'btn-hint',
        text: button.kind === 'combo' ? `v1 rule · buttonevent ${button.releaseCode}` : 'behavior_instance',
      }),
    ]),
    el('div', { class: 'events' }, [
      el('div', { class: 'event' }, [
        el('div', { class: 'event-label' }, [document.createTextNode('Short press'), shortBadge]),
        shortHost,
      ]),
      el('div', { class: 'event' }, [
        el('div', { class: 'event-label' }, [document.createTextNode('Hold'), holdBadge]),
        holdHost,
      ]),
    ]),
  ]);
}

function describeTarget(spec) {
  if (spec.action === 'none') return 'nothing';
  if (spec.action === 'off_home') return 'whole home';
  if (spec.action === 'off') return spec.groupId ? nameOfGroup(spec.groupId) : 'pick a zone';
  const g = groupOfScene(spec.sceneId);
  return g ? nameOfGroup(g) : 'pick a scene';
}

function describeHold(hold) {
  if (hold.mode === 'none') return 'nothing';
  if (hold.mode === 'dim_up' || hold.mode === 'dim_down') {
    return `${hold.mode === 'dim_up' ? 'dim up' : 'dim down'} · ${hold.groupId ? nameOfGroup(hold.groupId) : 'pick a zone'}`;
  }
  if (hold.action === 'off_home') return 'whole home';
  if (hold.action === 'off') return hold.groupId ? nameOfGroup(hold.groupId) : 'pick a zone';
  const g = groupOfScene(hold.sceneId);
  return g ? nameOfGroup(g) : 'pick a scene';
}

/** Full rebuild — only on switch selection, load, or revert. Never from a change handler. */
function renderSwitch() {
  const sw = current();
  const container = $('#buttons');
  container.textContent = '';

  if (!sw) {
    $('#sw-name').textContent = '—';
    $('#sw-meta').textContent = '';
    return;
  }

  $('#sw-name').textContent = sw.name || '(unnamed)';
  $('#sw-meta').textContent =
    `${sw.productName || sw.modelId} · ${sw.deviceId}${sw.sensorId ? ` · v1 sensor ${sw.sensorId}` : ''}`;

  for (const button of sw.buttons) container.appendChild(renderButtonCard(sw, button));
  refreshStatus();
}

/** Lightweight: dirty markers, save button, validation panel. Touches no form control. */
let statusToken = 0;
async function refreshStatus() {
  const sw = current();
  if (!sw) return;
  const dirty = isDirty(sw);
  $('#dirty-flag').classList.toggle('hidden', !dirty);

  const li = [...document.querySelectorAll('#switch-list li')][state.switches.indexOf(sw)];
  if (li) li.classList.toggle('has-dirty', dirty);

  const token = ++statusToken;
  const res = await window.hue.validate(sw, state.catalog);
  if (token !== statusToken) return; // a newer edit already superseded this check

  const issues = res.ok ? res.data.issues : [res.error];
  const box = $('#issues');
  if (issues.length) {
    box.textContent = '';
    box.appendChild(el('strong', { text: 'Needs attention before saving:' }));
    box.appendChild(el('ul', {}, issues.map((i) => el('li', { text: i }))));
    box.classList.remove('hidden');
  } else {
    box.classList.add('hidden');
  }
  $('#btn-save').disabled = issues.length > 0 || !dirty;
}

// ---------------------------------------------------------------------------
// toolbar
// ---------------------------------------------------------------------------

$('#btn-save').addEventListener('click', async () => {
  const sw = current();
  if (!sw) return;
  $('#btn-save').disabled = true;
  const res = await window.hue.save(sw, state.catalog);
  if (!res.ok) {
    toast(res.error, 'bad');
    refreshStatus();
    return;
  }
  if (res.data.blocked) {
    toast('Not saved — see the issues above.', 'bad');
    refreshStatus();
    return;
  }
  const log = $('#log');
  log.textContent = res.data.log.join('\n');
  log.classList.remove('hidden');
  toast(`Saved ${sw.name}.`, 'ok');
  await loadData();
});

$('#btn-revert').addEventListener('click', () => {
  const sw = current();
  if (!sw) return;
  state.switches[state.switches.indexOf(sw)] = clone(pristineOf(sw.deviceId));
  renderSwitchList();
  renderSwitch();
  toast('Reverted to what is on the bridge.');
});

$('#btn-reload').addEventListener('click', async () => {
  if (state.switches.some(isDirty) && !confirm('You have unsaved changes. Reload from the bridge and discard them?')) return;
  await loadData();
  toast('Reloaded from bridge.');
});

$('#btn-backup').addEventListener('click', async () => {
  const res = await window.hue.backupFull();
  toast(res.ok ? `Backed up to ${res.data.file}` : res.error, res.ok ? 'ok' : 'bad');
});

$('#btn-reveal').addEventListener('click', () => window.hue.backupReveal());

$('#btn-restore').addEventListener('click', async () => {
  const res = await window.hue.backupRestore();
  if (!res.ok) return toast(res.error, 'bad');
  if (res.data.cancelled) return;
  const log = $('#log');
  log.textContent = res.data.log.join('\n');
  log.classList.remove('hidden');
  await loadData();
  toast('Restore complete.', 'ok');
});

window.addEventListener('error', (e) => toast(`Unexpected error: ${e.message}`, 'bad'));
window.addEventListener('unhandledrejection', (e) => toast(`Unexpected error: ${e.reason && e.reason.message ? e.reason.message : e.reason}`, 'bad'));

boot();
