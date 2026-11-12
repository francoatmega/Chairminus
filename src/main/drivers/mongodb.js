'use strict';
const { MongoClient, BSON } = require('mongodb');
const { Driver, tlsOptions, wantsTls, cellValue, tableFromDocuments, tableFromFields } = require('./base');
const shell = require('../../shared/mongoshell');
const { ANY_COLUMN, NEGATIVE_OPS, activeRules, splitList } = require('../../shared/filters');

const { EJSON, ObjectId, Long, Decimal128 } = BSON;
const SYSTEM_DBS = new Set(['admin', 'local', 'config']);
const SAMPLE = 100;
const SPECIAL = { objectId: '$oid', date: '$date', decimal: '$numberDecimal', long: '$numberLong' };

/** Statement arguments arrive as Extended JSON; the server gets real BSON values. */
const revive = (v) => EJSON.deserialize(v, { relaxed: false });

/** BSON values -> Extended JSON, keeping what relaxed EJSON would round (64-bit integers). */
function toPlain(v) {
  if (v === null || v === undefined) return null;
  if (typeof v === 'bigint') return v >= Number.MIN_SAFE_INTEGER && v <= Number.MAX_SAFE_INTEGER ? Number(v) : { $numberLong: v.toString() };
  if (typeof v !== 'object') return v;
  if (Array.isArray(v)) return v.map(toPlain);
  if (v instanceof Date) return Number.isNaN(v.getTime()) ? null : { $date: v.toISOString() };
  if (v instanceof RegExp) return { $regularExpression: { pattern: v.source, options: v.flags } };
  switch (v._bsontype) {
    case undefined: break;
    case 'ObjectId': return { $oid: v.toHexString() };
    case 'Decimal128': return { $numberDecimal: v.toString() };
    case 'Long': {
      const n = v.toBigInt();
      return n >= Number.MIN_SAFE_INTEGER && n <= Number.MAX_SAFE_INTEGER ? Number(n) : { $numberLong: n.toString() };
    }
    case 'Double': case 'Int32': return v.valueOf();
    default: return EJSON.serialize(v, { relaxed: false });
  }
  const out = {};
  for (const k of Object.keys(v)) out[k] = toPlain(v[k]);
  return out;
}

function kindOf(v) {
  if (typeof v === 'string') return 'string';
  if (typeof v === 'number') return Number.isInteger(v) ? 'int' : 'double';
  if (typeof v === 'boolean') return 'bool';
  if (Array.isArray(v)) return 'array';
  for (const [kind, key] of Object.entries(SPECIAL)) if (typeof v[key] === 'string' && Object.keys(v).length === 1) return kind;
  return 'object';
}

/**
 * Documents as a grid. A column whose values all have one type gets that type and shows
 * ObjectIds, dates and decimals in plain form; in a column of mixed types they keep their
 * Extended JSON form, so writing a value back never changes its type.
 */
function documentTable(docs, first = []) {
  const plain = docs.map(toPlain);
  // _id leads, unless a projection left it out of every document.
  const lead = first.includes('_id') || plain.some((d) => d !== null && typeof d === 'object' && d._id !== undefined) ? ['_id'] : [];
  const t = tableFromDocuments(plain, { first: [...lead, ...first.filter((n) => n !== '_id')] });
  if (!docs.length || t.fields[0].name === 'value') return { ...t, docs: plain };
  t.fields.forEach((f, c) => {
    const kinds = new Set();
    for (const d of plain) if (d[f.name] !== null && d[f.name] !== undefined) kinds.add(kindOf(d[f.name]));
    if (kinds.size === 2 && kinds.has('int') && kinds.has('double')) { kinds.clear(); kinds.add('double'); }
    f.type = kinds.size === 0 ? '' : kinds.size === 1 ? [...kinds][0] : 'mixed';
    const key = SPECIAL[f.type];
    if (key) plain.forEach((d, r) => { if (d[f.name] !== null && d[f.name] !== undefined) t.rows[r][c] = d[f.name][key]; });
  });
  return { ...t, docs: plain };
}

const result = (table, extra) => ({ fields: table.fields, rows: table.rows, affected: null, command: '', truncated: false, ...extra });
const done = (command, message, extra) => ({ fields: [], rows: [], affected: null, command, truncated: false, message, ...extra });
const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`;

function limited(docs, limit) {
  const truncated = limit > 0 && docs.length > limit;
  if (truncated) docs.length = limit;
  return result(documentTable(docs), { command: 'FIND', truncated });
}

// ---- filters ------------------------------------------------------------------------------

const escapeRegex = (s) => String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** Filter text as the value a field of this type holds; undefined when the type says nothing. */
function typed(text, type) {
  const s = String(text ?? '');
  switch (type) {
    case 'string': return s;
    case 'objectId': return /^[0-9a-fA-F]{24}$/.test(s) ? new ObjectId(s) : s;
    case 'date': { const d = new Date(s); return Number.isNaN(d.getTime()) ? s : d; }
    case 'decimal': try { return Decimal128.fromString(s); } catch { return s; }
    case 'long': return /^-?\d+$/.test(s) ? Long.fromString(s) : s;
    case 'int': case 'double': return s.trim() !== '' && Number.isFinite(Number(s)) ? Number(s) : s;
    case 'bool': return /^(true|false)$/i.test(s) ? s.toLowerCase() === 'true' : s;
    default: return undefined;
  }
}

/** Without a known type, the same text could be a string, a number, a boolean or an ObjectId. */
function candidates(text) {
  const s = String(text ?? '');
  const out = [s];
  if (s.trim() !== '' && Number.isFinite(Number(s))) out.push(Number(s));
  if (/^(true|false)$/i.test(s)) out.push(s.toLowerCase() === 'true');
  if (/^[0-9a-fA-F]{24}$/.test(s)) out.push(new ObjectId(s));
  return out;
}

function compileFilter(rules, columns = []) {
  const typeOf = (name) => (columns.find((c) => c.name === name) || {}).type;
  const one = (rule, column) => {
    const type = typeOf(column);
    const exact = typed(rule.value, type);
    const anyOf = (text) => { const v = typed(text, type); return v === undefined ? candidates(text) : [v]; };
    const ordered = (text) => { const v = typed(text, type); return v !== undefined ? v : candidates(text).find((x) => typeof x === 'number') ?? String(text ?? ''); };
    const match = (pattern, negate) => {
      const options = rule.caseSensitive ? '' : 'i';
      // $regex only looks at strings; values of another known type are compared as text.
      if (type === 'string' || type === 'array' || type === 'mixed' || type === 'object' || !type) {
        return { [column]: negate ? { $not: { $regex: pattern, $options: options } } : { $regex: pattern, $options: options } };
      }
      const test = { $regexMatch: { input: { $convert: { input: `$${column}`, to: 'string', onError: '', onNull: '' } }, regex: pattern, options } };
      return { $expr: negate ? { $not: [test] } : test };
    };
    const text = escapeRegex(rule.value ?? '');
    switch (rule.op) {
      case '=': return { [column]: exact !== undefined ? exact : { $in: candidates(rule.value) } };
      case '<>': return { [column]: exact !== undefined ? { $ne: exact } : { $nin: candidates(rule.value) } };
      case '<': return { [column]: { $lt: ordered(rule.value) } };
      case '>': return { [column]: { $gt: ordered(rule.value) } };
      case '<=': return { [column]: { $lte: ordered(rule.value) } };
      case '>=': return { [column]: { $gte: ordered(rule.value) } };
      case 'contains': return match(text, false);
      case 'not_contains': return match(text, true);
      case 'prefix': return match('^' + text, false);
      case 'suffix': return match(text + '$', false);
      case 'like':
      case 'not_like': {
        const pattern = '^' + String(rule.value ?? '').split(/([%_])/).map((p) => (p === '%' ? '.*' : p === '_' ? '.' : escapeRegex(p))).join('') + '$';
        return { [column]: rule.op === 'like' ? { $regex: pattern } : { $not: { $regex: pattern } } };
      }
      case 'in': return { [column]: { $in: splitList(rule.value).flatMap(anyOf) } };
      case 'not_in': return { [column]: { $nin: splitList(rule.value).flatMap(anyOf) } };
      case 'between': return { [column]: { $gte: ordered(rule.value), $lte: ordered(rule.value2) } };
      case 'not_between': return { $or: [{ [column]: { $lt: ordered(rule.value) } }, { [column]: { $gt: ordered(rule.value2) } }] };
      case 'null': return { [column]: null };
      case 'not_null': return { [column]: { $ne: null } };
      case 'empty': return { [column]: { $in: [null, ''] } };
      case 'not_empty': return { [column]: { $nin: [null, ''] } };
      default: return null;
    }
  };

  const parts = [];
  for (const rule of activeRules(rules)) {
    if (rule.op === 'raw') {
      const doc = shell.parseValue(String(rule.value).trim().replace(/;+\s*$/, ''));
      if (doc === null || typeof doc !== 'object' || Array.isArray(doc)) throw new Error('A raw filter is a query document, like { age: { $gt: 30 } }');
      parts.push(revive(doc));
    } else if (rule.column === ANY_COLUMN) {
      const each = columns.map((c) => one(rule, c.name)).filter(Boolean);
      if (each.length) parts.push(NEGATIVE_OPS.includes(rule.op) ? { $and: each } : { $or: each });
    } else {
      const f = one(rule, rule.column);
      if (f) parts.push(f);
    }
  }
  return parts.length === 0 ? {} : parts.length === 1 ? parts[0] : { $and: parts };
}

// ---- driver -------------------------------------------------------------------------------

class MongoDriver extends Driver {
  constructor(params, log) {
    super(params, log);
    this.dialect = 'mongodb';
    this.sql = false;
    // Multi-document transactions need a replica set; changes are applied one by one.
    this.transactional = false;
    this.database = params.database || 'test';
  }

  async connect() {
    const p = this.params;
    const host = p.host || 'localhost';
    const hostPart = host.includes(':') && !host.startsWith('[') ? `[${host}]` : host;
    const extra = new URLSearchParams(p.options || '');
    const uri = (p.srv ? `mongodb+srv://${hostPart}/` : `mongodb://${hostPart}:${Number(p.port) || 27017}/`) + (p.options ? '?' + String(p.options).replace(/^\?/, '') : '');
    const options = { appName: 'Chairminus', serverSelectionTimeoutMS: 15000, connectTimeoutMS: 15000 };
    if (p.user) options.auth = { username: p.user, password: p.password || '' };
    if (p.authSource) options.authSource = p.authSource;
    // "Connect to this host": do not follow a replica set to member addresses that may only
    // resolve inside the server's own network (or behind the SSH tunnel).
    if (!p.srv && !['replicaSet', 'directConnection', 'loadBalanced'].some((k) => extra.has(k))) options.directConnection = true;
    if (!extra.has('tls') && !extra.has('ssl')) {
      options.tls = p.srv ? (p.sslMode || 'prefer') !== 'disable' : await wantsTls(p, 27017);
      if (options.tls) Object.assign(options, tlsOptions(p));
    }
    const client = new MongoClient(uri, options);
    client.on('error', (e) => { this.lastError = e; });
    try {
      await client.connect();
      const info = await client.db(this.database).command({ buildInfo: 1 });
      this.version = info.version;
    } catch (e) {
      await client.close(true).catch(() => {});
      throw e;
    }
    this.client = client;
  }

  async disconnect() {
    const c = this.client;
    this.client = null;
    if (c) await c.close(true).catch(() => {});
  }

  get db() {
    if (!this.client) throw new Error('Not connected');
    return this.client.db(this.database);
  }

  async ping(quiet) {
    await this.logged('db.runCommand({ping: 1})', quiet ? { quiet: true } : { meta: true }, () => this.db.command({ ping: 1 }));
  }

  async begin() { /* no transaction: see `transactional` */ }
  async commit() { /* nothing to commit */ }
  async rollback() { /* nothing to undo */ }

  async query(text, params = [], opts = {}) {
    if (!this.client) throw new Error('Not connected');
    return this.logged(text, opts, () => this.execute(shell.parse(text), opts.rowLimit || 0));
  }

  async execute(st, limit) {
    if (st.kind === 'use') throw new Error(`Switch databases with the database picker (${process.platform === 'darwin' ? '⌘K' : 'Ctrl+K'}); “use” is not available in a query`);
    if (st.kind === 'show') {
      if (/^(collections|tables)$/.test(st.what)) {
        const list = await this.db.listCollections({}, { nameOnly: false }).toArray();
        return result(tableFromDocuments(list.map((c) => ({ name: c.name, type: c.type })).sort((a, b) => a.name.localeCompare(b.name))));
      }
      if (/^(dbs|databases)$/.test(st.what)) {
        const r = await this.client.db('admin').command({ listDatabases: 1 });
        return result(tableFromDocuments(r.databases.map((d) => ({ name: d.name, sizeOnDisk: toPlain(d.sizeOnDisk), empty: d.empty }))));
      }
      throw new Error(`“show ${st.what}” is not available — try show collections or show dbs`);
    }
    const db = st.db ? this.client.db(st.db) : this.db;
    const args = st.args.map(revive);
    const chain = st.chain.map((c) => ({ name: c.name, args: c.args.map(revive) }));
    return st.kind === 'db' ? this.dbMethod(db, st.method, args, chain, limit) : this.collectionMethod(db.collection(st.collection), st.method, args, chain, limit);
  }

  async readCursor(cursor, limit) {
    const docs = [];
    try {
      for await (const d of cursor) {
        docs.push(d);
        if (limit && docs.length > limit) break;
      }
    } finally {
      await cursor.close().catch(() => {});
    }
    return limited(docs, limit);
  }

  async collectionMethod(coll, method, args, chain, limit) {
    const none = (what) => { if (chain.length) throw new Error(`.${chain[0].name}() cannot follow ${what}()`); };
    const written = (r) => `${plural(r.matchedCount, 'document')} matched, ${r.modifiedCount} modified${r.upsertedCount ? `, ${r.upsertedCount} inserted` : ''}`;
    switch (method) {
      case 'find': {
        const filter = args[0] || {};
        const cursor = coll.find(filter, args[1] ? { projection: args[1] } : {});
        let userLimit = 0;
        for (const c of chain) {
          switch (c.name) {
            case 'sort': cursor.sort(c.args[0]); break;
            case 'skip': cursor.skip(Number(c.args[0]) || 0); break;
            case 'limit': userLimit = Math.abs(Number(c.args[0]) || 0); break;
            case 'project': case 'projection': cursor.project(c.args[0]); break;
            case 'hint': cursor.hint(c.args[0]); break;
            case 'collation': cursor.collation(c.args[0]); break;
            case 'maxTimeMS': cursor.maxTimeMS(Number(c.args[0])); break;
            case 'comment': cursor.comment(String(c.args[0])); break;
            case 'toArray': case 'pretty': break;
            case 'count': return result({ fields: [{ name: 'count', type: 'int' }], rows: [[await coll.countDocuments(filter)]] });
            case 'explain': return result(tableFromFields(toPlain(await cursor.explain(c.args[0] || 'queryPlanner'))));
            default: throw new Error(`.${c.name}() is not supported after find()`);
          }
        }
        // One more than the limit is read so a cut-off result can say so.
        cursor.limit(limit && (!userLimit || userLimit > limit) ? limit + 1 : userLimit);
        return limited(await cursor.toArray(), limit);
      }
      case 'findOne': {
        none(method);
        const doc = await coll.findOne(args[0] || {}, args[1] ? { projection: args[1] } : {});
        return limited(doc ? [doc] : [], 0);
      }
      case 'aggregate': {
        const cursor = coll.aggregate(args[0] || [], args[1] || {});
        const explain = chain.find((c) => c.name === 'explain');
        if (explain) return result(tableFromFields(toPlain(await cursor.explain(explain.args[0] || 'queryPlanner'))));
        const r = await this.readCursor(cursor, limit);
        const last = (args[0] || [])[(args[0] || []).length - 1] || {};
        return '$out' in last || '$merge' in last ? done('AGGREGATE', 'The pipeline wrote its result', { schemaChanged: true }) : r;
      }
      case 'countDocuments': case 'count':
        none(method);
        return result({ fields: [{ name: 'count', type: 'int' }], rows: [[await coll.countDocuments(args[0] || {}, args[1] || {})]] });
      case 'estimatedDocumentCount':
        none(method);
        return result({ fields: [{ name: 'count', type: 'int' }], rows: [[await coll.estimatedDocumentCount()]] });
      case 'distinct': {
        none(method);
        const values = (await coll.distinct(String(args[0]), args[1] || {})).map(toPlain);
        const truncated = limit > 0 && values.length > limit;
        return result({ fields: [{ name: String(args[0]), type: '' }], rows: (truncated ? values.slice(0, limit) : values).map((v) => [cellValue(v)]) }, { truncated });
      }
      case 'insertOne': {
        const r = await coll.insertOne(args[0] || {});
        return done('INSERT', `1 document inserted (_id ${cellValue(toPlain(r.insertedId))})`, { affected: 1 });
      }
      case 'insertMany': {
        const r = await coll.insertMany(args[0] || [], args[1] || {});
        return done('INSERT', `${plural(r.insertedCount, 'document')} inserted`, { affected: r.insertedCount });
      }
      case 'updateOne': case 'updateMany': case 'replaceOne': {
        const r = await coll[method](args[0] || {}, args[1] || {}, args[2] || {});
        return done('UPDATE', written(r), { affected: r.matchedCount });
      }
      case 'deleteOne': case 'deleteMany': {
        const r = await coll[method](args[0] || {}, args[1] || {});
        return done('DELETE', `${plural(r.deletedCount, 'document')} deleted`, { affected: r.deletedCount });
      }
      case 'findOneAndUpdate': case 'findOneAndReplace': {
        const doc = await coll[method](args[0] || {}, args[1] || {}, args[2] || {});
        return limited(doc ? [doc] : [], 0);
      }
      case 'findOneAndDelete': {
        const doc = await coll.findOneAndDelete(args[0] || {}, args[1] || {});
        return limited(doc ? [doc] : [], 0);
      }
      case 'bulkWrite': {
        const r = await coll.bulkWrite(args[0] || [], args[1] || {});
        return done('BULK', `${r.insertedCount} inserted, ${r.matchedCount} matched, ${r.modifiedCount} modified, ${r.deletedCount} deleted, ${r.upsertedCount} upserted`);
      }
      case 'createIndex':
        return done('CREATE INDEX', `Index ${await coll.createIndex(args[0], args[1] || {})} created`, { schemaChanged: true });
      case 'dropIndex':
        await coll.dropIndex(args[0]);
        return done('DROP INDEX', 'Index dropped', { schemaChanged: true });
      case 'dropIndexes':
        await coll.dropIndexes();
        return done('DROP INDEX', 'Indexes dropped', { schemaChanged: true });
      case 'getIndexes': case 'indexes':
        return limited(await coll.listIndexes().toArray(), 0);
      case 'drop':
        await coll.drop();
        return done('DROP', `${coll.collectionName} dropped`, { schemaChanged: true });
      case 'renameCollection':
        await coll.rename(String(args[0]), { dropTarget: args[1] === true });
        return done('RENAME', `Renamed to ${args[0]}`, { schemaChanged: true });
      case 'stats':
        return result(tableFromFields(toPlain(await this.client.db(coll.dbName).command({ collStats: coll.collectionName }))));
      default:
        throw new Error(`db.collection.${method}() is not available here`);
    }
  }

  async dbMethod(db, method, args, chain, limit) {
    if (chain.length && method !== 'aggregate') throw new Error(`.${chain[0].name}() cannot follow db.${method}()`);
    const admin = this.client.db('admin');
    const fields = async (target, command) => result(tableFromFields(toPlain(await target.command(command))));
    switch (method) {
      case 'runCommand': case 'adminCommand': {
        const command = typeof args[0] === 'string' ? { [args[0]]: 1 } : args[0];
        if (!command || typeof command !== 'object') throw new Error(`db.${method}() needs a command document`);
        const r = await (method === 'adminCommand' ? admin : db).command(command);
        if (r.cursor && Array.isArray(r.cursor.firstBatch)) return limited(r.cursor.firstBatch, limit);
        return result(tableFromFields(toPlain(r)), { schemaChanged: shell.classify(`db.runCommand(${JSON.stringify(toPlain(command))})`) === 'write' });
      }
      case 'aggregate': return this.readCursor(db.aggregate(args[0] || [], args[1] || {}), limit);
      case 'createCollection':
        await db.createCollection(String(args[0]), args[1] || {});
        return done('CREATE', `${args[0]} created`, { schemaChanged: true });
      case 'createView':
        await db.createCollection(String(args[0]), { viewOn: String(args[1]), pipeline: args[2] || [] });
        return done('CREATE', `${args[0]} created`, { schemaChanged: true });
      case 'dropDatabase':
        await db.dropDatabase();
        return done('DROP', `${db.databaseName} dropped`, { schemaChanged: true });
      case 'getCollectionNames':
        return result(tableFromDocuments((await db.listCollections({}, { nameOnly: true }).toArray()).map((c) => ({ name: c.name }))));
      case 'getCollectionInfos':
        return limited(await db.listCollections(args[0] || {}).toArray(), limit);
      case 'stats': return fields(db, { dbStats: 1 });
      case 'serverStatus': return fields(db, { serverStatus: 1 });
      case 'hostInfo': return fields(admin, { hostInfo: 1 });
      case 'hello': case 'isMaster': return fields(db, { hello: 1 });
      case 'serverBuildInfo': return fields(db, { buildInfo: 1 });
      case 'version': return result({ fields: [{ name: 'version', type: '' }], rows: [[this.version]] });
      case 'getName': return result({ fields: [{ name: 'name', type: '' }], rows: [[db.databaseName]] });
      case 'currentOp': return limited((await admin.command({ currentOp: 1, ...(args[0] && typeof args[0] === 'object' ? args[0] : {}) })).inprog || [], limit);
      case 'killOp':
        await admin.command({ killOp: 1, op: args[0] });
        return done('KILL', 'Operation ended');
      default:
        throw new Error(`db.${method}() is not available here`);
    }
  }

  // ---- catalog ------------------------------------------------------------------------------

  async listDatabases() {
    let names = [];
    try {
      const r = await this.logged('db.adminCommand({listDatabases: 1, nameOnly: true})', { meta: true }, () => this.client.db('admin').command({ listDatabases: 1, nameOnly: true }));
      names = r.databases.map((d) => d.name);
    } catch { /* not allowed to list: only the current database is offered */ }
    // A database exists once something is stored in it, so the current one may be missing.
    if (!names.includes(this.database)) names.push(this.database);
    return names.sort((a, b) => a.localeCompare(b));
  }

  isSystemDatabase(name) { return SYSTEM_DBS.has(String(name)); }

  async useDatabase(name) { this.database = String(name); }

  collections() {
    return this.logged('db.getCollectionInfos()', { meta: true }, () => this.db.listCollections({}, { nameOnly: false }).toArray());
  }

  async listObjects() {
    const out = { tables: [], views: [], matviews: [], sequences: [], functions: [], procedures: [] };
    for (const c of (await this.collections()).sort((a, b) => a.name.localeCompare(b.name))) {
      if (c.type === 'view') out.views.push({ name: c.name, kind: 'view', estimate: null, comment: c.options && c.options.viewOn ? `view on ${c.options.viewOn}` : '' });
      else if (!c.name.startsWith('system.')) out.tables.push({ name: c.name, kind: 'table', estimate: null, comment: c.type === 'timeseries' ? 'time series' : '' });
    }
    return out;
  }

  async collectionInfo(name) {
    const info = (await this.collections()).find((c) => c.name === name);
    if (!info) throw new Error(`Collection ${name} not found`);
    return info;
  }

  indexDefinitions(name, list) {
    const ref = shell.collectionRef(name);
    return list.map((ix) => {
      const { v, key, name: indexName, ns, background, ...options } = ix;
      const plainKey = toPlain(key);
      return {
        name: indexName,
        unique: !!ix.unique || indexName === '_id_',
        primary: indexName === '_id_',
        method: Object.values(plainKey).find((x) => typeof x === 'string') || 'btree',
        columns: Object.keys(plainKey),
        definition: `${ref}.createIndex(${JSON.stringify(plainKey)}, ${JSON.stringify({ name: indexName, ...toPlain(options) })})`,
      };
    });
  }

  /** Fields and their types come from the first documents: a collection has no schema. */
  async describeTable(schema, table) {
    const info = await this.collectionInfo(table);
    const coll = this.db.collection(table);
    const sample = await this.logged(`${shell.collectionRef(table)}.find({}).limit(${SAMPLE})`, { meta: true }, () => coll.find({}).limit(SAMPLE).toArray());
    const fields = sample.length ? documentTable(sample).fields : [{ name: '_id', type: 'objectId' }];
    const indexes = info.type === 'view' ? [] : this.indexDefinitions(table, await coll.listIndexes().toArray().catch(() => []));
    const validator = info.options && info.options.validator;
    return {
      kind: info.type === 'view' ? 'view' : 'table',
      columns: fields.map((f) => ({
        name: f.name, type: f.type, base: f.type, nullable: f.name !== '_id', default: null, comment: null,
        pk: f.name === '_id', autoIncrement: f.name === '_id' && f.type === 'objectId', generated: false, extra: '', enumValues: null,
      })),
      primaryKey: ['_id'],
      indexes,
      foreignKeys: [],
      checks: validator ? [{ name: 'validator', definition: JSON.stringify(toPlain(validator)) }] : [],
      triggers: [],
    };
  }

  async ddl(schema, name) {
    const info = await this.collectionInfo(name);
    const options = toPlain(info.options || {});
    if (info.type === 'view') {
      return `db.createView(${JSON.stringify(name)}, ${JSON.stringify(options.viewOn)}, ${JSON.stringify(options.pipeline || [], null, 2)});`;
    }
    const lines = [`db.createCollection(${JSON.stringify(name)}${Object.keys(options).length ? ', ' + JSON.stringify(options, null, 2) : ''});`];
    const indexes = this.indexDefinitions(name, await this.db.collection(name).listIndexes().toArray().catch(() => []));
    for (const ix of indexes) if (!ix.primary) lines.push(ix.definition + ';');
    return lines.join('\n\n');
  }

  async listColumns() {
    return Object.fromEntries((await this.collections()).map((c) => [c.name, []]));
  }

  async estimateCount(schema, table) {
    try { return await this.db.collection(table).estimatedDocumentCount(); } catch { return null; }
  }

  async processList() {
    const r = await this.logged('db.currentOp()', { meta: true }, () => this.client.db('admin').command({ currentOp: 1 }));
    const ops = (r.inprog || []).map((o) => ({
      opid: o.opid, type: o.type, op: o.op, ns: o.ns, secs_running: o.secs_running, client: o.client, appName: o.appName, desc: o.desc, command: o.command,
    }));
    const t = documentTable(ops, ['opid', 'type', 'op', 'ns', 'secs_running', 'client', 'appName', 'desc', 'command']);
    const fields = t.fields.filter((f) => f.name !== '_id');
    const skip = t.fields.length - fields.length;
    return { fields, rows: t.rows.map((row) => row.slice(skip)), idColumn: 0, killStatement: 'db.killOp({id})' };
  }

  async kill(id) {
    await this.logged(`db.killOp(${id})`, {}, () => this.client.db('admin').command({ killOp: 1, op: /^-?\d+$/.test(String(id)) ? Number(id) : id }));
  }

  // ---- table pages --------------------------------------------------------------------------

  pageQuery({ table, filters, sort, columns }) {
    const filter = compileFilter(filters, columns);
    const order = sort && sort.length ? Object.fromEntries(sort.map((s) => [s.column, s.dir === 'desc' ? -1 : 1])) : { _id: 1 };
    const sql = `${shell.collectionRef(table)}.find(${EJSON.stringify(filter, { relaxed: true })}).sort(${JSON.stringify(order)})`;
    return { sql, params: [], filtered: Object.keys(filter).length > 0, filter, order };
  }

  pagePreview(req) {
    return `${this.pageQuery(req).sql}\n  .skip(${Number(req.offset) || 0}).limit(${Number(req.limit) || 300});`;
  }

  async fetchPage(req, opts = {}) {
    const q = this.pageQuery(req);
    const skip = Number(req.offset) || 0;
    return this.logged(`${q.sql}.skip(${skip}).limit(${Number(req.limit)})`, opts, async () => {
      const docs = await this.db.collection(req.table).find(q.filter).sort(q.order).skip(skip).limit(Number(req.limit)).toArray();
      return result(documentTable(docs, (req.columns || []).map((c) => c.name)), { command: 'FIND' });
    });
  }

  async countRows(req) {
    const q = this.pageQuery(req);
    return this.logged(`${shell.collectionRef(req.table)}.countDocuments(${EJSON.stringify(q.filter, { relaxed: true })})`, {}, () => this.db.collection(req.table).countDocuments(q.filter));
  }

  /** One cursor for the whole export instead of ever larger skips. */
  async *pages(req, size) {
    const q = this.pageQuery(req);
    const first = (req.columns || []).map((c) => c.name);
    const cursor = this.db.collection(req.table).find(q.filter).sort(q.order).batchSize(size);
    this.log({ sql: q.sql, ms: 0 });
    // `docs` carries the documents whole, for a JSON export.
    const page = (list) => { const t = documentTable(list, first); return { ...result(t), docs: t.docs }; };
    let batch = [];
    try {
      for await (const doc of cursor) {
        batch.push(doc);
        if (batch.length >= size) { yield page(batch); batch = []; }
      }
      yield page(batch);
    } finally {
      await cursor.close().catch(() => {});
    }
  }

  // ---- import -------------------------------------------------------------------------------

  insertBatchSize() { return 1000; }

  async insertRows(schema, table, names, rows, opts = {}) {
    const docs = rows.map((row) => {
      const doc = {};
      names.forEach((n, i) => { if (row[i] !== null && row[i] !== undefined) doc[n] = revive(row[i]); });
      return doc;
    });
    await this.logged(`${shell.collectionRef(table)}.insertMany([/* ${docs.length} documents */])`, opts, () => this.db.collection(table).insertMany(docs));
  }

  async createImportTable() { /* a collection is created by its first document */ }
}

module.exports = { MongoDriver, compileFilter, documentTable, toPlain };
