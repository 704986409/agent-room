#!/bin/sh
set -eu

script_dir=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
repo_dir=$(CDPATH= cd -- "$script_dir/../../.." && pwd)
agent_room_dir=$(dirname -- "$repo_dir")
compose_file=$repo_dir/deploy/vps/docker-compose.ip.yml
env_file=$agent_room_dir/secrets/.env.production

if [ ! -r "$env_file" ]; then
  printf 'Production environment file is missing: %s\n' "$env_file" >&2
  exit 1
fi

compose() {
  docker compose -p agent-room --env-file "$env_file" -f "$compose_file" "$@"
}

backend_cli() {
  compose exec -T redis sh -ec 'REDISCLI_AUTH="$REDIS_BACKEND_PASSWORD" redis-cli --user backend "$@"' sh "$@"
}

web_cli() {
  compose exec -T redis sh -ec 'REDISCLI_AUTH="$REDIS_WEB_PASSWORD" redis-cli --user web "$@"' sh "$@"
}

expect_noperm() {
  label=$1
  shift
  output=$("$@" 2>&1 || true)
  if ! printf '%s' "$output" | grep -qi NOPERM; then
    printf 'ACL check failed (%s): expected NOPERM\n' "$label" >&2
    exit 1
  fi
  printf '%s: PASS\n' "$label"
}

output=$(compose exec -T redis redis-cli PING 2>&1 || true)
if ! printf '%s' "$output" | grep -qi NOAUTH; then
  printf 'Default Redis user check failed: expected NOAUTH\n' >&2
  exit 1
fi
printf 'Redis default user disabled: PASS\n'

[ "$(backend_cli PING)" = PONG ]
backend_key="agent-room:smoke:acl:$(date +%s)"
[ "$(backend_cli SET "$backend_key" ok EX 60)" = OK ]
[ "$(backend_cli GET "$backend_key")" = ok ]
backend_cli DEL "$backend_key" >/dev/null
printf 'Redis backend ACL PING/SET/GET: PASS\n'

expect_noperm 'backend FLUSHALL' backend_cli FLUSHALL
expect_noperm 'backend KEYS' backend_cli KEYS '*'
expect_noperm 'backend CONFIG' backend_cli CONFIG GET '*'
expect_noperm 'web FLUSHALL' web_cli FLUSHALL
expect_noperm 'web KEYS' web_cli KEYS '*'
expect_noperm 'web CONFIG' web_cli CONFIG GET '*'

eval_keys_output=$(compose exec -T redis sh -ec 'REDISCLI_AUTH="$REDIS_WEB_PASSWORD" redis-cli --user web EVAL "$1" 0 2>&1 || true' sh "return redis.call('KEYS','*')")
if ! printf '%s' "$eval_keys_output" | grep -Eqi 'NOPERM|ACL failure in script'; then
  printf 'SECURITY BLOCKER: web ACL allowed EVAL to call KEYS\n' >&2
  exit 1
fi
printf 'web ACL EVAL KEYS: PASS (Redis ACL denied the script command)\n'

compose exec -T app node /app/deploy/vps/scripts/smoke-redis.mjs
