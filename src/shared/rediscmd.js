'use strict';
// Redis commands as the app sends and accepts them: one command per line, with the quoting
// rules of redis-cli. Keys are browsed as rows (key, type, ttl, size, value).

const { isBin, isExpr } = require('./dialect');

const BARE = /^[A-Za-z0-9_:.@/*+=-]+$/;
const ESCAPES = { n: '\n', r: '\r', t: '\t', b: '\b', a: '\x07' };

/** One command per line; blank lines and lines starting with # are skipped. */
function split(text) {
  const out = [];
  let pos = 0;
  for (const line of text.split('\n')) {
    const body = line.replace(/\s+$/, '');
    const lead = body.length - body.trimStart().length;
    if (body.trim() && body[lead] !== '#') out.push({ text: body.slice(lead), start: pos + lead, end: pos + body.length });
    pos += line.length + 1;
  }
  return out;
}

/** "SET greeting \"hello world\"" -> ['SET', 'greeting', 'hello world'] */
function parseArgs(line) {
  const s = String(line).trim();
  const args = [];
  let i = 0;
  while (i < s.length) {
    while (/\s/.test(s[i] || '')) i++;
    if (i >= s.length) break;
    const q = s[i];
    let arg = '';
    if (q === '"' || q === "'") {
      i++;
      for (;;) {
        if (i >= s.length) throw new Error('Invalid argument: a quote is not closed');
        const c = s[i++];
        if (c === q) break;
        if (c !== '\\') { arg += c; continue; }
        const e = s[i++];
        if (q === "'") arg += e === "'" || e === '\\' ? e : '\\' + (e || '');
        else if (e === 'x' && /^[0-9a-fA-F]{2}$/.test(s.slice(i, i + 2))) { arg += String.fromCharCode(parseInt(s.slice(i, i + 2), 16)); i += 2; }
        else arg += e in ESCAPES ? ESCAPES[e] : (e || '');
      }
      if (i < s.length && !/\s/.test(s[i])) throw new Error('Invalid argument: a closing quote must be followed by a space');
    } else {
      while (i < s.length && !/\s/.test(s[i])) arg += s[i++];
    }
    args.push(arg);
  }
  return args;
}

function quoteArg(v) {
  const s = String(v);
  if (BARE.test(s)) return s;
  return '"' + s.replace(/[\\"]/g, (m) => '\\' + m).replace(/\n/g, '\\n').replace(/\r/g, '\\r').replace(/\t/g, '\\t')
    // eslint-disable-next-line no-control-regex
    .replace(/[\x00-\x1f\x7f]/g, (m) => '\\x' + m.charCodeAt(0).toString(16).padStart(2, '0')) + '"';
}

const command = (...args) => args.map(quoteArg).join(' ');

const READ_COMMANDS = new Set([
  'GET', 'MGET', 'GETRANGE', 'SUBSTR', 'STRLEN', 'EXISTS', 'TYPE', 'TTL', 'PTTL', 'EXPIRETIME', 'PEXPIRETIME', 'KEYS', 'SCAN', 'RANDOMKEY',
  'DBSIZE', 'DUMP', 'OBJECT', 'MEMORY', 'TOUCH',
  'HGET', 'HMGET', 'HGETALL', 'HKEYS', 'HVALS', 'HLEN', 'HEXISTS', 'HSTRLEN', 'HSCAN', 'HRANDFIELD',
  'LRANGE', 'LLEN', 'LINDEX', 'LPOS',
  'SMEMBERS', 'SCARD', 'SISMEMBER', 'SMISMEMBER', 'SRANDMEMBER', 'SSCAN', 'SINTER', 'SUNION', 'SDIFF', 'SINTERCARD',
  'ZRANGE', 'ZRANGEBYSCORE', 'ZRANGEBYLEX', 'ZREVRANGE', 'ZREVRANGEBYSCORE', 'ZREVRANGEBYLEX', 'ZCARD', 'ZCOUNT', 'ZLEXCOUNT', 'ZSCORE',
  'ZMSCORE', 'ZRANK', 'ZREVRANK', 'ZSCAN', 'ZRANDMEMBER', 'ZINTER', 'ZUNION', 'ZDIFF',
  'XRANGE', 'XREVRANGE', 'XLEN', 'XINFO', 'XPENDING',
  'GETBIT', 'BITCOUNT', 'BITPOS', 'PFCOUNT', 'GEOPOS', 'GEODIST', 'GEOHASH', 'GEOSEARCH', 'GEORADIUS_RO', 'GEORADIUSBYMEMBER_RO',
  'INFO', 'PING', 'ECHO', 'TIME', 'LASTSAVE', 'COMMAND', 'LOLWUT', 'SLOWLOG', 'LATENCY', 'HELLO',
  'JSON.GET', 'JSON.MGET', 'JSON.TYPE', 'JSON.STRLEN', 'JSON.ARRLEN', 'JSON.OBJKEYS', 'JSON.OBJLEN', 'FT.SEARCH', 'FT.INFO', 'FT._LIST', 'TS.GET', 'TS.RANGE', 'TS.INFO',
]);
// Containers whose sub-command decides: only these forms are reads.
const READ_SUBCOMMANDS = {
  CONFIG: ['GET'], CLIENT: ['LIST', 'INFO', 'ID', 'GETNAME'], OBJECT: ['ENCODING', 'FREQ', 'IDLETIME', 'REFCOUNT', 'HELP'],
  MEMORY: ['USAGE', 'STATS', 'DOCTOR', 'HELP'], SLOWLOG: ['GET', 'LEN', 'HELP'], LATENCY: ['LATEST', 'HISTORY', 'DOCTOR', 'HELP'],
  XINFO: ['STREAM', 'GROUPS', 'CONSUMERS', 'HELP'], COMMAND: ['COUNT', 'DOCS', 'INFO', 'LIST', 'GETKEYS', 'HELP'], ACL: ['LIST', 'USERS', 'WHOAMI', 'CAT', 'GETUSER'],
  CLUSTER: ['INFO', 'NODES', 'SLOTS', 'SHARDS', 'MYID', 'KEYSLOT', 'COUNTKEYSINSLOT'], PUBSUB: ['CHANNELS', 'NUMSUB', 'NUMPAT'], FUNCTION: ['LIST', 'STATS'],
};

/** 'read' only for commands known not to change anything; anything unclear is a 'write'. */
function classify(statement) {
  let args;
  try { args = parseArgs(statement); } catch { return 'write'; }
  if (!args.length) return 'read';
  const name = args[0].toUpperCase();
  if (READ_SUBCOMMANDS[name]) {
    // COMMAND and SLOWLOG-style commands without a sub-command only report.
    if (args.length === 1) return name === 'COMMAND' ? 'read' : 'write';
    return READ_SUBCOMMANDS[name].includes(args[1].toUpperCase()) ? 'read' : 'write';
  }
  return READ_COMMANDS.has(name) ? 'read' : 'write';
}

// ---- writing commands ---------------------------------------------------------------------

/** The value column of each key type, as shown in the grid and as written back. */
const VALUE_SHAPES = {
  hash: 'a JSON object of fields, like {"name": "Ana"}',
  list: 'a JSON array, like ["a", "b"]',
  set: 'a JSON array, like ["a", "b"]',
  zset: 'a JSON object of member scores, like {"ana": 10}',
};
const TYPES = ['string', 'hash', 'list', 'set', 'zset', 'ReJSON-RL'];

const item = (v) => (v !== null && typeof v === 'object' ? JSON.stringify(v) : String(v));

function readJson(text, type, key) {
  let v;
  try { v = JSON.parse(String(text)); } catch { v = undefined; }
  const wantsArray = type === 'list' || type === 'set';
  const ok = v !== null && typeof v === 'object' && Array.isArray(v) === wantsArray;
  if (!ok) throw new Error(`The value of “${key}” must be ${VALUE_SHAPES[type]}`);
  const n = wantsArray ? v.length : Object.keys(v).length;
  if (!n) throw new Error(`A ${type} cannot be empty — delete the key “${key}” instead`);
  return v;
}

/** The commands that store `value` under `key` (which must not hold anything at that point). */
function storeCommands(key, type, value) {
  if (value === null || value === undefined || isExpr(value)) throw new Error(`“${key}” needs a value`);
  const text = isBin(value) ? value.__bin : String(value);
  switch (type) {
    case 'string': return [command('SET', key, text)];
    case 'hash': return [command('HSET', key, ...Object.entries(readJson(text, type, key)).flatMap(([f, v]) => [f, item(v)]))];
    case 'list': return [command('RPUSH', key, ...readJson(text, type, key).map(item))];
    case 'set': return [command('SADD', key, ...readJson(text, type, key).map(item))];
    case 'zset': {
      const pairs = Object.entries(readJson(text, type, key));
      const bad = pairs.find(([, score]) => !Number.isFinite(Number(score)));
      if (bad) throw new Error(`The score of “${bad[0]}” in “${key}” is not a number`);
      return [command('ZADD', key, ...pairs.flatMap(([member, score]) => [Number(score), member]))];
    }
    case 'ReJSON-RL':
      try { JSON.parse(text); } catch { throw new Error(`The value of “${key}” must be valid JSON`); }
      return [command('JSON.SET', key, '$', text)];
    default:
      throw new Error(`Values of type ${type} cannot be edited in the grid — use a query tab`);
  }
}

function ttlCommand(key, ttl) {
  if (ttl === null || ttl === undefined || ttl === '' || Number(ttl) < 0) return command('PERSIST', key);
  const n = Number(ttl);
  if (!Number.isInteger(n) || n === 0) throw new Error(`The TTL of “${key}” must be a whole number of seconds (empty or -1 removes it)`);
  return command('EXPIRE', key, n);
}

/**
 * Pending grid changes -> commands. They are sent in one MULTI/EXEC, so a key that is rewritten
 * (DEL + HSET, for example) is never seen half-written. `opts.absent` names a key that must not
 * exist yet; the driver checks it before anything is sent.
 */
function buildChanges({ changes }) {
  const out = [];
  const push = (kind, sql, opts) => out.push({ kind, single: false, sql, ...(opts ? { opts } : {}) });
  for (const ch of changes) {
    if (ch.type === 'insert') {
      const v = ch.values;
      const key = v.key === null || v.key === undefined ? '' : String(v.key);
      if (!key) throw new Error('A new key needs a name in the “key” column');
      const type = v.type === null || v.type === undefined || v.type === '' ? 'string' : String(v.type);
      if (!TYPES.includes(type)) throw new Error(`“${type}” is not a type that can be created here (${TYPES.slice(0, 5).join(', ')})`);
      storeCommands(key, type, v.value).forEach((sql, i) => push('insert', sql, i === 0 ? { absent: key } : null));
      if (v.ttl !== undefined && v.ttl !== null && v.ttl !== '' && Number(v.ttl) >= 0) push('insert', ttlCommand(key, v.ttl));
    } else if (ch.type === 'update') {
      const key = String(ch.original.key);
      const type = String(ch.original.type);
      const set = ch.set;
      const locked = ['type', 'size'].find((c) => c in set);
      if (locked) throw new Error(`The “${locked}” column cannot be edited`);
      if ('value' in set) {
        if (type === 'string') push('update', storeCommands(key, type, set.value)[0] + ' KEEPTTL');
        else if (type === 'ReJSON-RL') push('update', storeCommands(key, type, set.value)[0]);
        else {
          const store = storeCommands(key, type, set.value);
          push('update', command('DEL', key));
          store.forEach((sql) => push('update', sql));
          // Rewriting the key drops its expiry; put back what was loaded.
          if (!('ttl' in set) && Number(ch.original.ttl) > 0) push('update', ttlCommand(key, ch.original.ttl));
        }
      }
      if ('ttl' in set) push('update', ttlCommand(key, set.ttl));
      if ('key' in set) {
        const next = set.key === null || set.key === undefined ? '' : String(set.key);
        if (!next) throw new Error('A key cannot be renamed to an empty name');
        push('update', command('RENAMENX', key, next), { absent: next });
      }
    } else if (ch.type === 'delete') {
      push('delete', command('DEL', String(ch.original.key)));
    }
  }
  return out;
}

/** `name` is the key pattern the group was listed under (for example "user:*"). */
function objectStatements(name) {
  const scan = command('SCAN', 0, 'MATCH', name, 'COUNT', 100);
  return { select: scan, query: scan, drop: null, truncate: name === '*' ? 'FLUSHDB' : null };
}

module.exports = { split, parseArgs, quoteArg, command, classify, buildChanges, objectStatements, TYPES };
