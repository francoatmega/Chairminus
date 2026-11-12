#!/bin/sh
# Seed for Elasticsearch and OpenSearch (the same script and data serve both), run by the *-seed helpers
# once the cluster is up. Every data/<index>.index.json is created as an index and filled from
# data/<index>.ndjson. Does nothing when the "produtos" index already exists.
#   SEARCH_URL   base URL of the cluster
#   SEARCH_AUTH  user:password, when the cluster asks for one
set -eu

call() {
  method=$1; path=$2; shift 2
  out=$(curl -sS ${SEARCH_AUTH:+-u "$SEARCH_AUTH"} -X "$method" "$SEARCH_URL$path" -H 'Content-Type: application/json' -w '\n%{http_code}' "$@")
  code=$(printf '%s' "$out" | tail -n 1)
  case "$code" in
    2*) ;;
    *) echo "search: $method $path -> $code" >&2; printf '%s\n' "$out" | head -c 2000 >&2; exit 1 ;;
  esac
  if printf '%s' "$out" | grep -q '"errors":true'; then
    echo "search: $method $path reported item errors" >&2; printf '%s\n' "$out" | head -c 2000 >&2; exit 1
  fi
}

if [ "$(curl -s -o /dev/null ${SEARCH_AUTH:+-u "$SEARCH_AUTH"} -w '%{http_code}' -I "$SEARCH_URL/produtos")" = "200" ]; then
  echo "search: already seeded"
  exit 0
fi

for definition in /seed/data/*.index.json; do
  index=$(basename "$definition" .index.json)
  call PUT "/$index" --data-binary "@$definition"
  call POST "/$index/_bulk?refresh=true" --data-binary "@/seed/data/$index.ndjson"
  echo "search: $index"
done

# One alias over the monthly log indices; the app lists aliases as views.
call POST /_aliases -d '{ "actions": [ { "add": { "index": "registros-*", "alias": "registros" } } ] }'
echo "search: seeded"
