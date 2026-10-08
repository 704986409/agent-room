#!/bin/sh
set -eu

if [ "$#" -ne 2 ]; then
  printf 'Usage: %s <output-acl-file> <production-env-file>\n' "$0" >&2
  exit 2
fi

output_file=$1
env_file=$2
if [ ! -r "$env_file" ]; then
  printf 'Cannot read production environment file: %s\n' "$env_file" >&2
  exit 1
fi

set -a
# The production file is created from five hex-only generated secrets.
. "$env_file"
set +a

: "${REDIS_BACKEND_PASSWORD:?REDIS_BACKEND_PASSWORD is required}"
: "${REDIS_WEB_PASSWORD:?REDIS_WEB_PASSWORD is required}"

output_dir=$(dirname -- "$output_file")
mkdir -p "$output_dir"
umask 077
temporary_file=$(mktemp "$output_dir/.users.acl.XXXXXX")
trap 'rm -f "$temporary_file"' EXIT HUP INT TERM

backend_hash=$(printf '%s' "$REDIS_BACKEND_PASSWORD" | sha256sum | awk '{print $1}')
web_hash=$(printf '%s' "$REDIS_WEB_PASSWORD" | sha256sum | awk '{print $1}')

cat > "$temporary_file" <<EOF
user default off
user backend on #$backend_hash ~* +get +set +del +rpush +incr +ltrim +lrange +llen +expire +expireat +sadd +sismember +smembers +srem +eval +ping +ttl +bgsave +lastsave
user web on #$web_hash ~* +get +set +del +rpush +incr +ltrim +lrange +llen +expire +expireat +sadd +sismember +smembers +srem +eval +ping +ttl
EOF

chmod 644 "$temporary_file"
mv -f "$temporary_file" "$output_file"
trap - EXIT HUP INT TERM
printf 'Redis ACL file written (passwords are stored as SHA-256 hashes): %s\n' "$output_file"
