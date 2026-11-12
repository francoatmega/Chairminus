'use strict';
const mysql = require('mysql2/promise');
const { Types } = require('mysql2');
const { Driver, normalizeValue, readIfSet } = require('./base');

const TYPE_NAMES = Object.fromEntries(Object.entries(Types).filter(([k]) => /^\d+$/.test(k)).map(([k, v]) => [k, String(v).toLowerCase()]));
const SYSTEM_DBS = new Set(['information_schema', 'mysql', 'performance_schema', 'sys']);

function sslOptions(p) {
  const mode = p.sslMode || 'prefer';
  if (mode === 'disable' || mode === 'prefer') return undefined;
  const o = { rejectUnauthorized: mode === 'verify-ca' || mode === 'verify-full' };
  if (p.sslCa) o.ca = readIfSet(p.sslCa);
  if (p.sslCert) o.cert = readIfSet(p.sslCert);
  if (p.sslKey) o.key = readIfSet(p.sslKey);
  if (mode === 'verify-ca') o.checkServerIdentity = () => undefined;
  return o;
}

// JSON columns come back as text (not parsed objects) so they can be edited as written.
function typeCast(field, next) {
  if (field.type === 'JSON') return field.string('utf8');
  return next();
}

class MysqlDriver extends Driver {
  constructor(params, log) {
    super(params, log);
    this.dialect = 'mysql';
    this.hasSchemas = false;
    this.database = params.database || '';
  }

  config() {
    const p = this.params;
    const c = {
      user: p.user || undefined,
      password: p.password || undefined,
      database: this.database || undefined,
      ssl: sslOptions(p),
      connectTimeout: 15000,
      dateStrings: true,
      supportBigNumbers: true,
      bigNumberStrings: true,
      multipleStatements: false,
      charset: p.charset || 'utf8mb4',
      typeCast,
    };
    if (p.socketPath) c.socketPath = p.socketPath;
    else { c.host = p.host || 'localhost'; c.port = Number(p.port) || 3306; }
    return c;
  }

  async connect() {
    this.conn = await mysql.createConnection(this.config());
    this.conn.on('error', (e) => { this.lastError = e; });
    const v = await this.meta('SELECT VERSION() AS v, DATABASE() AS db');
    this.version = v[0].v;
    this.database = v[0].db || this.database;
  }

  async disconnect() {
    const c = this.conn;
    this.conn = null;
    if (c) await c.end().catch(() => c.destroy());
  }

  async query(sql, params = [], opts = {}) {
    if (!this.conn) throw new Error('Not connected');
    const started = Date.now();
    try {
      this.running = true;
      const [res, fieldDefs] = await this.conn.query({ sql, values: params, rowsAsArray: true });
      let out;
      if (Array.isArray(res)) {
        const fields = (fieldDefs || []).map((f) => ({ name: f.name, type: TYPE_NAMES[f.columnType] || String(f.columnType) }));
        const limit = opts.rowLimit || 0;
        const truncated = limit > 0 && res.length > limit;
        const rows = (truncated ? res.slice(0, limit) : res).map((r) => r.map(normalizeValue));
        out = { fields, rows, affected: null, command: 'SELECT', truncated };
      } else {
        out = { fields: [], rows: [], affected: res.affectedRows ?? null, command: firstWord(sql), truncated: false, info: res.info || '' };
      }
      if (!opts.quiet) this.log({ sql, params, ms: Date.now() - started, meta: !!opts.meta });
      return out;
    } catch (e) {
      if (!opts.quiet) this.log({ sql, params, ms: Date.now() - started, meta: !!opts.meta, error: e.message });
      throw e;
    } finally {
      this.running = false;
    }
  }

  async begin() { await this.query('START TRANSACTION'); }

  async cancel() {
    if (!this.conn || !this.running) return;
    const id = this.conn.threadId;
    const side = await mysql.createConnection(this.config());
    try { await side.query(`KILL QUERY ${Number(id)}`); } finally { side.end().catch(() => {}); }
  }

  async listDatabases() {
    const r = await this.query('SHOW DATABASES', [], { meta: true });
    return r.rows.map((x) => x[0]);
  }

  isSystemDatabase(name) { return SYSTEM_DBS.has(String(name).toLowerCase()); }

  async useDatabase(name) {
    await this.query(`USE ${this.q(name)}`, [], { meta: true });
    this.database = name;
  }

  async listObjects() {
    const out = { tables: [], views: [], matviews: [], sequences: [], functions: [], procedures: [] };
    if (!this.database) return out;
    const rels = await this.meta(`SELECT TABLE_NAME AS name, TABLE_TYPE AS type, TABLE_ROWS AS estimate, TABLE_COMMENT AS comment
      FROM information_schema.TABLES WHERE TABLE_SCHEMA = ? ORDER BY TABLE_NAME`, [this.database]);
    for (const r of rels) {
      const view = /VIEW/i.test(r.type);
      (view ? out.views : out.tables).push({ name: r.name, kind: view ? 'view' : 'table', estimate: r.estimate === null ? null : Number(r.estimate), comment: r.comment });
    }
    const routines = await this.meta(`SELECT ROUTINE_NAME AS name, ROUTINE_TYPE AS type FROM information_schema.ROUTINES
      WHERE ROUTINE_SCHEMA = ? ORDER BY ROUTINE_NAME`, [this.database]).catch(() => []);
    for (const r of routines) {
      const proc = /PROCEDURE/i.test(r.type);
      (proc ? out.procedures : out.functions).push({ name: r.name, kind: proc ? 'procedure' : 'function' });
    }
    return out;
  }

  async describeTable(schema, table) {
    const db = this.database;
    const cols = await this.meta(`SELECT COLUMN_NAME AS name, COLUMN_TYPE AS type, DATA_TYPE AS base, IS_NULLABLE AS nullable,
        COLUMN_DEFAULT AS dflt, COLUMN_KEY AS ckey, EXTRA AS extra, COLUMN_COMMENT AS comment,
        CHARACTER_SET_NAME AS charset, COLLATION_NAME AS collation
      FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = ? AND TABLE_NAME = ? ORDER BY ORDINAL_POSITION`, [db, table]);
    if (!cols.length) throw new Error(`Table ${table} not found`);
    const stats = await this.meta(`SELECT INDEX_NAME AS name, NON_UNIQUE AS non_unique, COLUMN_NAME AS col, INDEX_TYPE AS method
      FROM information_schema.STATISTICS WHERE TABLE_SCHEMA = ? AND TABLE_NAME = ? ORDER BY INDEX_NAME, SEQ_IN_INDEX`, [db, table]);
    const fks = await this.meta(`SELECT k.CONSTRAINT_NAME AS name, k.COLUMN_NAME AS col, k.REFERENCED_TABLE_SCHEMA AS ref_schema,
        k.REFERENCED_TABLE_NAME AS ref_table, k.REFERENCED_COLUMN_NAME AS ref_col, r.UPDATE_RULE AS on_update, r.DELETE_RULE AS on_delete
      FROM information_schema.KEY_COLUMN_USAGE k
      JOIN information_schema.REFERENTIAL_CONSTRAINTS r
        ON r.CONSTRAINT_SCHEMA = k.CONSTRAINT_SCHEMA AND r.CONSTRAINT_NAME = k.CONSTRAINT_NAME AND r.TABLE_NAME = k.TABLE_NAME
      WHERE k.TABLE_SCHEMA = ? AND k.TABLE_NAME = ? AND k.REFERENCED_TABLE_NAME IS NOT NULL
      ORDER BY k.CONSTRAINT_NAME, k.ORDINAL_POSITION`, [db, table]);
    const trg = await this.meta(`SELECT TRIGGER_NAME AS name, ACTION_TIMING AS timing, EVENT_MANIPULATION AS event, ACTION_STATEMENT AS body
      FROM information_schema.TRIGGERS WHERE EVENT_OBJECT_SCHEMA = ? AND EVENT_OBJECT_TABLE = ? ORDER BY TRIGGER_NAME`, [db, table]).catch(() => []);
    const kind = await this.meta('SELECT TABLE_TYPE AS type FROM information_schema.TABLES WHERE TABLE_SCHEMA = ? AND TABLE_NAME = ?', [db, table]);

    const indexes = [];
    for (const s of stats) {
      let ix = indexes.find((i) => i.name === s.name);
      if (!ix) {
        ix = { name: s.name, unique: Number(s.non_unique) === 0, primary: s.name === 'PRIMARY', method: s.method, columns: [], definition: '' };
        indexes.push(ix);
      }
      ix.columns.push(s.col);
    }
    const foreignKeys = [];
    for (const f of fks) {
      let fk = foreignKeys.find((x) => x.name === f.name);
      if (!fk) {
        fk = { name: f.name, columns: [], refSchema: f.ref_schema, refTable: f.ref_table, refColumns: [], onUpdate: f.on_update, onDelete: f.on_delete };
        foreignKeys.push(fk);
      }
      fk.columns.push(f.col);
      fk.refColumns.push(f.ref_col);
    }
    for (const fk of foreignKeys) {
      fk.definition = `FOREIGN KEY (${fk.columns.map((c) => this.q(c)).join(', ')}) REFERENCES ${this.q(fk.refTable)} (${fk.refColumns.map((c) => this.q(c)).join(', ')}) ON UPDATE ${fk.onUpdate} ON DELETE ${fk.onDelete}`;
    }
    const pk = indexes.find((i) => i.primary);
    const primaryKey = pk ? pk.columns : [];
    return {
      kind: kind.length && /VIEW/i.test(kind[0].type) ? 'view' : 'table',
      columns: cols.map((c) => ({
        name: c.name,
        type: c.type,
        base: c.base,
        nullable: c.nullable === 'YES',
        default: c.dflt,
        comment: c.comment,
        pk: primaryKey.includes(c.name),
        autoIncrement: /auto_increment/i.test(c.extra || ''),
        generated: /GENERATED/i.test(c.extra || ''),
        extra: c.extra || '',
        charset: c.charset,
        collation: c.collation,
        enumValues: /^(enum|set)\(/i.test(c.type) ? parseEnum(c.type) : null,
      })),
      primaryKey,
      indexes,
      foreignKeys,
      checks: [],
      triggers: trg.map((t) => ({ name: t.name, definition: `${t.timing} ${t.event}\n${t.body}` })),
    };
  }

  async ddl(schema, name, kind) {
    const what = { view: 'VIEW', function: 'FUNCTION', procedure: 'PROCEDURE' }[kind] || 'TABLE';
    const r = await this.query(`SHOW CREATE ${what} ${this.q(name)}`, [], { meta: true });
    if (!r.rows.length) return '';
    const i = r.fields.findIndex((f) => /^Create /i.test(f.name));
    return String(r.rows[0][i === -1 ? 1 : i] ?? '') + ';';
  }

  async listColumns() {
    if (!this.database) return {};
    const rows = await this.meta(`SELECT TABLE_NAME AS t, COLUMN_NAME AS c FROM information_schema.COLUMNS
      WHERE TABLE_SCHEMA = ? ORDER BY TABLE_NAME, ORDINAL_POSITION`, [this.database]);
    const out = {};
    for (const r of rows) (out[r.t] || (out[r.t] = [])).push(r.c);
    return out;
  }

  async estimateCount(schema, table) {
    const r = await this.meta('SELECT TABLE_ROWS AS n, ENGINE AS engine FROM information_schema.TABLES WHERE TABLE_SCHEMA = ? AND TABLE_NAME = ?', [this.database, table]);
    if (!r.length || r[0].n === null) return null;
    return Number(r[0].n);
  }

  async processList() {
    const r = await this.query('SHOW FULL PROCESSLIST', [], { meta: true });
    return { fields: r.fields, rows: r.rows, idColumn: 0 };
  }

  async kill(id) { await this.query(`KILL ${Number(id)}`); }

  async setForeignKeyChecks(on) { await this.query(`SET FOREIGN_KEY_CHECKS = ${on ? 1 : 0}`); }
}

function parseEnum(type) {
  const out = [];
  const re = /'((?:[^']|'')*)'/g;
  let m;
  while ((m = re.exec(type))) out.push(m[1].replace(/''/g, "'"));
  return out;
}

function firstWord(sql) {
  const m = /^\s*(?:\/\*[\s\S]*?\*\/\s*)*([A-Za-z]+)/.exec(sql);
  return m ? m[1].toUpperCase() : '';
}

module.exports = { MysqlDriver };
