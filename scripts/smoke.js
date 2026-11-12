'use strict';
// UI smoke test: starts the app against a throwaway data folder, opens a scratch SQLite database in a
// workspace, and fails when a window reports an error. Screenshots land in the folder printed at the end.
//   npm run smoke
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const root = path.join(__dirname, '..');
const out = fs.mkdtempSync(path.join(os.tmpdir(), 'chairminus-smoke-'));
const env = { ...process.env, CHAIRMINUS_USER_DATA: path.join(out, 'user-data'), CHAIRMINUS_SMOKE: path.join(__dirname, 'smoke-hook.js'), CHAIRMINUS_SMOKE_OUT: out };
delete env.ELECTRON_RUN_AS_NODE;

const r = spawnSync(require('electron'), [root], { env, stdio: 'inherit', timeout: 60000 });
const reportFile = path.join(out, 'report.json');
if (!fs.existsSync(reportFile)) { console.error(`Smoke test did not finish (exit ${r.status}).`); process.exit(1); }
const report = JSON.parse(fs.readFileSync(reportFile, 'utf8'));
console.log(JSON.stringify(report, null, 2));
console.log(`Screenshots: ${out}`);
process.exit(report.problems.length ? 1 : 0);
