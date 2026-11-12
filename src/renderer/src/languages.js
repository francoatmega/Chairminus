import { keys } from './dom.js';
import { StreamLanguage } from '@codemirror/language';

const words = (text) => text.trim().split(/\s+/);

const upperSet = (text) => new Set(words(text).map((word) => word.toUpperCase()));

function commonToken(stream, state, { lineComment, blockComment = true, backtick = 'property' }) {
  if (state.block) {
    if (stream.skipTo('*/')) {
      stream.next();
      stream.next();
      state.block = false;
    } else stream.skipToEnd();
    return 'comment';
  }
  if (stream.eatSpace()) return null;
  for (const prefix of lineComment)
    if (stream.match(prefix)) {
      stream.skipToEnd();
      return 'comment';
    }
  if (blockComment && stream.match('/*')) {
    state.block = true;
    return commonToken(stream, state, { lineComment, blockComment, backtick });
  }
  const quote = stream.peek();
  if (quote === '"' || quote === "'" || quote === '`') {
    stream.next();
    let escaped = false;
    for (let ch = stream.next(); ch != null && !(ch === quote && !escaped); ch = stream.next())
      escaped = !escaped && ch === '\\';
    return quote === '`' ? backtick : 'string';
  }
  if (stream.match(/^-?(?:0x[0-9a-f]+|\d+\.?\d*(?:e[-+]?\d+)?)/i)) return 'number';
}

const CYPHER_KEYWORDS =
  words(`MATCH OPTIONAL WHERE RETURN WITH UNWIND CREATE MERGE SET DELETE DETACH REMOVE ORDER BY SKIP LIMIT ASC DESC
  DISTINCT AS AND OR XOR NOT IN IS NULL STARTS ENDS CONTAINS CALL YIELD UNION ALL ON CASE WHEN THEN ELSE END FOREACH LOAD CSV FROM
  HEADERS FIELDTERMINATOR USE SHOW INDEX INDEXES CONSTRAINT CONSTRAINTS DATABASE DATABASES DROP IF EXISTS FOR REQUIRE UNIQUE EXPLAIN
  PROFILE TRANSACTIONS TERMINATE OF ROWS NODE KEY ASSERT`);

const CYPHER_FUNCTIONS = words(
  `count collect sum avg min max size length labels type keys properties id elementId exists coalesce head last\n  tail range nodes relationships startNode endNode toString toInteger toFloat toBoolean toLower toUpper trim split substring replace\n  date datetime localdatetime time duration point timestamp rand round abs`,
);

const CYPHER_KEYWORD_SET = upperSet(CYPHER_KEYWORDS.join(' '));

const cypherLanguage = StreamLanguage.define({
  name: 'cypher',
  startState: () => ({ block: false }),
  token(stream, state) {
    const common = commonToken(stream, state, { lineComment: ['//'] });
    if (common !== undefined) return common;
    if (stream.match(/^\$[A-Za-z_]\w*/)) return 'atom';
    if (stream.match(/^:[A-Za-z_]\w*/)) return 'builtin';
    if (stream.match(/^[A-Za-z_]\w*/)) {
      const word = stream.current().toUpperCase();
      return word === 'TRUE' || word === 'FALSE' ? 'atom' : CYPHER_KEYWORD_SET.has(word) ? 'keyword' : null;
    }
    return /[-+*/=<>!|&%^]/.test(stream.next()) ? 'operator' : null;
  },
  languageData: {
    commentTokens: { line: '//', block: { open: '/*', close: '*/' } },
    closeBrackets: { brackets: ['(', '[', '{', "'", '"', '`'] },
  },
});

const MONGO_COLLECTION_METHODS = words(
  `find findOne aggregate countDocuments estimatedDocumentCount distinct insertOne insertMany updateOne updateMany\n  replaceOne deleteOne deleteMany findOneAndUpdate findOneAndReplace findOneAndDelete bulkWrite createIndex dropIndex getIndexes drop\n  renameCollection stats sort limit skip project hint collation explain count`,
);

const MONGO_DB_METHODS = words(
  'runCommand adminCommand getCollection getSiblingDB createCollection createView dropDatabase getCollectionNames getCollectionInfos stats serverStatus currentOp killOp version',
);

const MONGO_OPERATORS = words(
  `$eq $ne $gt $gte $lt $lte $in $nin $and $or $not $nor $exists $type $regex $options $expr $elemMatch $all $size\n  $set $unset $inc $mul $push $pull $addToSet $rename $setOnInsert $match $group $project $sort $limit $skip $unwind $lookup $count\n  $addFields $sum $avg $min $max $first $last $facet $out $merge`,
);

const MONGO_TYPES = new Set(
  words('ObjectId ISODate Date NumberLong NumberInt NumberDecimal UUID BinData Timestamp MinKey MaxKey RegExp'),
);

const mongoLanguage = StreamLanguage.define({
  name: 'mongodb',
  startState: () => ({ block: false, dot: false }),
  token(stream, state) {
    const common = commonToken(stream, state, { lineComment: ['//'], backtick: 'string' });
    if (common !== undefined) {
      if (common !== null) state.dot = false;
      return common;
    }
    if (stream.match(/^\$[A-Za-z_]\w*/)) return 'atom';
    if (stream.match(/^[A-Za-z_]\w*/)) {
      const word = stream.current();
      const dot = state.dot;
      state.dot = false;
      return dot
        ? 'property'
        : word === 'db' || word === 'new' || word === 'show' || word === 'use'
          ? 'keyword'
          : word === 'true' || word === 'false' || word === 'null' || word === 'undefined'
            ? 'atom'
            : MONGO_TYPES.has(word)
              ? 'builtin'
              : stream.match(/^\s*:/, false)
                ? 'property'
                : null;
    }
    const ch = stream.next();
    state.dot = ch === '.';
    return null;
  },
  languageData: {
    commentTokens: { line: '//', block: { open: '/*', close: '*/' } },
    closeBrackets: { brackets: ['(', '[', '{', "'", '"'] },
  },
});

const REDIS_COMMANDS =
  words(`GET SET MGET MSET DEL UNLINK EXISTS EXPIRE PERSIST TTL TYPE RENAME KEYS SCAN DBSIZE INFO PING INCR DECR INCRBY
  APPEND STRLEN HGET HSET HMGET HGETALL HDEL HKEYS HVALS HLEN HEXISTS HSCAN LPUSH RPUSH LPOP RPOP LRANGE LLEN LINDEX LREM SADD SREM
  SMEMBERS SCARD SISMEMBER SSCAN ZADD ZREM ZRANGE ZRANGEBYSCORE ZREVRANGE ZCARD ZSCORE ZRANK ZSCAN XADD XRANGE XLEN XREAD PUBLISH
  FLUSHDB CONFIG CLIENT MEMORY OBJECT JSON.GET JSON.SET`);

const redisLanguage = StreamLanguage.define({
  name: 'redis',
  startState: () => ({ block: false, first: true }),
  token(stream, state) {
    if (stream.sol()) state.first = true;
    if (stream.eatSpace()) return null;
    if (state.first && stream.peek() === '#') {
      stream.skipToEnd();
      return 'comment';
    }
    if (state.first) {
      state.first = false;
      stream.match(/^\S+/);
      return 'keyword';
    }
    const common = commonToken(stream, state, { lineComment: [], blockComment: false, backtick: null });
    return common !== undefined ? common : (stream.match(/^\S+/), null);
  },
  languageData: { commentTokens: { line: '#' }, closeBrackets: { brackets: ['"', "'"] } },
});

const ES_METHODS = ['GET', 'POST', 'PUT', 'DELETE', 'HEAD'];

const ES_ENDPOINTS = words(
  '_search _count _doc _mapping _settings _bulk _update _delete_by_query _update_by_query _refresh _aliases _cat/indices _cat/aliases _cat/health _cat/nodes _cluster/health _nodes _tasks _sql',
);

const ES_KEYWORDS = words(
  `query match match_all match_phrase multi_match term terms range bool must must_not should filter exists wildcard\n  prefix ids query_string size from sort _source aggs fields track_total_hits doc order gte lte gt lt`,
);

const elasticLanguage = StreamLanguage.define({
  name: 'elasticsearch',
  startState: () => ({ block: false, path: false }),
  token(stream, state) {
    if (stream.sol()) {
      state.path = false;
      if (stream.match(/^\s*(?:#|\/\/).*/)) return 'comment';
      if (stream.match(/^\s*(?:GET|POST|PUT|DELETE|HEAD|PATCH)\b/i)) {
        state.path = true;
        return 'keyword';
      }
    }
    if (stream.eatSpace()) return null;
    if (state.path) {
      stream.match(/^\S+/);
      return 'builtin';
    }
    if (stream.peek() === '"') {
      stream.next();
      let escaped = false;
      for (let ch = stream.next(); ch != null && !(ch === '"' && !escaped); ch = stream.next())
        escaped = !escaped && ch === '\\';
      return stream.match(/^\s*:/, false) ? 'property' : 'string';
    }
    return stream.match(/^-?\d+\.?\d*(?:e[-+]?\d+)?/i)
      ? 'number'
      : stream.match(/^(?:true|false|null)\b/)
        ? 'atom'
        : (stream.next(), null);
  },
  languageData: { commentTokens: { line: '#' }, closeBrackets: { brackets: ['(', '[', '{', '"'] } },
});

const completion =
  (type, boost = 0) =>
  (label) => ({ label, type, boost });

function completionSource(dialect, schema) {
  const keys = Object.keys(schema || {});
  const fields = [...new Set(keys.flatMap((table) => schema[table] || []))];
  const result = (match, options, skip = 0) => ({ from: match.from + skip, options, validFor: /^[\w$.*/-]*$/ });
  if (dialect === 'neo4j') {
    const all = [
      ...CYPHER_KEYWORDS.map(completion('keyword')),
      ...CYPHER_FUNCTIONS.map(completion('function')),
      ...keys.map(completion('type', 1)),
    ];
    return (context) => {
      const label = context.matchBefore(/:\w*$/);
      if (label) return result(label, keys.map(completion('type')), 1);
      const word = context.matchBefore(/[\w$]+$/);
      return word || context.explicit ? result(word || { from: context.pos }, all) : null;
    };
  }
  if (dialect === 'mongodb')
    return (context) => {
      const dbMatch = context.matchBefore(/\bdb\.\w*$/);
      if (dbMatch)
        return result(
          dbMatch,
          [...keys.map(completion('type', 1)), ...MONGO_DB_METHODS.map(completion('function'))],
          3,
        );
      const member = context.matchBefore(/\.\w*$/);
      if (member) return result(member, MONGO_COLLECTION_METHODS.map(completion('function')), 1);
      const word = context.matchBefore(/[\w$]+$/);
      return !word && !context.explicit
        ? null
        : result(word || { from: context.pos }, [
            ...MONGO_OPERATORS.map(completion('keyword')),
            ...[...MONGO_TYPES].map(completion('type')),
            completion('keyword')('db'),
            ...fields.map(completion('property')),
          ]);
    };
  if (dialect === 'redis') {
    const commands = REDIS_COMMANDS.map(completion('keyword'));
    return (context) => {
      const word = context.matchBefore(/^\s*[\w.]*$/);
      return !word || (word.text.trim() === '' && !context.explicit)
        ? null
        : result(word, commands, word.text.length - word.text.trimStart().length);
    };
  }
  return (context) => {
    const line = context.state.doc.lineAt(context.pos);
    const before = line.text.slice(0, context.pos - line.from);
    if (/^\s*[A-Za-z]*$/.test(before)) {
      const word = context.matchBefore(/[A-Za-z]*$/);
      return word.text || context.explicit ? result(word, ES_METHODS.map(completion('keyword'))) : null;
    }
    if (/^\s*[A-Za-z]+\s+\S*$/.test(before)) {
      const word = context.matchBefore(/[\w.*-]*$/);
      return result(word, [...keys.map(completion('type', 1)), ...ES_ENDPOINTS.map(completion('function'))]);
    }
    const a = context.matchBefore(/[\w.]+$/);
    return a ? result(a, [...ES_KEYWORDS.map(completion('keyword')), ...fields.map(completion('property'))]) : null;
  };
}

const LANGUAGES = {
  neo4j: cypherLanguage,
  mongodb: mongoLanguage,
  redis: redisLanguage,
  elasticsearch: elasticLanguage,
};

export const PLACEHOLDERS = {
  neo4j: keys('Write Cypher here — ⌘↩ runs the statement under the cursor'),
  mongodb: keys('db.collection.find({ … }) — ⌘↩ runs the statement under the cursor'),
  redis: keys('One command per line, for example  GET user:1  — ⌘↩ runs the line under the cursor'),
  elasticsearch: keys('GET /index/_search, with the JSON body on the next lines — ⌘↩ runs the request under the cursor'),
};

export function languageSupport(dialect, schema) {
  const language = LANGUAGES[dialect];
  return language ? [language, language.data.of({ autocomplete: completionSource(dialect, schema) })] : null;
}
