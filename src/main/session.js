'use strict';
// One Session per workspace window: owns the driver, the optional SSH tunnel, the keep-alive
// timer and a queue that keeps statements of one operation together on the single connection.
const { exec } = require('child_process');
const store = require('./store');
const secrets = require('./secrets');
const { openTunnel } = require('./tunnel');
const { PostgresDriver } = require('./drivers/postgres');
const { MysqlDriver } = require('./drivers/mysql');
const { SqliteDriver } = require('./drivers/sqlite');
const { MongoDriver } = require('./drivers/mongodb');
const { RedisDriver } = require('./drivers/redis');
const { ElasticDriver } = require('./drivers/elastic');
const { Neo4jDriver } = require('./drivers/neo4j');
const { splitStatements } = require('../shared/tokenizer');
const { buildChangeStatements } = require('../shared/changes');

const KEEPALIVE_MS = 30000;
const DRIVERS = {
  postgres: PostgresDriver, mysql: MysqlDriver, mariadb: MysqlDriver, sqlite: SqliteDriver,
  mongodb: MongoDriver, redis: RedisDriver, elasticsearch: ElasticDriver, opensearch: ElasticDriver, neo4j: Neo4jDriver,
};

class NeedInput extends Error {
  constructor(what, message) { super(message || what); this.need = what; }
}

function runPasswordCommand(command) {
  return new Promise((resolve, reject) => {
    exec(command, { timeout: 15000, shell: process.platform === 'win32' ? undefined : '/bin/bash' }, (err, stdout, stderr) => {
      if (err) reject(new Error(`The password command failed: ${(stderr || err.message).trim()}`));
      else resolve(stdout.replace(/\r?\n$/, ''));
    });
  });
}

class Session {
  constructor(conn, emit) {
    this.conn = conn;
    this.emit = emit; // (channel, payload) -> renderer
    this.driver = null;
    this.tunnel = null;
    this.state = 'disconnected';
    this.queue = Promise.resolve();
    this.cancelled = false;
    this.credentials = {};
    this.logSeq = 0;
  }

  setState(state, detail) {
    this.state = state;
    this.emit('session:state', { state, detail: detail || '' });
  }

  log(entry) {
    this.emit('log', { id: ++this.logSeq, ts: Date.now(), ...entry });
  }

  /** Run fn while holding the connection; operations never interleave. */
  exclusive(fn) {
    const next = this.queue.then(fn, fn);
    this.queue = next.catch(() => {});
    return next;
  }

  async resolveCredentials(given = {}) {
    const c = this.conn;
    const out = { ...this.credentials };
    if (c.driver !== 'sqlite') {
      const mode = c.passwordMode || 'store';
      if (given.password !== undefined) out.password = given.password;
      else if (mode === 'command' && c.passwordCommand) out.password = await runPasswordCommand(c.passwordCommand);
      else if (mode === 'store') out.password = secrets.getSecret(`${c.id}:db`) || '';
      else if (out.password === undefined) throw new NeedInput('password', `Enter the password for ${c.user || 'the database user'}`);
    }
    if (c.ssh && c.ssh.enabled) {
      if (c.ssh.auth === 'key') {
        if (given.passphrase !== undefined) out.passphrase = given.passphrase;
        else if (out.passphrase === undefined) out.passphrase = secrets.getSecret(`${c.id}:sshkey`) || '';
      } else if (given.sshPassword !== undefined) out.sshPassword = given.sshPassword;
      else if (out.sshPassword === undefined) {
        out.sshPassword = secrets.getSecret(`${c.id}:ssh`);
        if (out.sshPassword === null) out.sshPassword = '';
      }
    }
    return out;
  }

  async connect(given) {
    const c = this.conn;
    const Impl = DRIVERS[c.driver];
    if (!Impl) throw new Error(`Unsupported driver: ${c.driver}`);
    const cred = await this.resolveCredentials(given);
    await this.close(true);
    this.setState('connecting');

    let host = c.host || 'localhost';
    let port = c.port || store.DEFAULT_PORTS[c.driver];
    try {
      if (c.ssh && c.ssh.enabled && c.driver !== 'sqlite') {
        try {
          this.tunnel = await openTunnel({
            host: c.ssh.host, port: c.ssh.port, user: c.ssh.user,
            password: c.ssh.auth === 'key' ? undefined : cred.sshPassword,
            keyPath: c.ssh.auth === 'key' ? c.ssh.keyPath : undefined,
            passphrase: cred.passphrase,
            dstHost: host, dstPort: port,
          });
        } catch (e) {
          if (e.needsPassphrase) throw new NeedInput('passphrase', 'Enter the private key password');
          throw e;
        }
        host = '127.0.0.1';
        port = this.tunnel.localPort;
        this.log({ sql: `-- SSH tunnel 127.0.0.1:${port} -> ${c.host || 'localhost'}:${c.port || store.DEFAULT_PORTS[c.driver]} via ${c.ssh.host}`, ms: 0, meta: true });
      }
      const params = {
        host, port, user: c.user, password: cred.password, database: this.currentDatabase || c.database,
        path: c.path, readOnly: c.readOnly, create: c.create, socketPath: c.useSocket ? c.socketPath : undefined,
        sslMode: c.sslMode, sslCa: c.sslCa, sslCert: c.sslCert, sslKey: c.sslKey,
        // certificates are issued for the real host, not for the tunnel's 127.0.0.1
        sslServerName: this.tunnel ? c.host : undefined,
        tunneled: !!this.tunnel,
        srv: c.srv, authSource: c.authSource, options: c.options, scheme: c.scheme,
      };
      const driver = new Impl(params, (entry) => this.log(entry));
      await driver.connect();
      this.driver = driver;
      this.credentials = cred;
      for (const s of splitStatements(c.startupSql || '', driver.dialect)) await driver.query(s.text, [], {});
    } catch (e) {
      await this.close(true);
      this.setState('disconnected', e.message);
      throw e;
    }
    this.setState('connected');
    this.startKeepAlive();
    return this.info();
  }

  info() {
    const d = this.driver;
    return {
      id: this.conn.id,
      name: this.conn.name,
      driver: this.conn.driver,
      dialect: d.dialect,
      sql: d.sql,
      product: d.product || '',
      version: d.version,
      database: d.database,
      hasSchemas: d.hasSchemas,
      hasDatabases: d.hasDatabases,
      replica: !!d.replica,
      safeMode: Number(this.conn.safeMode) || 0,
      environment: this.conn.environment || '',
      color: this.conn.color || '',
      canProcessList: d.canProcessList && d.dialect !== 'sqlite',
      canImport: d.canImport,
      transactional: d.transactional,
    };
  }

  startKeepAlive() {
    clearInterval(this.timer);
    this.timer = setInterval(() => this.keepAlive(), KEEPALIVE_MS);
  }

  async keepAlive() {
    if (this.busy || !this.driver || this.state === 'connecting') return;
    try {
      await this.exclusive(() => this.driver.ping(true));
      if (this.state !== 'connected') this.setState('connected');
    } catch (e) {
      this.setState('reconnecting', e.message);
      try {
        this.currentDatabase = this.driver ? this.driver.database : this.currentDatabase;
        await this.connect();
      } catch (err) {
        this.setState('disconnected', err.message);
        this.startKeepAlive(); // keep trying on the next ticks
      }
    }
  }

  async close(keepState) {
    clearInterval(this.timer);
    const d = this.driver;
    const t = this.tunnel;
    this.driver = null;
    this.tunnel = null;
    if (d) await d.disconnect().catch(() => {});
    if (t) t.close();
    if (!keepState) this.state = 'disconnected';
  }

  need() {
    if (!this.driver) throw new Error('Not connected. Use Connection ▸ Reconnect.');
    return this.driver;
  }

  /** Wrap an operation: exclusive use of the connection plus the busy flag for keep-alive. */
  op(fn) {
    return this.exclusive(async () => {
      this.busy = true;
      try { return await fn(this.need()); } finally { this.busy = false; }
    });
  }

  // ---- data -------------------------------------------------------------------------------

  /** The statement behind a table page; the SQL (or native request) is built by the driver. */
  pageQuery(req, inline) {
    return this.need().pageQuery(req, inline);
  }

  filterPreview(req) {
    return this.need().pagePreview(req);
  }

  fetchPage(req) {
    return this.op(async (d) => {
      const limit = Math.max(1, Number(req.limit) || 300);
      const offset = Math.max(0, Number(req.offset) || 0);
      const started = Date.now();
      const r = await d.fetchPage({ ...req, limit, offset }, {});
      return { fields: r.fields, rows: r.rows, ms: Date.now() - started };
    });
  }

  count(req) {
    return this.op(async (d) => {
      if (!req.exact && !d.pageQuery(req).filtered) {
        const est = await d.estimateCount(req.schema, req.table);
        const threshold = store.getSettings().estimateThreshold;
        if (est !== null && est > threshold) return { count: est, estimated: true };
      }
      const n = await d.countRows(req);
      // A driver that cannot count everything says so itself.
      return typeof n === 'object' ? n : { count: n, estimated: false };
    });
  }

  /** Run user statements one after another; stops at the first error. */
  run({ statements, rowLimit, record = true }) {
    this.cancelled = false;
    return this.op(async (d) => {
      const results = [];
      for (const sql of statements) {
        if (this.cancelled) { results.push({ sql, ok: false, error: 'Cancelled', ms: 0 }); break; }
        const started = Date.now();
        let entry;
        try {
          const r = await d.query(sql, [], { rowLimit });
          entry = { sql, ok: true, ms: Date.now() - started, ...r };
        } catch (e) {
          entry = { sql, ok: false, ms: Date.now() - started, error: e.message };
        }
        results.push(entry);
        if (record && this.conn.id) {
          try { store.appendHistory(this.conn.id, { ts: Date.now(), sql, ms: entry.ms, ok: entry.ok, error: entry.error, db: d.database }); } catch { /* history is best effort */ }
        }
        if (!entry.ok) break;
      }
      return results;
    });
  }

  async cancel() {
    this.cancelled = true;
    if (this.driver) await this.driver.cancel();
  }

  /**
   * Apply grid changes in one transaction. An UPDATE/DELETE that would touch anything other
   * than exactly one row rolls everything back and reports why. Where the database has no
   * transaction to roll back, the result says how many changes had already been applied.
   */
  applyChanges(req) {
    return this.op(async (d) => {
      const statements = buildChangeStatements({ ...req, dialect: d.dialect, schema: d.hasSchemas ? req.schema : null });
      if (!statements.length) return { ok: true, applied: 0 };
      if (store.getSettings().logOriginalValues) {
        for (const ch of req.changes) {
          if (ch.type !== 'insert') this.log({ sql: `-- original values: ${JSON.stringify(ch.original)}`, ms: 0 });
        }
      }
      let done = 0;
      const refused = (extra) => ({ ok: false, ...extra, applied: d.transactional ? 0 : done });
      await d.begin();
      try {
        for (const st of statements) {
          const r = await d.query(st.sql, [], st.opts || {});
          const affected = st.countInResult ? Number(r.rows.length ? r.rows[0][0] : 0) : r.affected;
          if (st.single && affected !== null && affected !== 1) {
            await d.rollback();
            return refused({ reason: affected > 1 ? 'multiple' : 'missing', affected, sql: st.sql, usesPrimaryKey: !!st.usesPrimaryKey });
          }
          done++;
        }
        await d.commit();
      } catch (e) {
        await d.rollback().catch(() => {});
        if (d.transactional || !done) throw e;
        return refused({ reason: 'error', error: e.message });
      }
      return { ok: true, applied: statements.length };
    });
  }
}

module.exports = { Session, NeedInput, DRIVERS };
