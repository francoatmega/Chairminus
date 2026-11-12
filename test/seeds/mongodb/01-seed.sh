#!/bin/bash
# Seed for the "loja" database on MongoDB. The image sources this once, when the data directory is created.
# The documents live in data/*.ndjson as canonical Extended JSON, so Int32, Double, Decimal128, ObjectId and
# Date all come back as the type they were. A shell script rather than a .js file on purpose:
# `node --test` would run any .js file under test/.

# Passed with --eval, not on stdin: the REPL would take a line that starts with "." for one of its commands
# and carry on after an error, while --eval runs the whole script and fails the container start if it throws.
seed=$(cat <<'MONGOSH'
const fs = require('fs');
const loja = db.getSiblingDB('loja');
const load = (name) => fs.readFileSync(`/docker-entrypoint-initdb.d/data/${name}.ndjson`, 'utf8')
  .split('\n').filter(Boolean).map((line) => EJSON.parse(line, { relaxed: false }));

loja.createCollection('avaliacoes', {
  validator: { $jsonSchema: { bsonType: 'object', required: ['sku', 'nota'], properties: { nota: { bsonType: 'int', minimum: 1, maximum: 5 } } } },
});
for (const name of ['clientes', 'produtos', 'pedidos', 'avaliacoes']) loja.getCollection(name).insertMany(load(name));

loja.clientes.createIndex({ email: 1 }, { unique: true });
loja.clientes.createIndex({ 'endereco.uf': 1, 'endereco.cidade': 1 });
loja.produtos.createIndex({ categoria: 1, preco: -1 });
loja.produtos.createIndex({ nome: 'text' });
loja.pedidos.createIndex({ 'cliente.id': 1, criadoEm: -1 });
loja.pedidos.createIndex({ status: 1 });
loja.avaliacoes.createIndex({ sku: 1 });

loja.createView('clientes_vip', 'clientes', [{ $match: { vip: true } }, { $project: { nome: 1, email: 1, endereco: 1, saldo: 1 } }]);

print('mongodb: seeded ' + ['clientes', 'produtos', 'pedidos', 'avaliacoes'].map((n) => loja.getCollection(n).countDocuments() + ' ' + n).join(', '));
MONGOSH
)

mongosh --quiet --host 127.0.0.1 -u "$MONGO_INITDB_ROOT_USERNAME" -p "$MONGO_INITDB_ROOT_PASSWORD" --authenticationDatabase admin --eval "$seed"
