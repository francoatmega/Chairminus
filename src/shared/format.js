'use strict';
// Row serialisation for copy/export and CSV parsing for import.

const { displayValue, isBin, isExpr } = require('./dialect');
const { insertStatement } = require('./changes');

const CSV_DEFAULTS = {
  delimiter: ',', quote: '"', quoteMode: 'needed', header: true, nullAsEmpty: true, lineBreak: '\n',
};

function csvCell(v, o) {
  if (v === null || v === undefined) return o.nullAsEmpty ? '' : 'NULL';
  const s = displayValue(v);
  const q = o.quote;
  const must = o.quoteMode === 'always' ||
    s.includes(o.delimiter) || s.includes(q) || s.includes('\n') || s.includes('\r') || /^\s|\s$/.test(s);
  return must ? q + s.split(q).join(q + q) + q : s;
}

function csvLine(values, opts) {
  const o = { ...CSV_DEFAULTS, ...opts };
  return values.map((v) => csvCell(v, o)).join(o.delimiter);
}

function toCsv(names, rows, opts) {
  const o = { ...CSV_DEFAULTS, ...opts };
  const lines = [];
  if (o.header) lines.push(csvLine(names, { ...o, nullAsEmpty: true }));
  for (const r of rows) lines.push(csvLine(r, o));
  return lines.join(o.lineBreak) + (lines.length ? o.lineBreak : '');
}

function jsonValue(v) {
  if (v === null || v === undefined) return null;
  if (isBin(v)) return '0x' + v.__bin;
  if (isExpr(v)) return v.__expr;
  return v;
}

/** Nested documents and arrays reach the grid as JSON text; `inflate` turns them back. */
function inflateValue(v) {
  if (typeof v !== 'string' || v.length < 2) return v;
  const open = v[0];
  if (!((open === '{' && v.endsWith('}')) || (open === '[' && v.endsWith(']')))) return v;
  try { return JSON.parse(v); } catch { return v; }
}

function rowObject(names, row, { inflate = false } = {}) {
  const obj = {};
  names.forEach((n, i) => { obj[n] = inflate ? inflateValue(jsonValue(row[i])) : jsonValue(row[i]); });
  return obj;
}

function toJson(names, rows, opts) {
  return JSON.stringify(rows.map((r) => rowObject(names, r, opts)), null, 2) + '\n';
}

function toMarkdown(names, rows) {
  const cell = (v) => displayValue(v).replace(/\|/g, '\\|').replace(/\r?\n/g, '<br>');
  const lines = ['| ' + names.map(cell).join(' | ') + ' |', '| ' + names.map(() => '---').join(' | ') + ' |'];
  for (const r of rows) lines.push('| ' + r.map(cell).join(' | ') + ' |');
  return lines.join('\n') + '\n';
}

function toInserts(dialect, schema, table, names, rows) {
  return rows.map((r) => insertStatement(dialect, schema, table, names, r)).join('\n') + (rows.length ? '\n' : '');
}

function toTsv(rows) {
  return rows.map((r) => r.map((v) => (v === null ? '' : displayValue(v).replace(/[\t\n\r]/g, ' '))).join('\t')).join('\n');
}

/**
 * Incremental CSV parser. feed() returns the rows completed so far; end() flushes the tail.
 * A quote left open at the end of the input is reported through `truncated`.
 */
function createCsvParser({ delimiter = ',', quote = '"' } = {}) {
  let field = '';
  let row = [];
  let inQuotes = false;
  let quotedField = false;
  let pendingQuote = false; // saw a quote inside a quoted field; next char decides
  let lastCR = false;
  const state = { truncated: false };

  const endField = () => { row.push(field); field = ''; quotedField = false; };

  function feed(chunk) {
    const rows = [];
    const endRow = () => {
      endField();
      if (!(row.length === 1 && row[0] === '')) rows.push(row);
      row = [];
    };
    for (let i = 0; i < chunk.length; i++) {
      const c = chunk[i];
      if (inQuotes) {
        if (pendingQuote) {
          pendingQuote = false;
          if (c === quote) { field += quote; continue; }
          inQuotes = false; // the quote closed the field; fall through to handle c
        } else if (c === quote) {
          pendingQuote = true;
          continue;
        } else {
          field += c;
          continue;
        }
      }
      if (c === '\n' && lastCR) { lastCR = false; continue; }
      lastCR = false;
      if (c === quote && field === '' && !quotedField) { inQuotes = true; quotedField = true; }
      else if (c === delimiter) endField();
      else if (c === '\n') endRow();
      else if (c === '\r') { endRow(); lastCR = true; }
      else field += c;
    }
    return rows;
  }

  function end() {
    if (inQuotes && !pendingQuote) state.truncated = true;
    inQuotes = false; pendingQuote = false;
    if (field !== '' || row.length) {
      endField();
      const r = row;
      row = [];
      return r.length === 1 && r[0] === '' ? [] : [r];
    }
    return [];
  }

  return { feed, end, state };
}

function parseCsv(text, opts) {
  const p = createCsvParser(opts);
  const rows = p.feed(text);
  rows.push(...p.end());
  return { rows, truncated: p.state.truncated };
}

/** Guess the delimiter from the first lines of a file. */
function sniffDelimiter(sample) {
  const lines = sample.split(/\r?\n/).slice(0, 5).filter(Boolean);
  let best = ',';
  let bestScore = 0;
  for (const d of [',', ';', '\t', '|']) {
    const counts = lines.map((l) => l.split(d).length - 1);
    if (!counts.length || counts[0] === 0) continue;
    const consistent = counts.every((c) => c === counts[0]);
    const score = counts[0] * (consistent ? 2 : 1);
    if (score > bestScore) { bestScore = score; best = d; }
  }
  return best;
}

module.exports = {
  CSV_DEFAULTS, csvLine, toCsv, toJson, toMarkdown, toInserts, toTsv, rowObject, jsonValue,
  createCsvParser, parseCsv, sniffDelimiter,
};
