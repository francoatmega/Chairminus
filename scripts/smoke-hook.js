'use strict';
// Loaded by src/main/main.js when CHAIRMINUS_SMOKE points here (development only). See scripts/smoke.js.
const fs = require('fs');
const path = require('path');
const { app, BrowserWindow } = require('electron');
const { DatabaseSync } = require('node:sqlite');

const out = process.env.CHAIRMINUS_SMOKE_OUT;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

module.exports = async ({ showWelcome, openWorkspace, ipc }) => {
  const problems = [];
  let phase = 'start';
  const watch = (win, label) => {
    win.webContents.on('console-message', (event) => {
      if (event.level === 'error') problems.push(`${label} (${phase}): ${event.message} [${event.sourceId}:${event.lineNumber}]`);
    });
    win.webContents.on('render-process-gone', (e, details) => problems.push(`${label}: renderer gone (${details.reason})`));
  };
  const inspect = async (win, label) => {
    const state = await win.webContents.executeJavaScript(`({
      fatal: document.querySelector('pre.fatal')?.textContent || null,
      elements: document.querySelectorAll('#app *').length,
      text: document.body.innerText.slice(0, 400),
    })`);
    if (state.fatal) problems.push(`${label}: ${state.fatal}`);
    if (!state.elements) problems.push(`${label}: nothing rendered`);
    fs.writeFileSync(path.join(out, `${label}.png`), (await win.webContents.capturePage()).toPNG());
    return state;
  };

  const report = { problems };
  try {
    const welcome = showWelcome();
    watch(welcome, 'welcome');

    const dbFile = path.join(out, 'scratch.sqlite');
    const db = new DatabaseSync(dbFile);
    db.exec(`CREATE TABLE people (id INTEGER PRIMARY KEY, name TEXT NOT NULL, age INTEGER, joined TEXT);
      INSERT INTO people (name, age, joined) VALUES ('Ada', 36, '2024-01-05'), ('Linus', 54, '2023-11-20'), ('Grace', 85, NULL);
      CREATE VIEW adults AS SELECT * FROM people WHERE age >= 18;`);
    db.close();

    const workspace = openWorkspace(ipc.adhocSqlite(dbFile));
    watch(workspace, 'workspace');
    await sleep(2500);
    phase = 'loaded';
    report.welcome = await inspect(welcome, 'welcome');
    report.workspace = await inspect(workspace, 'workspace');

    // Open a table, then a query tab.
    phase = 'open table';
    report.opened = await workspace.webContents.executeJavaScript(`(async () => {
      await window.app.openTable(null, 'people', 'table', { pin: true });
      return true;
    })()`).catch((e) => { problems.push('workspace: openTable failed: ' + e.message); return false; });
    await sleep(1500);
    report.table = await inspect(workspace, 'table');
    phase = 'new query';
    workspace.webContents.send('menu', 'new-query');
    await sleep(1200);
    report.query = await inspect(workspace, 'query');
  } catch (e) {
    problems.push(`hook: ${e.stack || e.message}`);
  }
  fs.writeFileSync(path.join(out, 'report.json'), JSON.stringify(report, null, 2));
  for (const w of BrowserWindow.getAllWindows()) w.destroy();
  app.quit();
};
