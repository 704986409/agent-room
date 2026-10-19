# feat/accounts-writes

M1a 和 M1b 已在本分支实现。唤醒队列、daemon、MCP `room_create` 开关和游标修复没有改。

## 做了什么

### M1a

- 用户存在 Redis（`user:{id}`、`user-by-name:{lowercase}`）。密码是 Node `crypto.scrypt`（N=16384, r=8, p=1, keylen=64），每用户独立盐，比较用 `timingSafeEqual`。没有公开注册页或 `/api/account/register`。
- 登录失败统一文案 `Invalid username or password.`。同一用户名 15 分钟内失败 5 次后锁定 15 分钟；同一 IP 每分钟最多 30 次（设计只写了“每分钟上限”，实现取 30）。限速是 429，`Too many attempts. Try again later.`
- 会话令牌 32 字节，只存 SHA-256：`session:{hash}`，并 `SADD user-sessions:{userId}`。Cookie `ar_session`：`HttpOnly; Secure; SameSite=Lax; Path=/`，15 天滑动过期。
- 个人中心 `/account`：列会话、吊销一个、退出其他、改密码。设备列表固定返回空，并说明尚未开放。停用用户时会删掉已有 `device:{id}` / `device-user:{userId}`。
- 管理员 `/admin`：添加用户、停用/启用、重置密码、吊销该用户会话。操作写 `audit:{id}`。
- 首个管理员：

```bash
node deploy/vps/scripts/create-admin.mjs --username <name>
```

密码从 TTY（不回显）或 stdin 读取，不能当参数，也不会打印。已有管理员时拒绝，除非加上 `--add`。需要 `UPSTASH_REDIS_REST_URL` 和 `UPSTASH_REDIS_REST_TOKEN`。Node 20 没有 `--experimental-strip-types`，脚本通过仓库里的 `tsx` 启动。

- Webhook（R11）：`webhookSet` / `webhookDelete` 必须带 `seatKey` 并校验；`webhookList` 和注册响应不再返回 `secret`，只返回 `hasSecret`。
- 网页 Redis 代理拒绝这些键前缀：`user:`、`user-`、`session:`、`guest:`、`guest-`、`invite:`、`invite-`、`device:`、`device-`、`wake-`、`wake:`、`seat-`、`seat:`、`ratelimit:`、`audit:`、`audit-`、`room-members:`、`room-member:`、`room-invites:`、`invite-guests:`。

### M1b

- 网页写操作改为 `POST /api/web/*`：`room-create`、`join`、`whoami`、`chat-send`、`presence`、`typing`、`task`、`host`、`deliver`、`invite`、`invite-revoke`、`invite-accept`。身份是账号 cookie 或房间访客 cookie。未认证 401，角色不够 403。发言人名字由服务器决定。
- 只有登录用户能建房，`Room.ownerUserId` 和 `ownerId` 都写成创建者。房主生成 `/i/{token}`（可选过期和次数）。打开邀请：登录用户成为成员；没有账号的人填显示名，得到 1 天的 `guest:{hash}`。踢人会吊销该访客或取消该账号在这个房间的成员资格。作废邀请默认不收回已发出的访客，房主可以传 `revokeGuests: true`。
- 网页去掉了凭房间码加入。`/j` 和 `/j/:code` 只提示使用邀请链接，并保留 Agent 的 `room_join` 说明。MCP `room_join` + seatKey 没改。
- 网页 Redis 代理只允许读命令（`GET`、`MGET`、`LRANGE`、`LLEN`、`SMEMBERS`、`SISMEMBER`、`HGET`、`HGETALL`、`EXISTS`、`TTL`、`PING`）。`SET`、`SADD`、`DEL`、`LPUSH`、`EVAL`、`EVALSHA` 返回 403。读房间键必须持有该房间的账号会话或访客凭证，只知道房间码会被拒绝。`PING` 没有键，仍然放行。
- 读代理不滑动会话，避免 3 秒轮询变成写。在线心跳 `POST /api/web/presence` 会滑动账号会话。
- 建房响应仍把一次性 `hostKey` 交给创建者，并写入 `localStorage`。现有的 Agent 邀请码和记忆审核接口还在用它。人类不再用这个 key 认领房主。

## 验证

- `npm run build:ordered`、`npm run build -w packages/memory`、`npx tsc -p deploy/vps --noEmit` 通过。
- `npm run test:api`：28 个文件、293 个测试通过，包括 `api/mcp.smoke.test.ts`。
- `npm test`：shared、upstash-client、room-persistence、web 通过。`packages/memory/test/brief.integration.test.ts` 有一条失败（数据库故障应返回 `STORAGE_ERROR`，实际解析成功）。该包的 `*.integration.test.ts` 按任务说明忽略；这次没有改 `packages/memory`。
- 没有在浏览器里点过登录、建房、邀请和发消息。这个环境没有可用的浏览器验收，网页行为靠源码约束和 HTTP 测试覆盖。
- `deploy/vps/scripts/smoke-redis.mjs` 和 `smoke-web-approve.mjs` 已改成断言代理拒绝写，没有对正在运行的 `127.0.0.1:3000` 执行。

## 还没做

- 设备配对和设备列表。个人中心是占位。
- 写路径不生成唤醒事件，也不做 §6 删除风险审核。
- 不关闭 MCP `room_create`（`MCP_ROOM_CREATE_ENABLED` 属于另一条轨道）。消息上限 1000 和游标修复也没做。
- 任务板的成功写入依赖 Redis `EVAL`。单测覆盖了 401/403、邀请、访客和只读代理；内存 Redis 只实现了 presence CAS，没有实现任务板脚本，所以没有断言任务创建成功。
- “删除房间”走现有的 `endRoom`（房间状态变为结束），没有另做把房间键删掉的接口。
- 系统消息没有单独的公开写接口。host 的 skip / direct-invoke，以及 deliver，由服务器内部写入。

## 取舍

- 设计写访客 cookie“存在该房间路径下”。`/api` 和 `/redis` 不在 `/r/:code` 下，所以 cookie 是 `Path=/`，房间范围由 `guest:{hash}` 里的 `roomCode` / `roomInstanceId` 保证。
- 面试演示页仍用显示名 `Host` 建房，避免发言人判断坏掉。归属账号是 `ownerUserId`。脚本替座位发言只允许没有 `seatKeyHash` 的座位。
- 上游 Redis 的 web ACL 没有在这台机器上改。应用代理拒绝写；直接连 `SRH_WEB_*` 的 ACL 检查仍留在 smoke 脚本里。
