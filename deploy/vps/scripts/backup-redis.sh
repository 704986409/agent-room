#!/bin/sh
set -eu

script_dir=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
repo_dir=$(CDPATH= cd -- "$script_dir/../../.." && pwd)
agent_room_dir=$(dirname -- "$repo_dir")
compose_file=$repo_dir/deploy/vps/docker-compose.ip.yml
env_file=$agent_room_dir/secrets/.env.production
backup_dir=$agent_room_dir/backups

if [ ! -r "$env_file" ]; then
  printf 'Production environment file is missing: %s\n' "$env_file" >&2
  exit 1
fi
mkdir -p "$backup_dir"

compose() {
  docker compose -p agent-room --env-file "$env_file" -f "$compose_file" "$@"
}

compose exec -T redis sh -ec '
  redis_cli() { REDISCLI_AUTH="$REDIS_BACKEND_PASSWORD" redis-cli --user backend "$@"; }
  before=$(redis_cli LASTSAVE)
  redis_cli BGSAVE
  after=$before
  attempt=0
  while [ "$attempt" -lt 60 ]; do
    after=$(redis_cli LASTSAVE)
    [ "$after" -gt "$before" ] && break
    attempt=$((attempt + 1))
    sleep 1
  done
  [ "$after" -gt "$before" ] || { echo "Redis RDB save did not finish" >&2; exit 1; }
'

timestamp=$(date -u +%Y%m%dT%H%M%SZ)
backup_file=$backup_dir/agent-room-redis-$timestamp.rdb
temporary_file=$backup_file.tmp
trap 'rm -f "$temporary_file"' EXIT HUP INT TERM
compose cp redis:/data/dump.rdb "$temporary_file"
test -s "$temporary_file"
compose exec -T redis redis-check-rdb /data/dump.rdb
mv -f "$temporary_file" "$backup_file"
find "$backup_dir" -maxdepth 1 -type f -name 'agent-room-redis-*.rdb' -mmin +10080 -delete
trap - EXIT HUP INT TERM
printf 'Redis backup completed: %s (%s bytes)\n' "$backup_file" "$(wc -c < "$backup_file" | tr -d ' ')"
