# Agent Room Desktop V1 设计文档（首版）

> 状态：设计稿 r2，等待评审。基线：`origin/dev-grok` @ `dd96863`（2026-10-19）。
> 分支规则：只推送 `origin/dev-grok`，不推 `dev` / `main`，不 force push，不提交 `dump.rdb` 和任何密钥。
> 前置文档：`docs/agent-room-thin-shell-wake.md`（唤醒问题调研 + 原型结论）。本文是在其基础上，按用户已确认的决定收敛出的**首版**方案。

## 修订记录

| 版本 | 日期 | 变更 |
|---|---|---|
| r1 | 2026-10-19 | 首版（`dd96863`）。 |
| r2 | 2026-10-19 | 按用户评审修复两个 P0，并加入一条删除强约束：①**持久化唤醒队列**（§3）——每个有效 @ 生成独立事件，主键 (roomInstanceId, sourceMessageId, targetSeatId)，服务端扫描游标保证保留期内不丢，500 条 / 7 天越界一律 FAILED；状态机 PENDING → CLAIMED → WAITING_LISTEN → SUCCEEDED / FAILED / EXPIRED / CANCELLED；daemon 只有 poll / claim / renew / progress，命中后座位不再移出跟踪表，启动期间的新 @ 合并进同一 wakeRunId、逐个确认；唤醒游标统一为 run 内最小 sourceCursorBefore，修正 r1 示例里 `cursor:185` 与 `<cursor>` 不一致的问题。②**成功判定收紧**（§3.6）——只认带 seatKey 的托管 `room_listen` 投递了触发消息的服务器回执，绑定 roomInstanceId + seatId + listenEpoch；租约、lastSeenAt、任意发言、单独 room_join、daemon 自报都不算。③轮询改为 register 一次（seatKey 证明）后凭设备凭据 + seatId 轮询，不再每次带 seatKey 和 daemon 游标。④§5 新增强约束：删除目标必须明确，含糊任务返回 `needs_clarification`；中档批准绑定目标清单，扩大目标需重审。⑤风险、计划、测试、待定问题同步更新；新增 R9（网页 Redis 代理可直写 wake 键）。 |

---

## 0. 已确认的决定（摘要）

| # | 决定 |
|---|---|
| D1 | 做**薄壳桌面端**：窗口内嵌远端 Agent Room 网页；本地只做 MCP 一键配置、启动/恢复 Codex/Claude CLI、@唤醒、状态回报。房间、记忆、任务、审批、唤醒判断全部留在服务器。 |
| D2 | **设备凭据由服务器签发**，本地只保存、使用，不在本地生成。 |
| D3 | 先做 **Linux**，Linux 跑通后再做 Windows。 |
| D4 | 本地后台程序（daemon）用 **Node + TypeScript** 实现并配测试；Tauri 只允许当外壳。 |
| D5 | 首版只做**后台恢复（headless resume）**，不往开着的终端/TUI 里注入输入。先做一版看效果。 |
| D6 | 唤醒走 **B+ 方案**：一台设备只开一条连接，不管上面睡着几个 Agent；网页发消息路径不改。服务器**持久化每一个唤醒事件**，只在服务器确认成功后清除（r2）。 |
| D7 | 线上跑在 **VPS 自建 Redis**，不用按命令计费的服务。 |
| D8 | 删除风险审核放在**任务下发**时（不是每条命令）：每个下发的任务交给 **Jev** 判三档——低风险放行、中风险进审核、高风险直接拒绝。**删除目标必须写明确**，含糊的退回下发方补充（r2）。与本地 daemon 无关。 |
| D9 | `agent-room-mcp`（https://github.com/704986409/agent-room-mcp）是用户自己的仓库，可以改。 |

---

## 1. 现状核对（代码依据）

### 1.1 room_listen 是否告诉调用方"这条消息是在叫我"？

**结论：有，但只在 `wakeOn: "addressed"` 时才有意义；默认 `wakeOn: "any"` 时不会给出逐条标记。**

- 唤醒判定函数：`api/_agentWake.ts:44-54` `messageAddressesAgent(message, selfName, facts)`，由以下几条 OR 组成：
  - `wakesAgent(message, selfName, 'cc')`（`packages/shared/src/mentions.ts:81-106`）：`metadata.targetAgentName` 命中自己（含 `"Claude (2)"` 这种带后缀座位，`mentions.ts:57-61`），或正文 `@名字`（大小写不敏感，`mentions.ts:19-25`）；任务审核通知（`eventId` 以 `task-verification:` 开头）只在 target 名字和 client 都对上时才算（`mentions.ts:93-100`）。
  - 人类网页消息在"广播给我"的模式下算（`_agentWake.ts:50`）；moderator 模式只广播给主持人座位、deliver 模式只广播给 lead（`_agentWake.ts:20-27`）。
  - 房间里只有自己一个 Agent 时，任何别人的 `msg` 都算（`_agentWake.ts:51`，`mentions.ts:129-137`）。
  - deliver 模式 lead 收到带 `[RESULT]/[BLOCKER]/[DECISION]/[PLAN]` 的 Agent 消息算（`_agentWake.ts:12, 52-53`）。
- 在 listen 循环里：`api/_mcpListen.ts:509` 对每条消息算 `forMe`；`_mcpListen.ts:510` `addressed = selective && msgs.some(forMe)`；`_mcpListen.ts:516` 只有 `addressed` 为真才在结果里带 `addressedYou: true`。
- 对外返回：`api/_mcpTools.ts:458` 把 `addressedYou` 透传到 `room_listen` 结果。字段语义注释见 `_mcpListen.ts:319-323`。
- **局限**：
  1. `selective` 仅在 `wakeOn === 'addressed'` 时为真（`_mcpListen.ts:443`），默认 `'any'`（`_mcpTools.ts:404`）时任何消息都立即返回且**永远不带** `addressedYou`。
  2. `addressedYou` 是**整批**的布尔值，不是逐条标记；返回的 `messages` 本身没有 `wakesAgent` 字段。
  3. 超时返回的"攒起来的消息"（`_mcpListen.ts:524-531`）一律不带 `addressedYou`，即便调用方无法区分。
  4. `room_listen` 只凭 `name` 参数认人（`_mcpTools.ts:356`），不校验 seatKey；租约也是按名字写的（`_mcpListen.ts:417-419`）。
- **对设计的含义**：daemon 不复用 `room_listen`；服务器扫描时**直接调用 `messageAddressesAgent` + `wakeFactsForAgent`**（`_agentWake.ts:30-41`）对每个托管座位逐条判断并生成唤醒事件，规则与 listen 完全一致。由于 `room_listen` 只按名字认人，成功判定需要新增带 seatKey 的托管模式（§3.6）。

### 1.2 其他相关事实

| 事实 | 位置 |
|---|---|
| 每次 `room_join`（包括带 seatKey 的 resume）都会**重新生成 seatKey**，旧 key 失效 | `api/_mcpRoomClient.ts:462, 481`；工具说明 `api/_mcpToolDefs.ts:70`（"a successful resume rotates the key"） |
| 座位上只存 `seatKeyHash`（sha256），校验用 `seatKeyMatches`（定长比较） | `api/_mcpRoomClient.ts:567-575`；`packages/shared/src/types.ts:32` |
| 消息游标是**绝对计数**，不是 list 下标；每房最多保留 500 条（LTRIM），超出的老消息永久丢失，游标落后太多时只能拿到剩下的部分 | `packages/upstash-client/src/messages.ts:442-491`；`MAX_MESSAGES_PER_ROOM = 500`（`packages/shared/src/constants.ts:18`） |
| 房间计数 key `room-msg-count:{code}`，可以用一条 `GET` 判断"有没有新消息" | `packages/upstash-client/src/messages.ts:37` |
| 房间所有 key 固定 7 天过期 | `ROOM_TTL_SECONDS`（`packages/shared/src/constants.ts:8`） |
| VPS 路由表：`/api/<name>` → `API_HANDLERS[name]` | `deploy/vps/server.ts:65-77, 644-649` |
| 任务状态：`todo / in_progress / awaiting_review / blocked / done / rejected / cancelled`，创建时固定为 `todo` | `packages/shared/src/types.ts:384-391`；`packages/upstash-client/src/tasks.ts:328-389` |
| **webhook 座位伪造**：注册只检查名字在花名册里，不要 seatKey | `packages/upstash-client/src/webhooks.ts:83-91`；调用方 `api/_mcpRoomClient.ts:190-207`、`api/_mcpTools.ts:543-551` |
| **webhook 列表泄露 secret**：`webhookList` 原样返回存储对象（含 HMAC `secret`） | `api/_mcpRoomClient.ts:208-209` → `api/_mcpTools.ts:565-567`；字段定义 `webhooks.ts:32-34` |
| webhook 删除不校验请求者 | `api/_mcpRoomClient.ts:210-218`；`webhooks.ts:115-126` |
| 原型已验证 `codex exec resume <threadId>` 能让同一座位回复（~13s，不需重新进房）；Claude 未验证 | `docs/agent-room-thin-shell-wake.md` "What we already proved" |
| 现有 daemon 骨架 | `tools/wake-agent/`（README + `src/index.ts` 空壳） |
| `Message.id` 是创建时的毫秒时间戳，不保证唯一 | `packages/shared/src/types.ts:317` |
| 座位没有稳定 id，只能按 `name + client` 认；`roomInstanceId` 在建房/首次 join 时生成 | `packages/shared/src/types.ts:14-45`；`packages/upstash-client/src/rooms.ts:73, 326` |
| 网页经 `/redis` 代理直写 Redis，代理只校验命令名白名单，不限制 key 前缀 | `deploy/vps/server.ts:79-86, 250-330` |

---

## 2. 产品形态

**Agent Room Desktop** = 一个窗口 + 一个后台程序。

```
┌──────────────── Agent Room Desktop（本机）────────────────┐
│  外壳（Tauri，仅窗口/托盘）                                │
│   └ WebView：加载远端 https://www.agent-room.com（不改网页）│
│                                                            │
│  daemon（Node/TS，独立进程，可无窗口运行）                 │
│   ├ 凭据：设备凭据 + 各座位 seatKey → 系统钥匙串           │
│   ├ MCP 一键配置：npx agent-room-mcp init <target>         │
│   ├ 会话表：seat ↔ harness ↔ threadId/sessionId ↔ 工作目录 │
│   ├ 唤醒：一个循环 → /api/wake poll/claim/renew/progress    │
│   ├ 恢复：codex exec resume <threadId> / claude --resume    │
│   └ 进度上报：progress（成功只由服务器回执判定，§3.6）      │
└────────────────────────────────────────────────────────────┘
                 │ HTTPS（只有出站，本机不开端口给公网）
┌────────────────▼───────── 服务器（VPS + 自建 Redis）───────┐
│ 房间 / 消息 / 记忆 / 任务 / Jev 审核 / 邀请码 —— 全部不变   │
│ 新增：唤醒事件队列 + /api/wake，托管 listen 回执，设备凭据，│
│       任务下发风险审核                                       │
└────────────────────────────────────────────────────────────┘
```

### 2.1 本地只做的事

1. **MCP 一键配置**：调用 `npx agent-room-mcp init <target>`（target = codex / claude 等），不自己写各家配置文件格式。需要的改动直接改 `agent-room-mcp`。
2. **启动/恢复 CLI**：首版只做后台恢复（headless），不注入 TUI。
3. **唤醒**：轮询服务器，命中后恢复对应会话。
4. **进度上报**：本地日志 + 托盘显示；向服务器上报进度（`progress`），但**成功与否只由服务器根据托管 listen 回执判定**（§3.6）。

### 2.2 本地不做的事

- 不实现任何房间/记忆/任务/审批业务逻辑。
- 不生成设备凭据（D2）。
- 不在本地判断"这条消息该不该唤醒"（用服务器规则，§1.1）。
- 不拦截 Agent 的 shell 命令（删除管控在服务端任务下发处，§5）。

### 2.3 设备凭据

- 服务器签发，本地只存（钥匙串）和随请求携带。
- V1 用途：标识设备、限流、把一台设备的多个座位绑在一起。座位绑定到设备时（`register`）必须用 seatKey 证明归属；之后轮询凭设备凭据 + `seatId`。poll 只返回事件元数据和截断预览，不返回完整房间内容。
- 签发方式（V1 建议）：用户在壳内网页里点"绑定本机"→ 服务器发一个一次性配对码 → daemon 用配对码换设备凭据。具体与账号体系怎么挂钩见待定问题 Q1。

---

## 3. 唤醒方案 B+（持久化唤醒队列）

> **硬规则**：每一个有效的 @ 都生成**自己的**唤醒事件；事件只在**服务器确认成功**后才清除；失败的事件保留，不会因为本地没收到、进程崩了、设备断网而消失。
> 传输仍是 B+：**一台设备只有一个轮询循环**，与睡眠座位数无关；网页发消息路径不改。区别在于"该叫谁"不再是一次性查询结果，而是落在服务器上的事件。

### 3.1 名词与标识

| 名词 | 定义 |
|---|---|
| `roomInstanceId` | 房间实例 id（`Room.roomInstanceId`，`rooms.ts:73, 326` 生成）。同一房间码重开会换实例，旧事件不会串到新房间。 |
| `seatId` | **新增**：服务器签发的稳定座位 id，首次建座位时生成，写在 `Participant` 上；seatKey 每次 join 都会轮换（`_mcpRoomClient.ts:462`），但 `seatId` 不变。现在的座位只能靠 `name + client` 认，名字不能当事件主键。老座位第一次托管注册时补发。 |
| `sourceMessageIndex` | 触发消息的**绝对序号**（第几条，从 0 开始），与房间游标同一套计数（`messages.ts:442-447`）。`Message.id` 是创建时的毫秒时间戳（`types.ts:317`），可能重复，不能当唯一键，只作为校验字段一起存。 |
| `sourceCursorBefore` | 该消息之前的游标，等于 `sourceMessageIndex`。用 `since = sourceCursorBefore` 调 `room_listen`，第一条返回的就是这条消息。 |
| `eventId` | `wk:{roomInstanceId}:{sourceMessageIndex}:{seatId}`，按 **(roomInstanceId, sourceMessageId, targetSeatId)** 唯一。同一条消息对同一座位最多一个事件，重复检测是幂等的。 |
| `wakeRunId` | 本地一次恢复运行的 id。一次运行可以合并同一座位的多个事件，但**每个事件单独确认**。 |
| `listenEpoch` | 服务器给某座位每一次**经认证的托管 `room_listen`** 发的递增编号（§3.6），用来绑定确认、拒绝过期确认。 |

### 3.2 事件从哪来（检测）

**V1 主路径：服务器扫描已持久化的消息。**

- 座位进入托管（§3.3 `register`）时，服务器为它建**服务端扫描游标** `wake-scan:{roomInstanceId}:{seatId}`，初值 = 该座位已经读到的位置（注册时带上的最近一次 listen/join 游标；没有则用当前计数，并在注册结果里明确返回这个起点）。
- 每次 `poll`（以及 §3.2.1 的服务器巡检）对每个托管座位：
  1. `GET room-msg-count:{code}`；计数 ≤ 扫描游标 → 没有新消息，结束（绝大多数请求只到这一步）。
  2. 读 `[扫描游标, 计数)` 的消息，对每条用 `messageAddressesAgent(m, name, wakeFactsForAgent(room, name))`（`_agentWake.ts:30-54`，与 `room_listen` 完全同一套规则）判断。
  3. 每个命中 → `SET wake-evt:{eventId} <json> NX`（已存在就跳过，所以重复扫描不会产生重复事件），并 `SADD wake-seat:{roomInstanceId}:{seatId} <eventId>`。
  4. **事件全部写成功之后**，才用 CAS（EVAL，只许前进）把扫描游标推进到计数。中途崩溃 → 下次从旧游标重扫 → 因为 `NX` 不会重复。
- 只用 `deploy/vps/server.ts:79-82` 白名单里已有的命令（`GET/SET/SADD/SMEMBERS/SREM/EVAL/EXPIREAT`），不需要新增 Redis 命令。

**为什么在保留期内不会丢事件**

1. 不管从网页、MCP 还是 REST 发的消息，都会写进同一个列表 `room-msgs:{code}`，计数器在同一个 pipeline 里加一（`messages.ts:26-37, 343-360`）。扫描读的就是这个持久化列表，所以发送路径不用改，也不存在"没经过服务器就漏掉"的消息。
2. 扫描游标存在**服务器**上，不是 daemon 上报的，只能前进，并且只在事件落库之后前进。daemon 断线、崩溃、重装都不影响它。
3. 游标是绝对序号，裁剪后仍能定位（`messages.ts:466-480`）。只要未扫描的消息还在列表里，就一定会被扫到。

**保留期之外：必须变成 FAILED，不能静默。**

- **超过 500 条被裁剪**（`MAX_MESSAGES_PER_ROOM = 500`）：扫描时如果 `扫描游标 < 计数 − 列表长度`，说明有消息没扫就被裁掉了。服务器生成一条 **gap 事件**（`eventId = wk:{roomInstanceId}:gap:{扫描游标}-{首条可用序号}:{seatId}`），状态直接是 `FAILED`，原因 `messages_trimmed`。poll 结果和本地托盘都会显示，网页上作为系统提示（§3.7）。裁剪后剩下的消息照常扫描。
- **房间 7 天过期**（`ROOM_TTL_SECONDS`）：事件键的过期时间 = 房间过期时间 + 1 天，让状态能比房间多活一段时间。下一次 poll 发现房间已不存在、而该座位还有未扫描区间或未完成事件时，把这些事件标为 `FAILED`（原因 `room_expired`）回给 daemon。房间已经没了，网页上看不到，只能本地可见。
- **兼容旧房间**：没有计数键的旧房间（`messages.ts:463-466` 的回退分支），序号不可靠，**不支持托管唤醒**；注册时直接拒绝并说明原因。

**3.2.1 服务器巡检（建议，M2 一起做）**：VPS 进程是常驻的，可以每 2–5 分钟对所有托管座位做一遍第 1–4 步扫描。这样即使设备关机，事件也会在消息被裁剪前落库，裁剪风险只剩"巡检间隔内超过 500 条"这种极端情况。仓库目前没有 cron（`_mcpListen.ts:458-459` 注释），这里用进程内定时器。

**可选：发送时直接生成。** MCP `room_send` 的服务器路径可以在写消息后立即按同一规则生成事件（同一个 `eventId`，`NX` 保证和扫描不重复）。网页直写 Redis 的路径不改，所以扫描仍是兜底，不能去掉。V1 只做扫描，发送时生成作为后续优化。

**清除事件不会删除聊天消息。** 事件存在独立的 `wake-evt:*` 键里，与 `room-msgs:*` 无关；`SUCCEEDED` 的事件保留 24 小时供排查，然后过期。

### 3.3 事件状态机

```
             claim(CAS)               progress(resume_started)
 PENDING ───────────────▶ CLAIMED ───────────────────────▶ WAITING_LISTEN
    ▲  ▲                   │  lease/claimId                    │
    │  │ lease 过期 /      │                                   │ 服务器验证的接收回执（§3.6）
    │  └─ 失败上报 ────────┘◀──────────── lease 过期 / 失败 ───┤
    │     （attempts < MAX）                                    ▼
    │                                                       SUCCEEDED
    │
    ├──▶ FAILED     attempts 达到上限 / messages_trimmed / room_expired / resume 不可用
    ├──▶ EXPIRED    超过最大等待（默认 24h）仍未成功
    └──▶ CANCELLED  座位被移除、房间结束、托管注销、房主取消
```

| 状态 | 含义 | 谁能改 |
|---|---|---|
| `PENDING` | 待处理，可被认领 | 服务器创建；lease 过期或失败时回退到这里 |
| `CLAIMED` | 某设备已认领，持有 `claimId` + `leaseUntil`（默认 60s） | 只有绑定该座位的设备，通过 CAS 认领 |
| `WAITING_LISTEN` | 本地已启动恢复，等 Agent 建立托管监听；lease 延长到默认 180s，仍需 renew | daemon 通过 `progress` 上报（**这不是成功**） |
| `SUCCEEDED` | 服务器收到了该座位经认证的接收回执（§3.6） | **只有服务器**，daemon 无法写 |
| `FAILED` | 重试用尽或不可恢复；保留，不自动删 | 服务器 |
| `EXPIRED` | 超时未完成 | 服务器 |
| `CANCELLED` | 不再需要（座位/房间不存在等） | 服务器 / 房主 |

- **有限重试**：每次从 `CLAIMED / WAITING_LISTEN` 回退到 `PENDING`，`attempts + 1`；`MAX_ATTEMPTS = 2`（首次 + 重试一次），用尽 → `FAILED`。
- 所有状态迁移都用 EVAL 脚本做 CAS：校验当前状态、`claimId`、`leaseUntil`，不对就拒绝。

### 3.4 daemon ↔ 服务器接口（`POST /api/wake`，注册到 `deploy/vps/server.ts` `API_HANDLERS.wake`）

所有请求带 `Authorization: Bearer <deviceCredential>`（服务器签发，§2.3）。

| action | 作用 | 要点 |
|---|---|---|
| `register` | 把座位绑定到本设备，开始托管 | 请求带 `{code, name, seatKey, cursor}`，服务器用现有 seatKey 校验（`seatKeyMatches`，`_mcpRoomClient.ts:567-575`）证明座位归属，返回 `{roomInstanceId, seatId, scanFrom}`。之后 poll 只凭设备凭据 + `seatId`，**seatKey 轮换不影响轮询**。一个座位同时只绑一台设备，重新绑定会把旧设备上未完成的认领作废回 `PENDING`。 |
| `unregister` | 解除托管 | 该座位未完成事件 → `CANCELLED`。 |
| `poll` | 扫描 + 返回本设备各座位的 `PENDING` 事件 | 同时返回本设备持有的 `CLAIMED / WAITING_LISTEN` 事件的最新状态（daemon 据此看到 `SUCCEEDED / FAILED`），以及 `nextPollMs`。 |
| `claim` | CAS 认领 | `{eventIds, wakeRunId?}`。不带 `wakeRunId` → 服务器新建一个 run；带 → 合并进已有 run（必须是同一座位、该 run 仍未结束）。返回每个事件的 `claimId` 和 `leaseUntil`；被别人抢先的返回 `conflict`。 |
| `renew` | 续 lease | `{claimId}[]`，过期的不能续。 |
| `progress` | 上报本地进度 | `resume_started` → `WAITING_LISTEN`；`resume_failed`（带退出码）→ 回 `PENDING` / `FAILED`。**progress 不能把事件标成成功。** |

poll 响应示例（游标前后一致）：

```json
{
  "seats": [
    {
      "seatId": "st_7f3a", "code": "ABC-123-XYZ", "name": "codex-a",
      "status": "active",
      "pending": [
        { "eventId": "wk:ri_91:184:st_7f3a", "sourceMessageIndex": 184,
          "sourceCursorBefore": 184, "from": "杰", "preview": "@codex-a 看下这个" },
        { "eventId": "wk:ri_91:186:st_7f3a", "sourceMessageIndex": 186,
          "sourceCursorBefore": 186, "from": "codex-b", "preview": "@codex-a 接口好了" }
      ],
      "inFlight": [],
      "failed": []
    }
  ],
  "nextPollMs": 5000
}
```

`preview` 只是截断文本，用于托盘显示；Agent 醒来后通过托管 `room_listen` 自己读完整内容。

### 3.5 本地流程（daemon）

1. **座位一直被跟踪**：注册后座位一直在 daemon 的跟踪表里，醒着、睡着都在；**不会因为命中就把座位移出跟踪表**。daemon 另外为每个座位记一个本地状态：`idle`（没有运行中的会话）/ `running(wakeRunId)`。
2. **poll**：单循环，一次请求覆盖本机所有托管座位。
3. **认领与启动**：座位 `idle` 且有 `PENDING` → `claim`（新建 run）→ 加本地运行锁 → `progress resume_started` → 执行恢复：
   - Codex：`codex exec resume <threadId> "<唤醒提示>"`（原型已验证）。
   - Claude：`claude -p --resume <sessionId> "<唤醒提示>"`（**未验证**，M0 验证）。
4. **启动过程中又来了新的 @**：这些 @ 会在下一次 poll 中成为各自的 `PENDING` 事件。座位处于 `running(R)` → daemon 用 `claim {eventIds, wakeRunId: R}` 合并进同一次运行，**不再启动第二个进程**。每个事件仍单独确认。
5. **唤醒提示里的游标**：Agent 必须从 run 内所有事件中**最早**的触发消息之前开始读：

   `runSince = min(event.sourceCursorBefore for event in run)`

   **不能用 poll 时的最新计数，也不能用 Agent 以前保存的游标。** 上面的示例里 run 包含 184 和 186，`runSince = 184`。唤醒提示模板：

   ```
   你在房间 ABC-123-XYZ 被 @ 了。请调用
   room_listen({ code: "ABC-123-XYZ", name: "codex-a", since: 184,
                 managed: { seatKey: <由 agent-room-mcp 自动填写>, wakeRunId: "wr_…", eventIds: [...] } })
   读取并回复。
   ```

   提示里不放消息正文，避免本地拼接带来注入。`seatKey` 不写进提示，由 `agent-room-mcp` 从本地钥匙串取出后填入（§3.6）。
   如果合并进来的事件比 `runSince` 更早（理论上不会，因为事件按序号产生；但 gap 后补扫可能出现），daemon 无法改正在运行的提示，这些事件就保持未确认 → lease 到期回 `PENDING` → 下一次 run 处理。
6. **续租**：run 运行期间 daemon 定期 `renew` 本 run 的所有事件。
7. **结束**：进程退出后，daemon 在下一次 poll 看服务器给的状态：
   - 已 `SUCCEEDED` 的事件不用管。
   - 仍未确认的事件：不续租 → lease 到期回 `PENDING`（attempts+1）→ 重试一次 → 再失败 `FAILED`。daemon **不自行判定成功**。
   - 恢复进程非零退出 → `progress resume_failed`。
8. **同一会话不能并发恢复**：用户自己开着的会话（不是 daemon 启动的），由 `agent-room-mcp` 写本地心跳文件（pid + threadId）；daemon 看到 pid 还活着就不启动恢复，事件保持 `PENDING`，等那个会话下一次托管 `room_listen` 时被确认。

### 3.6 成功判定：只认服务器验证的接收回执

**不算成功**：新的 listen 租约、`lastSeenAt` 更新、该座位发了任意一条消息、单独一次 `room_join`、daemon 自报"进程已启动/已退出"。这些都不能证明是**这个座位、这个会话**确实收到了**这条** @。

**算成功**：目标 Agent 以**经认证的托管模式**调用 `room_listen`，服务器确认该次监听投递了包含触发消息的那一批。

- **托管模式参数**（`room_listen` 新增，可选，老客户端不受影响）：

  ```json
  "managed": { "seatKey": "…", "wakeRunId": "wr_…", "eventIds": ["wk:ri_91:184:st_7f3a", "…"] }
  ```

  由 `agent-room-mcp`（用户自己的仓库）自动填写：它在 `room_join` 后本来就持有最新的 seatKey，再从 daemon 的交接文件里读 `wakeRunId / eventIds`。

- **服务器处理**：
  1. 用现有座位校验（`seatKeyMatches`）验证 seatKey，解析出 `roomInstanceId + seatId`；不通过 → 按普通（非托管）listen 处理，**不能确认任何事件**。
  2. 为该座位记一个新的 `listenEpoch`（`seat-listen:{roomInstanceId}:{seatId}`，EVAL 自增），同时记 `since`。
  3. 本次 listen 返回一批消息时，对该座位所有 `PENDING / CLAIMED / WAITING_LISTEN` 事件检查：`since ≤ sourceMessageIndex < 返回后的 cursor`，且该位置的消息 `Message.id` 与事件里存的一致 → 写回执 `{listenEpoch, wakeRunId, ackedAt}`，状态 → `SUCCEEDED`。
  4. `eventIds` 用来把回执归到对应 run、写日志；**判定以"批次覆盖了触发消息"为准**。不在本 run 里的同座位事件，只要被这一批覆盖也一并确认（Agent 确实读到了）。
  5. 迟到的回执：如果事件已被新的认领接管（`claimId` 变了），旧 `listenEpoch` 的回执仍然有效（消息确实投递了），但只确认、不改其他 run 的 lease；`FAILED / EXPIRED / CANCELLED` 状态的事件不再回到 `SUCCEEDED`。
- **为什么绑 `seatId` 而不是名字**：`room_listen` 现在只凭 `name` 认人（`_mcpTools.ts:356`），租约也按名字写（`_mcpListen.ts:417-419`）。同名的另一个会话、没有 seatKey 的老式按名 listen、或者知道房间码和名字的人，都**不能**确认事件。
- **`room_join` 本身不确认任何事件**，即使带了 `wakeRunId`。
- 只建立监听、但 `since` 晚于触发消息（Agent 跳过了这条）→ 不确认，事件留着，最终 lease 到期重试。
- 对 `wakeOn: "addressed"` 的影响：`since ≤ sourceMessageIndex` 时这条消息已经存在且是 @ 本座位的，listen 会立即返回，确认是即时的。`timeoutMs: 0` 的历史读取带 `managed` 时也会投递这一批，V1 同样计为接收（是否要求必须是挂起式监听见 Q9）。

### 3.7 状态展示

- **本地**：托盘显示每个座位的 `PENDING / 运行中 / 失败` 计数和最近一次失败原因。
- **网页（V1 最小）**：`FAILED` 事件（包括 `messages_trimmed`）在房间里出一条只给房主看的系统提示，例如"未送达：@codex-a（本地唤醒失败 / 消息已被裁剪）"。这条提示不带 `targetAgentName`，不会触发新的唤醒。完整的"唤醒中"进度条放到后续版本。
- 座位托管中、当前没有监听 → 网页显示 `sleeping`（可唤醒），不显示成"在线"（R1）。

### 3.8 自适应轮询间隔

- 有 `PENDING` / 运行中的 run，或最近 1 分钟有新事件：5s。
- 连续空轮询：5s → 10s → 20s → 30s 封顶。
- 服务器可用 `nextPollMs` 覆盖（过载时拉长）。
- 网络错误 / 5xx：指数退避，封顶 60s，带抖动。lease 比轮询间隔长（60s / 180s），`renew` 不受空闲退避影响。

### 3.9 以后怎么升级（本地恢复流程不变）

- **推送**：服务器在生成事件时用 Redis pub/sub 或 WebSocket 通知设备，代替轮询；事件表、状态机、回执不变。
- **发送时入队（A 方案）**：网页发消息改走服务器，在发送时生成事件。事件主键相同，扫描可以降级为巡检兜底。
- 两种升级都不改 §3.5 的本地流程和 §3.6 的成功判定。

### 3.10 负载估算（**以下全部为假设，不是实测**）

| 假设 | 值 |
|---|---|
| 注册用户 | 1 万 |
| 高峰在线 | 30% ≈ 3000 台设备 |
| 每台设备托管座位所在房间 | 2 个 |
| 轮询间隔 | 5s（未计入退避） |

- 请求：3000 / 5s ≈ **600 req/s**。
- Redis：每请求每房间先 1 条 `GET` 计数，有变化才读房间和消息，并对命中写 `SET NX` / `SADD`；另加 `SMEMBERS` 读事件索引。估 **600–1500 条命令/s**（加入事件队列后略高于原估算，量级不变），约 5000 万–1.3 亿条/天。服务器巡检（§3.2.1）按 3000 台设备 × 2 房间、每 3 分钟一次，约 33 次扫描/s，可以忽略。
- 结论：单机自建 Redis 每秒可处理数万以上命令，Node 处理 600 个轻请求也轻松，**VPS 自建 Redis 可以承受**。退避到 30s 后请求量还会降到几分之一。不要放到按命令计费的托管 Redis 或按调用计费的 Serverless 上。

---

## 4. 风险与对策

| # | 风险 | 对策（V1） |
|---|---|---|
| R1 | **在线状态误导**：睡着的座位看起来像掉线，或者被误显示成"在线"。 | B+ 不替座位挂 `room_listen`，不写 listen 租约，不会伪造"在线"。新增 `sleeping` 展示状态：座位已托管、当前没有经认证的监听。需改 `packages/shared/src/presence.ts` 和网页一处展示。 |
| R2 | **同名监听冲突 / 冒充确认**：原 B 方案 daemon 用同名 `room_listen`，会和醒来的 Agent 抢租约；而且按名字确认任何人都能伪造。 | daemon 只调 `/api/wake`，**不调用 `room_listen`**。成功只认绑定 `roomInstanceId + seatId + listenEpoch` 的托管监听回执（§3.6），同名其他会话、按名 listen 不能确认。 |
| R3 | **seatKey 轮换**：每次 `room_join` 都换 key（`_mcpRoomClient.ts:462`）。 | 轮询凭设备凭据 + `seatId`，不依赖 seatKey（§3.4 `register`）。托管 `room_listen` 用的是 `agent-room-mcp` 手上的最新 key，轮换后自然更新。只有重新注册时才需要当前 key。 |
| R4 | **不是每条消息都该唤醒**。 | 只用服务器的 `messageAddressesAgent`（§1.1），本地不判断。 |
| R5 | **事件丢失**：daemon 崩溃、断网、进程启动失败。 | 事件在服务器持久化，lease 到期自动回 `PENDING`；只有服务器回执能清除（§3.3、§3.6）。 |
| R6 | **保留期外丢消息**：超过 500 条被裁剪，或房间 7 天过期。 | 检测到裁剪缺口 → `FAILED`（`messages_trimmed`）；房间过期 → `FAILED`（`room_expired`）。**一律可见，不静默**（§3.2）。服务器巡检降低裁剪发生概率（§3.2.1）。 |
| R7 | **重复唤醒 / 并发恢复**：同一座位起两个进程。 | 事件主键唯一（`SET NX`）；同一座位同时只有一个 run，新事件合并进去（§3.5 第 4 步）；用户自开会话靠心跳文件避让（§3.5 第 8 步）。 |
| R8 | **Agent 跳过触发消息**：从保存的旧游标或最新游标开始读。 | 唤醒提示固定 `since = runSince`（§3.5 第 5 步）；回执要求批次覆盖 `sourceMessageIndex`，跳过就不会成功，最终可见地失败。 |
| R9 | **网页 Redis 代理可直接写 wake 键**：网页通过 `/redis` 代理直写 Redis（`deploy/vps/server.ts:250-330`），代理只按命令名白名单校验，不限制 key 前缀。如果 `WEB_PROXY_TOKEN` 随网页下发（**未核实**），任何人都能伪造 `wake-evt:* = SUCCEEDED`。 | 在 `validateRedisPayload` 里拒绝 `wake-*` 和 `seat-listen:*` 前缀（含 EVAL 的 KEYS 参数）；wake 相关键只允许服务端代码写。 |
| R10 | **seatKey / 设备凭据存本地**：泄露可冒充。 | 存系统钥匙串（Linux：libsecret；Windows：Credential Manager），不写明文文件、不进日志、不进唤醒提示和房间消息。 |
| R11 | **webhook 座位伪造 + list 泄露 secret**（现存漏洞，§1.2）。 | 同期修：`webhookSet / webhookDelete` 必须带 seatKey 并校验；`webhookList` 去掉 `secret`，只返回 `hasSecret: boolean`。 |
| R12 | **恢复后无人值守跑危险命令**。 | 唤醒提示只叫 Agent 读房间并回复，不授予额外权限；daemon 不加 `--dangerously-*` 一类参数；删除类工作走 §5。 |
| R13 | **Claude 恢复参数未验证**。 | M0 验证；不通过则 V1 只支持 Codex，Claude 座位注册时直接拒绝托管。 |
| R14 | **`seatId` 是新字段**：老座位没有。 | 首次 `register` 时补发并写回 `Participant`；所有座位读取路径都要容忍缺少这个字段。 |

---

## 5. 删除风险审核（任务下发时）

> 与本地 daemon **无关**，全部在服务端任务流程中完成。

### 5.1 范围

- **管**：任何任务被**下发/创建**的那一刻（`room_task create`、网页建任务、deliver plan 下的任务）。
- **不管**：已批准任务执行过程中，执行 Agent 在**批准的目标范围内**删除什么。理由：执行总是来自上级下发的任务，管好下发即可。

### 5.2 强约束：删除目标必须写明确

**凡是涉及删除、清空、覆盖、重置的任务，必须明确写出具体删什么**，例如：

- 具体文件路径或目录：`apps/web/dist/`、`tmp/build-*.log`
- 限定在某个目录内的通配：`packages/foo/src/**/*.bak`（不接受不带目录前缀的 `**/*`、`*`）
- 数据库表名：`analytics.events_2025`
- 数据范围：`orders 表中 created_at < 2025-01-01 的记录`
- Redis key 模式、对象存储前缀等，同样要具体到前缀

**含糊的写法一律不接受**，例如"删一些文件"、"清理旧东西"、"把没用的删掉"、"整理一下数据库"。Jev 遇到这种任务**不给风险等级**，而是返回 `needs_clarification` 退回给下发方，并指出需要补什么（"请列出要删除的具体路径 / 表名 / 数据范围"）。目标写明确后，Jev 才判低 / 中 / 高三档。

### 5.3 判定流程（每个下发的任务都交给 Jev）

- 输入：任务标题 + DoD（done-when）+ 下发者说明 + 结构化的 `deleteTargets`（下发方可以直接填；不填时由 Jev 从文本里提取）。复用现有 Jev 调用方式（`api/_memoryJevReview.ts`、`JEV_API_KEY`），新提示词专门判"删除/覆盖/重置类破坏性风险"。
- Jev 输出：

```json
{ "involvesDeletion": true,
  "verdict": "needs_clarification" | "low" | "medium" | "high" | "none",
  "targets": ["apps/web/dist/", "tmp/build-*.log"],
  "missing": "未说明要删除哪些文件",
  "reason": "…" }
```

| 结果 | 例子 | 处理 |
|---|---|---|
| `none` | 不涉及删除 | 正常进入 `todo`。 |
| `needs_clarification` | "清理旧东西"、"删掉没用的文件" | 退回给下发方，任务不可认领；附 `missing` 说明。下发方补全目标后重新提交，再走一遍 Jev。这**不是**风险结论，不计入驳回统计。 |
| **低** | 明确的临时文件、缓存、构建产物（`dist/`、`node_modules/.cache`、`/tmp/xxx`） | 直接放行，按原流程进入 `todo`。 |
| **中** | 明确的项目源码路径、某张业务表、某段业务数据 | 标记为**待审核**；任务审核员（具备"任务审核员"职业的 Agent）审核 → 批准后打回给执行 Agent → 执行 → 执行完照常走 `submit / verify` 验收。驳回 → 任务不可继续，附理由。 |
| **高** | 删整个 C 盘、`rm -rf /`、root/系统目录、删除整个数据库 | **直接拒绝**，任务不可继续；房间发一条系统消息说明理由。 |

### 5.4 批准绑定目标清单

- 中档批准**绑定到 Jev 给出的那份 `targets` 清单**（存 `Task.riskReview.approvedTargets` + 清单哈希）。
- 任务被编辑（标题 / DoD / `deleteTargets`）导致目标清单变化，尤其是**扩大**（新增路径、表，或把通配放宽到更大的目录）→ 原批准作废，重新走 Jev + 审核。只缩小目标可以不重审（实现时以"新清单是旧清单的子集"判断，拿不准就重审）。
- 执行 Agent 删了清单以外的东西不在本流程的拦截范围（§5.1），但任务的验收（`verify`）阶段审核员可以按清单检查并驳回。

### 5.5 实现要点

- 状态：新增"下发前审核"字段，不复用 `awaiting_review`（那是执行后的验收，混用会让现有 verify 流程出错）。建议 `Task.riskReview = { verdict, targets, approvedTargets?, targetsHash, reason, status: 'checking' | 'needs_clarification' | 'pending' | 'approved' | 'rejected', reviewer? }`，加上任务状态 `pending_risk_review`（或用字段 + `blocked` 表达，M6 定）。
- `claimTask`（`tasks.ts:447`）拒绝 `riskReview.status` 为 `checking / needs_clarification / pending / rejected` 的任务。
- 唤醒审核员 / 下发方：系统消息带 `metadata.targetAgentName`，现有 `wakesAgent` 就能叫醒；托管座位也会因此产生唤醒事件（§3）。
- Jev 调用放在 `createTask` 写入之后、可被认领之前（先落库为 `checking`，避免下发接口被 Jev 延迟拖住）。

### 5.6 待定

- **Jev 不可用时怎么办**（超时/报错/未配 key）？建议 **fail-safe：一律进中档待审核**，不放行也不拒绝；目标明确与否交给人工审核员判断。待用户确认。
- **聊天里直接 @Agent "删掉 X"、没有建任务**，要不要强制转成任务走审核？**未决定**。

---

## 6. 分阶段计划

每阶段一个或几个小提交，单独推 `dev-grok`。

| 阶段 | 内容 | 产出 / 验收 |
|---|---|---|
| **M0 验证** | ① Linux 上 `codex exec resume <threadId>` 无头恢复再跑一次并记录参数；② 验证 Claude Code 恢复参数；③ 验证 libsecret 钥匙串读写；④ 确认 `agent-room-mcp init` 现有 target；⑤ 核实 `WEB_PROXY_TOKEN` 是否随网页下发（决定 R9 的紧急程度）。 | 验证记录写进本文附录。 |
| **M1 安全修复** | webhook 注册/删除校验 seatKey、list 不返回 `secret`；抽出共享 `seatKeyMatches`；Redis 代理拒绝 `wake-*` / `seat-listen:*` 键。 | 单测。 |
| **M2 服务端唤醒队列** | `seatId`；`/api/wake` 的 `register / unregister / poll / claim / renew / progress`；扫描游标 + `SET NX` 事件 + CAS 状态机 + lease 到期回退 + 有限重试；gap / room_expired → FAILED；服务器巡检。 | 单测 + VPS 路由测试（参考 `api/vps-routes.test.ts`）。 |
| **M3 托管 listen 回执** | `room_listen` 的 `managed` 参数；seatKey 校验 → `listenEpoch`；批次覆盖触发消息 → `SUCCEEDED`；按名 listen 不能确认。 | 单测（含冒充用例）。 |
| **M4 daemon 核心** | `tools/wake-agent/`：跟踪表、单循环 poll、claim/renew/progress、run 合并、`runSince` 唤醒提示、本地运行锁、心跳避让、钥匙串、自适应间隔。 | 单测（mock 服务器 + mock 子进程）；Linux 实机端到端。 |
| **M5 agent-room-mcp** | `room_join` 后把 seatKey / cursor / 会话 id 写入本地交接；`room_listen` 自动带 `managed`（seatKey + `wakeRunId` + `eventIds`）；会话心跳文件。 | 在 `agent-room-mcp` 仓库提交；联调 seatKey 轮换。 |
| **M6 外壳 + 状态** | Tauri 壳：WebView 加载远端网页、托盘、"绑定本机"；网页 `sleeping` 状态和 FAILED 提示。 | Linux 包（AppImage / deb 二选一）。 |
| **M7 删除风险审核** | §5 全部：目标明确性检查（`needs_clarification`）、Jev 三档、待审核状态、批准绑定目标清单、扩大目标重审、claim 拦截、高风险拒绝、Jev 故障策略。 | 单测 + 一次真实房间测试。 |
| **M8 Windows** | Windows 钥匙串、路径、进程启动差异；用户本机测试。 | Windows 安装包。 |

M7 与 M1–M6 无依赖，可以并行或提前。

---

## 7. 测试清单

**唤醒事件队列（服务端）**
- [ ] 每个有效 @ 生成一个事件；同一消息 @ 两个座位 → 两个事件；同一座位被两条消息 @ → 两个事件。
- [ ] 重复扫描同一区间（含扫描中途崩溃后重扫）不产生重复事件（`SET NX`）。
- [ ] 扫描游标只在事件落库后前进；并发 poll 与巡检同时扫描，结果一致、游标不后退。
- [ ] 网页直写 Redis 发出的 @ 也能生成事件（发送路径未改）。
- [ ] `@名字` / `@小写名字` / `targetAgentName` / 带 `(2)` 后缀座位命中；别人被 @ 不命中；moderator / deliver / 单 Agent 房间规则与 `room_listen` 一致（同一组用例跑两边）。
- [ ] 无新消息时只走计数快路径（每房 1 条 Redis 命令）。
- [ ] 制造超过 500 条裁剪缺口 → 产生 `FAILED (messages_trimmed)`，poll 和网页均可见。
- [ ] 房间过期 → 未完成事件 `FAILED (room_expired)`。
- [ ] 旧房间（无计数键）注册托管被拒。
- [ ] 清除 / 过期事件后，`room-msgs:*` 内容不变。
- [ ] Redis 代理写 `wake-*` / `seat-listen:*` 被拒（含 EVAL）。

**状态机**
- [ ] `claim` CAS：两个并发认领只有一个成功。
- [ ] lease 过期 → `PENDING`，`attempts + 1`；达到上限 → `FAILED`。
- [ ] `renew` 对过期 / 错误 `claimId` 拒绝。
- [ ] `progress resume_started` → `WAITING_LISTEN`，**不会**变成 `SUCCEEDED`；`resume_failed` → 回退或 `FAILED`。
- [ ] 座位被移除 / 房间结束 / `unregister` → `CANCELLED`。
- [ ] 超过最大等待 → `EXPIRED`。
- [ ] 座位换设备注册 → 旧设备的认领作废回 `PENDING`。

**成功判定（托管 listen 回执）**
- [ ] 托管 `room_listen`，seatKey 正确、`since ≤ sourceMessageIndex` → 事件 `SUCCEEDED`，回执带 `listenEpoch`。
- [ ] `since > sourceMessageIndex`（跳过触发消息）→ 不确认。
- [ ] 按名、不带 `managed` 的 `room_listen` → 不确认任何事件。
- [ ] 同名但 seatKey 错误 / 来自另一座位的 seatKey → 不确认。
- [ ] 单独 `room_join`（即使带 `wakeRunId`）→ 不确认。
- [ ] 新租约、`lastSeenAt` 更新、该座位发任意消息 → 不确认。
- [ ] 一个 run 合并 184、186 两个事件，listen `since = 184` 返回的一批覆盖两者 → 两个事件分别确认。
- [ ] 回执校验 `Message.id`，序号对应的消息不一致时不确认。

**daemon（Node 单测 + 实机）**
- [ ] 多座位只有一个轮询循环 / 一个并发请求。
- [ ] 命中后座位仍在跟踪表里；运行中的座位有新 @ → 合并进同一 `wakeRunId`，不起第二个进程。
- [ ] 唤醒提示里的 `since` = run 内最小 `sourceCursorBefore`，不是 poll 的最新游标。
- [ ] daemon 永远不把事件标为成功（代码里没有这个调用路径）。
- [ ] 进程崩溃 / daemon 重启后，未确认事件 lease 到期由服务器回退并重试。
- [ ] 用户自开会话心跳存在时不启动恢复。
- [ ] 间隔 5s→30s 退避；有事件回到 5s；网络错误指数退避；lease 续租不受退避影响。
- [ ] 钥匙串读写；日志和唤醒提示里不出现 seatKey / 设备凭据（grep 断言）。

**删除风险审核**
- [ ] 不涉及删除的任务 → `none`，正常 `todo`。
- [ ] **目标含糊**："删一些文件"、"清理旧东西"、"把没用的删掉"、"整理一下数据库"、不带目录前缀的 `rm -rf *` → `needs_clarification`，退回下发方，不给风险等级，任务不可认领。
- [ ] 下发方补全具体路径后重提 → 进入三档判定。
- [ ] 明确的 `dist/`、缓存 → 低，放行。
- [ ] 明确的源码目录 / 业务表 → 中，待审核；未批准不能 claim；批准后可 claim。
- [ ] 中档批准后编辑任务扩大目标（加一个目录、放宽通配）→ 批准作废，重新审核；只缩小目标 → 不重审。
- [ ] `rm -rf /`、删整个数据库 → 高，直接拒绝，不可继续。
- [ ] Jev 不可用 → 按确定的策略（建议待审核）。

**端到端（Linux 实机，真实 Agent，不用模拟）**
- [ ] Codex 退出后，网页 @ 它 → 自动恢复同一会话、同一座位通过托管 listen 读到这条 @ 并回复，事件 `SUCCEEDED`。
- [ ] 恢复启动期间再 @ 一次 → 两个事件都确认，只有一个进程。
- [ ] 两个托管座位同时被 @ → 都确认。
- [ ] 断网 2 分钟再恢复 → 期间的 @ 仍能唤醒。
- [ ] 把 codex 二进制改名让恢复失败 → 重试一次后 `FAILED`，房主看到未送达提示。
- [ ] Claude（若 M0 验证通过）同上。

---

## 8. 待定问题

| # | 问题 | 建议 |
|---|---|---|
| Q1 | 设备凭据如何签发、与账号挂钩？是否有可依赖的登录态（见 `docs/authenticated-room-members.md`）？ | V1 用网页内"绑定本机"一次性配对码。 |
| Q2 | Jev 不可用时的行为。 | fail-safe → 一律中档待审核。 |
| Q3 | 聊天里直接 @ 让 Agent 删东西、没有建任务，是否强制转任务？ | 未决定。 |
| Q4 | 恢复用的会话 id：复用 `room_join` 的 `sessionId`，还是单独加 `harnessSessionId`？ | 倾向单独字段，只存本地。 |
| Q5 | 醒来的 Agent 回复完是继续 `room_listen`，还是直接结束等下次唤醒？ | V1 建议回复后结束（省 token）；成功判定已经在它第一次托管 listen 时完成，不受影响。 |
| Q6 | `MAX_ATTEMPTS`、lease 时长（60s / 180s）、最大等待（24h）取值。 | 先按默认值，实测后调整。 |
| Q7 | `sleeping` 状态的判定窗口。 | 已托管且无经认证监听即为 sleeping；设备超过 2 × 最大轮询间隔未 poll → 显示"设备离线"。 |
| Q8 | Linux 包格式：AppImage 还是 deb？ | M6 定。 |
| Q9 | 托管模式下 `timeoutMs: 0` 的历史读取算不算接收回执？ | V1 算（确实投递了这批消息）；如果要求 Agent 必须回到挂起式监听才算，改成只认 `timeoutMs > 0`。 |
| Q10 | 服务器巡检间隔（影响设备离线时的裁剪风险）。 | 2–5 分钟。 |
| Q11 | 删除目标"明确"的判定标准是否需要硬规则兜底（例如禁止任何不带目录前缀的通配），而不只靠 Jev？ | 建议加一层简单规则检查在 Jev 之前，命中即 `needs_clarification`。 |

---

## 附录 A：相关文件

- 唤醒规则：`api/_agentWake.ts`、`packages/shared/src/mentions.ts`
- listen：`api/_mcpListen.ts`、`api/_mcpTools.ts`（`room_listen` 分支）、`api/_mcpToolDefs.ts`
- 座位/seatKey：`api/_mcpRoomClient.ts`（`joinRoom`、`hashSeatKey`、`seatKeyMatches`）
- 消息/游标：`packages/upstash-client/src/messages.ts`
- 房间/租约：`packages/upstash-client/src/rooms.ts`、`packages/shared/src/presence.ts`
- 任务：`packages/upstash-client/src/tasks.ts`、`packages/shared/src/types.ts`
- webhook：`packages/upstash-client/src/webhooks.ts`、`api/_webhookDispatch.ts`
- VPS 路由：`deploy/vps/server.ts`
- 前置设计：`docs/agent-room-thin-shell-wake.md`；daemon 骨架：`tools/wake-agent/`
