'use strict';
const fs = require('fs');
const net = require('net');
const tls = require('tls');
const { quoteIdent, qualified, placeholder } = require('../../shared/dialect');
const { compileFilters } = require('../../shared/filters');

/** Make a driver value safe to send over IPC. */
function normalizeValue(v) {
  if (v === null || v === undefined) return null;
  switch (typeof v) {
    case 'string': case 'boolean': return v;
    case 'number': return Number.isFinite(v) ? v : String(v);
    case 'bigint': return v >= Number.MIN_SAFE_INTEGER && v <= Number.MAX_SAFE_INTEGER ? Number(v) : v.toString();
    case 'object':
      if (Buffer.isBuffer(v) || v instanceof Uint8Array) return { __bin: Buffer.from(v).toString('hex') };
      if (v instanceof Date) return Number.isNaN(v.getTime()) ? null : v.toISOString();
      try { return JSON.stringify(v); } catch { return String(v); }
    default: return String(v);
  }
}

function readIfSet(path) {
  return path ? fs.readFileSync(path, 'utf8') : undefined;
}

/** Node TLS options for a connection's TLS mode, or null when the mode is "disable". */
function tlsOptions(p) {
  const mode = p.sslMode || 'prefer';
  if (mode === 'disable') return null;
  const o = { rejectUnauthorized: mode === 'verify-ca' || mode === 'verify-full' };
  if (p.sslCa) o.ca = readIfSet(p.sslCa);
  if (p.sslCert) o.cert = readIfSet(p.sslCert);
  if (p.sslKey) o.key = readIfSet(p.sslKey);
  if (mode === 'verify-ca') o.checkServerIdentity = () => undefined;
  // certificates are issued for the real host, not for an SSH tunnel's 127.0.0.1
  if (p.sslServerName) o.servername = p.sslServerName;
  return o;
}

/**
 * "prefer" for protocols that cannot negotiate TLS themselves: true when the server answers a
 * TLS handshake. A server that speaks plain text fails the handshake at once.
 */
function probeTls(host, port, servername, timeout = 4000) {
  return new Promise((resolve) => {
    let socket;
    const done = (ok) => { if (socket) socket.destroy(); resolve(ok); };
    try {
      socket = tls.connect({ host, port: Number(port), servername: servername || undefined, rejectUnauthorized: false, timeout });
    } catch { resolve(false); return; }
    socket.once('secureConnect', () => done(true));
    socket.once('error', () => done(false));
    socket.once('timeout', () => done(false));
    socket.once('close', () => done(false));
  });
}

/**
 * The quicker way to the same answer where a plain-text server stays silent on a TLS hello:
 * send the protocol's own greeting and see whether the reply is in plain text.
 */
function speaksPlain(host, port, send, expect, timeout = 3000) {
  return new Promise((resolve) => {
    const socket = net.connect({ host, port: Number(port) });
    let data = '';
    const done = (ok) => { socket.destroy(); resolve(ok); };
    socket.setTimeout(timeout, () => done(false));
    socket.once('connect', () => socket.write(send));
    socket.on('data', (chunk) => {
      data += chunk.toString('latin1');
      if (expect.test(data)) done(true);
      else if (data.length >= 16) done(false);
    });
    socket.once('error', () => done(false));
    socket.once('close', () => done(false));
  });
}

/**
 * Whether to use TLS, resolving "prefer" by asking the server.
 * @param {{send:string, expect:RegExp}} [plain] the protocol's plain-text greeting and reply
 */
async function wantsTls(p, defaultPort, plain) {
  const mode = p.sslMode || 'prefer';
  if (mode === 'disable') return false;
  if (mode !== 'prefer') return true;
  const host = p.host || 'localhost';
  const port = p.port || defaultPort;
  if (plain) return !(await speaksPlain(host, port, plain.send, plain.expect));
  return probeTls(host, port, p.sslServerName);
}

/** A value inside a document, safe for JSON text (BigInt has no JSON form). */
function jsonText(v) {
  return JSON.stringify(v, (k, x) => (typeof x === 'bigint' ? (x >= Number.MIN_SAFE_INTEGER && x <= Number.MAX_SAFE_INTEGER ? Number(x) : x.toString()) : x));
}

/** A document field as a grid cell: scalars as they are, documents and arrays as JSON text. */
function cellValue(v) {
  if (v === null || v === undefined) return null;
  if (typeof v === 'object' && !(v instanceof Date) && !Buffer.isBuffer(v) && !(v instanceof Uint8Array)) return jsonText(v);
  return normalizeValue(v);
}

/**
 * Documents -> the {fields, rows} shape of a query result. Columns are the union of the
 * documents' fields, `first` ones leading, in order of first appearance.
 * @param {object[]} docs
 * @param {{first?:string[], types?:Object<string,string>}} [o]
 */
function tableFromDocuments(docs, { first = [], types = {} } = {}) {
  const names = [...first];
  const seen = new Set(names);
  for (const d of docs) {
    if (d === null || typeof d !== 'object' || Array.isArray(d)) continue;
    for (const k of Object.keys(d)) if (!seen.has(k)) { seen.add(k); names.push(k); }
  }
  const plain = docs.some((d) => d === null || typeof d !== 'object' || Array.isArray(d));
  if (plain) return { fields: [{ name: 'value', type: '' }], rows: docs.map((d) => [cellValue(d)]) };
  return {
    fields: names.map((n) => ({ name: n, type: types[n] || '' })),
    rows: docs.map((d) => names.map((n) => cellValue(d[n]))),
  };
}

/** A single document shown as rows of field / value. */
function tableFromFields(doc) {
  return { fields: [{ name: 'field', type: '' }, { name: 'value', type: '' }], rows: Object.keys(doc || {}).map((k) => [k, cellValue(doc[k])]) };
}

/** Text typed into a filter, as the value a field of this type would hold. */
function typedFilterValue(text, type) {
  const s = String(text ?? '');
  const t = String(type || '').toLowerCase();
  if (/^(bool|boolean)$/.test(t) && /^(true|false)$/i.test(s.trim())) return s.trim().toLowerCase() === 'true';
  if (/^(int|integer|long|short|byte|double|float|half_float|scaled_float|unsigned_long|decimal|number)$/.test(t) && s.trim() !== '' && Number.isFinite(Number(s))) return Number(s);
  return s;
}

/**
 * Common driver surface. Every method that talks to the server is async.
 * query() resolves to {fields:[{name,type}], rows:any[][], affected:number|null,
 * command:string, truncated:boolean}.
 */
class Driver {
  constructor(params, log) {
    this.params = params;
    this.log = log || (() => {});
    this.dialect = 'postgres';
    this.hasSchemas = false;
    this.hasDatabases = true;
    this.database = params.database || '';
    /** false for drivers whose statements are not SQL (they override the page/import methods). */
    this.sql = true;
    /** false when begin/commit cannot undo statements that already ran. */
    this.transactional = true;
    this.canProcessList = true;
    this.canImport = true;
  }

  q(name) { return quoteIdent(this.dialect, name); }
  target(schema, table) { return qualified(this.dialect, this.hasSchemas ? schema : null, table); }

  /** Run fn as one console-log entry, the way query() logs a statement. */
  async logged(sql, opts, fn) {
    const started = Date.now();
    try {
      const r = await fn();
      if (!opts.quiet) this.log({ sql, ms: Date.now() - started, meta: !!opts.meta });
      return r;
    } catch (e) {
      if (!opts.quiet) this.log({ sql, ms: Date.now() - started, meta: !!opts.meta, error: e.message });
      throw e;
    }
  }

  /** Run a metadata query and return rows as objects. */
  async meta(sql, params = []) {
    const r = await this.query(sql, params, { meta: true });
    return r.rows.map((row) => Object.fromEntries(r.fields.map((f, i) => [f.name, row[i]])));
  }

  async ping(quiet) { await this.query('SELECT 1', [], quiet ? { quiet: true } : { meta: true }); }
  async begin() { await this.query('BEGIN', [], {}); }
  async commit() { await this.query('COMMIT', [], {}); }
  async rollback() { await this.query('ROLLBACK', [], {}); }
  async listDatabases() { return []; }
  async useDatabase() { throw new Error('This driver has a single database'); }
  async listSchemas() { return []; }
  async estimateCount() { return null; }
  /** {table: [column, ...]} for the editor's completion. */
  async listColumns() { return {}; }
  async processList() { throw new Error('Process list is not available for this driver'); }
  async kill() { throw new Error('Not supported'); }
  async cancel() { /* optional */ }
  async setForeignKeyChecks() { /* optional */ }

  async count(schema, table, where, params) {
    const sql = `SELECT COUNT(*) FROM ${this.target(schema, table)}${where ? ' WHERE ' + where : ''}`;
    const r = await this.query(sql, params || [], {});
    return Number(r.rows[0][0]);
  }

  // ---- table pages --------------------------------------------------------------------------
  // The request is {schema, table, filters, sort, columns, primaryKey, limit, offset}.

  /** The statement behind a table page, without its LIMIT/OFFSET. `filtered`: a rule applies. */
  pageQuery({ schema, table, filters, sort, columns, primaryKey }, inline) {
    const where = compileFilters({ dialect: this.dialect, rules: filters || [], columns: columns || [], inline });
    let sql = `SELECT * FROM ${this.target(schema, table)}`;
    if (where.sql) sql += ` WHERE ${where.sql}`;
    const order = (sort && sort.length ? sort : (primaryKey || []).map((c) => ({ column: c, dir: 'asc' })));
    if (order.length) sql += ' ORDER BY ' + order.map((s) => `${this.q(s.column)} ${s.dir === 'desc' ? 'DESC' : 'ASC'}`).join(', ');
    return { sql, params: where.params, where, filtered: !!where.sql };
  }

  /** What a page request sends, written out for the filter preview. */
  pagePreview(req) {
    return `${this.pageQuery(req, true).sql}\nLIMIT ${Number(req.limit) || 300} OFFSET ${Number(req.offset) || 0};`;
  }

  async fetchPage(req, opts = {}) {
    const q = this.pageQuery(req);
    return this.query(`${q.sql} LIMIT ${Number(req.limit)} OFFSET ${Number(req.offset) || 0}`, q.params, opts);
  }

  async countRows(req) {
    const where = compileFilters({ dialect: this.dialect, rules: req.filters || [], columns: req.columns || [] });
    return this.count(req.schema, req.table, where.sql, where.params);
  }

  /** Every row of a (filtered) table, a page at a time, so an export keeps memory flat. */
  async *pages(req, size) {
    for (let offset = 0; ; offset += size) {
      const r = await this.fetchPage({ ...req, limit: size, offset }, { quiet: offset > 0 });
      yield r;
      if (r.rows.length < size) return;
    }
  }

  // ---- import -------------------------------------------------------------------------------

  /** How many rows of `width` columns fit in one insertRows() call. */
  insertBatchSize(width) { return Math.max(1, Math.min(200, Math.floor(900 / width))); }

  async insertRows(schema, table, names, rows, opts = {}) {
    const params = [];
    const tuples = rows.map((row) => '(' + row.map((v) => { params.push(v); return placeholder(this.dialect, params.length); }).join(', ') + ')');
    await this.query(`INSERT INTO ${this.target(schema, table)} (${names.map((n) => this.q(n)).join(', ')}) VALUES ${tuples.join(', ')}`, params, opts);
  }

  /** The table an import creates: every column is text. */
  async createImportTable(schema, table, names) {
    await this.query(`CREATE TABLE ${this.target(schema, table)} (${names.map((c) => `${this.q(c)} TEXT`).join(', ')})`, [], {});
  }

  /** CREATE TABLE text assembled from describeTable(); drivers with a native DDL override ddl(). */
  createTableFromDescription(schema, table, d) {
    const lines = d.columns.map((c) => {
      let s = `  ${this.q(c.name)} ${c.type}`;
      if (!c.nullable) s += ' NOT NULL';
      if (c.default !== null && c.default !== undefined && c.default !== '') s += ` DEFAULT ${c.default}`;
      if (c.extra) s += ' ' + c.extra;
      return s;
    });
    if (d.primaryKey.length) lines.push(`  PRIMARY KEY (${d.primaryKey.map((k) => this.q(k)).join(', ')})`);
    for (const fk of d.foreignKeys) lines.push(`  CONSTRAINT ${this.q(fk.name)} ${fk.definition}`);
    for (const ck of d.checks || []) lines.push(`  CONSTRAINT ${this.q(ck.name)} ${ck.definition}`);
    let out = `CREATE TABLE ${this.target(schema, table)} (\n${lines.join(',\n')}\n);`;
    for (const ix of d.indexes) if (!ix.primary && ix.definition) out += `\n\n${ix.definition};`;
    return out;
  }
}

module.exports = {
  Driver, normalizeValue, readIfSet, tlsOptions, probeTls, wantsTls,
  jsonText, cellValue, tableFromDocuments, tableFromFields, typedFilterValue,
};
