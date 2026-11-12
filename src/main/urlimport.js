'use strict';
// Connection URLs: postgres://user:pass@host:5432/db?sslmode=require, mysql://..., sqlite:/path,
// mongodb://, mongodb+srv://, redis://, rediss://, neo4j://, bolt://, http(s):// for
// Elasticsearch and OpenSearch, and the SSH form driver+ssh://sshUser@sshHost:22/dbUser:dbPass@dbHost:5432/db

const DRIVERS = {
  postgres: 'postgres', postgresql: 'postgres', pg: 'postgres',
  mysql: 'mysql', mariadb: 'mariadb',
  sqlite: 'sqlite', sqlite3: 'sqlite', file: 'sqlite',
  mongodb: 'mongodb', mongo: 'mongodb', 'mongodb+srv': 'mongodb',
  redis: 'redis', rediss: 'redis', valkey: 'redis', valkeys: 'redis',
  elasticsearch: 'elasticsearch', es: 'elasticsearch', opensearch: 'opensearch', http: 'elasticsearch', https: 'elasticsearch',
  neo4j: 'neo4j', bolt: 'neo4j', 'neo4j+s': 'neo4j', 'neo4j+ssc': 'neo4j', 'bolt+s': 'neo4j', 'bolt+ssc': 'neo4j',
};
const PORTS = { postgres: 5432, mysql: 3306, mariadb: 3306, mongodb: 27017, redis: 6379, elasticsearch: 9200, opensearch: 9200, neo4j: 7687 };
/** What a scheme says about TLS: "+s" checks the certificate, "+ssc" accepts a self-signed one. */
const SCHEME_TLS = { rediss: 'require', valkeys: 'require', https: 'require', 'neo4j+s': 'verify-full', 'bolt+s': 'verify-full', 'neo4j+ssc': 'require', 'bolt+ssc': 'require' };
/** MongoDB URL options the form has a field for; the rest stay in "options". */
const MONGO_FIELDS = ['authSource', 'tls', 'ssl', 'name', 'env', 'environment', 'sslmode', 'usePrivateKey'];
const dec = (s) => { try { return decodeURIComponent(s); } catch { return s; } };

function parseAuthority(text) {
  // [user[:pass]@]host[:port]
  let user = '', password = '', hostport = text;
  const at = text.lastIndexOf('@');
  if (at !== -1) {
    const cred = text.slice(0, at);
    hostport = text.slice(at + 1);
    const colon = cred.indexOf(':');
    user = dec(colon === -1 ? cred : cred.slice(0, colon));
    password = colon === -1 ? '' : dec(cred.slice(colon + 1));
  }
  let host = hostport, port = '';
  const m = /^\[([^\]]+)\](?::(\d+))?$/.exec(hostport) || /^([^:]*)(?::(\d+))?$/.exec(hostport);
  if (m) { host = m[1]; port = m[2] || ''; }
  return { user, password, host, port };
}

/** @returns {{connection:object, password:string, sshPassword:string}} */
function parseConnectionUrl(input) {
  const url = String(input || '').trim();
  const m = /^([a-z0-9]+(?:\+(?:srv|ssc|s))?)(\+ssh)?:(?:\/\/)?(.*)$/i.exec(url);
  if (!m) throw new Error('Invalid URL');
  const scheme = m[1].toLowerCase();
  const driver = DRIVERS[scheme];
  if (!driver) throw new Error(`Invalid URL: "${m[1]}" is not a supported driver`);
  let rest = m[3];

  if (driver === 'sqlite') {
    const p = dec(rest.split('?')[0]);
    if (!p) throw new Error('Invalid URL');
    const filePath = p.startsWith('/') || p.startsWith('~') ? p : '/' + p;
    return { connection: { driver, name: filePath.split('/').pop(), path: filePath }, password: '', sshPassword: '' };
  }

  let query = '';
  const qi = rest.indexOf('?');
  if (qi !== -1) { query = rest.slice(qi + 1); rest = rest.slice(0, qi); }
  const options = Object.fromEntries(new URLSearchParams(query));

  const conn = { driver, ssh: { enabled: false } };
  let sshPassword = '';
  if (m[2]) {
    const slash = rest.indexOf('/');
    if (slash === -1) throw new Error('Invalid URL');
    const s = parseAuthority(rest.slice(0, slash));
    if (!s.host) throw new Error('Invalid host');
    conn.ssh = { enabled: true, host: s.host, port: Number(s.port) || 22, user: s.user, auth: options.usePrivateKey === 'true' ? 'key' : 'password' };
    sshPassword = s.password;
    rest = rest.slice(slash + 1);
  }
  const slash = rest.indexOf('/');
  const a = parseAuthority(slash === -1 ? rest : rest.slice(0, slash));
  if (!a.host) throw new Error('Invalid host');
  if (a.port && !(Number(a.port) > 0 && Number(a.port) < 65536)) throw new Error('Invalid port');
  conn.host = a.host;
  conn.port = Number(a.port) || (scheme === 'https' ? 443 : PORTS[driver]);
  conn.user = a.user;
  conn.database = slash === -1 ? '' : dec(rest.slice(slash + 1));
  if (SCHEME_TLS[scheme]) conn.sslMode = SCHEME_TLS[scheme];
  if (driver === 'elasticsearch' || driver === 'opensearch') {
    conn.database = ''; // a path after the host is not a database
    if (scheme === 'http') conn.sslMode = 'disable';
  } else if (driver === 'neo4j') {
    conn.scheme = scheme.startsWith('neo4j') ? 'neo4j' : 'bolt';
  } else if (driver === 'redis') {
    if (conn.database && !/^\d+$/.test(conn.database)) throw new Error('Invalid URL: a Redis database is a number');
  } else if (driver === 'mongodb') {
    if (scheme === 'mongodb+srv') { conn.srv = true; delete conn.port; }
    if (a.host.includes(',')) throw new Error('Invalid host: list one host, and name the replica set in the options');
    if (options.authSource) conn.authSource = options.authSource;
    if (options.tls === 'true' || options.ssl === 'true') conn.sslMode = 'require';
    const extra = new URLSearchParams(query);
    for (const k of MONGO_FIELDS) extra.delete(k);
    if ([...extra].length) conn.options = extra.toString();
  }
  conn.name = options.name || `${conn.host}${conn.database ? '/' + conn.database : ''}`;
  const ssl = options.sslmode || options['ssl-mode'] || options.tlsmode;
  if (ssl) {
    const map = { disabled: 'disable', disable: 'disable', preferred: 'prefer', prefer: 'prefer', required: 'require', require: 'require',
      verify_ca: 'verify-ca', 'verify-ca': 'verify-ca', verify_identity: 'verify-full', 'verify-full': 'verify-full' };
    conn.sslMode = map[String(ssl).toLowerCase()] || 'prefer';
  }
  if (options.env || options.environment) conn.environment = options.env || options.environment;
  return { connection: conn, password: a.password, sshPassword };
}

module.exports = { parseConnectionUrl };
