'use strict';
// Export (table or already-loaded rows) and import (CSV / JSON / SQL file).
const fs = require('fs');
const { once } = require('events');
const fmt = require('../shared/format');
const { splitStatements } = require('../shared/tokenizer');
const { isSqlDialect } = require('../shared/dialect');

const PAGE = 2000;

function validateCsvOptions(o) {
  if (o && o.delimiter && o.decimal && o.delimiter === o.decimal) {
    throw new Error("Column delimiter and decimal delimiter shouldn't be the same symbol");
  }
}

async function write(stream, text) {
  if (!stream.write(text)) await once(stream, 'drain');
}

function chunkText(format, names, rows, ctx, first) {
  switch (format) {
    case 'csv': return fmt.toCsv(names, rows, { ...ctx.csv, header: first && ctx.csv.header !== false });
    case 'markdown': {
      const md = fmt.toMarkdown(names, rows);
      return first ? md : md.split('\n').slice(2).join('\n');
    }
    case 'sql': return fmt.toInserts(ctx.dialect, ctx.schema, ctx.table, names, rows);
    case 'json': return rows.map((r, i) => (first && i === 0 ? '  ' : ',\n  ') + JSON.stringify(ctx.docs ? ctx.docs[i] : fmt.rowObject(names, r, { inflate: ctx.inflate }))).join('');
    default: throw new Error(`Unknown format: ${format}`);
  }
}

/** Rows that are already in memory (a query result or the loaded page). */
async function exportRows({ filePath, format, names, rows, csv, dialect, schema, table }) {
  validateCsvOptions(csv);
  // Outside SQL a cell may hold a nested document as JSON text; JSON output gets it back whole.
  const ctx = { csv: csv || {}, dialect, schema, table: table || 'result', inflate: !isSqlDialect(dialect) };
  const stream = fs.createWriteStream(filePath, { encoding: 'utf8' });
  if (format === 'json') await write(stream, '[\n');
  await write(stream, chunkText(format, names, rows, ctx, true));
  if (format === 'json') await write(stream, '\n]\n');
  stream.end();
  await once(stream, 'finish');
  return { rows: rows.length };
}

/** A whole table (optionally filtered), read page by page so memory stays flat. */
async function exportTable(session, req, progress) {
  validateCsvOptions(req.csv);
  return session.op(async (d) => {
    const desc = await d.describeTable(req.schema, req.table);
    const page = { ...req, columns: desc.columns, primaryKey: desc.primaryKey };
    const wanted = req.columnNames && req.columnNames.length ? req.columnNames : null;
    // Rows of a document database do not all have the same fields, and a file needs one set
    // of columns: the ones the table was described with.
    const fixed = d.sql ? null : (wanted || desc.columns.map((c) => c.name));
    const ctx = { csv: req.csv || {}, dialect: d.dialect, schema: d.hasSchemas ? req.schema : null, table: req.table, inflate: !d.sql };
    const stream = fs.createWriteStream(req.filePath, { encoding: 'utf8' });
    let total = 0;
    try {
      if (req.format === 'sql') {
        if (!d.sql) throw new Error('SQL export is only available for SQL databases');
        if (req.dropIfExists) await write(stream, `DROP TABLE IF EXISTS ${d.target(req.schema, req.table)};\n\n`);
        if (req.includeStructure) await write(stream, (await d.ddl(req.schema, req.table, desc.kind)) + '\n\n');
      }
      if (req.format === 'json') await write(stream, '[\n');
      if (req.format !== 'sql' || req.includeContent !== false) {
        let first = true;
        for await (const r of d.pages(page, PAGE)) {
          if (session.cancelled) throw new Error('Cancelled');
          let names = r.fields.map((f) => f.name);
          let rows = r.rows;
          if (fixed || wanted) {
            let idx = (fixed || wanted).map((n) => names.indexOf(n));
            if (!fixed) idx = idx.filter((i) => i !== -1);
            names = fixed || idx.map((i) => names[i]);
            rows = rows.map((row) => idx.map((i) => (i === -1 ? null : row[i])));
          }
          // Whole documents, when the driver has them and no column was left out.
          ctx.docs = req.format === 'json' && r.docs && !wanted ? r.docs : null;
          if (rows.length || first) await write(stream, chunkText(req.format, names, rows, ctx, first));
          first = false;
          total += rows.length;
          progress({ rows: total });
        }
      }
      if (req.format === 'json') await write(stream, '\n]\n');
    } finally {
      stream.end();
      await once(stream, 'finish').catch(() => {});
    }
    return { rows: total };
  });
}

// ---- import -------------------------------------------------------------------------------

const PREVIEW_BYTES = 512 * 1024;

function readHead(filePath, encoding) {
  const fd = fs.openSync(filePath, 'r');
  try {
    const size = fs.fstatSync(fd).size;
    const buf = Buffer.alloc(Math.min(size, PREVIEW_BYTES));
    fs.readSync(fd, buf, 0, buf.length, 0);
    return { text: new TextDecoder(encoding || 'utf-8').decode(buf).replace(/^﻿/, ''), partial: size > buf.length };
  } finally {
    fs.closeSync(fd);
  }
}

function previewFile({ filePath, format, delimiter, encoding }) {
  if (format === 'json') {
    const data = JSON.parse(fs.readFileSync(filePath, 'utf8').replace(/^﻿/, ''));
    const list = Array.isArray(data) ? data : [data];
    const names = [];
    for (const o of list.slice(0, 200)) for (const k of Object.keys(o || {})) if (!names.includes(k)) names.push(k);
    return { names, rows: list.slice(0, 100).map((o) => names.map((n) => jsonCell(o[n]))), total: list.length };
  }
  const head = readHead(filePath, encoding);
  const d = delimiter || fmt.sniffDelimiter(head.text);
  const parsed = fmt.parseCsv(head.text, { delimiter: d });
  // A preview cut in the middle of a file always ends on a partial row; drop it.
  if (head.partial && parsed.rows.length > 1) parsed.rows.pop();
  return { delimiter: d, rows: parsed.rows.slice(0, 101), truncated: !head.partial && parsed.truncated };
}

function jsonCell(v) {
  if (v === null || v === undefined) return null;
  return typeof v === 'object' ? JSON.stringify(v) : String(v);
}

async function* csvRows(filePath, { delimiter, encoding }) {
  const parser = fmt.createCsvParser({ delimiter });
  const decoder = new TextDecoder(encoding || 'utf-8');
  let first = true;
  for await (const chunk of fs.createReadStream(filePath)) {
    let text = decoder.decode(chunk, { stream: true });
    if (first) { text = text.replace(/^﻿/, ''); first = false; }
    yield parser.feed(text);
  }
  yield parser.feed(decoder.decode());
  yield parser.end();
  if (parser.state.truncated) throw new Error('The CSV file was truncated unexpectedly, please check the file encoding');
}

async function* jsonRows(filePath, names, raw) {
  const data = JSON.parse(fs.readFileSync(filePath, 'utf8').replace(/^﻿/, ''));
  const list = Array.isArray(data) ? data : [data];
  const cell = raw ? (v) => (v === undefined ? null : v) : jsonCell;
  for (let i = 0; i < list.length; i += 500) {
    yield list.slice(i, i + 500).map((o) => names.map((n) => cell((o || {})[n])));
  }
}

/**
 * A SQL column gives text its type; a document keeps whatever it is handed. So text from a CSV
 * becomes a number or a boolean only when writing it back out gives the same text.
 */
function inferValue(v) {
  if (typeof v !== 'string' || v === '') return v;
  if (v === 'true' || v === 'false') return v === 'true';
  return /^-?\d/.test(v) && String(Number(v)) === v ? Number(v) : v;
}

/**
 * @param {object} req
 * @param {{source:number, target:string}[]} req.mapping  source column index -> table column
 * @param {{name:string, columns:string[]}|null} req.createTable
 */
async function importFile(session, req, progress) {
  return session.op(async (d) => {
    if (!d.canImport) throw new Error('Importing a file is not available for this database');
    const mapping = req.mapping.filter((m) => m.target);
    if (!mapping.length) throw new Error('Nothing to import: no column is mapped');
    const table = req.createTable ? req.createTable.name : req.table;
    const names = mapping.map((m) => m.target);
    const perBatch = d.insertBatchSize(mapping.length);
    // Document databases keep the JSON values as they are (numbers, nested documents).
    const source = req.format === 'json'
      ? jsonRows(req.filePath, req.sourceNames, !d.sql)
      : csvRows(req.filePath, { delimiter: req.delimiter, encoding: req.encoding });

    let total = 0;
    let skipHeader = req.format !== 'json' && req.header;
    const flush = async (batch) => {
      if (!batch.length) return;
      const rows = batch.map((row) => mapping.map((m) => {
        const v = row[m.source];
        if (v === undefined || (v === '' && req.emptyAsNull !== false)) return null;
        return d.sql || req.format === 'json' ? v : inferValue(v);
      }));
      await d.insertRows(req.schema, table, names, rows, { quiet: total > 0 });
      total += batch.length;
      progress({ rows: total });
    };

    if (req.disableForeignKeys) await d.setForeignKeyChecks(false);
    await d.begin();
    try {
      if (req.createTable) await d.createImportTable(req.schema, table, req.createTable.columns);
      let batch = [];
      for await (const rows of source) {
        for (const row of rows) {
          if (skipHeader) { skipHeader = false; continue; }
          if (session.cancelled) throw new Error('Cancelled');
          batch.push(row);
          if (batch.length >= perBatch) { await flush(batch); batch = []; }
        }
      }
      await flush(batch);
      await d.commit();
    } catch (e) {
      await d.rollback().catch(() => {});
      // Without a transaction to roll back, the rows sent so far stay.
      if (!d.transactional && total > 0) throw new Error(`${e.message}\n${total} rows had already been imported and were kept.`);
      throw e;
    } finally {
      if (req.disableForeignKeys) await d.setForeignKeyChecks(true).catch(() => {});
    }
    return { rows: total, table };
  });
}

/** Run every statement of a .sql file, in order, stopping at the first error. */
async function runSqlFile(session, { filePath, encoding }, progress) {
  let text;
  try {
    text = new TextDecoder(encoding || 'utf-8', { fatal: true }).decode(fs.readFileSync(filePath));
  } catch {
    throw new Error(`The file couldn't be opened using text encoding ${encoding || 'UTF-8'}.`);
  }
  return session.op(async (d) => {
    const statements = splitStatements(text, d.dialect);
    let done = 0;
    for (const s of statements) {
      if (session.cancelled) throw new Error(`Cancelled after ${done} statements`);
      try {
        await d.query(s.text, [], { quiet: done > 0 });
      } catch (e) {
        throw new Error(`Statement ${done + 1} of ${statements.length} failed: ${e.message}`);
      }
      done++;
      if (done % 20 === 0) progress({ statements: done, total: statements.length });
    }
    return { statements: done };
  });
}

module.exports = { exportRows, exportTable, previewFile, importFile, runSqlFile };
