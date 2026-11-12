#!/bin/sh
# Seed for Redis, run by the redis-seed helper once the server answers. Does nothing when database 0
# already holds keys, so `docker compose start` keeps whatever was changed.
set -eu

cli() { redis-cli -h "${REDIS_HOST:-redis}" --no-auth-warning -a "${REDIS_PASSWORD:-secret}" "$@"; }

if [ "$(cli DBSIZE)" != "0" ]; then
  echo "redis: already seeded"
  exit 0
fi

cli < /seed/seed.redis > /tmp/seed.log
if grep -E '^(ERR|WRONGTYPE|NOAUTH|NOPERM)' /tmp/seed.log; then
  echo "redis: the seed reported errors" >&2
  exit 1
fi
echo "redis: seeded $(cli DBSIZE) keys"
