'use strict';
// SQL tokenizer shared by the main process and the renderer.
// It only needs to be good enough to: split a batch into statements, tell reads from
// writes, and find variables outside of strings/comments.
// Cypher (Neo4j) is close enough to SQL to be tokenized here; MongoDB, Redis and
// Elasticsearch have their own readers, and the functions below hand over to them.

const { isSqlDialect } = require('./dialect');

const NATIVE = {
  mongodb: require('./mongoshell'),
  redis: require('./rediscmd'),
  elasticsearch: require('./esconsole'),
};

const WORD_START = /[A-Za-z_\u0080-￿]/;
const WORD_PART = /[A-Za-z0-9_$\u0080-￿]/;

/**
 * @param {string} sql
 * @param {'postgres'|'mysql'|'sqlite'|'neo4j'} dialect
 * @returns {{type:string,text:string,start:number,end:number}[]}
 *   type: ws | comment | string | ident (quoted identifier) | word | number | punct
 */
function tokenize(sql, dialect = 'postgres') {
  const out = [];
  const n = sql.length;
  let i = 0;
  const push = (type, start, end) => out.push({ type, text: sql.slice(start, end), start, end });
  const cypher = dialect === 'neo4j';
  const backslashEscapes = dialect === 'mysql' || cypher;

  while (i < n) {
    const c = sql[i];
    const c2 = sql[i + 1];
    const start = i;

    if (/\s/.test(c)) {
      while (i < n && /\s/.test(sql[i])) i++;
      push('ws', start, i);
      continue;
    }
    // line comments ("--" is a relationship pattern in Cypher, which comments with "//")
    if ((c === '-' && c2 === '-' && !cypher) || (c === '#' && dialect === 'mysql') || (c === '/' && c2 === '/' && cypher)) {
      while (i < n && sql[i] !== '\n') i++;
      push('comment', start, i);
      continue;
    }
    // block comments (PostgreSQL allows nesting)
    if (c === '/' && c2 === '*') {
      let depth = 1;
      i += 2;
      while (i < n && depth > 0) {
        if (sql[i] === '/' && sql[i + 1] === '*' && dialect === 'postgres') { depth++; i += 2; }
        else if (sql[i] === '*' && sql[i + 1] === '/') { depth--; i += 2; }
        else i++;
      }
      push('comment', start, i);
      continue;
    }
    // single-quoted string (optionally E'..' in PostgreSQL)
    if (c === "'" || ((c === 'E' || c === 'e') && c2 === "'" && dialect === 'postgres' && !isWordBefore(sql, i))) {
      const escapes = backslashEscapes || c !== "'";
      i += c === "'" ? 1 : 2;
      while (i < n) {
        if (escapes && sql[i] === '\\') { i += 2; continue; }
        if (sql[i] === "'") {
          if (sql[i + 1] === "'") { i += 2; continue; }
          i++;
          break;
        }
        i++;
      }
      push('string', start, Math.min(i, n));
      continue;
    }
    // dollar-quoted string (PostgreSQL): $$..$$ or $tag$..$tag$
    if (c === '$' && dialect === 'postgres') {
      const m = /^\$([A-Za-z_][A-Za-z0-9_]*)?\$/.exec(sql.slice(i, i + 80));
      if (m) {
        const close = sql.indexOf(m[0], i + m[0].length);
        i = close === -1 ? n : close + m[0].length;
        push('string', start, i);
        continue;
      }
    }
    // quoted identifiers
    if (c === '"' || c === '`') {
      // In MySQL a double-quoted token is a string unless ANSI_QUOTES is on; either way
      // it must be skipped as one unit, which is all the callers need.
      i++;
      while (i < n) {
        if (backslashEscapes && c === '"' && sql[i] === '\\') { i += 2; continue; }
        if (sql[i] === c) {
          if (sql[i + 1] === c) { i += 2; continue; }
          i++;
          break;
        }
        i++;
      }
      push(c === '"' && (dialect === 'mysql' || cypher) ? 'string' : 'ident', start, Math.min(i, n));
      continue;
    }
    if (c === '[' && dialect === 'sqlite') {
      const close = sql.indexOf(']', i + 1);
      i = close === -1 ? n : close + 1;
      push('ident', start, i);
      continue;
    }
    if (/[0-9]/.test(c) || (c === '.' && /[0-9]/.test(c2 || ''))) {
      while (i < n && /[0-9A-Za-z_.]/.test(sql[i])) i++;
      push('number', start, i);
      continue;
    }
    if (WORD_START.test(c)) {
      while (i < n && WORD_PART.test(sql[i])) i++;
      push('word', start, i);
      continue;
    }
    i++;
    push('punct', start, i);
  }
  return out;
}

function isWordBefore(sql, i) {
  return i > 0 && WORD_PART.test(sql[i - 1]);
}

const significant = (t) => t.type !== 'ws' && t.type !== 'comment';

const COMPOUND_KINDS = new Set(['TRIGGER', 'PROCEDURE', 'FUNCTION', 'EVENT']);

/**
 * Split a batch on top-level semicolons. Statements that are only whitespace/comments are
 * dropped. CREATE TRIGGER/PROCEDURE/FUNCTION bodies (BEGIN ... END) are kept whole.
 * @returns {{text:string,start:number,end:number}[]}
 */
function splitStatements(sql, dialect = 'postgres') {
  if (NATIVE[dialect]) return NATIVE[dialect].split(sql);
  const tokens = tokenize(sql, dialect);
  const out = [];
  let first = -1; // index of the first significant token of the current statement
  let last = -1;
  let compound = null; // null = undecided, false = plain, true = BEGIN/END aware
  let depth = 0;
  let words = [];

  const flush = () => {
    if (first !== -1) {
      const start = tokens[first].start;
      const end = tokens[last].end;
      out.push({ text: sql.slice(start, end), start, end });
    }
    first = -1; last = -1; compound = null; depth = 0; words = [];
  };

  for (let k = 0; k < tokens.length; k++) {
    const t = tokens[k];
    if (!significant(t)) continue;
    if (t.type === 'punct' && t.text === ';' && !(compound && depth > 0)) {
      flush();
      continue;
    }
    if (first === -1) first = k;
    last = k;
    if (t.type !== 'word') continue;
    const w = t.text.toUpperCase();
    if (compound === null) {
      words.push(w);
      if (words[0] !== 'CREATE') compound = false;
      else if (COMPOUND_KINDS.has(w)) compound = dialect === 'mysql' || dialect === 'sqlite';
      else if (w === 'TABLE' || w === 'VIEW' || w === 'INDEX' || words.length > 12) compound = false;
      continue;
    }
    if (!compound) continue;
    if (w === 'BEGIN' || w === 'CASE') depth++;
    else if (w === 'END') {
      const next = nextSignificant(tokens, k);
      const nw = next && next.type === 'word' ? next.text.toUpperCase() : '';
      if (nw === 'IF' || nw === 'LOOP' || nw === 'WHILE' || nw === 'REPEAT') continue;
      if (depth > 0) depth--;
    }
  }
  flush();
  return out;
}

function nextSignificant(tokens, k) {
  for (let j = k + 1; j < tokens.length; j++) if (significant(tokens[j])) return tokens[j];
  return null;
}

/** Statement under the caret; a caret in the gap after a statement belongs to that statement. */
function statementAt(sql, offset, dialect = 'postgres') {
  const stmts = splitStatements(sql, dialect);
  let prev = null;
  for (const s of stmts) {
    if (offset < s.start) return prev || s;
    if (offset <= s.end) return s;
    prev = s;
  }
  return prev;
}

const WRITE_WORDS = new Set([
  'INSERT', 'UPDATE', 'DELETE', 'MERGE', 'REPLACE', 'UPSERT', 'TRUNCATE', 'DROP', 'ALTER', 'CREATE',
  'GRANT', 'REVOKE', 'CALL', 'EXECUTE', 'COPY', 'LOAD', 'VACUUM', 'REINDEX', 'RENAME',
]);

/**
 * 'read' for statements that cannot change data (SELECT / EXPLAIN / SHOW and friends),
 * 'write' for everything else. When unsure the answer is 'write'.
 */
function classify(statement, dialect = 'postgres') {
  if (NATIVE[dialect]) return NATIVE[dialect].classify(statement);
  if (dialect === 'neo4j') return classifyCypher(statement);
  const words = [];
  let parenDepth = 0;
  const topLevel = [];
  for (const t of tokenize(statement, dialect)) {
    if (t.type === 'punct') {
      if (t.text === '(') parenDepth++;
      else if (t.text === ')') parenDepth = Math.max(0, parenDepth - 1);
      continue;
    }
    if (t.type !== 'word') continue;
    const w = t.text.toUpperCase();
    words.push(w);
    if (parenDepth === 0) topLevel.push(w);
  }
  if (!words.length) return 'read';
  const head = words[0];
  const hasWrite = words.some((w) => WRITE_WORDS.has(w));

  switch (head) {
    case 'SELECT':
    case 'VALUES':
    case 'TABLE':
      // SELECT ... INTO creates a table (PostgreSQL) or writes a file (MySQL).
      return topLevel.includes('INTO') ? 'write' : 'read';
    case 'WITH':
      // Data-modifying CTEs are writes.
      return hasWrite || topLevel.includes('INTO') ? 'write' : 'read';
    case 'EXPLAIN':
      // EXPLAIN ANALYZE really runs the statement.
      return (words.includes('ANALYZE') || words.includes('ANALYSE')) && hasWrite ? 'write' : 'read';
    case 'SHOW':
    case 'DESCRIBE':
    case 'DESC':
      return 'read';
    default:
      return 'write';
  }
}

const CYPHER_WRITE_WORDS = new Set([
  'CREATE', 'MERGE', 'SET', 'DELETE', 'DETACH', 'REMOVE', 'DROP', 'FOREACH', 'LOAD', 'INSERT', 'ALTER', 'RENAME',
  'GRANT', 'DENY', 'REVOKE', 'START', 'STOP', 'TERMINATE', 'ENABLE', 'DEALLOCATE', 'REALLOCATE',
]);
// Procedures that only report. Any other CALL may write, so it counts as a write.
const CYPHER_READ_PROCEDURES = new RegExp('^(?:' + [
  'db\\.(?:labels|relationshiptypes|propertykeys|info|ping|indexes|constraints|schema\\.\\w+|index\\.(?:fulltext|vector)\\.query\\w+)',
  'dbms\\.(?:components|info|showcurrentuser|listconfig|listqueries|listtransactions|listconnections|functions|procedures|queryjmx)',
  'apoc\\.(?:help|version|meta\\.\\w+)',
].join('|') + ')$');

function classifyCypher(statement) {
  const tokens = tokenize(statement, 'neo4j').filter(significant);
  if (!tokens.length) return 'read';
  const head = tokens[0].type === 'word' ? tokens[0].text.toUpperCase() : '';
  // EXPLAIN plans the statement without running it; PROFILE runs it.
  if (head === 'EXPLAIN' || head === 'SHOW') return 'read';
  for (let k = 0; k < tokens.length; k++) {
    const t = tokens[k];
    if (t.type !== 'word') continue;
    const before = k > 0 ? tokens[k - 1].text : '';
    const after = k + 1 < tokens.length ? tokens[k + 1].text : '';
    // Labels (:Create), properties (n.set), parameters ($set) and map keys {set: 1} are names.
    if (before === ':' || before === '.' || before === '$' || after === ':') continue;
    const w = t.text.toUpperCase();
    if (CYPHER_WRITE_WORDS.has(w)) return 'write';
    if (w !== 'CALL' || after === '{' || after === '(') continue; // a subquery is judged by its own words
    let name = '';
    for (let j = k + 1; j < tokens.length && (tokens[j].type === 'word' || tokens[j].text === '.'); j++) name += tokens[j].text;
    if (!CYPHER_READ_PROCEDURES.test(name.toLowerCase())) return 'write';
  }
  return 'read';
}

/** True when every statement of the batch is a read. */
function isReadOnlyBatch(statements, dialect) {
  return statements.every((s) => classify(typeof s === 'string' ? s : s.text, dialect) === 'read');
}

const VARIABLE_PATTERNS = {
  colon: /(?<![:\w]):([A-Za-z_][A-Za-z0-9_]*)/g,
  dollar: /\$\{([A-Za-z_][A-Za-z0-9_]*)\}/g,
  braces: /\{\{\s*([A-Za-z_][A-Za-z0-9_]*)\s*\}\}/g,
};

/**
 * The variable syntax in effect. Outside SQL ":name" is a label, a JSON value or part of a
 * key name, so those dialects use ${name} unless {{name}} was chosen.
 */
function variableFormat(format, dialect = 'postgres') {
  if (isSqlDialect(dialect)) return VARIABLE_PATTERNS[format] ? format : 'colon';
  return format === 'braces' ? 'braces' : 'dollar';
}

function variableSpans(sql, format, dialect, inStrings) {
  const pattern = VARIABLE_PATTERNS[variableFormat(format, dialect)];
  const spans = [];
  // Mask out the regions that must not be searched, keeping offsets stable. Requests and
  // commands (JSON bodies, Redis arguments) are searched as written.
  let masked = '';
  for (const t of NATIVE[dialect] ? [{ type: 'text', text: sql }] : tokenize(sql, dialect)) {
    const skip = t.type === 'comment' || (t.type === 'string' && !inStrings);
    masked += skip ? ' '.repeat(t.text.length) : t.text;
  }
  pattern.lastIndex = 0;
  let m;
  while ((m = pattern.exec(masked))) {
    spans.push({ name: m[1], start: m.index, end: m.index + m[0].length });
  }
  return spans;
}

/** Distinct variable names in order of first appearance. */
function findVariables(sql, format = 'colon', dialect = 'postgres', inStrings = false) {
  const seen = new Set();
  const names = [];
  for (const s of variableSpans(sql, format, dialect, inStrings)) {
    if (!seen.has(s.name)) { seen.add(s.name); names.push(s.name); }
  }
  return names;
}

/** Replace variables with the given raw text values. */
function substituteVariables(sql, values, format = 'colon', dialect = 'postgres', inStrings = false) {
  const spans = variableSpans(sql, format, dialect, inStrings);
  let out = '';
  let pos = 0;
  for (const s of spans) {
    if (!(s.name in values)) continue;
    out += sql.slice(pos, s.start) + values[s.name];
    pos = s.end;
  }
  return out + sql.slice(pos);
}

/** Several statements written out as one text, the way each language separates them. */
function joinStatements(statements, dialect = 'postgres') {
  if (dialect === 'redis') return statements.join('\n');
  if (dialect === 'elasticsearch') return statements.join('\n\n');
  return statements.map((s) => s.replace(/;\s*$/, '') + ';').join('\n');
}

module.exports = {
  tokenize, splitStatements, statementAt, classify, isReadOnlyBatch,
  findVariables, substituteVariables, variableFormat, joinStatements,
};
