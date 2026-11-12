#!/bin/sh
# Seed for Neo4j, run by the neo4j-seed helper. Waits for Bolt, then loads seed.cypher.
# Does nothing when the graph already has nodes.
set -eu

shell() { cypher-shell -a "${NEO4J_URI:-bolt://neo4j:7687}" -u neo4j -p "${NEO4J_PASSWORD:-secretsecret}" "$@"; }

tries=0
until shell 'RETURN 1' >/dev/null 2>&1; do
  tries=$((tries + 1))
  if [ "$tries" -ge 30 ]; then echo "neo4j: the server did not accept Bolt connections" >&2; exit 1; fi
  sleep 2
done

count=$(shell --format plain 'MATCH (n) RETURN count(n) AS n' | tail -n 1)
if [ "$count" != "0" ]; then
  echo "neo4j: already seeded ($count nodes)"
  exit 0
fi

shell --fail-fast -f /seed/seed.cypher
echo "neo4j: seeded $(shell --format plain 'MATCH (n) RETURN count(n) AS n' | tail -n 1) nodes, $(shell --format plain 'MATCH ()-[r]->() RETURN count(r) AS n' | tail -n 1) relationships"
