# Wake poll load generator

Not for production. This script does not start Redis, the VPS, or any paid API.

## Self-test (no network)

```bash
node tools/wake-load/load.mjs --self-test
```

Prints request count, error count, latency p50/p99, and the waits chosen after HTTP 5xx. Devices must back off (cap 60s) instead of reconnecting together. `nextPollMs` lengthens the next wait when the handler asks for it.

## Disposable local server

Start your own API and Redis somewhere that is not this machine's running services and not `agent-room.com`. Then review `load.mjs` before removing the live-run guard. Hostnames ending in `agent-room.com` or `upstash.io` are refused.

Record peak connections, Redis command latency, Redis memory, API CPU, and error rate in `docs/agent-room-desktop-v1-design.md` appendix B. Suggested shape: 3000 devices × 2 rooms, then double it. This track does not run that measurement.
