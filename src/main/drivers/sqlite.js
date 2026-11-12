'use strict';
const fs = require('fs');
const { DatabaseSync } = require('node:sqlite');
const { Driver, normalizeValue } = require('./base');

class SqliteDriver extends Driver {
  constructor(params, log) {
    super(params, log);
    this.dialect = 'sqlite';
    this.hasSchemas = false;
    this.hasDatabases = false;
    this.database = params.path || ':memory:';
  }

  async connect() {
    const path = this.params.path;
    if (!path) throw new Error('Choose a database file');
    if (path !== ':memory:' && !fs.existsSync(path) && !this.params.create) {
      throw new Error(`The file does not exist: ${path}`);
    }
    this.db = new DatabaseSync(path, { readOnly: !!this.params.readOnly });
    // Fails here, not later, when the file is not a database (or is encrypted).
    this.db.prepare('SELECT count(*) FROM sqlite_master').get();
    if (!this.params.readOnly) this.db.exec('PRAGMA foreign_keys = ON');
    this.version = this.db.prepare('SELECT sqlite_version() AS v').get().v;
  }

  async disconnect() {
    const d = this.db;
    this.db = null;
    if (d) try { d.close(); } catch { /* already closed */ }
  }

  async query(sql, params = [], opts = {}) {
    if (!this.db) throw new Error('Not connected');
    const started = Date.now();
    try {
      const stmt = this.db.prepare(sql);
      stmt.setReadBigInts(true);
      const cols = stmt.columns();
      let out;
      if (cols.length) {
        stmt.setReturnArrays(true);
        const limit = opts.rowLimit || 0;
        const rows = [];
        let truncated = false;
        for (const r of stmt.iterate(...params)) {
          if (limit && rows.length >= limit) { truncated = true; break; }
          rows.push(r.map(normalizeValue));
        }
        out = { fields: cols.map((c) => ({ name: c.name, type: (c.type || '').toLowerCase() })), rows, affected: null, command: 'SELECT', truncated };
      } else {
        const r = stmt.run(...params);
        const word = (/^\s*([A-Za-z]+)/.exec(sql) || [])[1] || '';
        const dml = /^(INSERT|UPDATE|DELETE|REPLACE)$/i.test(word);
        out = { fields: [], rows: [], affected: dml ? Number(r.changes) : null, command: word.toUpperCase(), truncated: false };
      }
      if (!opts.quiet) this.log({ sql, params, ms: Date.now() - started, meta: !!opts.meta });
      return out;
    } catch (e) {
      if (!opts.quiet) this.log({ sql, params, ms: Date.now() - started, meta: !!opts.meta, error: e.message });
      throw e;
    }
  }

  async listObjects() {
    const rows = await this.meta(`SELECT name, type FROM sqlite_master
      WHERE type IN ('table','view') AND name NOT LIKE 'sqlite\\_%' ESCAPE '\\' ORDER BY name`);
    const out = { tables: [], views: [], matviews: [], sequences: [], functions: [], procedures: [] };
    for (const r of rows) (r.type === 'view' ? out.views : out.tables).push({ name: r.name, kind: r.type, estimate: null });
    return out;
  }

  async describeTable(schema, table) {
    const t = this.q(table);
    const info = await this.meta(`PRAGMA table_xinfo(${t})`);
    if (!info.length) throw new Error(`Table ${table} not found`);
    const master = await this.meta('SELECT type, sql FROM sqlite_master WHERE name = ?', [table]);
    const createSql = master.length ? master[0].sql || '' : '';
    const idxList = await this.meta(`PRAGMA index_list(${t})`);
    const indexes = [];
    for (const ix of idxList) {
      const cols = await this.meta(`PRAGMA index_info(${this.q(ix.name)})`);
      const def = await this.meta('SELECT sql FROM sqlite_master WHERE type = ? AND name = ?', ['index', ix.name]);
      indexes.push({
        name: ix.name, unique: Number(ix.unique) === 1, primary: ix.origin === 'pk', method: 'btree',
        columns: cols.map((c) => c.name).filter((n) => n !== null), definition: def.length && def[0].sql ? def[0].sql : '',
      });
    }
    const fkRows = await this.meta(`PRAGMA foreign_key_list(${t})`);
    const foreignKeys = [];
    for (const f of fkRows) {
      let fk = foreignKeys.find((x) => x.id === f.id);
      if (!fk) {
        fk = { id: f.id, name: `fk_${table}_${f.id}`, columns: [], refSchema: null, refTable: f.table, refColumns: [], onUpdate: f.on_update, onDelete: f.on_delete };
        foreignKeys.push(fk);
      }
      fk.columns.push(f.from);
      if (f.to !== null) fk.refColumns.push(f.to);
    }
    for (const fk of foreignKeys) {
      fk.definition = `FOREIGN KEY (${fk.columns.map((c) => this.q(c)).join(', ')}) REFERENCES ${this.q(fk.refTable)}${fk.refColumns.length ? ` (${fk.refColumns.map((c) => this.q(c)).join(', ')})` : ''} ON UPDATE ${fk.onUpdate} ON DELETE ${fk.onDelete}`;
    }
    const triggers = await this.meta("SELECT name, sql AS definition FROM sqlite_master WHERE type = 'trigger' AND tbl_name = ? ORDER BY name", [table]);
    const pkCols = info.filter((c) => Number(c.pk) > 0).sort((a, b) => Number(a.pk) - Number(b.pk)).map((c) => c.name);
    const visible = info.filter((c) => Number(c.hidden) !== 1);
    return {
      kind: master.length && master[0].type === 'view' ? 'view' : 'table',
      columns: visible.map((c) => ({
        name: c.name,
        type: c.type || '',
        base: (c.type || '').toLowerCase(),
        nullable: Number(c.notnull) === 0,
        default: c.dflt_value,
        comment: null,
        pk: Number(c.pk) > 0,
        autoIncrement: Number(c.pk) > 0 && pkCols.length === 1 && /^INTEGER$/i.test(c.type || ''),
        generated: Number(c.hidden) > 1,
        extra: '',
        enumValues: null,
      })),
      primaryKey: pkCols,
      indexes,
      foreignKeys,
      checks: [],
      triggers,
      withoutRowid: /\bWITHOUT\s+ROWID\b/i.test(createSql),
    };
  }

  async ddl(schema, name) {
    const rows = await this.meta(`SELECT sql FROM sqlite_master WHERE (name = ? OR (tbl_name = ? AND type IN ('index','trigger')))
      AND sql IS NOT NULL ORDER BY CASE type WHEN 'table' THEN 0 WHEN 'view' THEN 0 WHEN 'index' THEN 1 ELSE 2 END, name`, [name, name]);
    return rows.map((r) => r.sql + ';').join('\n\n');
  }

  async listColumns() {
    const rows = await this.meta(`SELECT m.name AS t, p.name AS c FROM sqlite_master m JOIN pragma_table_info(m.name) p
      WHERE m.type IN ('table','view') AND m.name NOT LIKE 'sqlite\\_%' ESCAPE '\\' ORDER BY m.name, p.cid`);
    const out = {};
    for (const r of rows) (out[r.t] || (out[r.t] = [])).push(r.c);
    return out;
  }

  async setForeignKeyChecks(on) { this.db.exec(`PRAGMA foreign_keys = ${on ? 'ON' : 'OFF'}`); }
}

module.exports = { SqliteDriver };
