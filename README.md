# Chairminus

A desktop database client for PostgreSQL, MySQL, MariaDB, SQLite, MongoDB, Redis, Elasticsearch, OpenSearch and Neo4j. It runs on macOS and Windows and is built with Electron.

Browse and edit data in a spreadsheet-like grid, write queries in each engine's own language, and keep every connection in one place.

## Features

- **One app for nine engines.** SQL databases get a SQL editor. MongoDB gets shell syntax (`db.coll.find(…)`), Redis gets commands, Elasticsearch and OpenSearch get console requests (`GET /index/_search`), and Neo4j gets Cypher.
- **Edit data in place.** Change cells and insert, duplicate or delete rows. Edits stay pending until you commit them, and you can preview the SQL first.
- **Filter, sort and page** through large tables without writing a query.
- **Query editor.** Syntax highlighting, autocompletion and SQL formatting. Run the statement under the cursor, or every statement.
- **Query history and saved snippets** for every connection, also listed on the start screen.
- **Import and export.** Export a result or a table as CSV, JSON, SQL or Markdown. Import CSV, TSV or JSON files, and run scripts: `.sql`, `.cypher`, MongoDB `.js`, `.redis` or Elasticsearch `.es`.
- **Safe modes** for each connection: send queries without asking, confirm every query or only writes, or ask for the database password first.
- **Connections your way.** Connect over SSH (with a password, a private key or the SSH agent) or with TLS and client certificates. You can also paste a connection URL, such as `postgresql://user@host/db` or `mongodb+srv://…`.
- **Passwords stay on your machine.** They are encrypted with the operating system's protected storage: the Keychain on macOS, your Windows account (DPAPI) on Windows. They can also be asked for every time, or read from a command such as a password manager CLI.
- **Organize connections** with groups, environment tags (local, staging, production…) and favorites.
- **Light and dark themes**, following the system by default.

## Getting started

You need [Node.js](https://nodejs.org) 22 or newer.

```sh
npm install
npm start
```

`npm start` builds the interface and opens the app.

> **Already have Chairminus installed?** Quit it before running `npm start`. Both copies share the same data folder, so only one can run at a time. While the installed app is open, `npm start` just brings its window to the front. To use a separate data folder instead, set `CHAIRMINUS_USER_DATA`:
>
> ```sh
> CHAIRMINUS_USER_DATA=/tmp/chairminus-dev npm start
> ```

## Building the app

| Command | Output | Runs on |
|---|---|---|
| `npm run dist:mac` | `dist/Chairminus-<version>-<arch>.dmg` | macOS |
| `npm run dist:win` | `dist/Chairminus-<version>-win32-x64.zip` (portable: unzip and run `Chairminus.exe`) | macOS or Windows |
| `npm run dist` | The app folder for the current system, in `dist/` | macOS or Windows |

Set `CHAIRMINUS_ARCH=x64` or `arm64` to build for another processor than the current one.

The builds are not signed with a developer certificate, so macOS Gatekeeper and Windows SmartScreen warn when the app is opened for the first time.

To redraw the app icons from the logo in `src/shared/logo.js`, run `npm run icon`. It writes `build/icon.ico`, and on macOS also `build/icon.icns`.

## Test databases

`test/seeds` holds a Docker Compose file with a ready-to-use database for every engine except SQLite. Each one is filled with the same sample store ("loja"): customers, products, orders and reviews.

```sh
cd test/seeds
docker compose up -d      # start and seed everything
docker compose down       # stop and discard the data; the next "up" seeds again
```

| Engine | Address | User | Password |
|---|---|---|---|
| PostgreSQL | 127.0.0.1:55432 | postgres | secret |
| MySQL | 127.0.0.1:53306 | root | secret |
| MariaDB | 127.0.0.1:53307 | root | secret |
| MongoDB | 127.0.0.1:57017 | root | secret (auth database `admin`) |
| Redis | 127.0.0.1:56379 | — | secret |
| Elasticsearch | 127.0.0.1:59200 | elastic | secret |
| OpenSearch | 127.0.0.1:59201 | — | — |
| Neo4j | 127.0.0.1:57687 | neo4j | secretsecret |

The database is `loja` wherever an engine has one. More details are in the header of `test/seeds/docker-compose.yml`.

## Checks

```sh
npm test               # unit tests for the shared modules
npm run check:drivers  # every database driver loads inside Electron; SQLite round trip
npm run smoke          # opens the app against a scratch database and reports window errors
```

## Project layout

```
src/
  main/        Electron main process: windows, menus, IPC, saved connections, password storage
    drivers/   one driver per engine, behind a common interface (base.js)
  preload/     the bridge the interface uses to talk to the main process
  renderer/    the interface: index.html, styles.css and src/ (bundled by esbuild)
  shared/      code used on both sides: SQL dialects, tokenizer, filters, formatting, query parsers
scripts/       build, packaging (.dmg, Windows zip), icons and checks
test/          unit tests and the seeded test databases
```

## License

See [LICENSE](LICENSE).
