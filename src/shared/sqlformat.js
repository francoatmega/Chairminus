'use strict';
// A small SQL beautifier: upper-cases keywords and puts the main clauses on their own lines.

const { tokenize } = require('./tokenizer');

const KEYWORDS = new Set(`ADD ALL ALTER AND ANY AS ASC BEGIN BETWEEN BY CASCADE CASE CAST CHECK COLUMN COMMIT CONSTRAINT
CREATE CROSS DATABASE DEFAULT DELETE DESC DISTINCT DROP ELSE END EXCEPT EXISTS EXPLAIN FALSE FOREIGN FROM FULL GROUP
HAVING IF ILIKE IN INDEX INNER INSERT INTERSECT INTO IS JOIN KEY LEFT LIKE LIMIT NOT NULL OFFSET ON OR ORDER OUTER
PRIMARY REFERENCES RETURNING RIGHT ROLLBACK SELECT SET TABLE THEN TRUE TRUNCATE UNION UNIQUE UPDATE USING VALUES VIEW
WHEN WHERE WITH ANALYZE SHOW OVER PARTITION WINDOW NATURAL LATERAL RECURSIVE REPLACE TRIGGER SCHEMA TEMPORARY TEMP
COUNT`.split(/\s+/));
KEYWORDS.delete('COUNT');

// Clauses that start a new line at the statement's base indent.
const CLAUSES = new Set(['SELECT', 'FROM', 'WHERE', 'HAVING', 'LIMIT', 'OFFSET', 'VALUES', 'SET', 'RETURNING',
  'UNION', 'EXCEPT', 'INTERSECT', 'UPDATE', 'INSERT', 'DELETE', 'WITH', 'WINDOW']);
const JOIN_HEADS = new Set(['JOIN', 'LEFT', 'RIGHT', 'INNER', 'FULL', 'CROSS', 'NATURAL']);
const JOIN_PARTS = new Set(['JOIN', 'LEFT', 'RIGHT', 'INNER', 'FULL', 'CROSS', 'NATURAL', 'OUTER']);

const isSpecial = (t) => t.type === 'punct' && ':@$#{}[]'.includes(t.text);

function formatSql(sql, { dialect = 'postgres', indent = '  ', uppercase = true } = {}) {
  const tokens = tokenize(sql, dialect).filter((t) => t.type !== 'ws');
  let out = '';
  let line = '';
  const stack = []; // per open paren: {block:boolean, level:number}
  let level = 0; // indent of clause keywords
  let afterClause = false;
  let prev = null;
  let prevWord = '';
  let between = false; // the AND of BETWEEN x AND y stays inline

  const pad = (n) => indent.repeat(Math.max(0, n));
  const newline = (n) => {
    if (line.trim() !== '') out += line.replace(/\s+$/, '') + '\n';
    line = pad(n);
  };
  const add = (text, noSpace) => {
    if (line.trim() !== '' && !noSpace && !/[(.]$/.test(line) && !/::$/.test(line)) line += ' ';
    line += text;
  };

  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i];
    const up = t.type === 'word' ? t.text.toUpperCase() : '';
    const isKw = t.type === 'word' && KEYWORDS.has(up);
    const text = isKw && uppercase ? up : t.text;
    const inline = stack.length && !stack[stack.length - 1].block;

    // Variables and subscripts keep the spacing they were written with: :name, ${name},
    // {{name}}, @var, $1, items[1].
    if (prev && prev.end === t.start && (isSpecial(prev) || isSpecial(t)) && !(t.type === 'punct' && '(),;'.includes(t.text))) {
      line += text;
      prev = t;
      if (t.type === 'word') prevWord = up;
      continue;
    }
    if (t.type === 'comment') {
      if (t.text.startsWith('--') || t.text.startsWith('#')) { add(t.text); newline(level + (afterClause ? 1 : 0)); }
      else add(t.text);
      prev = t;
      continue;
    }
    if (t.type === 'punct') {
      if (t.text === '(') {
        const next = tokens[i + 1];
        const nextUp = next && next.type === 'word' ? next.text.toUpperCase() : '';
        const block = nextUp === 'SELECT' || nextUp === 'WITH';
        const call = prev && (prev.type === 'word' || prev.type === 'ident') && !KEYWORDS.has(prev.text.toUpperCase());
        add('(', call);
        stack.push({ block, level, afterClause });
        if (block) { level += 2; afterClause = false; newline(level); }
      } else if (t.text === ')') {
        const s = stack.pop();
        if (s) {
          if (s.block) { level = s.level; newline(level + 1); }
          afterClause = s.afterClause;
        }
        add(')', true);
      } else if (t.text === ',') {
        add(',', true);
        if (!inline) newline(level + 1);
      } else if (t.text === ';') {
        add(';', true);
        out += line.replace(/\s+$/, '') + '\n\n';
        line = '';
        level = 0; afterClause = false; stack.length = 0;
      } else if (t.text === '.') {
        add('.', true);
      } else if (t.text === ':' && tokens[i + 1] && tokens[i + 1].text === ':' && tokens[i + 1].start === t.end) {
        add('::', true);
        i++;
      } else {
        // operators made of several punctuation tokens (<=, <>, ||, ->>) stay glued together
        const glued = prev && prev.type === 'punct' && prev.end === t.start && !'(),;'.includes(prev.text);
        add(t.text, glued);
      }
      prev = t;
      continue;
    }

    if (isKw && !inline) {
      if (CLAUSES.has(up)) {
        // Keywords that are clause heads elsewhere but continue the current clause here.
        const glue = (up === 'UPDATE' && (prevWord === 'FOR' || prevWord === 'DO' || prevWord === 'ON')) ||
          (up === 'DELETE' && prevWord === 'ON') ||
          (up === 'FROM' && (prevWord === 'DELETE' || prevWord === 'DISTINCT'));
        if (!glue) newline(level);
        add(text);
        afterClause = true;
        prev = t; prevWord = up;
        continue;
      }
      if ((up === 'GROUP' || up === 'ORDER') && tokens[i + 1] && tokens[i + 1].text.toUpperCase() === 'BY') {
        newline(level);
        add(text);
        afterClause = true;
        prev = t; prevWord = up;
        continue;
      }
      if (JOIN_HEADS.has(up) && !JOIN_PARTS.has(prevWord)) {
        newline(level);
        add(text);
        prev = t; prevWord = up;
        continue;
      }
      if ((up === 'AND' || up === 'OR') && !between) {
        newline(level + 1);
        add(text);
        prev = t; prevWord = up;
        continue;
      }
    }
    if (up === 'BETWEEN') between = true;
    else if (up === 'AND') between = false;
    add(text);
    prev = t;
    if (t.type === 'word') prevWord = up;
  }
  if (line.trim() !== '') out += line.replace(/\s+$/, '') + '\n';
  return out.replace(/\n{3,}/g, '\n\n').trim() + '\n';
}

module.exports = { formatSql };
