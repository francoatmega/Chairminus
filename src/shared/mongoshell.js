'use strict';
// The mongosh statements the app sends and accepts, for example
//   db.users.find({ age: { $gt: 30 } }).sort({ name: 1 }).limit(20)
// Nothing is evaluated: arguments are data literals, read into Extended JSON, so the same
// text can be split, classified and previewed in the renderer and run in the main process.

const { isBin, isExpr } = require('./dialect');

const IDENT = /[A-Za-z_$][\w$]*/y;
const NUMBER = /[-+]?(?:0[xX][0-9a-fA-F]+|(?:\d+\.?\d*|\.\d+)(?:[eE][-+]?\d+)?)/y;
const ESCAPES = { n: '\n', t: '\t', r: '\r', b: '\b', f: '\f', v: '\v', 0: '\0' };
const SIMPLE_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;

function hexToBase64(hex) {
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
  const bytes = (String(hex).match(/[0-9a-fA-F]{2}/g) || []).map((h) => parseInt(h, 16));
  let out = '';
  for (let i = 0; i < bytes.length; i += 3) {
    const n = (bytes[i] << 16) | ((bytes[i + 1] || 0) << 8) | (bytes[i + 2] || 0);
    out += chars[n >> 18] + chars[(n >> 12) & 63] + (i + 1 < bytes.length ? chars[(n >> 6) & 63] : '=') + (i + 2 < bytes.length ? chars[n & 63] : '=');
  }
  return out;
}

function newObjectId() {
  const rand = () => Math.floor(Math.random() * 256).toString(16).padStart(2, '0');
  return Math.floor(Date.now() / 1000).toString(16).padStart(8, '0') + Array.from({ length: 8 }, rand).join('');
}

function toDate(v) {
  const d = v === undefined ? new Date() : new Date(v);
  if (Number.isNaN(d.getTime())) throw new Error(`Invalid date: ${v}`);
  return { $date: d.toISOString() };
}

/** Shell helpers -> Extended JSON. */
const CONSTRUCTORS = {
  ObjectId: (a) => ({ $oid: a === undefined ? newObjectId() : String(a) }),
  ISODate: toDate,
  Date: toDate,
  NumberLong: (a) => ({ $numberLong: String(a) }),
  Long: (a) => ({ $numberLong: String(a) }),
  NumberInt: (a) => ({ $numberInt: String(a) }),
  Int32: (a) => ({ $numberInt: String(a) }),
  NumberDecimal: (a) => ({ $numberDecimal: String(a) }),
  Decimal128: (a) => ({ $numberDecimal: String(a) }),
  Double: (a) => ({ $numberDouble: String(a) }),
  UUID: (a) => ({ $uuid: String(a) }),
  BinData: (sub, b64) => ({ $binary: { base64: String(b64), subType: Number(sub).toString(16).padStart(2, '0') } }),
  HexData: (sub, hex) => ({ $binary: { base64: hexToBase64(hex), subType: Number(sub).toString(16).padStart(2, '0') } }),
  Timestamp: (t, i) => ({ $timestamp: t !== null && typeof t === 'object' ? t : { t: Number(t) || 0, i: Number(i) || 0 } }),
  MinKey: () => ({ $minKey: 1 }),
  MaxKey: () => ({ $maxKey: 1 }),
  RegExp: (pattern, options) => ({ $regularExpression: { pattern: String(pattern), options: String(options || '') } }),
};

class Reader {
  constructor(text) { this.s = text; this.i = 0; }

  fail(message) {
    const at = this.s.slice(this.i, this.i + 24).replace(/\s+/g, ' ');
    throw new Error(`${message}${at ? ` near “${at}”` : ' at the end of the statement'}`);
  }

  ws() {
    const s = this.s;
    for (;;) {
      const c = s[this.i];
      if (c === ' ' || c === '\n' || c === '\t' || c === '\r') this.i++;
      else if (c === '/' && s[this.i + 1] === '/') { while (this.i < s.length && s[this.i] !== '\n') this.i++; }
      else if (c === '/' && s[this.i + 1] === '*') { const e = s.indexOf('*/', this.i + 2); this.i = e === -1 ? s.length : e + 2; }
      else return;
    }
  }

  peek() { this.ws(); return this.s[this.i]; }
  done() { this.ws(); return this.i >= this.s.length; }
  eat(ch) { if (this.peek() === ch) { this.i++; return true; } return false; }
  expect(ch) { if (!this.eat(ch)) this.fail(`Expected “${ch}”`); }

  ident() {
    this.ws();
    IDENT.lastIndex = this.i;
    const m = IDENT.exec(this.s);
    if (!m) return null;
    this.i += m[0].length;
    return m[0];
  }

  string() {
    const q = this.peek();
    if (q !== '"' && q !== "'" && q !== '`') this.fail('Expected a string');
    const s = this.s;
    let out = '';
    this.i++;
    for (;;) {
      if (this.i >= s.length) this.fail('Unterminated string');
      const c = s[this.i++];
      if (c === q) return out;
      if (c !== '\\') { out += c; continue; }
      const e = s[this.i++];
      if (e === 'u' && s[this.i] === '{') {
        const close = s.indexOf('}', this.i);
        out += String.fromCodePoint(parseInt(s.slice(this.i + 1, close), 16));
        this.i = close + 1;
      } else if (e === 'u') { out += String.fromCharCode(parseInt(s.slice(this.i, this.i + 4), 16)); this.i += 4; }
      else if (e === 'x') { out += String.fromCharCode(parseInt(s.slice(this.i, this.i + 2), 16)); this.i += 2; }
      else out += e in ESCAPES ? ESCAPES[e] : e;
    }
  }

  regex() {
    const s = this.s;
    let j = this.i + 1;
    let inClass = false;
    for (; j < s.length; j++) {
      const c = s[j];
      if (c === '\\') j++;
      else if (c === '\n') break;
      else if (c === '[') inClass = true;
      else if (c === ']') inClass = false;
      else if (c === '/' && !inClass) break;
    }
    if (s[j] !== '/') this.fail('Unterminated regular expression');
    const pattern = s.slice(this.i + 1, j);
    const flags = /^[a-z]*/.exec(s.slice(j + 1))[0];
    this.i = j + 1 + flags.length;
    return { $regularExpression: { pattern, options: flags } };
  }

  args() {
    this.expect('(');
    const out = [];
    while (!this.eat(')')) {
      out.push(this.value());
      if (!this.eat(',') && this.peek() !== ')') this.fail('Expected “,” or “)”');
    }
    return out;
  }

  value() {
    const c = this.peek();
    if (c === undefined) this.fail('A value is missing');
    if (c === '{') return this.object();
    if (c === '[') {
      this.i++;
      const out = [];
      while (!this.eat(']')) {
        out.push(this.value());
        if (!this.eat(',') && this.peek() !== ']') this.fail('Expected “,” or “]”');
      }
      return out;
    }
    if (c === '"' || c === "'" || c === '`') return this.string();
    if (c === '/') return this.regex();
    NUMBER.lastIndex = this.i;
    const num = NUMBER.exec(this.s);
    if (num) { this.i += num[0].length; return Number(num[0]); }
    if (c === '-' || c === '+') {
      this.i++;
      if (this.ident() !== 'Infinity') this.fail('Expected a number');
      return { $numberDouble: c === '-' ? '-Infinity' : 'Infinity' };
    }
    let name = this.ident();
    if (name === 'new') name = this.ident();
    switch (name) {
      case 'true': return true;
      case 'false': return false;
      case 'null': case 'undefined': return null;
      case 'NaN': case 'Infinity': return { $numberDouble: name };
      case null: return this.fail('Unexpected character');
      default:
    }
    if (!CONSTRUCTORS[name]) this.fail(`“${name}” is not a value this editor understands. Arguments are literals — variables and functions are not evaluated`);
    return CONSTRUCTORS[name](...(this.peek() === '(' ? this.args() : []));
  }

  object() {
    this.expect('{');
    const out = {};
    while (!this.eat('}')) {
      const c = this.peek();
      let key;
      if (c === '"' || c === "'") key = this.string();
      else {
        key = this.ident();
        if (key === null) {
          NUMBER.lastIndex = this.i;
          const num = NUMBER.exec(this.s);
          if (!num) this.fail('Expected a field name');
          this.i += num[0].length;
          key = num[0];
        }
      }
      this.expect(':');
      out[key] = this.value();
      if (!this.eat(',') && this.peek() !== '}') this.fail('Expected “,” or “}”');
    }
    return out;
  }
}

/** Read one literal (used for the raw filter of a collection). */
function parseValue(text) {
  const r = new Reader(String(text));
  const v = r.value();
  if (!r.done()) r.fail('Unexpected text');
  return v;
}

/**
 * @returns {{kind:'show', what:string}
 *   | {kind:'use', db:string}
 *   | {kind:'db', db:string|null, method:string, args:any[], chain:{name:string,args:any[]}[]}
 *   | {kind:'coll', db:string|null, collection:string, method:string, args:any[], chain:{name:string,args:any[]}[]}}
 */
function parse(text) {
  const r = new Reader(String(text));
  const head = r.ident();
  if (head === 'show' || head === 'use') {
    const rest = r.s.slice(r.i).replace(/;\s*$/, '').trim();
    if (!rest) r.fail(`“${head}” needs a name`);
    return head === 'show' ? { kind: 'show', what: rest.toLowerCase() } : { kind: 'use', db: rest };
  }
  if (head !== 'db') throw new Error('Statements start with “db.” — for example db.users.find({ age: { $gt: 30 } })');

  const segs = [];
  for (;;) {
    let name;
    if (r.eat('.')) { name = r.ident(); if (name === null) r.fail('Expected a name after “.”'); }
    else if (r.peek() === '[') { r.i++; name = r.string(); r.expect(']'); }
    else break;
    segs.push({ name, args: r.peek() === '(' ? r.args() : null });
  }
  r.eat(';');
  if (!r.done()) r.fail('Unexpected text');

  let db = null;
  if (segs.length && segs[0].name === 'getSiblingDB' && segs[0].args) db = String(segs.shift().args[0] ?? '');
  let collection = null;
  if (segs.length && segs[0].name === 'getCollection' && segs[0].args) collection = String(segs.shift().args[0] ?? '');
  const k = segs.findIndex((s) => s.args);
  if (k === -1) throw new Error('A method call is missing — for example db.users.find({})');
  const chain = segs.slice(k + 1);
  const loose = chain.find((s) => !s.args);
  if (loose) throw new Error(`“.${loose.name}” needs parentheses`);
  const call = { method: segs[k].name, args: segs[k].args, chain: chain.map((s) => ({ name: s.name, args: s.args })) };
  if (collection === null && k === 0) return { kind: 'db', db, ...call };
  if (collection !== null && k !== 0) throw new Error('Expected a method after getCollection(…)');
  return { kind: 'coll', db, collection: collection !== null ? collection : segs.slice(0, k).map((s) => s.name).join('.'), ...call };
}

// ---- splitting and classification ---------------------------------------------------------

const STARTS_STATEMENT = /^(?:db\s*[.[]|show\s|use\s)/;

/** Statements end at a top-level “;”, or at a line break followed by a new db./show/use. */
function split(text) {
  const out = [];
  const n = text.length;
  let start = -1;
  let last = -1;
  let depth = 0;
  const flush = () => { if (start !== -1) out.push({ text: text.slice(start, last), start, end: last }); start = -1; };
  for (let i = 0; i < n;) {
    const c = text[i];
    if (c === '/' && text[i + 1] === '/') { while (i < n && text[i] !== '\n') i++; continue; }
    if (c === '/' && text[i + 1] === '*') { const e = text.indexOf('*/', i + 2); i = e === -1 ? n : e + 2; continue; }
    if (c === '\n' && depth === 0 && start !== -1 && STARTS_STATEMENT.test(text.slice(i + 1, i + 40).trimStart())) { flush(); i++; continue; }
    if (c === ' ' || c === '\n' || c === '\t' || c === '\r') { i++; continue; }
    if (c === ';' && depth === 0) { flush(); i++; continue; }
    if (start === -1) start = i;
    if (c === '"' || c === "'" || c === '`') {
      i++;
      while (i < n && text[i] !== c) i += text[i] === '\\' ? 2 : 1;
      i = Math.min(n, i + 1);
    } else {
      if (c === '(' || c === '{' || c === '[') depth++;
      else if (c === ')' || c === '}' || c === ']') depth = Math.max(0, depth - 1);
      i++;
    }
    last = i;
  }
  flush();
  return out;
}

const READ_METHODS = new Set(['find', 'findOne', 'aggregate', 'countDocuments', 'count', 'estimatedDocumentCount', 'distinct',
  'getIndexes', 'indexes', 'stats', 'dataSize', 'storageSize', 'totalSize', 'totalIndexSize', 'isCapped', 'explain']);
const READ_DB_METHODS = new Set(['getCollectionNames', 'getCollectionInfos', 'stats', 'version', 'serverStatus', 'currentOp',
  'hostInfo', 'getName', 'hello', 'isMaster', 'serverBuildInfo', 'runCommand', 'adminCommand', 'aggregate']);
const READ_COMMANDS = new Set(['find', 'aggregate', 'count', 'distinct', 'listcollections', 'listindexes', 'listdatabases', 'ping',
  'hello', 'ismaster', 'buildinfo', 'dbstats', 'collstats', 'serverstatus', 'connectionstatus', 'hostinfo', 'getparameter',
  'currentop', 'explain', 'whatsmyuri', 'usersinfo', 'rolesinfo', 'top', 'datasize', 'getlog', 'features', 'listcommands']);

const writesOut = (pipeline) => Array.isArray(pipeline) && pipeline.some((st) => st && typeof st === 'object' && ('$out' in st || '$merge' in st));

/** 'read' only for statements known not to change anything; anything unclear is a 'write'. */
function classify(statement) {
  let st;
  try { st = parse(statement); } catch { return 'write'; }
  if (st.kind === 'show' || st.kind === 'use') return 'read';
  if (st.kind === 'coll') {
    if (!READ_METHODS.has(st.method)) return 'write';
    return st.method === 'aggregate' && writesOut(st.args[0]) ? 'write' : 'read';
  }
  if (!READ_DB_METHODS.has(st.method)) return 'write';
  if (st.method === 'aggregate') return writesOut(st.args[0]) ? 'write' : 'read';
  if (st.method !== 'runCommand' && st.method !== 'adminCommand') return 'read';
  const cmd = st.args[0];
  const name = typeof cmd === 'string' ? cmd : Object.keys(cmd || {})[0];
  if (!name || !READ_COMMANDS.has(name.toLowerCase())) return 'write';
  return name.toLowerCase() === 'aggregate' && writesOut(cmd.pipeline) ? 'write' : 'read';
}

// ---- writing statements -------------------------------------------------------------------

function collectionRef(name) {
  return SIMPLE_NAME.test(name) ? `db.${name}` : `db.getCollection(${JSON.stringify(String(name))})`;
}

/** A JSON object or array written as text, or undefined. */
function container(text) {
  const t = text.trim();
  if (!((t.startsWith('{') && t.endsWith('}')) || (t.startsWith('[') && t.endsWith(']')))) return undefined;
  try { const v = JSON.parse(t); return v !== null && typeof v === 'object' ? v : undefined; } catch { return undefined; }
}

/**
 * A grid value as shell text. `type` is the field's type in the loaded page: it tells an
 * ObjectId from a 24-character string, and a date from text that looks like one.
 */
function literal(v, type) {
  if (v === null || v === undefined) return 'null';
  if (isExpr(v)) return v.__expr;
  if (isBin(v)) return `HexData(0, "${v.__bin.replace(/[^0-9a-fA-F]/g, '')}")`;
  if (typeof v === 'boolean') return String(v);
  const s = String(v);
  const t = String(type || '');
  if (t === 'decimal' && /^-?\d+(\.\d+)?([eE][-+]?\d+)?$/.test(s)) return `NumberDecimal("${s}")`;
  if (t === 'long' && /^-?\d+$/.test(s)) return `NumberLong("${s}")`;
  if (typeof v === 'number') return Number.isFinite(v) ? s : JSON.stringify(s);
  if (t === 'objectId' && /^[0-9a-fA-F]{24}$/.test(s)) return `ObjectId("${s}")`;
  if (t === 'date' && !Number.isNaN(Date.parse(s))) return `ISODate(${JSON.stringify(s)})`;
  if ((t === 'int' || t === 'double') && s.trim() !== '' && Number.isFinite(Number(s))) return String(Number(s));
  if (t === 'bool' && /^(true|false)$/i.test(s)) return s.toLowerCase();
  if (t !== 'string') {
    // Nested documents and arrays travel as JSON text; written back, they are documents again.
    const doc = container(s);
    if (doc !== undefined) return JSON.stringify(doc);
  }
  return JSON.stringify(s);
}

function document(values, typeOf) {
  const names = Object.keys(values).filter((k) => values[k] !== undefined);
  return '{' + names.map((n) => `${JSON.stringify(n)}: ${literal(values[n], typeOf(n))}`).join(', ') + '}';
}

/** Pending grid changes -> insertOne / updateOne / deleteOne. Documents are found by _id. */
function buildChanges({ table, columns = [], changes }) {
  const ref = collectionRef(table);
  const typeOf = (name) => (columns.find((c) => c.name === name) || {}).type;
  const byId = (original) => {
    if (original._id === undefined || original._id === null) throw new Error('This document has no _id, so it cannot be changed from the grid');
    return `{"_id": ${literal(original._id, typeOf('_id'))}}`;
  };
  const out = [];
  for (const ch of changes) {
    if (ch.type === 'insert') {
      out.push({ kind: 'insert', single: false, sql: `${ref}.insertOne(${document(ch.values, typeOf)})` });
    } else if (ch.type === 'update') {
      if (!Object.keys(ch.set).length) continue;
      if ('_id' in ch.set) throw new Error('The _id of a document cannot be changed. Duplicate the document and delete the original instead.');
      out.push({ kind: 'update', single: true, usesPrimaryKey: true, sql: `${ref}.updateOne(${byId(ch.original)}, {"$set": ${document(ch.set, typeOf)}})` });
    } else if (ch.type === 'delete') {
      out.push({ kind: 'delete', single: true, usesPrimaryKey: true, sql: `${ref}.deleteOne(${byId(ch.original)})` });
    }
  }
  return out;
}

function objectStatements(name, kind) {
  const ref = collectionRef(name);
  return {
    select: `${ref}.find({})`,
    query: `${ref}.find({})\n  .limit(100)`,
    drop: `${ref}.drop()`,
    truncate: kind === 'table' ? `${ref}.deleteMany({})` : null,
  };
}

module.exports = { parse, parseValue, split, classify, literal, collectionRef, buildChanges, objectStatements, container };
