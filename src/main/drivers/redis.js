'use strict';
const { createClient } = require('@redis/client');
const { Driver, tlsOptions, wantsTls, cellValue } = require('./base');
const { parseArgs, command, classify, TYPES } = require('../../shared/rediscmd');
const { ANY_COLUMN, activeRules, splitList } = require('../../shared/filters');

// Keys are browsed as rows. A key group ("user:*") plays the part of a table.
const FIELDS = [
  { name: 'key', type: 'string' }, { name: 'type', type: 'string' }, { name: 'ttl', type: 'integer' },
  { name: 'size', type: 'integer' }, { name: 'value', type: 'string' },
];
const MAX_KEYS = 100000; // keys listed for one group
const MAX_SCANS = 2000; // SCAN calls spent looking for them
const GROUP_SAMPLE = 20000; // keys read to find the groups of the sidebar
const MAX_ITEMS = 1000; // members of a hash/list/set/zset shown in a cell
const MAX_STRING = 1024 * 1024;

// These change what the connection itself is, which would break the session that owns it.
const UNAVAILABLE = new Set(['SUBSCRIBE', 'PSUBSCRIBE', 'SSUBSCRIBE', 'UNSUBSCRIBE', 'PUNSUBSCRIBE', 'SUNSUBSCRIBE', 'MONITOR', 'SYNC', 'PSYNC',
  'QUIT', 'RESET', 'HELLO', 'AUTH', 'MULTI', 'EXEC', 'DISCARD', 'WATCH', 'UNWATCH']);
const PAIRS = new Set(['HGETALL', 'HSCAN', 'ZSCAN']);

const table = (names, rows, extra) => ({ fields: names.map((n) => ({ name: n, type: '' })), rows, affected: null, command: '', truncated: false, ...extra });
const pairs = (list) => { const out = []; for (let i = 0; i + 1 < list.length; i += 2) out.push([list[i], list[i + 1]]); return out; };
const cell = cellValue;

function globToRegex(glob) {
  let out = '';
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i];
    if (c === '*') out += '.*';
    else if (c === '?') out += '.';
    else if (c === '\\' && i + 1 < glob.length) out += glob[++i].replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    else if (c === '[') {
      const close = glob.indexOf(']', i + 1);
      if (close === -1) out += '\\[';
      else { out += '[' + glob.slice(i + 1, close).replace(/\\/g, '\\\\') + ']'; i = close; }
    } else out += c.replace(/[.+^${}()|\\]/g, '\\$&');
  }
  return new RegExp('^' + out + '$', 's');
}

/** A filter rule as a test on a key name. */
function keyTest(rule) {
  const v = String(rule.value ?? '');
  const fold = (s) => (rule.caseSensitive ? s : s.toLowerCase());
  const needle = fold(v);
  const like = () => new RegExp('^' + v.split(/([%_])/).map((p) => (p === '%' ? '.*' : p === '_' ? '.' : p.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))).join('') + '$', 's');
  switch (rule.op) {
    case '=': return (k) => k === v;
    case '<>': return (k) => k !== v;
    case '<': return (k) => k < v;
    case '>': return (k) => k > v;
    case '<=': return (k) => k <= v;
    case '>=': return (k) => k >= v;
    case 'contains': return (k) => fold(k).includes(needle);
    case 'not_contains': return (k) => !fold(k).includes(needle);
    case 'prefix': return (k) => fold(k).startsWith(needle);
    case 'suffix': return (k) => fold(k).endsWith(needle);
    case 'in': { const set = new Set(splitList(v)); return (k) => set.has(k); }
    case 'not_in': { const set = new Set(splitList(v)); return (k) => !set.has(k); }
    case 'between': return (k) => k >= v && k <= String(rule.value2 ?? '');
    case 'not_between': return (k) => k < v || k > String(rule.value2 ?? '');
    case 'like': { const re = like(); return (k) => re.test(k); }
    case 'not_like': { const re = like(); return (k) => !re.test(k); }
    case 'null': case 'empty': return () => false;
    case 'not_null': case 'not_empty': return () => true;
    case 'raw': { const re = globToRegex(v.trim()); return (k) => re.test(k); }
    default: return () => true;
  }
}

class RedisDriver extends Driver {
  constructor(params, log) {
    super(params, log);
    this.dialect = 'redis';
    this.sql = false;
    this.canImport = false;
    this.database = String(params.database || '0');
    this.batch = null;
    this.listing = null;
  }

  async connect() {
    const p = this.params;
    const socket = { host: p.host || 'localhost', port: Number(p.port) || 6379, connectTimeout: 15000, reconnectStrategy: false };
    if (await wantsTls(p, 6379, { send: 'PING\r\n', expect: /^[+-]/ })) Object.assign(socket, { tls: true }, tlsOptions(p));
    const client = createClient({
      socket, username: p.user || undefined, password: p.password || undefined,
      database: Number(this.database) || 0, name: 'Chairminus', disableOfflineQueue: true, RESP: 2,
    });
    // The session's keep-alive notices a dropped connection and reconnects; the client must not.
    client.on('error', (e) => { this.lastError = e; });
    try {
      await client.connect();
      this.client = client;
      const info = String(await client.sendCommand(['INFO', 'server']));
      this.version = (/^redis_version:(.+)$/m.exec(info) || [])[1]?.trim() || '';
      this.product = /^valkey_version:/m.test(info) ? 'Valkey' : '';
    } catch (e) {
      this.client = null;
      try { client.destroy(); } catch { /* never connected */ }
      throw e;
    }
  }

  async disconnect() {
    const c = this.client;
    this.client = null;
    if (c) try { c.destroy(); } catch { /* already closed */ }
  }

  send(args) {
    if (!this.client) throw new Error('Not connected');
    return this.client.sendCommand(args.map(String));
  }

  async ping(quiet) { await this.logged('PING', quiet ? { quiet: true } : { meta: true }, () => this.send(['PING'])); }

  // ---- statements ---------------------------------------------------------------------------

  async query(text, params = [], opts = {}) {
    if (!this.client) throw new Error('Not connected');
    const args = parseArgs(text);
    if (!args.length) return table([], []);
    const name = args[0].toUpperCase();
    if (name === 'SELECT') throw new Error(`Switch databases with the database picker (${process.platform === 'darwin' ? '⌘K' : 'Ctrl+K'}); SELECT is not available in a query`);
    if (UNAVAILABLE.has(name)) throw new Error(`${name} is not available here: it changes the state of the connection the app is using`);
    if (this.batch) {
      // Between begin() and commit() commands are held back and sent as one MULTI/EXEC.
      if (opts.absent !== undefined && Number(await this.send(['EXISTS', opts.absent])) > 0) throw new Error(`The key “${opts.absent}” already exists`);
      this.batch.push(args);
      return table([], [], { command: name, message: 'QUEUED' });
    }
    const r = await this.logged(text, opts, async () => this.shape(name, args, await this.send(args), text));
    if (opts.rowLimit && r.rows.length > opts.rowLimit) { r.rows.length = opts.rowLimit; r.truncated = true; }
    if (r.schemaChanged) this.listing = null;
    return r;
  }

  /** A reply as a result grid; replies of commands that write become a one-line message. */
  shape(name, args, reply, text) {
    const sub = String(args[1] || '').toUpperCase();
    if (!Array.isArray(reply)) {
      if (name === 'INFO' && typeof reply === 'string') {
        const rows = [];
        let section = '';
        for (const line of reply.split(/\r?\n/)) {
          if (line.startsWith('#')) section = line.slice(1).trim();
          else if (line.includes(':')) rows.push([section, line.slice(0, line.indexOf(':')), line.slice(line.indexOf(':') + 1)]);
        }
        return table(['section', 'key', 'value'], rows);
      }
      if (name === 'CLIENT' && sub === 'LIST' && typeof reply === 'string') return this.clientTable(reply);
      if (classify(text) === 'write') {
        const n = typeof reply === 'number' || typeof reply === 'bigint' ? Number(reply) : null;
        return table([], [], { command: name, message: reply === null ? '(nil)' : n !== null ? `(integer) ${n}` : String(reply), affected: name === 'DEL' || name === 'UNLINK' ? n : null, schemaChanged: true });
      }
      return table(['value'], [[cell(reply)]]);
    }
    // SCAN-style replies are [next cursor, items].
    if (/^(SCAN|SSCAN|HSCAN|ZSCAN)$/.test(name) && reply.length === 2 && Array.isArray(reply[1])) {
      const next = `Next cursor: ${reply[0]}${String(reply[0]) === '0' ? ' (the scan is complete)' : ''}`;
      if (name === 'SCAN') return table(['key'], reply[1].map((k) => [cell(k)]), { message: next });
      if (name === 'SSCAN') return table(['member'], reply[1].map((k) => [cell(k)]), { message: next });
      return table(name === 'HSCAN' ? ['field', 'value'] : ['member', 'score'], pairs(reply[1]).map((p) => p.map(cell)), { message: next });
    }
    const upper = args.map((a) => a.toUpperCase());
    if (PAIRS.has(name) || (name === 'CONFIG' && sub === 'GET') || upper.includes('WITHVALUES')) return table(['field', 'value'], pairs(reply).map((p) => p.map(cell)));
    if (upper.includes('WITHSCORES') && reply.every((x) => !Array.isArray(x))) return table(['member', 'score'], pairs(reply).map((p) => p.map(cell)));
    return table(['#', 'value'], reply.map((v, i) => [i + 1, cell(v)]), classify(text) === 'write' ? { schemaChanged: true } : {});
  }

  clientTable(text) {
    const clients = text.split('\n').filter((l) => l.trim()).map((l) => Object.fromEntries(l.trim().split(' ').map((kv) => [kv.slice(0, kv.indexOf('=')), kv.slice(kv.indexOf('=') + 1)])));
    const names = ['id', 'addr', 'name', 'user', 'db', 'age', 'idle', 'cmd', 'flags'].filter((n) => clients.some((c) => n in c));
    return table(names, clients.map((c) => names.map((n) => c[n] ?? null)));
  }

  // ---- transactions -------------------------------------------------------------------------

  async begin() { this.batch = []; }
  async rollback() { this.batch = null; }

  async commit() {
    const batch = this.batch || [];
    this.batch = null;
    this.listing = null;
    if (!batch.length) return;
    const text = ['MULTI', ...batch.map((a) => command(...a)), 'EXEC'].join('\n');
    await this.logged(text, {}, async () => {
      const multi = this.client.multi();
      for (const args of batch) multi.addCommand(args);
      let replies;
      try {
        replies = await multi.exec();
      } catch (e) {
        const at = e.errorIndexes && e.errorIndexes.length ? e.errorIndexes[0] : -1;
        if (at === -1) throw e;
        throw new Error(`${command(...batch[at])} failed: ${e.replies[at].message}. The other commands of the transaction were applied.`);
      }
      const lost = batch.findIndex((args, i) => args[0].toUpperCase() === 'RENAMENX' && Number(replies[i]) === 0);
      if (lost !== -1) throw new Error(`“${batch[lost][1]}” was not renamed: “${batch[lost][2]}” was created in the meantime. The other changes were saved.`);
    });
  }

  // ---- catalog ------------------------------------------------------------------------------

  async listDatabases() {
    let n = 16;
    try {
      const r = await this.send(['CONFIG', 'GET', 'databases']);
      n = Number(Array.isArray(r) ? r[1] : r && r.databases) || 16;
    } catch { /* CONFIG is often disabled on hosted servers; 16 is the default */ }
    const names = Array.from({ length: Math.max(n, Number(this.database) + 1) }, (x, i) => String(i));
    return names;
  }

  async useDatabase(name) {
    if (!/^\d+$/.test(String(name))) throw new Error('Redis databases are numbered');
    await this.logged(`SELECT ${name}`, { meta: true }, () => this.send(['SELECT', name]));
    this.database = String(name);
    this.listing = null;
  }

  /** SCAN until `stop` says so or the cursor wraps. `complete`: every matching key was seen. */
  async scan(pattern, type, max) {
    const keys = new Set();
    let cursor = '0';
    let calls = 0;
    do {
      const args = ['SCAN', cursor, 'MATCH', pattern, 'COUNT', 1000];
      if (type) args.push('TYPE', type);
      const [next, batch] = await this.send(args);
      for (const k of batch) keys.add(k);
      cursor = String(next);
      calls++;
    } while (cursor !== '0' && keys.size < max && calls < MAX_SCANS);
    return { keys: [...keys], complete: cursor === '0' };
  }

  /** The sidebar: "*" for every key, then one group per prefix (the part before the first ":"). */
  async listObjects() {
    const out = { tables: [], views: [], matviews: [], sequences: [], functions: [], procedures: [] };
    const scan = await this.logged('SCAN 0 MATCH * COUNT 1000', { meta: true }, () => this.scan('*', null, GROUP_SAMPLE));
    const groups = new Map();
    for (const k of scan.keys) {
      const at = k.indexOf(':');
      if (at > 0) groups.set(k.slice(0, at), (groups.get(k.slice(0, at)) || 0) + 1);
    }
    out.tables.push({ name: '*', kind: 'table', estimate: null, comment: 'Every key of this database' });
    const names = [...groups.keys()].sort((a, b) => a.localeCompare(b)).slice(0, 2000);
    for (const g of names) {
      out.tables.push({ name: `${g}:*`, kind: 'table', estimate: scan.complete ? groups.get(g) : null, comment: scan.complete ? `${groups.get(g)} keys` : 'Keys starting with this prefix' });
    }
    return out;
  }

  async describeTable() {
    const column = (name, type, extra) => ({
      name, type, base: type, nullable: name !== 'key', default: null, comment: null, pk: name === 'key', autoIncrement: false, generated: false, extra: '', enumValues: null, ...extra,
    });
    return {
      kind: 'table',
      columns: [
        column('key', 'string'),
        column('type', 'string', { enumValues: TYPES.slice(0, 5), comment: 'string, hash, list, set, zset or stream' }),
        column('ttl', 'integer', { comment: 'Seconds until the key expires; -1 when it does not' }),
        column('size', 'integer', { comment: 'Length of a string, or number of members' }),
        column('value', 'string', { comment: 'Hashes and sorted sets as a JSON object, lists and sets as a JSON array' }),
      ],
      primaryKey: ['key'],
      indexes: [], foreignKeys: [], checks: [], triggers: [],
    };
  }

  async ddl() { return '# Redis keys have no definition.'; }
  async listColumns() { return {}; }

  async estimateCount(schema, tableName) {
    return tableName === '*' ? Number(await this.send(['DBSIZE'])) : null;
  }

  async processList() {
    const reply = await this.logged('CLIENT LIST', { meta: true }, () => this.send(['CLIENT', 'LIST']));
    const t = this.clientTable(String(reply));
    return { fields: t.fields, rows: t.rows, idColumn: 0, killStatement: 'CLIENT KILL ID {id}' };
  }

  async kill(id) { await this.logged(`CLIENT KILL ID ${id}`, {}, () => this.send(['CLIENT', 'KILL', 'ID', id])); }

  // ---- key pages ----------------------------------------------------------------------------

  /** What a page request means for SCAN: the group's pattern, an optional type, key tests. */
  keyFilter(req) {
    const tests = [];
    let type = null;
    for (const rule of activeRules(req.filters)) {
      if (rule.op === 'raw' || rule.column === 'key' || rule.column === ANY_COLUMN) tests.push(keyTest(rule));
      else if (rule.column === 'type' && rule.op === '=' && !type) type = String(rule.value);
      else if (rule.column === 'type') throw new Error('The type column can only be filtered with “=”');
      else throw new Error(`Keys can be filtered by key and by type. “${rule.column}” is read one key at a time, so it cannot be searched`);
    }
    return { pattern: req.table || '*', type, tests, filtered: tests.length > 0 || !!type };
  }

  pageQuery(req) {
    const f = this.keyFilter(req);
    return { sql: command('SCAN', 0, 'MATCH', f.pattern, 'COUNT', 1000, ...(f.type ? ['TYPE', f.type] : [])), params: [], filtered: f.filtered };
  }

  pagePreview(req) {
    const f = this.keyFilter(req);
    const lines = [`${this.pageQuery(req).sql}   # repeated until the cursor returns to 0`];
    if (f.tests.length) lines.push('# key filters are applied to the names that come back');
    lines.push('# then, for each key of the page: TYPE, TTL and the value (GET, HGETALL, LRANGE, SMEMBERS, ZRANGE)');
    return lines.join('\n');
  }

  /**
   * The sorted key names of a group. SCAN has no order and no offset, so the names are read
   * once, sorted, and kept until the first page is asked for again.
   */
  async keyList(req, refresh) {
    const f = this.keyFilter(req);
    const desc = (req.sort || []).some((s) => s.column === 'key' && s.dir === 'desc');
    const id = JSON.stringify([this.database, f.pattern, req.filters || [], desc]);
    if (!refresh && this.listing && this.listing.id === id) return this.listing;
    const scan = await this.logged(`${this.pageQuery(req).sql}   # until the cursor returns to 0`, {}, () => this.scan(f.pattern, f.type, MAX_KEYS));
    const keys = scan.keys.filter((k) => f.tests.every((t) => t(k))).sort();
    if (desc) keys.reverse();
    this.listing = { id, keys, complete: scan.complete };
    return this.listing;
  }

  async loadValue(key, type) {
    const big = (n, what) => `(${n} ${what} — too many to show here; read them in a query tab)`;
    const many = async (lengthCommand, read, shape) => {
      const n = Number(await this.send([lengthCommand, key]));
      return { size: n, value: n > MAX_ITEMS ? big(n, 'members') : JSON.stringify(shape(await this.send(read))) };
    };
    switch (type) {
      case 'string': {
        const n = Number(await this.send(['STRLEN', key]));
        return { size: n, value: n > MAX_STRING ? big(n, 'bytes') : await this.send(['GET', key]) };
      }
      case 'hash': return many('HLEN', ['HGETALL', key], (r) => Object.fromEntries(pairs(r)));
      case 'list': return many('LLEN', ['LRANGE', key, 0, -1], (r) => r);
      case 'set': return many('SCARD', ['SMEMBERS', key], (r) => [...r].sort());
      case 'zset': return many('ZCARD', ['ZRANGE', key, 0, -1, 'WITHSCORES'], (r) => Object.fromEntries(pairs(r).map(([m, s]) => [m, Number(s)])));
      case 'stream': {
        const n = Number(await this.send(['XLEN', key]));
        const entries = await this.send(['XRANGE', key, '-', '+', 'COUNT', 100]);
        return { size: n, value: JSON.stringify(entries.map(([id, f]) => ({ id, ...Object.fromEntries(pairs(f)) }))) };
      }
      case 'ReJSON-RL': return { size: null, value: await this.send(['JSON.GET', key]) };
      case 'none': return { size: null, value: null };
      default: return { size: null, value: `(${type})` };
    }
  }

  async fetchPage(req, opts = {}) {
    const offset = Number(req.offset) || 0;
    const list = await this.keyList(req, offset === 0);
    const keys = list.keys.slice(offset, offset + Number(req.limit));
    const rows = await this.logged(`# TYPE, TTL and value of ${keys.length} keys`, { ...opts, meta: true }, async () => {
      // Commands issued together travel as one pipeline.
      const types = await Promise.all(keys.map((k) => this.send(['TYPE', k])));
      const ttls = await Promise.all(keys.map((k) => this.send(['TTL', k])));
      const values = await Promise.all(keys.map((k, i) => this.loadValue(k, types[i])));
      return keys.map((k, i) => [k, types[i], Number(ttls[i]), values[i].size, values[i].value]);
    });
    // Only the key order is known for the whole group; other columns sort the loaded page.
    const by = (req.sort || []).find((s) => s.column !== 'key');
    if (by) {
      const c = FIELDS.findIndex((f) => f.name === by.column);
      const dir = by.dir === 'desc' ? -1 : 1;
      if (c !== -1) rows.sort((a, b) => (a[c] === b[c] ? 0 : a[c] === null ? 1 : b[c] === null ? -1 : a[c] < b[c] ? -dir : dir));
    }
    return { fields: FIELDS.map((f) => ({ ...f })), rows, affected: null, command: 'SCAN', truncated: false };
  }

  async countRows(req) {
    const list = await this.keyList(req, false);
    return { count: list.keys.length, estimated: !list.complete };
  }

  async insertRows() { throw new Error('Importing a file is not available for Redis'); }
  async createImportTable() { throw new Error('Importing a file is not available for Redis'); }
}

module.exports = { RedisDriver, globToRegex, keyTest };
