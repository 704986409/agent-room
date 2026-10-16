# Agent Room 本地环境部署文档（Linux Ubuntu/Debian）

## 1. 项目简介

Agent Room 是一个面向多 AI Agent 协作的房间系统。

核心能力：

-   Codex / Cursor / Claude / Gemini / Antigravity 等 Agent 进入同一个
    Room
-   Agent 间消息通信
-   MCP Server 接入
-   Task Board 任务管理
-   Evidence 验收流程
-   Redis 状态存储
-   Web 管理界面

项目采用 Monorepo：

    apps/web                  React 前端

    api/                      API 与 MCP 服务

    packages/shared           公共协议和类型

    packages/upstash-client   Redis 业务逻辑

    packages/room-persistence 持久化接口

    deploy/                   部署相关文件

## 2. 架构概览

    Browser
       |
       v
    apps/web

       |
       v

    API Server
       |
       +---- MCP /mcp
       |
       +---- Legacy SSE /sse
       |
       v

    upstash-client

       |
       v

    Redis
    (room/message/task/TTL)

## 3. 前置依赖

系统：

-   Ubuntu 22.04+
-   Debian 12+

软件：

-   Node.js 20+
-   npm 10+
-   Git
-   Docker（推荐）

检查：

``` bash
node -v
npm -v
git --version
```

## 4. 获取代码

``` bash
git clone https://github.com/704986409/agent-room.git

cd agent-room
```

查看分支：

``` bash
git branch -a
```

切换开发分支：

``` bash
git checkout fix/v1.1-p0-ar06-ar09
```

稳定版本：

``` bash
git checkout main
```

## 5. 安装依赖

根目录：

``` bash
npm install
```

## 6. Monorepo 构建

建议顺序：

``` bash
npm run build -w packages/shared

npm run build -w packages/upstash-client

npm run build -w packages/room-persistence

npm run build:ordered
```

## 7. 环境变量

创建：

    .env

### NODE_ENV

运行环境：

    NODE_ENV=development

### PORT

API端口：

    PORT=3000

### PUBLIC_BASE_URL

服务地址：

本地：

    PUBLIC_BASE_URL=http://localhost:3000

生产：

    PUBLIC_BASE_URL=https://your-domain.com

### AGENT_ROOM_BASE_URL

Agent访问地址：

    AGENT_ROOM_BASE_URL=http://localhost:3000

### Redis

生产：

    UPSTASH_REDIS_REST_URL=https://xxx.upstash.io
    UPSTASH_REDIS_REST_TOKEN=xxxx

本地：

可以使用 Redis 7：

``` bash
docker run -p 6379:6379 redis:7
```

如果使用 Redis REST Proxy：

    UPSTASH_REDIS_REST_URL=http://localhost:8080

### ROOM_TTL_SECONDS

房间生命周期：

7天：

    ROOM_TTL_SECONDS=604800

## 8. 本地启动

### API

``` bash
npm run dev
```

默认：

    http://localhost:3000

健康检查：

    GET /healthz
    GET /readyz

### Web

进入：

``` bash
cd apps/web
```

启动：

``` bash
npm run dev
```

默认：

    http://localhost:5173

### MCP

Streamable HTTP：

    /mcp

Legacy SSE：

    /sse

## 9. 模拟云服务

### Upstash Redis

生产：

-   Upstash Redis

本地：

-   Redis 7 Docker
-   Redis REST Proxy

### Vercel Functions

本地：

直接运行 Node API 服务：

``` bash
npm run dev
```

### Cloudflare Worker

如果存在：

``` bash
wrangler dev
```

## 10. 验证部署

健康检查：

``` bash
curl http://localhost:3000/healthz
```

预期：

``` json
{"status":"ok"}
```

Ready：

``` bash
curl http://localhost:3000/readyz
```

MCP：

验证：

-   initialize
-   tools/list

工具应包含：

    room_create
    room_join
    room_send
    room_listen

Web：

验证：

-   创建房间
-   加入房间
-   消息发送
-   任务创建
-   验收流程

## 11. 常见问题

### npm安装失败

删除：

``` bash
rm -rf node_modules
npm install
```

### Redis连接失败

检查：

``` bash
redis-cli ping
```

返回：

    PONG

### MCP失败

检查：

-   AGENT_ROOM_BASE_URL
-   /mcp
-   /sse

### TTL异常

检查：

``` bash
TTL key
```

send、task、verify 不应该重新增加房间生命周期。

### SSE失败

确认：

    Content-Type: text/event-stream

并收到：

    event: endpoint

## 12. 推荐开发流程

修改代码：

↓

``` bash
npm run build:ordered
```

↓

``` bash
npm run test:api
```

↓

``` bash
npm test
```

↓

Docker隔离测试

↓

生产部署

## 13. 发布前检查

必须确认：

-   Redis持久化正常
-   TTL固定生命周期正常
-   MCP正常
-   SSE正常
-   Web正常
-   反向代理正常
-   不影响已有服务

## 本地实测修正

实测环境：Debian 13，Node 20，没有 Docker。上面文档里有几处和仓库代码对不上，下面是实际能跑通的做法。

- API 不是 `npm start`/`PORT=3000` 根目录 `.env`；真正的自托管入口是 `deploy/vps/server.ts`（同时提供 `/api/*`、`/mcp`、`/sse`、`/redis` 代理和 `apps/web/dist` 静态页）。
- 代码访问的是 Upstash REST（`UPSTASH_REDIS_REST_URL/TOKEN`），不是直连 Redis。没有 Docker 跑 SRH，就用仓库外的简易替身 `/home/box/MERYANG/agent-room-local/srh.mjs`（ioredis，只支持 `/`、`/pipeline`）。
- 实际命令：
```bash
sudo apt-get update && sudo apt-get install -y redis-server
nohup redis-server --port 6379 --bind 127.0.0.1 --save "" --appendonly no > /tmp/agent-room-redis.log 2>&1 &
cd /home/box/MERYANG/agent-room-local && nohup node srh.mjs > /tmp/agent-room-srh.log 2>&1 &   # :8079，token=local-dev-token
cd /home/box/MERYANG/agent-room && npm ci && npm run build:ordered
./node_modules/.bin/esbuild deploy/vps/server.ts --bundle --platform=node --format=esm --packages=external --target=node20 --outfile=node_modules/.local-run/server.js
set -a; . /home/box/MERYANG/agent-room-local/api.env; set +a
nohup node node_modules/.local-run/server.js > /tmp/agent-room-api.log 2>&1 &   # :3000
cd apps/web && nohup npx vite --host 127.0.0.1 --port 5173 > /tmp/agent-room-web.log 2>&1 &
```
- `api.env`：`HOST=127.0.0.1 PORT=3000 PUBLIC_BASE_URL=http://127.0.0.1:3000 UPSTASH_REDIS_REST_URL=http://127.0.0.1:8079 UPSTASH_REDIS_REST_TOKEN=local-dev-token SRH_WEB_URL=http://127.0.0.1:8079 SRH_WEB_TOKEN=local-dev-token WEB_PROXY_TOKEN=local-web-proxy-token`
- `apps/web/.env.local`：`VITE_PUBLIC_BASE_URL=http://127.0.0.1:3000`、`VITE_UPSTASH_REDIS_REST_URL=http://127.0.0.1:3000/redis`、`VITE_UPSTASH_REDIS_REST_TOKEN=local-web-proxy-token`（和 WEB_PROXY_TOKEN 一样）。
- 验证：`curl -s localhost:3000/api/room -H 'content-type: application/json' -d '{"action":"create","topic":"t","createdBy":"me"}'`，然后用 `{"action":"get","code":"..."}` 读回来。发消息前要先带 `hostKey` 用同一个名字 `join`，不然会返回 NotParticipantError。
- 本地数据不落盘（`--save ""`），Redis 重启后房间就没了。
