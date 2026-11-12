'use strict';
// Identifier/literal quoting per dialect. Values travel between processes as:
//   null | string | number | boolean | {__bin: hex} | {__expr: 'NOW()'}

/** Dialects that speak SQL; the others have a query language of their own. */
const SQL_DIALECTS = ['postgres', 'mysql', 'sqlite'];
function isSqlDialect(dialect) { return SQL_DIALECTS.includes(dialect); }

function quoteIdent(dialect, name) {
  if (dialect === 'mysql' || dialect === 'neo4j') return '`' + String(name).replace(/`/g, '``') + '`';
  return '"' + String(name).replace(/"/g, '""') + '"';
}

function qualified(dialect, schema, table) {
  return schema ? quoteIdent(dialect, schema) + '.' + quoteIdent(dialect, table) : quoteIdent(dialect, table);
}

function isBin(v) { return v !== null && typeof v === 'object' && typeof v.__bin === 'string'; }
function isExpr(v) { return v !== null && typeof v === 'object' && typeof v.__expr === 'string'; }

function stringLiteral(dialect, s) {
  s = String(s);
  if (dialect === 'mysql') {
    return "'" + s.replace(/\\/g, '\\\\').replace(/'/g, "''").replace(/\0/g, '\\0') + "'";
  }
  if (dialect === 'postgres' && s.includes('\\')) {
    // E'' strings behave the same whatever standard_conforming_strings is set to.
    return "E'" + s.replace(/\\/g, '\\\\').replace(/'/g, "''") + "'";
  }
  return "'" + s.replace(/'/g, "''") + "'";
}

function literal(dialect, v) {
  if (v === null || v === undefined) return 'NULL';
  if (isExpr(v)) return v.__expr;
  if (isBin(v)) {
    const hex = v.__bin.replace(/[^0-9a-fA-F]/g, '');
    return dialect === 'postgres' ? `'\\x${hex}'::bytea` : `X'${hex}'`;
  }
  if (typeof v === 'number') return Number.isFinite(v) ? String(v) : stringLiteral(dialect, String(v));
  if (typeof v === 'bigint') return String(v);
  if (typeof v === 'boolean') return dialect === 'sqlite' ? (v ? '1' : '0') : (v ? 'TRUE' : 'FALSE');
  return stringLiteral(dialect, v);
}

function placeholder(dialect, index) {
  return dialect === 'postgres' ? '$' + index : '?';
}

/** Text shown in a grid cell. */
function displayValue(v) {
  if (v === null || v === undefined) return 'NULL';
  if (isExpr(v)) return v.__expr;
  if (isBin(v)) return '0x' + v.__bin;
  if (typeof v === 'boolean') return v ? 'true' : 'false';
  return String(v);
}

/** Text used when a value is edited or copied (NULL becomes ''). */
function editText(v) {
  return v === null || v === undefined ? '' : displayValue(v);
}

function sameValue(a, b) {
  if (a === b) return true;
  if (a === null || b === null || a === undefined || b === undefined) return false;
  if (typeof a === 'object' || typeof b === 'object') return JSON.stringify(a) === JSON.stringify(b);
  return String(a) === String(b);
}

const NUMERIC_TYPE = /^(u?int|integer|smallint|bigint|tinyint|mediumint|serial|bigserial|smallserial|numeric|decimal|real|float|double|money|oid|number|long|short|newdecimal|year|byte|half_float|scaled_float|unsigned_long)/i;
const TEXT_TYPE = /(char|text|name|citext|string|clob|enum|set|uuid|keyword)/i;

function isNumericType(type) { return NUMERIC_TYPE.test(String(type || '').trim()); }
function isTextType(type) { return TEXT_TYPE.test(String(type || '')); }

module.exports = {
  quoteIdent, qualified, literal, stringLiteral, placeholder, displayValue, editText, sameValue,
  isBin, isExpr, isNumericType, isTextType, isSqlDialect,
};
