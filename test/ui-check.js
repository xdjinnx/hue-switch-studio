'use strict';

/**
 * Headless UI check. Loads the real renderer against fixture data, then inspects and
 * drives the controls the way a user would.
 *
 * Run with:  npx electron test/ui-check.js
 */

const path = require('path');
const { app, BrowserWindow } = require('electron');

app.disableHardwareAcceleration();

const script = `
(async () => {
  const out = [];
  const sleep = (ms) => new Promise(r => setTimeout(r, ms));
  await sleep(600);

  out.push('editor visible: ' + !document.querySelector('#editor').classList.contains('hidden'));
  out.push('switches listed: ' + document.querySelectorAll('#switch-list li').length);

  const cards = document.querySelectorAll('.btn-card');
  out.push('button cards: ' + cards.length);

  const first = cards[0];
  if (!first) { out.push('NO CARDS RENDERED'); return out.join('\\n'); }

  // Is anything being clipped? A card whose scrollHeight exceeds its clientHeight is
  // cropping its own controls.
  out.push('window: ' + window.innerWidth + 'x' + window.innerHeight);
  cards.forEach((c, i) => {
    const clipped = c.scrollHeight > c.clientHeight + 1;
    out.push('  card' + (i + 1) + ' client=' + c.clientHeight + ' scroll=' + c.scrollHeight +
             (clipped ? '  <<< CLIPPED by ' + (c.scrollHeight - c.clientHeight) + 'px' : ''));
  });
  const btns = document.querySelector('#buttons');
  out.push('#buttons client=' + btns.clientHeight + ' scroll=' + btns.scrollHeight +
           ' overflowY=' + getComputedStyle(btns).overflowY);

  const selects = first.querySelectorAll('select');
  out.push('selects in card 1: ' + selects.length);
  selects.forEach((s, i) => {
    out.push('  select[' + i + '] disabled=' + s.disabled +
             ' opts=' + s.options.length +
             ' value=' + JSON.stringify(s.value) +
             ' pointerEvents=' + getComputedStyle(s).pointerEvents +
             ' visible=' + (s.offsetWidth > 0 && s.offsetHeight > 0));
  });

  // Helper: re-query a select by its label text within card 1 (the DOM is rebuilt on change).
  const byLabel = (text) => {
    const card = document.querySelectorAll('.btn-card')[0];
    return [...card.querySelectorAll('select')].find(
      (s) => s.previousElementSibling && s.previousElementSibling.textContent.includes(text)
    );
  };
  const set = async (labelText, value, what) => {
    const sel = byLabel(labelText);
    if (!sel) { out.push('!! no select labelled ' + labelText); return; }
    const has = [...sel.options].some((o) => o.value === value);
    out.push(what + ': setting "' + labelText + '" = ' + JSON.stringify(value) + ' (option exists: ' + has + ')');
    sel.value = value;
    sel.dispatchEvent(new Event('change', { bubbles: true }));
    await sleep(350);
    const again = byLabel(labelText);
    out.push('   -> after rerender value = ' + JSON.stringify(again ? again.value : '(select gone)'));
  };

  // 1. A genuinely different action
  await set('Action', 'off', 'STEP 1');
  // 2. Back to scene, then pick a different zone
  await set('Action', 'scene', 'STEP 2');
  await set('Zone', '2f6764ea-2aa6-4fb6-a2d7-d9ea322f782b', 'STEP 3 (Living room default)');
  // 3. Then a scene inside that zone
  await set('Scene', '77f29f65-f5d4-479b-a1fa-9aa01f217798', 'STEP 4 (Bright)');
  // 4. Hold -> run an action
  await set('While held', 'action', 'STEP 5');
  await sleep(300);

  const after = document.querySelectorAll('.btn-card')[0];
  const selects2 = after.querySelectorAll('select');
  out.push('after change, selects in card 1: ' + selects2.length);
  selects2.forEach((s, i) => {
    const label = s.previousElementSibling ? s.previousElementSibling.textContent : '?';
    out.push('  select[' + i + '] label="' + label + '" opts=' + s.options.length + ' value=' + JSON.stringify(s.value));
  });
  out.push('dirty flag shown: ' + !document.querySelector('#dirty-flag').classList.contains('hidden'));
  out.push('save disabled: ' + document.querySelector('#btn-save').disabled);

  const issues = document.querySelector('#issues');
  out.push('issues panel: ' + (issues.classList.contains('hidden') ? 'hidden' : issues.textContent.trim().slice(0, 300)));

  return out.join('\\n');
})()
`;

app.whenReady().then(async () => {
  const win = new BrowserWindow({
    width: 960,
    height: 790,
    show: false,
    webPreferences: {
      preload: path.join(__dirname, 'ui-preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false, // the test preload reads fixtures from disk; the real one doesn't
    },
  });

  win.webContents.on('console-message', (_e, level, message, line, src) => {
    console.log(`[renderer/${level}] ${message} (${String(src).split(/[\\/]/).pop()}:${line})`);
  });

  await win.loadFile(path.join(__dirname, '..', 'src', 'renderer', 'index.html'));

  try {
    const result = await win.webContents.executeJavaScript(script, true);
    console.log('\n===== UI CHECK =====');
    console.log(result);
    console.log('====================');
  } catch (err) {
    console.log('EXECUTE FAILED: ' + err.message);
  }
  app.exit(0);
});
