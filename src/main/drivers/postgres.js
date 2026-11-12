'use strict';
const { Client } = require('pg');
const Cursor = require('pg-cursor');
const { Driver, readIfSet } = require('./base');

// Every value arrives as the server's own text form, which keeps precision (bigint,
// numeric, timestamps) and round-trips cleanly when written back as a literal.
const RAW_TYPES = { getTypeParser: () => (v) => v };
const BOOL_OID = 16;
const SYSTEM_SCHEMAS = new Set(['pg_catalog', 'information_schema']);

function sslOptions(p) {
  const mode = p.sslMode || 'prefer';
  if (mode === 'disable') return false;
  const o = { rejectUnauthorized: mode === 'verify-ca' || mode === 'verify-full' };
  if (p.sslCa) o.ca = readIfSet(p.sslCa);
  if (p.sslCert) o.cert = readIfSet(p.sslCert);
  if (p.sslKey) o.key = readIfSet(p.sslKey);
  if (mode === 'verify-ca') o.checkServerIdentity = () => undefined;
  if (p.sslServerName) o.servername = p.sslServerName;
  return o;
}

class PostgresDriver extends Driver {
  constructor(params, log) {
    super(params, log);
    this.dialect = 'postgres';
    this.hasSchemas = true;
    this.typeNames = new Map();
    this.database = params.database || params.user || 'postgres';
  }

  clientConfig(ssl) {
    const p = this.params;
    return {
      host: p.host || 'localhost',
      port: Number(p.port) || 5432,
      user: p.user || undefined,
      password: p.password || undefined,
      database: this.database,
      ssl,
      application_name: 'Chairminus',
      connectionTimeoutMillis: 15000,
      keepAlive: true,
      types: RAW_TYPES,
    };
  }

  async openClient() {
    const mode = this.params.sslMode || 'prefer';
    const attempt = async (ssl) => {
      const c = new Client(this.clientConfig(ssl));
      c.on('error', (e) => { this.lastError = e; });
      try { await c.connect(); } catch (e) { c.end().catch(() => {}); throw e; }
      return c;
    };
    if (mode !== 'prefer') return attempt(sslOptions(this.params));
    try {
      return await attempt(sslOptions(this.params));
    } catch (e) {
      // "prefer": fall back to a plain connection only when the server has no TLS.
      if (/does not support SSL|SSL connections|ECONNRESET|EPROTO/i.test(String(e.message))) return attempt(false);
      throw e;
    }
  }

  async connect() {
    this.client = await this.openClient();
    const v = await this.meta('SHOW server_version');
    this.version = v[0].server_version;
    const types = await this.query('SELECT oid, typname FROM pg_type', [], { meta: true, quiet: true });
    this.typeNames = new Map(types.rows.map((r) => [Number(r[0]), r[1]]));
    try {
      const r = await this.meta('SELECT pg_is_in_recovery() AS replica');
      this.replica = r[0].replica === true;
    } catch { this.replica = false; }
  }

  async disconnect() {
    const c = this.client;
    this.client = null;
    if (c) await c.end().catch(() => {});
  }

  async query(sql, params = [], opts = {}) {
    if (!this.client) throw new Error('Not connected');
    const started = Date.now();
    const limit = opts.rowLimit || 0;
    const cursor = this.client.query(new Cursor(sql, params, { rowMode: 'array', types: RAW_TYPES }));
    try {
      this.running = true;
      const rows = await cursor.read(limit ? limit + 1 : 1e9);
      const res = cursor._result || {};
      const truncated = limit > 0 && rows.length > limit;
      if (truncated) rows.length = limit;
      const fields = (res.fields || []).map((f) => ({ name: f.name, type: this.typeNames.get(f.dataTypeID) || String(f.dataTypeID), oid: f.dataTypeID }));
      fields.forEach((f, i) => {
        if (f.oid !== BOOL_OID) return;
        for (const r of rows) if (r[i] !== null) r[i] = r[i] === 't';
      });
      const command = res.command || '';
      const affected = fields.length ? null : (typeof res.rowCount === 'number' ? res.rowCount : null);
      if (!opts.quiet) this.log({ sql, params, ms: Date.now() - started, meta: !!opts.meta });
      return { fields, rows, affected, command, truncated };
    } catch (e) {
      if (!opts.quiet) this.log({ sql, params, ms: Date.now() - started, meta: !!opts.meta, error: e.message });
      throw decorate(e);
    } finally {
      this.running = false;
      await cursor.close().catch(() => {});
    }
  }

  async cancel() {
    if (!this.client || !this.running) return;
    const pid = this.client.processID;
    const side = await this.openClient();
    try { await side.query('SELECT pg_cancel_backend($1)', [pid]); } finally { side.end().catch(() => {}); }
  }

  async listDatabases() {
    const rows = await this.meta('SELECT datname FROM pg_database WHERE NOT datistemplate AND datallowconn ORDER BY datname');
    return rows.map((r) => r.datname);
  }

  async useDatabase(name) {
    const previous = this.database;
    const old = this.client;
    this.database = name;
    try {
      this.client = await this.openClient();
    } catch (e) {
      this.database = previous;
      throw e;
    }
    if (old) old.end().catch(() => {});
  }

  async listSchemas() {
    const rows = await this.meta(`SELECT nspname AS name FROM pg_namespace
      WHERE nspname !~ '^pg_toast' AND nspname !~ '^pg_temp_' ORDER BY nspname`);
    return rows.map((r) => ({ name: r.name, system: SYSTEM_SCHEMAS.has(r.name) }));
  }

  async currentSchema() {
    const r = await this.meta('SELECT current_schema() AS s');
    return r[0].s || 'public';
  }

  async listObjects(schema) {
    const rels = await this.meta(`SELECT c.relname AS name, c.relkind AS kind, c.reltuples::bigint AS estimate,
        obj_description(c.oid, 'pg_class') AS comment
      FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname = $1 AND c.relkind IN ('r','p','v','m','f','S') ORDER BY c.relname`, [schema]);
    const fns = await this.meta(`SELECT p.proname AS name, pg_get_function_identity_arguments(p.oid) AS args,
        p.prokind AS kind, p.oid::text AS oid
      FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
      WHERE n.nspname = $1 AND p.prokind IN ('f','p') ORDER BY p.proname`, [schema]).catch(() => []);
    const kind = { r: 'table', p: 'table', f: 'table', v: 'view', m: 'matview', S: 'sequence' };
    const out = { tables: [], views: [], matviews: [], sequences: [], functions: [], procedures: [] };
    for (const r of rels) {
      const k = kind[r.kind];
      const item = { name: r.name, kind: k, estimate: r.estimate === null ? null : Number(r.estimate), comment: r.comment };
      (k === 'table' ? out.tables : k === 'view' ? out.views : k === 'matview' ? out.matviews : out.sequences).push(item);
    }
    for (const f of fns) {
      (f.kind === 'p' ? out.procedures : out.functions).push({ name: f.name, kind: f.kind === 'p' ? 'procedure' : 'function', args: f.args, oid: f.oid });
    }
    return out;
  }

  async describeTable(schema, table) {
    const rel = await this.meta(`SELECT c.oid::text AS oid, c.relkind AS kind FROM pg_class c
      JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = $1 AND c.relname = $2`, [schema, table]);
    if (!rel.length) throw new Error(`Relation ${schema}.${table} not found`);
    const oid = rel[0].oid;
    const cols = await this.meta(`SELECT a.attname AS name, format_type(a.atttypid, a.atttypmod) AS type,
        t.typname AS base, t.typtype AS typtype, a.atttypid::text AS typoid, NOT a.attnotnull AS nullable,
        pg_get_expr(d.adbin, d.adrelid) AS "default", a.attidentity AS identity, a.attgenerated AS generated,
        col_description(a.attrelid, a.attnum) AS comment
      FROM pg_attribute a
      JOIN pg_type t ON t.oid = a.atttypid
      LEFT JOIN pg_attrdef d ON d.adrelid = a.attrelid AND d.adnum = a.attnum
      WHERE a.attrelid = $1::oid AND a.attnum > 0 AND NOT a.attisdropped ORDER BY a.attnum`, [oid]);
    const idx = await this.meta(`SELECT ic.relname AS name, i.indisunique AS "unique", i.indisprimary AS "primary",
        am.amname AS method, pg_get_indexdef(i.indexrelid) AS definition,
        ARRAY(SELECT a.attname FROM unnest(i.indkey) WITH ORDINALITY k(attnum, ord)
              JOIN pg_attribute a ON a.attrelid = i.indrelid AND a.attnum = k.attnum ORDER BY k.ord)::text AS columns
      FROM pg_index i JOIN pg_class ic ON ic.oid = i.indexrelid JOIN pg_am am ON am.oid = ic.relam
      WHERE i.indrelid = $1::oid ORDER BY i.indisprimary DESC, ic.relname`, [oid]);
    const cons = await this.meta(`SELECT c.conname AS name, c.contype AS type, pg_get_constraintdef(c.oid) AS definition,
        ARRAY(SELECT a.attname FROM unnest(c.conkey) WITH ORDINALITY k(attnum, ord)
              JOIN pg_attribute a ON a.attrelid = c.conrelid AND a.attnum = k.attnum ORDER BY k.ord)::text AS columns,
        fn.nspname AS ref_schema, fc.relname AS ref_table,
        ARRAY(SELECT a.attname FROM unnest(c.confkey) WITH ORDINALITY k(attnum, ord)
              JOIN pg_attribute a ON a.attrelid = c.confrelid AND a.attnum = k.attnum ORDER BY k.ord)::text AS ref_columns
      FROM pg_constraint c
      LEFT JOIN pg_class fc ON fc.oid = c.confrelid LEFT JOIN pg_namespace fn ON fn.oid = fc.relnamespace
      WHERE c.conrelid = $1::oid ORDER BY c.conname`, [oid]);
    const trg = await this.meta(`SELECT tgname AS name, pg_get_triggerdef(oid) AS definition
      FROM pg_trigger WHERE tgrelid = $1::oid AND NOT tgisinternal ORDER BY tgname`, [oid]);

    const enumOids = [...new Set(cols.filter((c) => c.typtype === 'e').map((c) => c.typoid))];
    const enums = new Map();
    if (enumOids.length) {
      const ev = await this.meta(`SELECT enumtypid::text AS oid, enumlabel AS label FROM pg_enum
        WHERE enumtypid::text = ANY($1::text[]) ORDER BY enumtypid, enumsortorder`, ['{' + enumOids.join(',') + '}']);
      for (const e of ev) { if (!enums.has(e.oid)) enums.set(e.oid, []); enums.get(e.oid).push(e.label); }
    }

    const pkIndex = idx.find((i) => i.primary === true);
    const primaryKey = pkIndex ? parseArray(pkIndex.columns) : [];
    const columns = cols.map((c) => ({
      name: c.name,
      type: c.type,
      base: c.base,
      nullable: c.nullable === true,
      default: c.default,
      comment: c.comment,
      pk: primaryKey.includes(c.name),
      autoIncrement: !!c.identity || /^nextval\(/.test(c.default || ''),
      generated: !!c.generated,
      extra: c.identity === 'a' ? 'GENERATED ALWAYS AS IDENTITY' : c.identity === 'd' ? 'GENERATED BY DEFAULT AS IDENTITY' : '',
      enumValues: enums.get(c.typoid) || null,
    }));
    return {
      kind: { r: 'table', p: 'table', f: 'table', v: 'view', m: 'matview' }[rel[0].kind] || 'table',
      columns,
      primaryKey,
      indexes: idx.map((i) => ({ name: i.name, unique: i.unique === true, primary: i.primary === true, method: i.method, columns: parseArray(i.columns), definition: i.definition })),
      foreignKeys: cons.filter((c) => c.type === 'f').map((c) => ({
        name: c.name, columns: parseArray(c.columns), refSchema: c.ref_schema, refTable: c.ref_table,
        refColumns: parseArray(c.ref_columns), definition: c.definition,
      })),
      checks: cons.filter((c) => c.type === 'c').map((c) => ({ name: c.name, definition: c.definition })),
      triggers: trg,
    };
  }

  async ddl(schema, name, kind, extra = {}) {
    if (kind === 'view' || kind === 'matview') {
      const r = await this.meta(`SELECT pg_get_viewdef(c.oid, true) AS def FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
        WHERE n.nspname = $1 AND c.relname = $2`, [schema, name]);
      const head = kind === 'matview' ? 'CREATE MATERIALIZED VIEW' : 'CREATE OR REPLACE VIEW';
      return `${head} ${this.target(schema, name)} AS\n${r.length ? r[0].def : ''}`;
    }
    if (kind === 'function' || kind === 'procedure') {
      const r = await this.meta('SELECT pg_get_functiondef($1::oid) AS def', [extra.oid]);
      return r[0].def;
    }
    if (kind === 'sequence') {
      const r = await this.meta(`SELECT * FROM pg_sequences WHERE schemaname = $1 AND sequencename = $2`, [schema, name]);
      if (!r.length) return '';
      const s = r[0];
      return `CREATE SEQUENCE ${this.target(schema, name)}\n  AS ${s.data_type}\n  INCREMENT BY ${s.increment_by}\n  MINVALUE ${s.min_value}\n  MAXVALUE ${s.max_value}\n  START WITH ${s.start_value}\n  CACHE ${s.cache_size}${s.cycle === true ? '\n  CYCLE' : ''};\n\n-- last_value: ${s.last_value ?? 'not used yet'}`;
    }
    const d = await this.describeTable(schema, name);
    let out = this.createTableFromDescription(schema, name, {
      ...d,
      // identity and serial columns already carry their default in `extra`/`default`
      indexes: d.indexes.filter((i) => !i.primary),
    });
    for (const t of d.triggers) out += `\n\n${t.definition};`;
    return out;
  }

  async listColumns(schema) {
    const rows = await this.meta(`SELECT c.relname AS t, a.attname AS c FROM pg_attribute a
      JOIN pg_class c ON c.oid = a.attrelid JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname = $1 AND c.relkind IN ('r','p','v','m','f') AND a.attnum > 0 AND NOT a.attisdropped
      ORDER BY c.relname, a.attnum`, [schema]);
    const out = {};
    for (const r of rows) (out[r.t] || (out[r.t] = [])).push(r.c);
    return out;
  }

  async estimateCount(schema, table) {
    const r = await this.meta(`SELECT c.reltuples::bigint AS n FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname = $1 AND c.relname = $2`, [schema, table]);
    if (!r.length || r[0].n === null) return null;
    const n = Number(r[0].n);
    return n < 0 ? null : n;
  }

  async processList() {
    const r = await this.query(`SELECT pid, usename AS "user", datname AS database, application_name AS application,
        client_addr AS client, state, to_char(query_start, 'YYYY-MM-DD HH24:MI:SS') AS started, wait_event_type AS wait, query
      FROM pg_stat_activity WHERE pid <> pg_backend_pid() ORDER BY query_start DESC NULLS LAST`, [], { meta: true });
    return { fields: r.fields, rows: r.rows, idColumn: 0 };
  }

  async kill(id) {
    await this.query('SELECT pg_terminate_backend($1::int)', [String(id)], {});
  }
}

function parseArray(text) {
  // Postgres text[] output: {a,"b c",d}
  if (!text || text === '{}') return [];
  const out = [];
  const body = String(text).slice(1, -1);
  let cur = '';
  let quoted = false;
  for (let i = 0; i < body.length; i++) {
    const c = body[i];
    if (quoted) {
      if (c === '\\') { cur += body[++i]; }
      else if (c === '"') quoted = false;
      else cur += c;
    } else if (c === '"') quoted = true;
    else if (c === ',') { out.push(cur); cur = ''; }
    else cur += c;
  }
  out.push(cur);
  return out;
}

function decorate(e) {
  if (e && e.position && !/position/i.test(e.message)) e.message += ` (at character ${e.position})`;
  if (e && e.detail) e.message += `\n${e.detail}`;
  if (e && e.hint) e.message += `\nHint: ${e.hint}`;
  return e;
}

module.exports = { PostgresDriver, parseArray };
