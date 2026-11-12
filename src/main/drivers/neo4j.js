'use strict';
const neo4j = require('neo4j-driver-lite');
const { Driver, wantsTls, jsonText, normalizeValue } = require('./base');
const cypher = require('../../shared/cypher');
const { ANY_COLUMN, NEGATIVE_OPS, activeRules, splitList } = require('../../shared/filters');

// Node labels are browsed as tables and relationship types as read-only views: one node or
// relationship per row, `_id` holding its element id and one column per property.
const SAMPLE = 100;
const NODE_META = ['_id', '_labels'];
const REL_META = ['_id', '_start', '_end'];
const COUNTERS = [
  ['nodesCreated', 'node', 'created'], ['nodesDeleted', 'node', 'deleted'],
  ['relationshipsCreated', 'relationship', 'created'], ['relationshipsDeleted', 'relationship', 'deleted'],
  ['propertiesSet', 'property', 'set'], ['labelsAdded', 'label', 'added'], ['labelsRemoved', 'label', 'removed'],
  ['indexesAdded', 'index', 'added'], ['indexesRemoved', 'index', 'removed'],
  ['constraintsAdded', 'constraint', 'added'], ['constraintsRemoved', 'constraint', 'removed'],
];
const TEMPORAL = [['date', neo4j.isDate], ['datetime', neo4j.isDateTime], ['localdatetime', neo4j.isLocalDateTime],
  ['time', neo4j.isTime], ['localtime', neo4j.isLocalTime], ['duration', neo4j.isDuration]];

const pluralOf = (word, n) => (n === 1 ? word : word === 'property' ? 'properties' : word === 'index' ? 'indexes' : word + 's');

/** The type a property value has, as shown in the grid and used when writing it back. */
function typeOf(v) {
  if (typeof v === 'string') return 'string';
  if (typeof v === 'bigint') return 'integer';
  if (typeof v === 'number') return 'float';
  if (typeof v === 'boolean') return 'boolean';
  if (Array.isArray(v)) return 'list';
  for (const [name, is] of TEMPORAL) if (is(v)) return name;
  if (neo4j.isPoint(v)) return 'point';
  if (neo4j.isNode(v)) return 'node';
  if (neo4j.isRelationship(v)) return 'relationship';
  if (neo4j.isPath(v)) return 'path';
  return 'map';
}

const elementDoc = (e) => (neo4j.isNode(e)
  ? { _id: e.elementId, _labels: e.labels, ...e.properties }
  : { _id: e.elementId, _type: e.type, _start: e.startNodeElementId, _end: e.endNodeElementId, ...e.properties });

/** Driver values -> plain data: nodes and relationships become objects, temporal values text. */
function plain(v) {
  if (v === null || v === undefined) return null;
  if (typeof v !== 'object') return v;
  if (Array.isArray(v)) return v.map(plain);
  if (v instanceof Uint8Array) return Buffer.from(v).toString('hex');
  if (neo4j.isNode(v) || neo4j.isRelationship(v)) return plain(elementDoc(v));
  if (neo4j.isPath(v)) return v.segments.length ? [plain(v.start), ...v.segments.flatMap((s) => [plain(s.relationship), plain(s.end)])] : [plain(v.start)];
  if (neo4j.isPoint(v)) return { srid: plain(v.srid), x: v.x, y: v.y, ...(v.z === undefined ? {} : { z: v.z }) };
  if (TEMPORAL.some(([, is]) => is(v))) return v.toString();
  const out = {};
  for (const k of Object.keys(v)) out[k] = plain(v[k]);
  return out;
}

/** A value as a grid cell: scalars as they are, everything structured as JSON text. */
function cell(v) {
  const p = plain(v);
  if (v instanceof Uint8Array) return normalizeValue(v);
  return p !== null && typeof p === 'object' ? jsonText(p) : normalizeValue(p);
}

/** Rows of documents as a grid, each column typed by the values it holds. */
function documentTable(docs, first) {
  const names = [...first];
  const seen = new Set(names);
  for (const d of docs) for (const k of Object.keys(d)) if (!seen.has(k)) { seen.add(k); names.push(k); }
  const fields = names.map((n) => {
    const kinds = new Set();
    for (const d of docs) if (d[n] !== null && d[n] !== undefined) kinds.add(typeOf(d[n]));
    const meta = n === '_id' || n === '_start' || n === '_end' ? 'id' : n === '_labels' ? 'labels' : null;
    return { name: n, type: meta || (kinds.size === 0 ? '' : kinds.size === 1 ? [...kinds][0] : 'mixed') };
  });
  return { fields, rows: docs.map((d) => names.map((n) => cell(d[n]))) };
}

function planTable(plan, profiled) {
  const rows = [];
  const walk = (node, depth) => {
    const a = node.arguments || {};
    const num = (x) => (x === undefined || x === null ? null : Number(x));
    rows.push(['  '.repeat(depth) + String(node.operatorType).replace(/@.*$/, ''), a.Details === undefined ? null : String(a.Details),
      a.EstimatedRows === undefined ? null : Math.round(Number(a.EstimatedRows) * 100) / 100,
      ...(profiled ? [num(node.rows), num(node.dbHits)] : []), (node.identifiers || []).join(', ')]);
    for (const child of node.children || []) walk(child, depth + 1);
  };
  walk(plan, 0);
  const names = ['operator', 'details', 'estimated rows', ...(profiled ? ['rows', 'db hits'] : []), 'variables'];
  return { fields: names.map((n) => ({ name: n, type: '' })), rows };
}

class Neo4jDriver extends Driver {
  constructor(params, log) {
    super(params, log);
    this.dialect = 'neo4j';
    this.sql = false;
    this.database = params.database || '';
    this.labels = new Set();
    this.relTypes = new Set();
  }

  async connect() {
    const p = this.params;
    const host = p.host || 'localhost';
    // neo4j:// asks the server for the addresses of its cluster, which a tunnel cannot reach.
    const scheme = p.scheme === 'neo4j' && !p.tunneled ? 'neo4j' : 'bolt';
    const url = `${scheme}://${host.includes(':') && !host.startsWith('[') ? `[${host}]` : host}:${Number(p.port) || 7687}`;
    const mode = p.sslMode || 'prefer';
    const config = { userAgent: 'Chairminus', connectionTimeout: 15000, connectionAcquisitionTimeout: 20000, maxConnectionPoolSize: 4, useBigInt: true };
    config.encrypted = await wantsTls(p, 7687);
    if (config.encrypted) {
      const verify = mode === 'verify-ca' || mode === 'verify-full';
      config.trust = !verify ? 'TRUST_ALL_CERTIFICATES' : p.sslCa ? 'TRUST_CUSTOM_CA_SIGNED_CERTIFICATES' : 'TRUST_SYSTEM_CA_SIGNED_CERTIFICATES';
      if (verify && p.sslCa) config.trustedCertificates = [p.sslCa];
      if (p.sslCert && p.sslKey) config.clientCertificate = { certfile: p.sslCert, keyfile: p.sslKey };
    }
    const driver = neo4j.driver(url, p.user ? neo4j.auth.basic(p.user, p.password || '') : undefined, config);
    try {
      const info = await driver.getServerInfo(this.database ? { database: this.database } : {});
      this.version = String(info.agent || '').replace(/^Neo4j\//, '');
      this.driver = driver;
      const [major, minor] = this.version.split('.').map(Number);
      // elementId() and toStringOrNull() arrived in Neo4j 5.0 and 4.3.
      this.idFn = major >= 5 ? 'elementId' : 'id';
      this.textFn = major >= 5 || (major === 4 && minor >= 3) ? 'toStringOrNull' : 'toString';
      if (!this.database) this.database = (await this.run('RETURN 1', {}, 0)).database || '';
    } catch (e) {
      this.driver = null;
      await driver.close().catch(() => {});
      throw e;
    }
  }

  async disconnect() {
    const d = this.driver;
    this.driver = null;
    this.tx = null;
    if (d) await d.close().catch(() => {});
  }

  async ping(quiet) { await this.logged('RETURN 1', quiet ? { quiet: true } : { meta: true }, () => this.run('RETURN 1', {}, 0)); }

  // ---- statements ---------------------------------------------------------------------------

  async query(text, params = {}, opts = {}) {
    if (!this.driver) throw new Error('Not connected');
    if (/^\s*:/.test(text)) throw new Error(`Commands that start with “:” belong to Neo4j Browser; switch databases with the database picker (${process.platform === 'darwin' ? '⌘K' : 'Ctrl+K'})`);
    return this.logged(text, opts, () => this.run(text, params, opts.rowLimit || 0));
  }

  /** Run in the open transaction, or in a transaction of its own. */
  async run(text, params, limit, database) {
    const session = this.tx ? null : this.driver.session({ database: database || this.database || undefined });
    if (session) this.active = session;
    try {
      const res = (this.tx || session).run(text, params && !Array.isArray(params) ? params : {});
      const keys = await res.keys();
      const values = [];
      let truncated = false;
      for await (const record of res) {
        if (limit && values.length >= limit) { truncated = true; break; }
        values.push(keys.map((k) => record.get(k)));
      }
      const fields = keys.map((name, c) => {
        const kinds = new Set();
        for (const row of values) if (row[c] !== null && row[c] !== undefined) kinds.add(typeOf(row[c]));
        return { name, type: kinds.size === 1 ? [...kinds][0] : kinds.size ? 'mixed' : '' };
      });
      const out = { fields, rows: values.map((row) => row.map(cell)), affected: null, command: '', truncated };
      // A result that was cut short never reaches its summary.
      if (truncated) return out;
      const summary = await res.summary();
      out.database = summary.database && summary.database.name;
      const updates = summary.counters.updates();
      const parts = COUNTERS.filter(([key]) => Number(updates[key]) > 0).map(([key, word, verb]) => `${Number(updates[key])} ${pluralOf(word, Number(updates[key]))} ${verb}`);
      out.command = String(summary.queryType || '').toUpperCase();
      out.schemaChanged = summary.counters.containsSystemUpdates()
        || ['nodesCreated', 'nodesDeleted', 'relationshipsCreated', 'relationshipsDeleted', 'labelsAdded', 'labelsRemoved'].some((k) => Number(updates[k]) > 0);
      // EXPLAIN returns no rows and PROFILE is run for its plan: show the plan as the result.
      const plan = summary.hasProfile() ? summary.profile : summary.hasPlan() ? summary.plan : null;
      if (plan) Object.assign(out, planTable(plan, summary.hasProfile()));
      else if (!keys.length) out.message = parts.length ? parts.join(', ') : summary.counters.containsSystemUpdates() ? 'Statement completed' : 'No changes';
      return out;
    } finally {
      if (session) {
        if (this.active === session) this.active = null;
        await session.close().catch(() => {});
      }
    }
  }

  async cancel() {
    const s = this.active;
    if (s) await s.close().catch(() => {});
  }

  async begin() {
    this.txSession = this.driver.session({ database: this.database || undefined });
    this.tx = await this.txSession.beginTransaction();
  }

  async finish(how) {
    const tx = this.tx;
    const session = this.txSession;
    this.tx = null;
    this.txSession = null;
    try { if (tx) await tx[how](); } finally { if (session) await session.close().catch(() => {}); }
  }

  async commit() { await this.finish('commit'); }
  async rollback() { await this.finish('rollback'); }

  /** A catalog query, as rows of objects. */
  async meta(text, database) {
    const r = await this.logged(text, { meta: true }, () => this.run(text, {}, 0, database));
    return r.rows.map((row) => Object.fromEntries(r.fields.map((f, i) => [f.name, row[i]])));
  }

  // ---- catalog ------------------------------------------------------------------------------

  async listDatabases() {
    let names = [];
    try { names = (await this.meta('SHOW DATABASES YIELD name RETURN DISTINCT name ORDER BY name', 'system')).map((r) => r.name); } catch { /* Community 3.x/4.0 or no permission */ }
    if (this.database && !names.includes(this.database)) names.push(this.database);
    return names;
  }

  isSystemDatabase(name) { return name === 'system'; }

  async useDatabase(name) {
    await this.logged(`USE ${cypher.name(name)} RETURN 1`, { meta: true }, () => this.run('RETURN 1', {}, 0, String(name)));
    this.database = String(name);
    this.labels = new Set();
    this.relTypes = new Set();
  }

  async listObjects() {
    const out = { tables: [], views: [], matviews: [], sequences: [], functions: [], procedures: [] };
    const labels = await this.meta('CALL db.labels() YIELD label RETURN label ORDER BY label');
    const types = await this.meta('CALL db.relationshipTypes() YIELD relationshipType RETURN relationshipType ORDER BY relationshipType');
    this.labels = new Set(labels.map((r) => r.label));
    this.relTypes = new Set(types.map((r) => r.relationshipType));
    for (const name of this.labels) out.tables.push({ name, kind: 'table', estimate: null, comment: 'node label' });
    for (const name of this.relTypes) out.views.push({ name, kind: 'view', estimate: null, comment: 'relationship type' });
    return out;
  }

  /** A name that is both a label and a relationship type is taken as the label. */
  async isRelationship(name) {
    if (!this.labels.size && !this.relTypes.size) await this.listObjects();
    return this.relTypes.has(name) && !this.labels.has(name);
  }

  pattern(name, rel) {
    return rel ? `MATCH ()-[r:${cypher.name(name)}]->()` : `MATCH (n:${cypher.name(name)})`;
  }

  /** Indexes and constraints declared on a label or relationship type. */
  async schemaOf(name) {
    const on = `WHERE ${cypher.string(name)} IN labelsOrTypes`;
    const indexes = await this.meta(`SHOW INDEXES YIELD name, type, labelsOrTypes, properties, owningConstraint, createStatement ${on} RETURN name, type, properties, owningConstraint, createStatement ORDER BY name`).catch(() => []);
    const constraints = await this.meta(`SHOW CONSTRAINTS YIELD name, type, labelsOrTypes, properties, createStatement ${on} RETURN name, type, properties, createStatement ORDER BY name`).catch(() => []);
    return { indexes, constraints };
  }

  /** Properties and their types come from the first nodes: a label has no schema. */
  async describeTable(schema, table) {
    const rel = await this.isRelationship(table);
    const v = rel ? 'r' : 'n';
    const sample = await this.elements(`${this.pattern(table, rel)} RETURN ${v} LIMIT ${SAMPLE}`, {}, { meta: true });
    const fields = documentTable(sample.map(({ _type, ...d }) => d), rel ? REL_META : NODE_META).fields;
    const { indexes, constraints } = await this.schemaOf(table);
    const list = (text) => { try { return JSON.parse(text); } catch { return []; } };
    return {
      kind: rel ? 'view' : 'table',
      columns: fields.map((f) => ({
        name: f.name, type: f.type, base: f.type, nullable: !f.name.startsWith('_'), default: null,
        comment: f.name === '_id' ? 'Element id, assigned by Neo4j' : null,
        pk: f.name === '_id', autoIncrement: f.name === '_id', generated: f.name === '_labels', extra: '', enumValues: null,
      })),
      primaryKey: ['_id'],
      indexes: indexes.map((ix) => ({
        name: ix.name, unique: !!ix.owningConstraint, primary: false, method: String(ix.type || '').toLowerCase(),
        columns: list(ix.properties), definition: ix.createStatement || '',
      })),
      foreignKeys: [],
      checks: constraints.map((c) => ({ name: c.name, definition: c.createStatement || `${c.type} (${list(c.properties).join(', ')})` })),
      triggers: [],
      note: rel ? 'Relationship type — read only' : undefined,
    };
  }

  async ddl(schema, name) {
    const { indexes, constraints } = await this.schemaOf(name);
    const lines = [...constraints.map((c) => c.createStatement), ...indexes.filter((ix) => !ix.owningConstraint).map((ix) => ix.createStatement)].filter(Boolean);
    return lines.length ? lines.map((l) => l + ';').join('\n\n') : `// ${name} has no indexes or constraints. Labels and relationship types exist while something uses them.`;
  }

  async listColumns() {
    if (!this.labels.size && !this.relTypes.size) await this.listObjects();
    return Object.fromEntries([...this.labels, ...this.relTypes].map((n) => [n, []]));
  }

  async processList() {
    const r = await this.logged('SHOW TRANSACTIONS', { meta: true }, () => this.run('SHOW TRANSACTIONS YIELD transactionId, username, database, status, elapsedTime, currentQuery RETURN transactionId, username, database, status, elapsedTime, currentQuery', {}, 0));
    return { fields: r.fields, rows: r.rows, idColumn: 0, killStatement: "TERMINATE TRANSACTIONS '{id}'" };
  }

  async kill(id) { await this.query(`TERMINATE TRANSACTIONS ${cypher.string(id)}`); }

  // ---- node pages ---------------------------------------------------------------------------

  /** Filter rules -> a Cypher predicate on `v` (n for nodes, r for relationships). */
  where(rules, columns, v, inline) {
    const params = {};
    let count = 0;
    const val = (x) => {
      if (inline) return typeof x === 'bigint' ? String(x) : Array.isArray(x) ? '[' + x.map((i) => (typeof i === 'bigint' ? String(i) : cypher.literal(i))).join(', ') + ']' : cypher.literal(x);
      params[`p${++count}`] = x;
      return `$p${count}`;
    };
    const typeFor = (column) => (column === '_id' ? (this.idFn === 'id' ? 'integer' : 'string') : (columns.find((c) => c.name === column) || {}).type);
    const expr = (column) => (column === '_id' ? `${this.idFn}(${v})`
      : column === '_labels' ? `labels(${v})`
        : column === '_start' ? `${this.idFn}(startNode(${v}))`
          : column === '_end' ? `${this.idFn}(endNode(${v}))` : `${v}.${cypher.name(column)}`);
    /** The typed value of a known column type, or undefined when the text must be compared as text. */
    const typed = (text, type) => {
      const s = String(text ?? '').trim();
      if (type === 'string') return String(text ?? '');
      if (type === 'integer' && /^-?\d+$/.test(s)) return BigInt(s);
      if (type === 'float' && s !== '' && Number.isFinite(Number(s))) return Number(s);
      if (type === 'boolean' && /^(true|false)$/i.test(s)) return s.toLowerCase() === 'true';
      return undefined;
    };
    const one = (rule, column) => {
      const type = typeFor(column);
      const e = expr(column);
      const text = type === 'string' ? e : `${this.textFn}(${e})`;
      const raw = String(rule.value ?? '');
      const both = (value) => { const t = typed(value, type); return t !== undefined ? [e, t] : [text, String(value ?? '')]; };
      const compare = (op) => { const [lhs, value] = both(raw); return `${lhs} ${op} ${val(value)}`; };
      const match = (word, negate) => {
        const test = rule.caseSensitive ? `${text} ${word} ${val(raw)}` : `toLower(${text}) ${word} toLower(${val(raw)})`;
        return negate ? `NOT (${test})` : test;
      };
      const like = () => `${text} =~ ${val('(?s)' + raw.split(/([%_])/).map((p) => (p === '%' ? '.*' : p === '_' ? '.' : p.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))).join(''))}`;
      const list = () => { const items = splitList(raw).map((i) => both(i)); const direct = items.every(([lhs]) => lhs === e); return `${direct ? e : text} IN ${val(items.map(([, value]) => (direct ? value : String(value))))}`; };
      const between = () => { const [lhs, a] = both(raw); const [, b] = both(rule.value2); return `${lhs} >= ${val(a)} AND ${lhs} <= ${val(b)}`; };
      switch (rule.op) {
        case '=': return compare('=');
        case '<>': return compare('<>');
        case '<': return compare('<');
        case '>': return compare('>');
        case '<=': return compare('<=');
        case '>=': return compare('>=');
        case 'contains': return match('CONTAINS', false);
        case 'not_contains': return match('CONTAINS', true);
        case 'prefix': return match('STARTS WITH', false);
        case 'suffix': return match('ENDS WITH', false);
        case 'like': return like();
        case 'not_like': return `NOT (${like()})`;
        case 'in': return list();
        case 'not_in': return `NOT (${list()})`;
        case 'between': return `(${between()})`;
        case 'not_between': return `NOT (${between()})`;
        case 'null': return `${e} IS NULL`;
        case 'not_null': return `${e} IS NOT NULL`;
        case 'empty': return `(${e} IS NULL OR ${text} = '')`;
        case 'not_empty': return `(${e} IS NOT NULL AND ${text} <> '')`;
        default: return null;
      }
    };
    const parts = [];
    for (const rule of activeRules(rules)) {
      if (rule.op === 'raw') parts.push(`(${String(rule.value).trim().replace(/;+\s*$/, '')})`);
      else if (rule.column === ANY_COLUMN) {
        const each = (columns || []).filter((c) => c.name !== '_labels').map((c) => one(rule, c.name)).filter(Boolean);
        if (each.length) parts.push('(' + each.join(NEGATIVE_OPS.includes(rule.op) ? ' AND ' : ' OR ') + ')');
      } else {
        const sql = one(rule, rule.column);
        if (sql) parts.push(sql);
      }
    }
    return { text: parts.join(' AND '), params };
  }

  /**
   * Pages come in the store's own order unless a sort is chosen: ordering every node of a
   * label by id on each page would cost far more than the page itself.
   */
  pageQuery(req, inline) {
    const rel = this.relTypes.has(req.table) && !this.labels.has(req.table);
    const v = rel ? 'r' : 'n';
    const where = this.where(req.filters, req.columns || [], v, inline);
    const match = `${this.pattern(req.table, rel)}${where.text ? ' WHERE ' + where.text : ''}`;
    const order = (req.sort || []).map((s) => {
      const e = s.column === '_id' ? `${this.idFn}(${v})` : s.column === '_labels' ? `labels(${v})` : s.column === '_start' ? `${this.idFn}(startNode(${v}))`
        : s.column === '_end' ? `${this.idFn}(endNode(${v}))` : `${v}.${cypher.name(s.column)}`;
      return `${e} ${s.dir === 'desc' ? 'DESC' : 'ASC'}`;
    });
    return { sql: `${match} RETURN ${v}${order.length ? ' ORDER BY ' + order.join(', ') : ''}`, params: where.params, filtered: !!where.text, match, v, rel };
  }

  pagePreview(req) {
    return `${this.pageQuery(req, true).sql}\nSKIP ${Number(req.offset) || 0} LIMIT ${Number(req.limit) || 300};`;
  }

  /** The nodes or relationships a statement returns in its only column, as documents. */
  async elements(text, params, opts) {
    return this.logged(text, opts, async () => {
      const session = this.tx ? null : this.driver.session({ database: this.database || undefined });
      try {
        const res = await (this.tx || session).run(text, params);
        return res.records.map((rec) => elementDoc(rec.get(0)));
      } finally {
        if (session) await session.close().catch(() => {});
      }
    });
  }

  async fetchPage(req, opts = {}) {
    await this.isRelationship(req.table);
    const q = this.pageQuery(req);
    const docs = await this.elements(`${q.sql} SKIP ${Number(req.offset) || 0} LIMIT ${Number(req.limit)}`, q.params, opts);
    const known = (req.columns || []).map((c) => c.name).filter((n) => !n.startsWith('_'));
    const t = documentTable(docs.map(({ _type, ...d }) => d), [...(q.rel ? REL_META : NODE_META), ...known]);
    return { ...t, affected: null, command: 'MATCH', truncated: false };
  }

  async countRows(req) {
    await this.isRelationship(req.table);
    const q = this.pageQuery(req);
    const r = await this.logged(`${q.match} RETURN count(${q.v})`, {}, () => this.run(`${q.match} RETURN count(${q.v})`, q.params, 0));
    return Number(r.rows[0][0]);
  }

  // ---- import -------------------------------------------------------------------------------

  insertBatchSize() { return 500; }

  async insertRows(schema, table, names, rows, opts = {}) {
    const maps = rows.map((row) => {
      const props = {};
      names.forEach((n, i) => {
        const v = row[i];
        if (v === null || v === undefined || n.startsWith('_')) return;
        // Whole numbers are stored as integers, not as the floats JavaScript numbers map to.
        props[n] = typeof v === 'number' && Number.isInteger(v) ? BigInt(v) : v !== null && typeof v === 'object' && !Array.isArray(v) ? JSON.stringify(v) : v;
      });
      return props;
    });
    const text = `UNWIND $rows AS row CREATE (n:${cypher.name(table)}) SET n += row`;
    await this.logged(`${text}   // ${rows.length} rows`, opts, () => this.run(text, { rows: maps }, 0));
  }

  async createImportTable() { /* a label exists once a node carries it */ }
}

module.exports = { Neo4jDriver };
