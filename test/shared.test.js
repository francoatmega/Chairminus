'use strict';
// Characterization tests for the pure modules in src/shared. They pin down behavior observed in the
// shipped 0.1.0 build; the original test suite was not part of the packaged app.
const test = require('node:test');
const assert = require('node:assert/strict');

const dialect = require('../src/shared/dialect');
const tokenizer = require('../src/shared/tokenizer');
const changes = require('../src/shared/changes');
const format = require('../src/shared/format');
const { formatSql } = require('../src/shared/sqlformat');

test('identifiers are quoted per dialect', () => {
  assert.equal(dialect.quoteIdent('postgres', 'a"b'), '"a""b"');
  assert.equal(dialect.quoteIdent('mysql', 'a`b'), '`a``b`');
  assert.equal(dialect.qualified('postgres', 'public', 't'), '"public"."t"');
});

test('literals cover strings, NULL, numbers, binary and expressions', () => {
  assert.equal(dialect.literal('postgres', "it's"), "'it''s'");
  assert.equal(dialect.literal('mysql', null), 'NULL');
  assert.equal(dialect.literal('sqlite', 42), '42');
  assert.equal(dialect.literal('postgres', { __bin: 'ff00' }), "'\\xff00'::bytea");
  assert.equal(dialect.literal('mysql', { __expr: 'NOW()' }), 'NOW()');
});

test('statements are split outside comments and strings', () => {
  const parts = tokenizer.splitStatements("select 1; -- c;\nselect ';';", 'postgres').map((s) => s.text);
  assert.deepEqual(parts, ['select 1', "select ';'"]);
  assert.deepEqual(tokenizer.statementAt('select 1;\nselect 2;', 12, 'postgres'), { text: 'select 2', start: 10, end: 18 });
});

test('a batch is read-only only when every statement is', () => {
  assert.equal(tokenizer.isReadOnlyBatch(['select 1', 'explain select 2'], 'postgres'), true);
  assert.equal(tokenizer.isReadOnlyBatch(['select 1', 'delete from t'], 'postgres'), false);
});

test('variables inside quoted strings are skipped by default', () => {
  assert.deepEqual(tokenizer.findVariables("select :a, ':b', :a", 'colon', 'postgres', false), ['a']);
});

test('pending changes become UPDATE / DELETE / INSERT keyed by the primary key', () => {
  const statements = changes.buildChangeStatements({
    dialect: 'postgres', schema: 'public', table: 't', columns: [{ name: 'id' }, { name: 'name' }], primaryKey: ['id'],
    changes: [
      { type: 'update', original: { id: 1, name: 'a' }, set: { name: 'b' } },
      { type: 'delete', original: { id: 2, name: 'z' } },
      { type: 'insert', values: { name: 'n' } },
    ],
  });
  assert.deepEqual(statements.map((s) => s.sql), [
    `UPDATE "public"."t" SET "name" = 'b' WHERE "id" = 1`,
    `DELETE FROM "public"."t" WHERE "id" = 2`,
    `INSERT INTO "public"."t" ("name") VALUES ('n')`,
  ]);
  assert.equal(statements[0].usesPrimaryKey, true);
});

test('CSV and Markdown output, and CSV parsing', () => {
  assert.equal(format.toCsv(['a', 'b'], [[1, 'x,y'], [null, 'q']]), 'a,b\n1,"x,y"\n,q\n');
  assert.equal(format.toMarkdown(['a'], [[1]]), '| a |\n| --- |\n| 1 |\n');
  assert.deepEqual(format.parseCsv('a,b\n1,"x,y"\n').rows, [['a', 'b'], ['1', 'x,y']]);
});

test('the SQL formatter breaks clauses and upper-cases keywords', () => {
  const sql = formatSql('select a,b from t where x=1 and y=2', { dialect: 'postgres', indent: '  ', uppercase: true });
  assert.equal(sql, 'SELECT a,\n  b\nFROM t\nWHERE x = 1\n  AND y = 2\n');
});
