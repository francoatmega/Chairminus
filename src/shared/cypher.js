'use strict';
// Cypher written by the app for Neo4j. Node labels are browsed as tables: one node per row,
// `_id` holding the node's element id and one column per property.

const { isBin, isExpr } = require('./dialect');

const name = (s) => '`' + String(s).replace(/`/g, '``') + '`';

function string(s) {
  return "'" + String(s).replace(/\\/g, '\\\\').replace(/'/g, "\\'").replace(/\n/g, '\\n').replace(/\r/g, '\\r').replace(/\t/g, '\\t') + "'";
}

/** Temporal property types and the function that builds each from its text form. */
const TEMPORAL = { date: 'date', datetime: 'datetime', localdatetime: 'localdatetime', time: 'time', localtime: 'localtime', duration: 'duration' };

function listLiteral(items) {
  return '[' + items.map((v) => {
    if (v === null) return 'null';
    if (Array.isArray(v)) return listLiteral(v);
    if (typeof v === 'object') throw new Error('A property cannot hold a map, only values and lists of values');
    return typeof v === 'string' ? string(v) : String(v);
  }).join(', ') + ']';
}

/** A grid value as a Cypher literal. `type` is the property's type in the loaded page. */
function literal(v, type) {
  if (v === null || v === undefined) return 'null';
  if (isExpr(v)) return v.__expr;
  if (isBin(v)) throw new Error('Binary properties cannot be edited in the grid');
  if (typeof v === 'boolean') return String(v);
  const t = String(type || '');
  if (typeof v === 'number') {
    if (!Number.isFinite(v)) return string(v);
    return t === 'float' && Number.isInteger(v) ? v.toFixed(1) : String(v);
  }
  const s = String(v);
  if (TEMPORAL[t]) return `${TEMPORAL[t]}(${string(s)})`;
  if (t === 'point') throw new Error('Point properties cannot be edited in the grid — use a query tab');
  if (t === 'integer' && /^-?\d+$/.test(s.trim())) return s.trim();
  if (t === 'float' && s.trim() !== '' && Number.isFinite(Number(s))) return Number.isInteger(Number(s)) ? Number(s).toFixed(1) : String(Number(s));
  if (t === 'boolean' && /^(true|false)$/i.test(s.trim())) return s.trim().toLowerCase();
  if (t !== 'string' && s.trim().startsWith('[') && s.trim().endsWith(']')) {
    // Lists travel as JSON text; written back, they are lists again.
    try { const list = JSON.parse(s); if (Array.isArray(list)) return listLiteral(list); } catch { /* plain text */ }
  }
  return string(s);
}

/** Neo4j 5 identifies nodes by element id ("4:…:12"); Neo4j 4 only has the numeric id. */
function matchNode(id) {
  if (id === undefined || id === null || id === '') throw new Error('This row has no _id, so it cannot be changed from the grid');
  return /^\d+$/.test(String(id)) ? `MATCH (n) WHERE id(n) = ${id}` : `MATCH (n) WHERE elementId(n) = ${string(id)}`;
}

function properties(values, typeOf) {
  const names = Object.keys(values).filter((k) => values[k] !== undefined);
  const meta = names.find((k) => k === '_id' || k === '_labels');
  if (meta) throw new Error(`“${meta}” is managed by Neo4j and cannot be set from the grid`);
  return names.map((k) => [name(k), literal(values[k], typeOf(k))]);
}

/**
 * Pending grid changes -> CREATE / SET / DELETE. UPDATE and DELETE return how many nodes
 * they matched, so a node that disappeared in the meantime is noticed. DELETE is not DETACH
 * DELETE: a node that still has relationships is refused by the server.
 */
function buildChanges({ table, columns = [], changes }) {
  const typeOf = (n) => (columns.find((c) => c.name === n) || {}).type;
  const out = [];
  for (const ch of changes) {
    if (ch.type === 'insert') {
      const props = properties(ch.values, typeOf).filter(([, v]) => v !== 'null');
      out.push({ kind: 'insert', single: false, sql: `CREATE (n:${name(table)}${props.length ? ` {${props.map(([k, v]) => `${k}: ${v}`).join(', ')}}` : ''})` });
    } else if (ch.type === 'update') {
      const props = properties(ch.set, typeOf);
      if (!props.length) continue;
      out.push({
        kind: 'update', single: true, usesPrimaryKey: true, countInResult: true,
        sql: `${matchNode(ch.original._id)} SET ${props.map(([k, v]) => `n.${k} = ${v}`).join(', ')} RETURN count(n) AS affected`,
      });
    } else if (ch.type === 'delete') {
      out.push({ kind: 'delete', single: true, usesPrimaryKey: true, countInResult: true, sql: `${matchNode(ch.original._id)} DELETE n RETURN count(*) AS affected` });
    }
  }
  return out;
}

/** kind 'table' is a node label, anything else a relationship type. */
function objectStatements(objectName, kind) {
  if (kind !== 'table') {
    const rel = `MATCH (a)-[r:${name(objectName)}]->(b) RETURN a, r, b`;
    return { select: rel, query: `${rel}\nLIMIT 100`, drop: null, truncate: null };
  }
  const match = `MATCH (n:${name(objectName)})`;
  return { select: `${match} RETURN n`, query: `${match} RETURN n\nLIMIT 100`, drop: null, truncate: `${match} DETACH DELETE n` };
}

module.exports = { name, string, literal, buildChanges, objectStatements };
