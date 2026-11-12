'use strict';
// Filter rules -> WHERE clause, per dialect. Values are sent as bind parameters; the
// "inline" form (literals written into the SQL) only exists for the preview and for export.

const { quoteIdent, literal, placeholder, isTextType } = require('./dialect');

const OPERATORS = [
  { id: '=', label: '=' },
  { id: '<>', label: '≠' },
  { id: '<', label: '<' },
  { id: '>', label: '>' },
  { id: '<=', label: '≤' },
  { id: '>=', label: '≥' },
  { id: 'contains', label: 'contains' },
  { id: 'not_contains', label: 'does not contain' },
  { id: 'prefix', label: 'starts with' },
  { id: 'suffix', label: 'ends with' },
  { id: 'in', label: 'IN' },
  { id: 'not_in', label: 'NOT IN' },
  { id: 'between', label: 'BETWEEN', two: true },
  { id: 'not_between', label: 'NOT BETWEEN', two: true },
  { id: 'like', label: 'LIKE' },
  { id: 'not_like', label: 'NOT LIKE' },
  { id: 'null', label: 'IS NULL', none: true },
  { id: 'not_null', label: 'IS NOT NULL', none: true },
  { id: 'empty', label: 'is empty', none: true },
  { id: 'not_empty', label: 'is not empty', none: true },
  { id: 'raw', label: 'Raw SQL', raw: true },
];
const OP = Object.fromEntries(OPERATORS.map((o) => [o.id, o]));
const ANY_COLUMN = '*';

const escapeLike = (v) => String(v).replace(/[\\%_]/g, (m) => '\\' + m);
const escapeGlob = (v) => String(v).replace(/[*?[]/g, (m) => '[' + m + ']');

function splitList(value) {
  return String(value ?? '').split(',').map((s) => s.trim()).filter((s) => s !== '');
}

/**
 * @param {object} o
 * @param {'postgres'|'mysql'|'sqlite'} o.dialect
 * @param {{column:string,op:string,value?:string,value2?:string,caseSensitive?:boolean,enabled?:boolean}[]} o.rules
 * @param {{name:string,type?:string}[]} o.columns  needed for "any column" and for casts
 * @param {boolean} [o.inline] write literals instead of placeholders
 * @returns {{sql:string, params:any[]}} sql is '' when no rule applies
 */
function compileFilters({ dialect, rules, columns = [], inline = false }) {
  const params = [];
  const val = (v) => {
    if (inline) return literal(dialect, v);
    params.push(v);
    return placeholder(dialect, params.length);
  };
  const typeOf = (name) => (columns.find((c) => c.name === name) || {}).type;

  const one = (rule, column, any) => {
    const op = rule.op;
    const type = typeOf(column);
    const id = quoteIdent(dialect, column);
    // PostgreSQL will not compare a non-text column with an arbitrary string, so text
    // matching (and every "any column" test) goes through ::TEXT.
    const asText = dialect === 'postgres' && !isTextType(type) ? id + '::TEXT' : id;
    const cmp = any && dialect === 'postgres' ? asText : id;

    const pattern = (kind, negate) => {
      const raw = String(rule.value ?? '');
      const not = negate ? 'NOT ' : '';
      if (rule.caseSensitive && dialect === 'sqlite') {
        // SQLite's LIKE ignores ASCII case; GLOB does not.
        const g = escapeGlob(raw);
        const p = kind === 'contains' ? `*${g}*` : kind === 'prefix' ? `${g}*` : `*${g}`;
        return `${asText} ${not}GLOB ${val(p)}`;
      }
      const e = escapeLike(raw);
      const p = kind === 'contains' ? `%${e}%` : kind === 'prefix' ? `${e}%` : `%${e}`;
      const esc = dialect === 'sqlite' ? " ESCAPE '\\'" : '';
      if (rule.caseSensitive) {
        if (dialect === 'mysql') return `${id} ${not}LIKE BINARY ${val(p)}`;
        return `${asText} ${not}LIKE ${val(p)}${esc}`;
      }
      if (dialect === 'postgres') return `${asText} ${not}ILIKE ${val(p)}`;
      return `LOWER(${id}) ${not}LIKE LOWER(${val(p)})${esc}`;
    };

    switch (op) {
      case '=': case '<>': case '<': case '>': case '<=': case '>=':
        return `${cmp} ${op} ${val(rule.value ?? '')}`;
      case 'contains': return pattern('contains', false);
      case 'not_contains': return pattern('contains', true);
      case 'prefix': return pattern('prefix', false);
      case 'suffix': return pattern('suffix', false);
      case 'like': return `${asText} LIKE ${val(rule.value ?? '')}`;
      case 'not_like': return `${asText} NOT LIKE ${val(rule.value ?? '')}`;
      case 'in':
      case 'not_in': {
        const items = splitList(rule.value);
        if (!items.length) return op === 'in' ? '(1 = 0)' : '(1 = 1)';
        return `${cmp} ${op === 'in' ? 'IN' : 'NOT IN'} (${items.map(val).join(', ')})`;
      }
      case 'between':
      case 'not_between':
        return `${cmp} ${op === 'between' ? 'BETWEEN' : 'NOT BETWEEN'} ${val(rule.value ?? '')} AND ${val(rule.value2 ?? '')}`;
      case 'null': return `${id} IS NULL`;
      case 'not_null': return `${id} IS NOT NULL`;
      case 'empty': return `(${id} IS NULL OR ${asText} = '')`;
      case 'not_empty': return `(${id} IS NOT NULL AND ${asText} <> '')`;
      default: return null;
    }
  };

  const parts = [];
  for (const rule of rules || []) {
    if (rule.enabled === false) continue;
    const def = OP[rule.op];
    if (!def) continue;
    if (def.raw) {
      const text = String(rule.value ?? '').trim().replace(/;+\s*$/, '');
      if (text) parts.push(`(${text})`);
      continue;
    }
    if (!def.none && !def.two && (rule.value === undefined || rule.value === null || rule.value === '') &&
        rule.op !== 'in' && rule.op !== 'not_in' && rule.op !== '=' && rule.op !== '<>') continue;
    if (rule.column === ANY_COLUMN) {
      const negative = ['<>', 'not_contains', 'not_like', 'not_in', 'not_between', 'not_null', 'not_empty'].includes(rule.op);
      const each = columns.map((c) => one(rule, c.name, true)).filter(Boolean);
      if (each.length) parts.push('(' + each.join(negative ? ' AND ' : ' OR ') + ')');
    } else if (rule.column) {
      const sql = one(rule, rule.column, false);
      if (sql) parts.push(sql);
    }
  }
  return { sql: parts.join(' AND '), params };
}

const NEGATIVE_OPS = ['<>', 'not_contains', 'not_like', 'not_in', 'not_between', 'not_null', 'not_empty'];

/**
 * The rules that take part in a filter, for drivers that build their own query: disabled
 * rules, unknown operators and rules still waiting for a value are left out.
 */
function activeRules(rules) {
  return (rules || []).filter((rule) => {
    const def = OP[rule.op];
    if (rule.enabled === false || !def) return false;
    if (def.raw) return String(rule.value ?? '').trim() !== '';
    const blank = rule.value === undefined || rule.value === null || rule.value === '';
    if (blank && !def.none && !def.two && !['in', 'not_in', '=', '<>'].includes(rule.op)) return false;
    return !!rule.column;
  });
}

module.exports = { OPERATORS, ANY_COLUMN, NEGATIVE_OPS, compileFilters, activeRules, splitList, escapeLike };
