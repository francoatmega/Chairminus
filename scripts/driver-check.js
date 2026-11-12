'use strict';
// Checks, inside Electron's Node, that every database driver loads and that the built-in SQLite driver works
// end to end on an in-memory database. Runs with `npm run check:drivers`.
const { app } = require('electron');

async function main() {
  const { DRIVERS } = require('../src/main/session');
  let failed = false;
  for (const [name, Impl] of Object.entries(DRIVERS)) console.log(`ok    ${name.padEnd(14)} ${Impl.name}`);

  const { SqliteDriver } = require('../src/main/drivers/sqlite');
  const driver = new SqliteDriver({ path: ':memory:' }, () => {});
  try {
    await driver.connect();
    await driver.query('CREATE TABLE t (id INTEGER PRIMARY KEY, name TEXT)');
    await driver.query("INSERT INTO t (name) VALUES ('a'), ('b')");
    const result = await driver.query('SELECT count(*) AS n FROM t');
    const n = Number(result.rows[0][0]);
    if (n !== 2) throw new Error(`expected 2 rows, got ${n}`);
    console.log(`ok    sqlite round trip (SQLite ${driver.version})`);
  } catch (e) {
    failed = true;
    console.error(`FAIL  sqlite round trip: ${e.message}`);
  } finally {
    await driver.disconnect();
  }
  console.log(`Electron ${process.versions.electron}, Node ${process.versions.node}`);
  return failed ? 1 : 0;
}

app.whenReady().then(main).then((code) => app.exit(code), (e) => { console.error(e); app.exit(1); });
