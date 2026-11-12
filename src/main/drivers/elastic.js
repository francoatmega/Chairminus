'use strict';
// Elasticsearch and OpenSearch share their REST API, so one driver talks to both over plain
// HTTP(S) — the official clients each refuse the other product.
const http = require('http');
const https = require('https');
const { Driver, tlsOptions, wantsTls, cellValue, tableFromDocuments, tableFromFields, typedFilterValue } = require('./base');
const es = require('../../shared/esconsole');
const { ANY_COLUMN, activeRules, splitList } = require('../../shared/filters');

const MAPPING_TTL_MS = 30000;
const PLAIN_HTTP = { send: 'HEAD / HTTP/1.0\r\n\r\n', expect: /^HTTP\/1\.[01] / };
const WRITTEN = { created: 1, updated: 1, deleted: 1, noop: 1, not_found: 0 };
const seg = (s) => encodeURIComponent(String(s));

const result = (table, extra) => ({ fields: table.fields, rows: table.rows, affected: null, command: '', truncated: false, ...extra });

function errorText(status, data) {
  const err = data && typeof data === 'object' ? data.error : null;
  if (err && typeof err === 'object') {
    const cause = Array.isArray(err.root_cause) && err.root_cause[0] ? err.root_cause[0] : err;
    return `${cause.reason || err.reason || err.type} (${cause.type || err.type}, HTTP ${status})`;
  }
  if (typeof err === 'string') return `${err} (HTTP ${status})`;
  if (status === 401) return 'Authentication failed (HTTP 401) — check the user and password, or the API key';
  if (status === 403) return 'Not allowed (HTTP 403)';
  return `HTTP ${status}${typeof data === 'string' && data.trim() ? ': ' + data.trim().slice(0, 300) : ''}`;
}

/** Search hits as documents: _id first, then the fields of _source. */
function hitDocuments(hits, { index = false, score = false } = {}) {
  return hits.map((h) => {
    const doc = { _id: h._id };
    if (index) doc._index = h._index;
    if (score) doc._score = h._score;
    Object.assign(doc, h._source || {});
    // "fields" answers come as arrays, one-element for single values.
    for (const [k, v] of Object.entries(h.fields || {})) if (!(k in doc)) doc[k] = Array.isArray(v) && v.length === 1 ? v[0] : v;
    return doc;
  });
}

/** A response body as a result grid. */
function shape(data) {
  if (typeof data === 'string') return { fields: [{ name: 'response', type: '' }], rows: data === '' ? [] : [[data]] };
  if (Array.isArray(data)) return tableFromDocuments(data);
  if (data === null || typeof data !== 'object') return { fields: [{ name: 'response', type: '' }], rows: [[cellValue(data)]] };
  const hits = data.hits && Array.isArray(data.hits.hits) ? data.hits.hits : null;
  // A search that only aggregates has no hits worth a grid: show the whole answer instead.
  if (hits && (hits.length || !data.aggregations)) {
    const many = new Set(hits.map((h) => h._index)).size > 1;
    return tableFromDocuments(hitDocuments(hits, { index: many, score: hits.some((h) => typeof h._score === 'number') }), { first: ['_id'] });
  }
  if (Array.isArray(data.docs) && data.docs.every((d) => d && '_id' in d)) return tableFromDocuments(hitDocuments(data.docs.filter((d) => d.found !== false)), { first: ['_id'] });
  // SQL answers: Elasticsearch {columns, rows}, ES|QL {columns, values}, OpenSearch {schema, datarows}.
  const columns = data.columns || data.schema;
  const rows = data.rows || data.values || data.datarows;
  if (Array.isArray(columns) && Array.isArray(rows) && columns.every((c) => c && typeof c.name === 'string')) {
    return { fields: columns.map((c) => ({ name: c.alias || c.name, type: c.type || '' })), rows: rows.map((r) => r.map(cellValue)) };
  }
  return tableFromFields(data);
}

// ---- filters ------------------------------------------------------------------------------

const escapeWildcard = (s) => String(s).replace(/[\\*?]/g, '\\$&');
const escapeQueryString = (s) => String(s).replace(/[+\-=&|><!(){}[\]^"~*?:\\/]/g, '\\$&');
const likeToWildcard = (s) => String(s).split(/([%_])/).map((p) => (p === '%' ? '*' : p === '_' ? '?' : escapeWildcard(p))).join('');
const not = (q) => ({ bool: { must_not: [q] } });
const STRING_TYPES = /^(text|keyword|wildcard|constant_keyword|match_only_text|search_as_you_type)$/;

/**
 * Filter rules -> query DSL. `fields` comes from the mapping: exact matching on a text field
 * goes to its keyword sub-field, since the text itself is stored as analysed words.
 */
function compileQuery(rules, fields = {}) {
  const info = (column) => fields[column] || {};
  const exact = (column) => { const f = info(column); return f.type === 'text' || f.type === 'match_only_text' ? f.keyword : column; };
  const value = (column, text) => typedFilterValue(text, info(column).type);
  const stringy = (column) => !info(column).type || STRING_TYPES.test(info(column).type);

  const anyColumn = (rule) => {
    const text = String(rule.value ?? '');
    const all = (query) => ({ query_string: { query, lenient: true, analyze_wildcard: true } });
    switch (rule.op) {
      case 'contains': return all(`*${escapeQueryString(text)}*`);
      case 'not_contains': return not(all(`*${escapeQueryString(text)}*`));
      case 'prefix': return all(`${escapeQueryString(text)}*`);
      case 'suffix': return all(`*${escapeQueryString(text)}`);
      case '=': return { multi_match: { query: text, type: 'phrase', lenient: true } };
      case '<>': return not({ multi_match: { query: text, type: 'phrase', lenient: true } });
      default: throw new Error('“Any column” can be searched with contains, starts with, ends with, = and ≠');
    }
  };

  const one = (rule) => {
    const column = rule.column;
    const text = String(rule.value ?? '');
    const insensitive = rule.caseSensitive ? {} : { case_insensitive: true };
    const term = (v) => {
      if (column === '_id') return { ids: { values: [String(v)] } };
      const f = exact(column);
      return f ? { term: { [f]: { value: value(column, v) } } } : { match_phrase: { [column]: String(v) } };
    };
    const wildcard = (pattern) => {
      if (column === '_id') throw new Error('_id can be filtered with = and IN');
      // Wildcards only exist for text; other types are compared as written.
      if (!stringy(column)) return { query_string: { query: escapeQueryString(text), fields: [column], lenient: true } };
      const f = exact(column);
      return f ? { wildcard: { [f]: { value: pattern, ...insensitive } } } : { query_string: { query: pattern, fields: [column], analyze_wildcard: true } };
    };
    const range = (bounds) => ({ range: { [column]: Object.fromEntries(Object.entries(bounds).map(([k, v]) => [k, value(column, v)])) } });
    const terms = () => {
      const items = splitList(text);
      if (column === '_id') return { ids: { values: items } };
      const f = exact(column);
      return f ? { terms: { [f]: items.map((v) => value(column, v)) } } : { bool: { should: items.map((v) => ({ match_phrase: { [column]: v } })), minimum_should_match: 1 } };
    };
    const blank = () => ({ bool: { should: [not({ exists: { field: column } }), ...(stringy(column) && exact(column) ? [{ term: { [exact(column)]: { value: '' } } }] : [])], minimum_should_match: 1 } });
    switch (rule.op) {
      case '=': return term(text);
      case '<>': return not(term(text));
      case '<': return range({ lt: text });
      case '>': return range({ gt: text });
      case '<=': return range({ lte: text });
      case '>=': return range({ gte: text });
      case 'contains': return wildcard(`*${escapeWildcard(text)}*`);
      case 'not_contains': return not(wildcard(`*${escapeWildcard(text)}*`));
      case 'prefix': return wildcard(`${escapeWildcard(text)}*`);
      case 'suffix': return wildcard(`*${escapeWildcard(text)}`);
      case 'like': return wildcard(likeToWildcard(text));
      case 'not_like': return not(wildcard(likeToWildcard(text)));
      case 'in': return terms();
      case 'not_in': return not(terms());
      case 'between': return range({ gte: text, lte: rule.value2 ?? '' });
      case 'not_between': return not(range({ gte: text, lte: rule.value2 ?? '' }));
      case 'null': return not({ exists: { field: column } });
      case 'not_null': return { exists: { field: column } };
      case 'empty': return blank();
      case 'not_empty': return not(blank());
      default: return null;
    }
  };

  const clauses = [];
  for (const rule of activeRules(rules)) {
    if (rule.op === 'raw') {
      const text = String(rule.value).trim();
      if (text.startsWith('{')) {
        try { clauses.push(JSON.parse(text)); } catch (e) { throw new Error(`The raw filter is not valid JSON: ${e.message}`); }
      } else clauses.push({ query_string: { query: text } });
    } else {
      const q = rule.column === ANY_COLUMN ? anyColumn(rule) : one(rule);
      if (q) clauses.push(q);
    }
  }
  return clauses.length ? { bool: { filter: clauses } } : { match_all: {} };
}

// ---- driver -------------------------------------------------------------------------------

class ElasticDriver extends Driver {
  constructor(params, log) {
    super(params, log);
    this.dialect = 'elasticsearch';
    this.sql = false;
    this.hasDatabases = false;
    // Every request stands alone: there is nothing to roll back.
    this.transactional = false;
    this.database = '';
    this.product = 'Elasticsearch';
    this.kinds = new Map();
    this.mappings = new Map();
  }

  async connect() {
    const p = this.params;
    this.secure = await wantsTls(p, 9200, PLAIN_HTTP);
    this.agent = this.secure
      ? new https.Agent({ keepAlive: true, maxSockets: 4, ...tlsOptions(p) })
      : new http.Agent({ keepAlive: true, maxSockets: 4 });
    // A password without a user is an API key (the encoded form both products hand out).
    this.authorization = p.user ? 'Basic ' + Buffer.from(`${p.user}:${p.password || ''}`).toString('base64')
      : p.password ? `ApiKey ${p.password}` : null;
    try {
      const root = (await this.request('GET', '/')).data;
      const v = (root && root.version) || {};
      this.product = v.distribution === 'opensearch' ? 'OpenSearch' : 'Elasticsearch';
      this.version = v.number || '';
    } catch (e) {
      this.agent.destroy();
      this.agent = null;
      throw e;
    }
  }

  async disconnect() {
    const a = this.agent;
    this.agent = null;
    if (a) a.destroy();
  }

  /** @returns {Promise<{status:number, data:any}>} data is parsed JSON, or the text as sent */
  request(method, path, body, { ndjson = false, accept = [] } = {}) {
    if (!this.agent) return Promise.reject(new Error('Not connected'));
    const p = this.params;
    return new Promise((resolve, reject) => {
      const headers = { Accept: 'application/json' };
      if (body) {
        headers['Content-Type'] = ndjson ? 'application/x-ndjson' : 'application/json';
        headers['Content-Length'] = Buffer.byteLength(body);
      }
      if (this.authorization) headers.Authorization = this.authorization;
      const req = (this.secure ? https : http).request({
        host: p.host || 'localhost', port: Number(p.port) || 9200, method, path, headers, agent: this.agent,
      }, (res) => {
        const chunks = [];
        res.on('data', (c) => chunks.push(c));
        res.on('error', reject);
        res.on('end', () => {
          this.current = null;
          const text = Buffer.concat(chunks).toString('utf8');
          let data = text;
          if (/json/i.test(res.headers['content-type'] || '')) { try { data = JSON.parse(text); } catch { /* keep the text */ } }
          if (res.statusCode >= 400 && !accept.includes(res.statusCode)) reject(new Error(errorText(res.statusCode, data)));
          else resolve({ status: res.statusCode, data });
        });
      });
      req.on('error', (e) => { this.current = null; reject(e); });
      this.current = req;
      if (body) req.write(body);
      req.end();
    });
  }

  /** A request made by the app itself, logged like a statement. */
  call(method, path, body, opts = {}) {
    const text = `${method} ${path}${body ? '\n' + (typeof body === 'string' ? body : JSON.stringify(body)) : ''}`;
    return this.logged(text, opts, async () => (await this.request(method, path, body && typeof body !== 'string' ? JSON.stringify(body) : body, opts)).data);
  }

  async ping(quiet) { await this.call('GET', '/', null, quiet ? { quiet: true } : { meta: true }); }
  async begin() { /* no transaction: see `transactional` */ }
  async commit() { /* nothing to commit */ }
  async rollback() { /* nothing to undo */ }

  async cancel() {
    if (this.current) this.current.destroy(new Error('Cancelled'));
  }

  // ---- statements ---------------------------------------------------------------------------

  async query(text, params = [], opts = {}) {
    const req = es.parse(text);
    let path = req.path;
    // _cat answers in aligned text unless asked for JSON, which is what a grid needs.
    if (req.endpoint.startsWith('/_cat/') && !/[?&]format=/.test(path)) path += (path.includes('?') ? '&' : '?') + 'format=json';
    return this.logged(text, opts, async () => {
      // Deleting a document that is already gone answers 404 with a normal body.
      const res = await this.request(req.method, path, req.body, { ndjson: req.ndjson, accept: req.method === 'DELETE' || req.method === 'HEAD' ? [404] : [] });
      const data = res.data;
      if (req.method === 'HEAD') return { fields: [], rows: [], affected: null, command: 'HEAD', truncated: false, message: res.status === 404 ? '404 — not found' : `${res.status} — exists` };
      if (res.status === 404 && !(data && data.result === 'not_found')) throw new Error(errorText(404, data));
      const t = shape(data);
      const limit = opts.rowLimit || 0;
      const truncated = limit > 0 && t.rows.length > limit;
      if (truncated) t.rows.length = limit;
      const obj = data !== null && typeof data === 'object' && !Array.isArray(data) ? data : {};
      const affected = obj.result in WRITTEN ? WRITTEN[obj.result] : typeof obj.deleted === 'number' && 'total' in obj ? obj.deleted : typeof obj.updated === 'number' && 'total' in obj ? obj.updated : null;
      if (obj.items && obj.errors === true) {
        const bad = obj.items.map((i) => Object.values(i)[0]).find((i) => i && i.error);
        throw new Error(`Some bulk actions failed: ${bad ? bad.error.reason : 'see the response'}`);
      }
      const total = obj.hits && obj.hits.total !== undefined ? (typeof obj.hits.total === 'object' ? `${obj.hits.total.relation === 'gte' ? 'more than ' : ''}${obj.hits.total.value}` : String(obj.hits.total)) : null;
      // Requests on an index itself (PUT /orders, DELETE /orders, aliases, templates) change the sidebar.
      const schemaChanged = req.method !== 'GET' && !/\/(_doc|_create|_update|_search|_count|_bulk|_msearch|_mget|_sql|_refresh|_delete_by_query|_update_by_query|_analyze)(\/|$)/.test(req.endpoint);
      if (schemaChanged) this.mappings.clear();
      return result(t, { command: req.method, truncated, affected, schemaChanged, ...(total !== null ? { message: `${total} hits${typeof obj.took === 'number' ? ` in ${obj.took} ms` : ''}` } : {}) });
    });
  }

  // ---- catalog ------------------------------------------------------------------------------

  async listObjects() {
    const out = { tables: [], views: [], matviews: [], sequences: [], functions: [], procedures: [] };
    const indices = await this.call('GET', '/_cat/indices?format=json&h=index,docs.count,health,status&s=index', null, { meta: true });
    const kinds = new Map();
    const system = (name) => name.startsWith('.');
    for (const i of [...indices.filter((x) => !system(x.index)), ...indices.filter((x) => system(x.index))]) {
      out.tables.push({ name: i.index, kind: 'table', estimate: i['docs.count'] === undefined || i['docs.count'] === null ? null : Number(i['docs.count']), comment: [i.health, i.status].filter(Boolean).join(' · ') });
      kinds.set(i.index, 'table');
    }
    const aliases = await this.call('GET', '/_cat/aliases?format=json&h=alias,index', null, { meta: true }).catch(() => []);
    const byAlias = new Map();
    for (const a of aliases) if (!system(a.alias)) byAlias.set(a.alias, [...(byAlias.get(a.alias) || []), a.index]);
    for (const name of [...byAlias.keys()].sort()) {
      out.views.push({ name, kind: 'view', estimate: null, comment: `alias of ${byAlias.get(name).join(', ')}` });
      kinds.set(name, 'view');
    }
    // Data streams are missing from older servers and from some hosted ones.
    const streams = await this.call('GET', '/_data_stream', null, { meta: true }).catch(() => ({}));
    for (const s of (streams.data_streams || []).sort((a, b) => a.name.localeCompare(b.name))) {
      out.matviews.push({ name: s.name, kind: 'matview', estimate: null, comment: 'data stream' });
      kinds.set(s.name, 'matview');
    }
    this.kinds = kinds;
    return out;
  }

  /** Top-level fields of an index (or of every index behind an alias), from its mapping. */
  async fieldInfo(index, fresh) {
    const cached = this.mappings.get(index);
    if (!fresh && cached && Date.now() - cached.at < MAPPING_TTL_MS) return cached;
    const data = await this.call('GET', `/${seg(index)}/_mapping`, null, { meta: true });
    const fields = {};
    for (const entry of Object.values(data)) {
      const props = (entry.mappings && entry.mappings.properties) || {};
      for (const [name, p] of Object.entries(props)) {
        if (fields[name]) continue;
        const sub = Object.entries(p.fields || {}).find(([, f]) => f.type === 'keyword');
        fields[name] = { type: p.type || 'object', keyword: sub ? `${name}.${sub[0]}` : null };
      }
    }
    const info = { at: Date.now(), fields, names: Object.keys(fields), indices: Object.keys(data).length };
    this.mappings.set(index, info);
    return info;
  }

  async kindOf(name) {
    if (!this.kinds.size) await this.listObjects();
    return this.kinds.get(name) || 'table';
  }

  async describeTable(schema, table) {
    const info = await this.fieldInfo(table, true);
    const kind = await this.kindOf(table);
    const column = (name, type, extra) => ({
      name, type, base: type, nullable: true, default: null, comment: null, pk: false, autoIncrement: false, generated: false, extra: '', enumValues: null, ...extra,
    });
    return {
      kind,
      columns: [
        column('_id', 'keyword', { pk: true, nullable: false, autoIncrement: true, comment: 'Document id; left empty, the server generates one' }),
        ...(kind === 'table' ? [] : [column('_index', 'keyword', { comment: 'The index that holds the document' })]),
        ...info.names.map((n) => column(n, info.fields[n].type, { comment: info.fields[n].keyword ? `exact values in ${info.fields[n].keyword}` : null })),
      ],
      primaryKey: ['_id'],
      indexes: [], foreignKeys: [], checks: [], triggers: [],
    };
  }

  /** The request that would create the index again: settings worth keeping, and the mapping. */
  async ddl(schema, name) {
    const data = await this.call('GET', `/${seg(name)}`, null, { meta: true });
    return Object.entries(data).map(([index, def]) => {
      const settings = { ...((def.settings && def.settings.index) || {}) };
      // Assigned by the server when the index is created.
      for (const k of ['uuid', 'version', 'creation_date', 'provided_name', 'history_uuid']) delete settings[k];
      const body = { ...(Object.keys(def.aliases || {}).length ? { aliases: def.aliases } : {}), settings: { index: settings }, mappings: def.mappings || {} };
      return `PUT /${index}\n${JSON.stringify(body, null, 2)}`;
    }).join('\n\n');
  }

  async listColumns() {
    const data = await this.call('GET', '/_mapping', null, { meta: true }).catch(() => ({}));
    const out = {};
    for (const [index, entry] of Object.entries(data)) {
      if (!index.startsWith('.')) out[index] = Object.keys((entry.mappings && entry.mappings.properties) || {});
    }
    return out;
  }

  async processList() {
    const data = await this.call('GET', '/_tasks?detailed=true&group_by=none', null, { meta: true });
    const tasks = Array.isArray(data.tasks) ? data.tasks : [];
    const names = ['id', 'action', 'description', 'running_ms', 'cancellable', 'type'];
    return {
      fields: names.map((n) => ({ name: n, type: '' })),
      rows: tasks.map((t) => [`${t.node}:${t.id}`, t.action, t.description || '', Math.round((t.running_time_in_nanos || 0) / 1e6), t.cancellable === true, t.type]),
      idColumn: 0, killStatement: 'POST /_tasks/{id}/_cancel',
    };
  }

  async kill(id) {
    if (!/^[\w-]+:\d+$/.test(String(id))) throw new Error('Invalid task id');
    await this.call('POST', `/_tasks/${id}/_cancel`, null, {});
  }

  // ---- index pages --------------------------------------------------------------------------

  searchBody(req, info) {
    const body = { query: compileQuery(req.filters, { _id: { type: 'keyword' }, ...info.fields }) };
    body.sort = req.sort && req.sort.length
      ? req.sort.map((s) => {
        const f = info.fields[s.column] || {};
        // Text is not sortable; its keyword sub-field is.
        return { [(f.type === 'text' && f.keyword) || s.column]: { order: s.dir === 'desc' ? 'desc' : 'asc' } };
      })
      : ['_doc'];
    return body;
  }

  pageQuery(req) {
    const info = this.mappings.get(req.table) || { fields: Object.fromEntries((req.columns || []).map((c) => [c.name, { type: c.type, keyword: null }])) };
    const body = this.searchBody(req, info);
    return { sql: `POST /${seg(req.table)}/_search`, params: [], filtered: !('match_all' in body.query), body };
  }

  pagePreview(req) {
    const q = this.pageQuery(req);
    return `${q.sql}\n${JSON.stringify({ from: Number(req.offset) || 0, size: Number(req.limit) || 300, ...q.body }, null, 2)}`;
  }

  pageTable(hits, info, kind) {
    const docs = hitDocuments(hits, { index: kind !== 'table' });
    const types = { _id: 'keyword', _index: 'keyword' };
    for (const n of info.names) types[n] = info.fields[n].type;
    return tableFromDocuments(docs, { first: ['_id', ...(kind === 'table' ? [] : ['_index']), ...info.names], types });
  }

  async fetchPage(req, opts = {}) {
    const info = await this.fieldInfo(req.table);
    const kind = await this.kindOf(req.table);
    const body = { from: Number(req.offset) || 0, size: Number(req.limit), ...this.searchBody(req, info), track_total_hits: false };
    const data = await this.call('POST', `/${seg(req.table)}/_search`, body, opts);
    return result(this.pageTable(data.hits.hits, info, kind), { command: 'POST' });
  }

  async countRows(req) {
    const info = await this.fieldInfo(req.table);
    const data = await this.call('POST', `/${seg(req.table)}/_count`, { query: this.searchBody(req, info).query }, {});
    return Number(data.count);
  }

  /** from/size stops at 10,000 documents; an export reads the index through a scroll instead. */
  async *pages(req, size) {
    const info = await this.fieldInfo(req.table);
    const kind = await this.kindOf(req.table);
    let data = await this.call('POST', `/${seg(req.table)}/_search?scroll=2m`, { size, ...this.searchBody(req, info) }, {});
    try {
      for (;;) {
        // `docs` carries the documents whole, for a JSON export.
        yield { ...result(this.pageTable(data.hits.hits, info, kind)), docs: hitDocuments(data.hits.hits, { index: kind !== 'table' }) };
        if (data.hits.hits.length < size || !data._scroll_id) return;
        data = await this.call('POST', '/_search/scroll', { scroll: '2m', scroll_id: data._scroll_id }, { quiet: true });
      }
    } finally {
      if (data && data._scroll_id) await this.call('DELETE', '/_search/scroll', { scroll_id: data._scroll_id }, { quiet: true }).catch(() => {});
    }
  }

  // ---- import -------------------------------------------------------------------------------

  insertBatchSize() { return 500; }

  async insertRows(schema, table, names, rows, opts = {}) {
    const lines = [];
    for (const row of rows) {
      const doc = {};
      let id;
      names.forEach((n, i) => {
        if (row[i] === null || row[i] === undefined) return;
        if (n === '_id') id = String(row[i]);
        else doc[n] = row[i];
      });
      lines.push(JSON.stringify({ index: id === undefined ? {} : { _id: id } }), JSON.stringify(doc));
    }
    const text = `POST /${seg(table)}/_bulk?refresh=true   # ${rows.length} documents`;
    await this.logged(text, opts, async () => {
      const { data } = await this.request('POST', `/${seg(table)}/_bulk?refresh=true`, lines.join('\n') + '\n', { ndjson: true });
      if (data.errors) {
        const bad = data.items.map((i) => Object.values(i)[0]).find((i) => i && i.error);
        throw new Error(bad ? `${bad.error.reason} (${bad.error.type})` : 'Some documents were refused');
      }
    });
  }

  async createImportTable() { /* an index is created by its first document */ }
}

module.exports = { ElasticDriver, compileQuery, shape };
