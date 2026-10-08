# Debian 12 IP deployment

This deployment publishes the Agent Room app on one host port. Redis and both
Serverless Redis HTTP (SRH) instances stay on the private `agent-room-private`
Docker network. The existing host Caddy and 3x-UI/x-ui services are not part of
this Compose project.

SRH uses the upstream image and environment contract documented at
[`hiett/serverless-redis-http`](https://github.com/hiett/serverless-redis-http):
`hiett/serverless-redis-http:latest`, port 80, `SRH_MODE=env`, `SRH_TOKEN`, and
`SRH_CONNECTION_STRING`.

## Safety checks before deployment

Record the current machine state before installing Docker or starting this
stack. The deployment plan's protected listeners are 22, 80, 443, 2096, and
9000–9006. Treat every other existing listener as an in-use service too.

```sh
mkdir -p /opt/agent-room/preflight /opt/agent-room/secrets \
  /opt/agent-room/backups /opt/agent-room/runtime
date -Is | tee /opt/agent-room/preflight/date.txt
cat /etc/os-release | tee /opt/agent-room/preflight/os.txt
uname -a | tee /opt/agent-room/preflight/kernel.txt
free -h | tee /opt/agent-room/preflight/memory.txt
df -h | tee /opt/agent-room/preflight/disk.txt
ss -lntup | tee /opt/agent-room/preflight/ss-before.txt
systemctl status caddy --no-pager \
  | tee /opt/agent-room/preflight/caddy-status-before.txt || true
systemctl list-units --type=service --all \
  | grep -Ei '3x-ui|x-ui' \
  | tee /opt/agent-room/preflight/xui-units.txt || true
ps aux | grep -Ei '[3]x-ui|[x]-ui' \
  | tee /opt/agent-room/preflight/xui-process-before.txt || true
nft list ruleset > /opt/agent-room/preflight/nft-before.txt 2>&1 || true
iptables-save > /opt/agent-room/preflight/iptables-before.txt 2>&1 || true
if [ -f /etc/caddy/Caddyfile ]; then
  sha256sum /etc/caddy/Caddyfile \
    | tee /opt/agent-room/preflight/caddy-hash-before.txt
fi
```

If Docker is already installed, reuse it and check `docker version` and
`docker compose version`. If it is absent, install Docker CE from Docker's
official Debian repository (not Debian's `docker.io` package):

```sh
apt-get update
apt-get install -y ca-certificates curl
install -m 0755 -d /etc/apt/keyrings
curl -fsSL https://download.docker.com/linux/debian/gpg \
  -o /etc/apt/keyrings/docker.asc
chmod a+r /etc/apt/keyrings/docker.asc
printf 'deb [arch=%s signed-by=/etc/apt/keyrings/docker.asc] https://download.docker.com/linux/debian %s stable\n' \
  "$(dpkg --print-architecture)" "$(. /etc/os-release && echo "$VERSION_CODENAME")" \
  > /etc/apt/sources.list.d/docker.list
apt-get update
apt-get install -y docker-ce docker-ce-cli containerd.io \
  docker-buildx-plugin docker-compose-plugin
```

After Docker installation, immediately check Caddy and the listener baseline
again. Stop the deployment if any protected service or listener changed. Do
not enable/reset UFW or flush nftables/iptables rules.

Before starting Compose, check the only planned public port:

```sh
ss -lntp | grep -E ':(3100)\b' || true
```

If port 3100 is already in use, leave that process alone. Set `HOST_PORT=3101`
in the private production env file and change both public URLs below to port
3101. Do not change any other service's port.

## Checkout and secrets

Use the requested deployment branch, not a PR merge:

```sh
cd /opt/agent-room
git clone https://github.com/704986409/agent-room.git repo
cd /opt/agent-room/repo
git checkout feat/vps-ip-deploy-7d
git pull --ff-only
git status --short --branch
```

Generate the production env file without printing its secret values:

```sh
umask 077
{
  printf 'HOST_PORT=3100\n'
  printf 'PUBLIC_BASE_URL=http://103.204.174.252:3100\n'
  printf 'VITE_UPSTASH_REDIS_REST_URL=http://103.204.174.252:3100/redis\n'
  printf 'REDIS_BACKEND_PASSWORD=%s\n' "$(openssl rand -hex 32)"
  printf 'REDIS_WEB_PASSWORD=%s\n' "$(openssl rand -hex 32)"
  printf 'SRH_PRIVATE_TOKEN=%s\n' "$(openssl rand -hex 32)"
  printf 'SRH_WEB_TOKEN=%s\n' "$(openssl rand -hex 32)"
  printf 'WEB_PROXY_TOKEN=%s\n' "$(openssl rand -hex 32)"
} > /opt/agent-room/secrets/.env.production
chmod 600 /opt/agent-room/secrets/.env.production
chmod +x deploy/vps/scripts/*.sh
deploy/vps/scripts/write-redis-acl.sh \
  /opt/agent-room/runtime/users.acl \
  /opt/agent-room/secrets/.env.production
```

The ACL file contains SHA-256 hashes of the random Redis passwords. The app
container receives the private SRH token and the web proxy token; it does not
receive either Redis password. The browser bundle contains only
`WEB_PROXY_TOKEN`, which is a public routing marker and not a Redis/SRH secret.
Do not copy `.env.production` into the repository or print it in deployment
logs.

## Build and start

Validate Compose without printing its expanded secret-bearing configuration,
then start services in dependency order:

```sh
docker compose -p agent-room --env-file /opt/agent-room/secrets/.env.production \
  -f deploy/vps/docker-compose.ip.yml config --quiet
docker compose -p agent-room --env-file /opt/agent-room/secrets/.env.production \
  -f deploy/vps/docker-compose.ip.yml up --build -d
```

The build runs `npm ci`, `npm run build:ordered`, the NodeNext type check, and
bundles `deploy/vps/server.ts` with the API handlers into a Node 20 production
runtime. It does not run `vercel dev`, `vite preview`, or a development server.
The API adapter parses JSON requests and leaves multipart uploads untouched for
`api/upload.ts` to consume. MCP listen requests have a 320-second Node timeout.

The Compose file publishes only `${HOST_PORT}:3000`. It has no host port
bindings for Redis 6379, either SRH instance, or container port 3000. Redis uses
an isolated persistent volume, AOF with `appendfsync everysec`, RDB snapshots,
and `noeviction`.

Check the app and readiness endpoints from the VPS:

```sh
curl -fsS http://127.0.0.1:3100/healthz
curl -fsS http://127.0.0.1:3100/readyz
docker compose -p agent-room --env-file /opt/agent-room/secrets/.env.production \
  -f deploy/vps/docker-compose.ip.yml ps
deploy/vps/scripts/smoke-redis.sh
```

Also check them from a separate machine at
`http://103.204.174.252:3100/healthz` and `/readyz`. If the host firewall or
provider network blocks the new port, stop here; do not alter the firewall as
part of this deployment.

## Backups

The backup script requests an RDB snapshot from only the Agent Room Redis
container, validates it with `redis-check-rdb`, and retains seven days of
backups under `/opt/agent-room/backups`:

```sh
deploy/vps/scripts/backup-redis.sh
```

Install the optional daily 03:30 timer after the first manual backup succeeds:

```sh
install -m 0644 deploy/vps/agent-room-redis-backup.service \
  /etc/systemd/system/agent-room-redis-backup.service
install -m 0644 deploy/vps/agent-room-redis-backup.timer \
  /etc/systemd/system/agent-room-redis-backup.timer
systemctl daemon-reload
systemctl enable --now agent-room-redis-backup.timer
systemctl status agent-room-redis-backup.timer --no-pager
```

## Rechecks and rollback

After each Agent Room container restart, recheck `/healthz`, `/readyz`, Caddy,
the protected listener ports, and the real 3x-UI proxy path. Restart only the
Agent Room service being tested, for example:

```sh
docker compose -p agent-room --env-file /opt/agent-room/secrets/.env.production \
  -f deploy/vps/docker-compose.ip.yml restart app
```

If an existing service changes state, stop only this deployment:

```sh
docker compose -p agent-room --env-file /opt/agent-room/secrets/.env.production \
  -f deploy/vps/docker-compose.ip.yml stop
```

Do not use `down -v`, restart Docker during resilience testing, edit/reload
Caddy, stop/restart 3x-UI/x-ui, change the firewall, or reboot the VPS.
