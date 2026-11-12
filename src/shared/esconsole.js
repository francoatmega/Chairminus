'use strict';
// Elasticsearch / OpenSearch requests in console form, as the app sends and accepts them:
//   GET /orders/_search
//   { "query": { "match": { "status": "open" } } }
// A request is its "METHOD path" line plus the JSON body on the lines that follow.

const { isBin, isExpr, isNumericType } = require('./dialect');

const REQUEST_LINE = /^[ \t]*(GET|POST|PUT|DELETE|HEAD|PATCH)[ \t]+(\S+)[ \t]*$/i;
const COMMENT_LINE = /^\s*(#|\/\/)/;
/** Endpoints whose body is newline-delimited JSON and must be sent as written. */
const NDJSON = /\/(_bulk|_msearch|_msearch\/template)$/;

/** One request per "METHOD path" line; the body runs until the next request line. */
function split(text) {
  const out = [];
  let pos = 0;
  let cur = null;
  const flush = () => { if (cur) out.push({ text: text.slice(cur.start, cur.end), start: cur.start, end: cur.end }); cur = null; };
  for (const line of text.split('\n')) {
    const lead = line.length - line.trimStart().length;
    if (REQUEST_LINE.test(line)) { flush(); cur = { start: pos + lead, end: pos + line.trimEnd().length }; }
    else if (cur && line.trim() && !COMMENT_LINE.test(line)) cur.end = pos + line.trimEnd().length;
    else if (!cur && line.trim() && !COMMENT_LINE.test(line)) {
      // Text before any request line is kept so that running it reports the mistake.
      cur = { start: pos + lead, end: pos + line.trimEnd().length };
    }
    pos += line.length + 1;
  }
  flush();
  return out;
}

/** @returns {{method:string, path:string, endpoint:string, body:string, ndjson:boolean}} */
function parse(statement) {
  const lines = String(statement).split('\n');
  let first = 0;
  while (first < lines.length && (!lines[first].trim() || COMMENT_LINE.test(lines[first]))) first++;
  const m = REQUEST_LINE.exec(lines[first] || '');
  if (!m) throw new Error('A request starts with a method and a path — for example GET /_cat/indices');
  const method = m[1].toUpperCase();
  const path = m[2].startsWith('/') ? m[2] : '/' + m[2];
  const endpoint = path.split('?')[0].replace(/\/+$/, '') || '/';
  const ndjson = NDJSON.test(endpoint);
  const rest = lines.slice(first + 1).filter((l) => !COMMENT_LINE.test(l));
  let body = rest.join('\n').trim();
  if (ndjson) body = rest.filter((l) => l.trim()).map((l) => l.trim()).join('\n') + '\n';
  else if (body) {
    try { JSON.parse(body); } catch (e) { throw new Error(`The request body is not valid JSON: ${e.message}`); }
  }
  return { method, path, endpoint, body: ndjson && body === '\n' ? '' : body, ndjson };
}

const READ_ENDPOINTS = new Set(['_search', '_count', '_msearch', '_mget', '_explain', '_validate', '_analyze', '_field_caps', '_search_shards',
  '_terms_enum', '_termvectors', '_mtermvectors', '_rank_eval', '_knn_search', '_sql', '_eql', '_esql', '_ppl', '_render', '_query']);

/** 'read' for GET/HEAD and for the POST endpoints that only search; anything unclear is a 'write'. */
function classify(statement) {
  let req;
  try { req = parse(statement); } catch { return 'write'; }
  if (req.method === 'GET' || req.method === 'HEAD') return 'read';
  if (req.method !== 'POST') return 'write';
  const parts = req.endpoint.split('/').filter(Boolean);
  // POST /index/_search, /_search/template, /_sql/translate, /_plugins/_sql, /_validate/query …
  // Scroll and point-in-time calls change server state, so they stay writes.
  if (parts.some((p) => p === 'scroll' || p === '_pit' || p === 'point_in_time' || p === 'close' || p === '_async_search')) return 'write';
  const at = parts.findIndex((p) => READ_ENDPOINTS.has(p));
  if (at === -1) return 'write';
  return parts.slice(at + 1).every((p) => !p.startsWith('_') || p === '_explain') ? 'read' : 'write';
}

// ---- writing requests ---------------------------------------------------------------------

const seg = (s) => encodeURIComponent(String(s));

/** A grid value as the JSON value to index. Arrays and objects travel as JSON text. */
function jsonValue(v, type) {
  if (v === null || v === undefined || isExpr(v)) return null;
  if (isBin(v)) return v.__bin;
  if (typeof v !== 'string') return v;
  const t = v.trim();
  if ((t.startsWith('{') && t.endsWith('}')) || (t.startsWith('[') && t.endsWith(']'))) {
    // Any field may hold several values, so a JSON array is always sent as an array.
    try { const parsed = JSON.parse(t); if (parsed !== null && typeof parsed === 'object') return parsed; } catch { /* plain text */ }
  }
  if (isNumericType(type) && t !== '' && Number.isFinite(Number(t)) && String(Number(t)) === t) return Number(t);
  if (type === 'boolean' && /^(true|false)$/i.test(t)) return t.toLowerCase() === 'true';
  return v;
}

function source(values, typeOf) {
  const doc = {};
  for (const k of Object.keys(values)) {
    if (values[k] === undefined || k === '_id') continue;
    if (k.startsWith('_')) throw new Error(`“${k}” is metadata and cannot be set`);
    doc[k] = jsonValue(values[k], typeOf(k));
  }
  return JSON.stringify(doc);
}

/**
 * Pending grid changes -> one request per document. refresh=true makes each change visible to
 * the search that reloads the grid. There is no transaction: requests are sent in order.
 */
function buildChanges({ table, columns = [], changes }) {
  const typeOf = (name) => (columns.find((c) => c.name === name) || {}).type;
  const index = seg(table);
  const idOf = (original) => {
    if (original._id === undefined || original._id === null || original._id === '') throw new Error('This document has no _id, so it cannot be changed from the grid');
    return seg(original._id);
  };
  const out = [];
  for (const ch of changes) {
    if (ch.type === 'insert') {
      const id = ch.values._id;
      const line = id !== undefined && id !== null && id !== '' ? `PUT /${index}/_create/${seg(id)}?refresh=true` : `POST /${index}/_doc?refresh=true`;
      out.push({ kind: 'insert', single: false, sql: `${line}\n${source(ch.values, typeOf)}` });
    } else if (ch.type === 'update') {
      if (!Object.keys(ch.set).length) continue;
      if ('_id' in ch.set) throw new Error('The _id of a document cannot be changed. Duplicate the document and delete the original instead.');
      out.push({ kind: 'update', single: true, usesPrimaryKey: true, sql: `POST /${index}/_update/${idOf(ch.original)}?refresh=true\n{"doc": ${source(ch.set, typeOf)}}` });
    } else if (ch.type === 'delete') {
      out.push({ kind: 'delete', single: true, usesPrimaryKey: true, sql: `DELETE /${index}/_doc/${idOf(ch.original)}?refresh=true` });
    }
  }
  return out;
}

function objectStatements(name, kind) {
  const index = seg(name);
  const search = `GET /${index}/_search\n{\n  "size": 100,\n  "query": { "match_all": {} }\n}`;
  return {
    select: search,
    query: search,
    drop: kind === 'table' ? `DELETE /${index}` : null,
    truncate: kind === 'table' ? `POST /${index}/_delete_by_query?refresh=true\n{"query": {"match_all": {}}}` : null,
  };
}

module.exports = { split, parse, classify, jsonValue, buildChanges, objectStatements };
