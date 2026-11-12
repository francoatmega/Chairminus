'use strict';
// Pending grid changes -> SQL. The SQL shown in "Preview SQL" is exactly what is sent.

const { quoteIdent, qualified, literal, isTextType } = require('./dialect');

/** Databases without SQL write their changes in their own language. */
const NATIVE = {
  mongodb: require('./mongoshell'),
  redis: require('./rediscmd'),
  elasticsearch: require('./esconsole'),
  neo4j: require('./cypher'),
};

/**
 * @typedef {{type:'update', original:Object<string,any>, set:Object<string,any>}
 *         | {type:'insert', values:Object<string,any>}
 *         | {type:'delete', original:Object<string,any>}} Change
 */

/** WHERE that locates one row: the primary key when there is one, else every original value. */
function rowCondition(dialect, columns, primaryKey, original) {
  const usePk = primaryKey && primaryKey.length && primaryKey.every((k) => original[k] !== undefined && original[k] !== null);
  const names = usePk ? primaryKey : columns.map((c) => c.name).filter((n) => original[n] !== undefined);
  const parts = names.map((name) => {
    const id = quoteIdent(dialect, name);
    const v = original[name];
    if (v === null) return `${id} IS NULL`;
    const col = columns.find((c) => c.name === name) || {};
    // Without a key, PostgreSQL types such as json or point have no "=" at all.
    let lhs = id;
    if (!usePk && typeof v !== 'object') {
      if (dialect === 'postgres' && !isTextType(col.type)) lhs = `${id}::TEXT`;
      // MySQL compares a JSON column with a string as two JSON values, which never match.
      else if (dialect === 'mysql' && /^json/i.test(col.type || '')) lhs = `CAST(${id} AS CHAR)`;
    }
    return `${lhs} = ${literal(dialect, v)}`;
  });
  return { sql: parts.join(' AND ') || '1 = 1', usesPrimaryKey: !!usePk };
}

/** Narrow a condition to a single physical row (used by "Save Again with Row Identity"). */
function identityCondition(dialect, target, cond) {
  if (dialect === 'postgres') return `(tableoid, ctid) = (SELECT tableoid, ctid FROM ${target} WHERE ${cond} LIMIT 1)`;
  if (dialect === 'sqlite') return `rowid = (SELECT rowid FROM ${target} WHERE ${cond} LIMIT 1)`;
  return cond; // MySQL appends LIMIT 1 instead
}

/**
 * @param {object} o
 * @param {string} o.dialect
 * @param {string} [o.schema]
 * @param {string} o.table
 * @param {{name:string,type?:string}[]} o.columns
 * @param {string[]} o.primaryKey
 * @param {Change[]} o.changes
 * @param {boolean} [o.rowIdentity] restrict each UPDATE/DELETE to one physical row
 * @returns {{sql:string, kind:string, single:boolean, usesPrimaryKey?:boolean, countInResult?:boolean, opts?:object}[]}
 *   single: the statement must change exactly one row. countInResult: that count is the
 *   statement's one result value instead of its affected-row count.
 */
function buildChangeStatements({ dialect, schema, table, columns, primaryKey, changes, rowIdentity = false }) {
  if (NATIVE[dialect]) return NATIVE[dialect].buildChanges({ table, columns, primaryKey, changes });
  const target = qualified(dialect, schema, table);
  const out = [];
  const where = (original) => {
    const cond = rowCondition(dialect, columns, primaryKey, original);
    if (!rowIdentity || cond.usesPrimaryKey) return { clause: cond.sql, tail: '', usesPrimaryKey: cond.usesPrimaryKey };
    return {
      clause: identityCondition(dialect, target, cond.sql),
      tail: dialect === 'mysql' ? ' LIMIT 1' : '',
      usesPrimaryKey: false,
    };
  };

  for (const ch of changes) {
    if (ch.type === 'insert') {
      const names = Object.keys(ch.values).filter((k) => ch.values[k] !== undefined);
      if (!names.length) {
        out.push({ kind: 'insert', single: false, sql: dialect === 'mysql' ? `INSERT INTO ${target} () VALUES ()` : `INSERT INTO ${target} DEFAULT VALUES` });
      } else {
        out.push({
          kind: 'insert', single: false,
          sql: `INSERT INTO ${target} (${names.map((n) => quoteIdent(dialect, n)).join(', ')}) VALUES (${names.map((n) => literal(dialect, ch.values[n])).join(', ')})`,
        });
      }
    } else if (ch.type === 'update') {
      const names = Object.keys(ch.set);
      if (!names.length) continue;
      const w = where(ch.original);
      out.push({
        kind: 'update', single: true, usesPrimaryKey: w.usesPrimaryKey,
        sql: `UPDATE ${target} SET ${names.map((n) => `${quoteIdent(dialect, n)} = ${literal(dialect, ch.set[n])}`).join(', ')} WHERE ${w.clause}${w.tail}`,
      });
    } else if (ch.type === 'delete') {
      const w = where(ch.original);
      out.push({ kind: 'delete', single: true, usesPrimaryKey: w.usesPrimaryKey, sql: `DELETE FROM ${target} WHERE ${w.clause}${w.tail}` });
    }
  }
  return out;
}

function insertStatement(dialect, schema, table, names, row) {
  return `INSERT INTO ${qualified(dialect, schema, table)} (${names.map((n) => quoteIdent(dialect, n)).join(', ')}) VALUES (${row.map((v) => literal(dialect, v)).join(', ')});`;
}

/**
 * Ready-made statements for a table-like object, in the connection's own language.
 * drop/truncate are null where the database has no such operation.
 * @returns {{select:string, query:string, drop:string|null, truncate:string|null}}
 */
function objectStatements(dialect, schema, name, kind = 'table') {
  if (NATIVE[dialect]) return NATIVE[dialect].objectStatements(name, kind);
  const target = qualified(dialect, schema, name);
  const what = kind === 'matview' ? 'MATERIALIZED VIEW' : kind === 'view' ? 'VIEW' : 'TABLE';
  return {
    select: `SELECT * FROM ${target};`,
    query: `SELECT * FROM ${target}\nLIMIT 100;`,
    drop: `DROP ${what} ${target}`,
    truncate: kind !== 'table' ? null : dialect === 'sqlite' ? `DELETE FROM ${target}` : `TRUNCATE TABLE ${target}`,
  };
}

/**
 * What an import is about to send, written as one statement for the confirmation dialog
 * (and so that the safe mode sees a write).
 */
function importStatement(dialect, schema, table, names, fileName) {
  switch (dialect) {
    case 'mongodb': return `${NATIVE.mongodb.collectionRef(table)}.insertMany([ /* rows of ${fileName} */ ])`;
    case 'elasticsearch': return `POST /${encodeURIComponent(table)}/_bulk\n# rows of ${fileName}`;
    case 'neo4j': return `UNWIND $rows AS row CREATE (n:${NATIVE.neo4j.name(table)}) SET n += row  // rows of ${fileName}`;
    default:
      return `INSERT INTO ${qualified(dialect, schema, table)} (${names.map((n) => quoteIdent(dialect, n)).join(', ')}) VALUES (…)  -- rows of ${fileName}`;
  }
}

module.exports = { buildChangeStatements, rowCondition, insertStatement, objectStatements, importStatement };
