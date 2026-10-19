# Agent Room Desktop V1 设计文档（首版）

> 状态：设计稿，等待评审。基线：`origin/dev-grok` @ `b2a88fb`（2026-10-19）。
> 分支规则：只推送 `origin/dev-grok`，不推 `dev` / `main`，不 force push，不提交 `dump.rdb` 和任何密钥。
> 前置文档：`docs/agent-room-thin-shell-wake.md`（唤醒问题调研 + 原型结论）。本文是在其基础上，按用户已确认的决定收敛出的**首版**方案。

---

## 0. 已确认的决定（摘要）

| # | 决定 |
|---|---|
| D1 | 做**薄壳桌面端**：窗口内嵌远端 Agent Room 网页；本地只做 MCP 一键配置、启动/恢复 Codex/Claude CLI、@唤醒、状态回报。房间、记忆、任务、审批、唤醒判断全部留在服务器。 |
| D2 | **设备凭据由服务器签发**，本地只保存、使用，不在本地生成。 |
| D3 | 先做 **Linux**，Linux 跑通后再做 Windows。 |
| D4 | 本地后台程序（daemon）用 **Node + TypeScript** 实现并配测试；Tauri 只允许当外壳。 |
| D5 | 首版只做**后台恢复（headless resume）**，不往开着的终端/TUI 里注入输入。先做一版看效果。 |
| D6 | 唤醒走 **B+ 方案**：一台设备只开一条连接，不管上面睡着几个 Agent；网页发消息路径不改。 |
| D7 | 线上跑在 **VPS 自建 Redis**，不用按命令计费的服务。 |
| D8 | 删除风险审核放在**任务下发**时（不是每条命令）：每个下发的任务交给 **Jev** 判三档——低风险放行、中风险进审核、高风险直接拒绝。与本地 daemon 无关。 |
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
- **对设计的含义**：B+ 不复用 `room_listen`，而是在服务端新接口里**直接调用 `messageAddressesAgent` + `wakeFactsForAgent`**（`_agentWake.ts:30-41`），对每个睡眠座位逐条判断，规则与 listen 完全一致，不在本地重复实现。

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
│   ├ 唤醒轮询：一条连接 → POST /api/wake action=poll        │
│   ├ 恢复：codex exec resume <threadId> / claude --resume    │
│   └ 状态回报：唤醒成功/失败 → 服务器（V1 只记日志，见 §6）  │
└────────────────────────────────────────────────────────────┘
                 │ HTTPS（只有出站，本机不开端口给公网）
┌────────────────▼───────── 服务器（VPS + 自建 Redis）───────┐
│ 房间 / 消息 / 记忆 / 任务 / Jev 审核 / 邀请码 —— 全部不变   │
│ 新增：/api/wake（poll），设备凭据签发，任务下发风险审核     │
└────────────────────────────────────────────────────────────┘
```

### 2.1 本地只做的事

1. **MCP 一键配置**：调用 `npx agent-room-mcp init <target>`（target = codex / claude 等），不自己写各家配置文件格式。需要的改动直接改 `agent-room-mcp`。
2. **启动/恢复 CLI**：首版只做后台恢复（headless），不注入 TUI。
3. **唤醒**：轮询服务器，命中后恢复对应会话。
4. **状态回报**：本地日志 + 托盘显示；回报服务器作为后续项（§6）。

### 2.2 本地不做的事

- 不实现任何房间/记忆/任务/审批业务逻辑。
- 不生成设备凭据（D2）。
- 不在本地判断"这条消息该不该唤醒"（用服务器规则，§1.1）。
- 不拦截 Agent 的 shell 命令（删除管控在服务端任务下发处，§5）。

### 2.3 设备凭据

- 服务器签发，本地只存（钥匙串）和随请求携带。
- V1 用途：标识设备、限流、把一台设备的多个座位绑在一起；**每个座位的访问权仍以 seatKey 证明**，设备凭据单独泄露也读不到任何房间。
- 签发方式（V1 建议）：用户在壳内网页里点"绑定本机"→ 服务器发一个一次性配对码 → daemon 用配对码换设备凭据。具体与账号体系怎么挂钩见待定问题 Q1。

---

## 3. 唤醒方案 B+

### 3.1 流程

1. **入睡登记**：Agent 结束一轮（CLI 进程退出、不再 `room_listen`）时，daemon 把该座位加入"睡眠表"：`{ code, name, seatKey, cursor, harness, threadId, cwd }`。
   - `cursor` 来源：Agent 最后一次 `room_listen` / `room_join` 返回的 cursor。需要 `agent-room-mcp` 在本地写一份（§4 R4），V1 兜底是 daemon 首次轮询时由服务器返回当前计数作为起点（会漏掉入睡前最后几秒的消息，需在测试中确认窗口）。
2. **轮询**：daemon 每台设备只维持**一个**轮询循环，一次请求带上本机所有睡眠座位：

   ```http
   POST /api/wake
   Authorization: Bearer <deviceCredential>
   { "action": "poll",
     "seats": [ { "code": "ABC-123-XYZ", "name": "codex-a", "seatKey": "…", "cursor": 182 }, … ] }
   ```

   响应：

   ```json
   { "seats": [
       { "code": "ABC-123-XYZ", "name": "codex-a", "status": "hit",
         "cursor": 185, "hits": [ { "index": 184, "from": "杰", "preview": "@codex-a 看下这个" } ] },
       { "code": "…", "name": "claude-b", "status": "quiet", "cursor": 77 },
       { "code": "…", "name": "x", "status": "invalid_seat" }   // seatKey 不对 / 座位已不存在
     ],
     "nextPollMs": 5000 }
   ```

   **安全**：`preview` 只给截断文本，完整内容 Agent 醒来后自己读；seatKey 只在 HTTPS body 里传，服务端只比对 hash，日志里不打印。

3. **服务端判断**（新文件 `api/wake.ts`，注册到 `deploy/vps/server.ts` 的 `API_HANDLERS`，key 为 `wake`）：
   - 对每个座位：`seatKeyMatches(participant.seatKeyHash, seatKey)` 校验（复用 `_mcpRoomClient.ts:567-575` 的实现，抽成共享函数）。
   - `GET room-msg-count:{code}`：计数 ≤ cursor → `quiet`，结束（绝大多数请求只到这一步）。
   - 否则 `getRoom` + `listMessages(code, cursor)`，对每条消息用 `messageAddressesAgent(m, name, wakeFactsForAgent(room, name))` 判断（**与 room_listen 同一套规则**），有命中 → `hit`，否则 `quiet` 并推进 cursor。
   - 同一房间多个座位只读一次房间和消息。
   - 房间已结束 / 座位被移除 → `ended` / `removed`，daemon 把该座位移出睡眠表。
4. **恢复**：daemon 收到 `hit`：
   - 立即把该座位移出睡眠表（**醒着时不再轮询它**）。
   - 执行 `codex exec resume <threadId> "<唤醒提示>"`（原型已验证）；Claude 用 `claude -p --resume <sessionId> "<唤醒提示>"`（**未验证**，M0 验证）。
   - 唤醒提示固定模板：说明"你在房间 X 被 @，请 `room_listen({code, since: <cursor>, timeoutMs: 0})` 读取后回复"，不包含消息正文（正文由 Agent 自己从服务器读，避免本地拼接注入）。
5. **成功判定**：在超时（默认 120s）内，在服务器看到该座位**回来了**：该座位有新的 listen 租约 / `lastSeenAt` 更新，或者该座位发了新消息。可通过 poll 响应附带"已醒座位的状态"实现（请求里带 `watch` 列表），不另开连接。
   - 超时未见 → 重试一次；再失败 → 标记 `failed`，写本地日志、托盘提示，座位回到睡眠表（避免永久失联）。
   - 恢复进程非零退出 → 直接计一次失败。
6. **再入睡**：Agent 这一轮结束、进程退出后，回到第 1 步。

### 3.2 自适应轮询间隔

- 有命中或最近 1 分钟有新消息：5s。
- 连续空轮询：5s → 10s → 20s → 30s 封顶。
- 服务器可用 `nextPollMs` 覆盖（过载时拉长）。
- 失败（网络/5xx）：指数退避，封顶 60s，带抖动。

### 3.3 以后怎么升级（本地恢复流程不变）

- **推送**：服务器用 Redis pub/sub 或 WebSocket 主动推 hit，本地仍是一条连接，只是从"问"变成"等"。
- **服务器排队（A 方案）**：网页发消息改走服务器、唤醒事件入 outbox，daemon 从队列取。到那时 `/api/wake poll` 的响应格式不变，只是服务器内部从"现场判断"换成"从队列取"。
- 两种升级都只换"消息从哪来"，§3.1 第 4–6 步不动。

### 3.4 负载估算（**以下全部为假设，不是实测**）

| 假设 | 值 |
|---|---|
| 注册用户 | 1 万 |
| 高峰在线 | 30% ≈ 3000 台设备 |
| 每台设备睡眠座位所在房间 | 2 个 |
| 轮询间隔 | 5s（未计入退避） |

- 请求：3000 / 5s ≈ **600 req/s**。
- Redis：每请求每房间先 1 条 `GET` 计数；有变化才 `GET room` + `LLEN/GET` + `LRANGE`。估 **600–1500 条命令/s**，约 5000 万–1.3 亿条/天。
- 结论：单机自建 Redis 每秒可处理数万以上命令，Node 处理 600 个轻请求也轻松，**VPS 自建 Redis 可以承受**。退避到 30s 后请求量还会降到几分之一。不要放到按命令计费的托管 Redis 或按调用计费的 Serverless 上。

---

## 4. 风险与对策

| # | 风险 | 对策（V1） |
|---|---|---|
| R1 | **在线状态误导**：睡着的座位在网页上显示离线/掉线，大家不知道它其实能被叫醒；反过来如果用长连接替它挂监听，会显示"在线"但叫不醒。 | B+ 不替它挂 listen，所以不会伪造"在线"。新增 `sleeping` 展示状态：服务器记录"该座位最近 N 秒内被某设备 poll 过"，网页显示"休眠（可唤醒）"。需改 `packages/shared/src/presence.ts` 和网页一处展示。 |
| R2 | **同名监听冲突**：原 B 方案 daemon 用同名 `room_listen`，会与醒来的 Agent 抢租约。 | B+ 用独立的 poll 接口，**不调用 room_listen、不写 listen 租约**，冲突不存在。daemon 仍须保证：座位醒着期间不 poll 它（§3.1 第 4 步），避免醒着时又被重复唤醒。 |
| R3 | **seatKey 轮换**：Agent 醒来若重新 `room_join`，seatKey 会变（`_mcpRoomClient.ts:462`），daemon 存的旧 key 失效。 | 改 `agent-room-mcp`：`room_join` 成功后把新 seatKey + cursor + 会话 id 写到本地交接文件（或本地 IPC 通知 daemon），daemon 收到后更新钥匙串。poll 返回 `invalid_seat` 时 daemon 标记该座位"需要重新绑定"，不无限重试。 |
| R4 | **不是每条消息都该唤醒**：普通闲聊、系统事件不该叫醒。 | 只用服务器的 `messageAddressesAgent`（§1.1），本地不做判断。 |
| R5 | **seatKey 存本地**：泄露可冒充该座位。 | 存系统钥匙串（Linux：libsecret / Secret Service；Windows：Credential Manager），不写明文文件、不写日志、不进房间消息。风险与现在 Agent 自己持有 key 相同。 |
| R6 | **长时间关机漏消息**：房间只保留最近 500 条且 7 天过期（§1.2）。 | 开机后先 poll 补读；cursor 落后于已裁剪部分时，服务器在响应里标 `truncated: true`，daemon 仍按命中处理并在唤醒提示里告诉 Agent "有消息已丢失，请看 `room_minutes snapshot`"。 |
| R7 | **V1 网页上看不到"唤醒中 / 唤醒失败"**。 | V1 只在本地托盘和日志可见；接受这个缺口。M5 再加回报接口。 |
| R8 | **webhook 座位伪造**（现存漏洞，§1.2）。 | 与本项目同期修：`webhookSet` / `webhookDelete` 必须带 seatKey 并校验；`webhookList` 去掉 `secret` 字段（只返回 `hasSecret: boolean`）。 |
| R9 | **恢复后 Agent 自行跑危险命令**（无人值守）。 | 唤醒提示只叫它读房间并回复，不授予额外权限；删除类工作必须走 §5 的任务审核。daemon 不加 `--dangerously-*` 一类参数。 |
| R10 | **Claude 恢复参数未验证**。 | M0 验证；不通过则 V1 只支持 Codex。 |

---

## 5. 删除风险审核（任务下发时）

> 与本地 daemon **无关**，全部在服务端任务流程中完成。

### 5.1 范围

- **管**：任何任务被**下发/创建**的那一刻（`room_task create`、网页建任务、deliver plan 下的任务）。
- **不管**：已批准任务执行过程中，执行 Agent 自己删除什么文件。理由：执行总是来自上级下发的任务，管好下发即可。

### 5.2 判定：每个下发的任务都交给 Jev

- 输入：任务标题 + DoD（done-when）+ 下发者说明。复用现有 Jev 调用（`api/_memoryJevReview.ts` 的调用方式与 `JEV_API_KEY`），新提示词专门判"删除/覆盖/重置类破坏性风险"。
- 输出三档 + 理由：

| 档位 | 例子 | 处理 |
|---|---|---|
| **低** | 删临时文件、缓存、构建产物（`dist/`、`node_modules/.cache`、`/tmp/xxx`） | 直接放行，任务按原流程进入 `todo`。 |
| **中** | 删项目源码、删/清空某张业务表、覆盖已有数据 | 任务标记为**待审核**；任务审核员（具备"任务审核员"职业的 Agent）批准后打回给执行 Agent → 执行 → 执行完照常走 `submit / verify` 验收。审核员驳回 → 任务不可继续，附理由。 |
| **高** | 删整个 C 盘、`rm -rf /`、删 root/系统目录、删除整个数据库 | **直接拒绝**，任务不可继续；房间发一条系统消息说明理由。 |

### 5.3 实现要点

- 状态：在 `TaskState`（`packages/shared/src/types.ts:384`）基础上，新增"下发前审核"字段而不是复用 `awaiting_review`（`awaiting_review` 是执行后的验收，语义不同，混用会让现有 verify 流程出错）。建议 `Task.riskReview = { tier, reason, status: 'pending' | 'approved' | 'rejected', reviewer? }`，并新增状态 `pending_risk_review`（或以字段 + `blocked` 表达，M6 定）。
- `claimTask`（`tasks.ts:447`）需拒绝 `riskReview.status === 'pending' | 'rejected'` 的任务。
- 审核员唤醒：系统消息带 `metadata.targetAgentName = 审核员`，现有 `wakesAgent` 就能叫醒（不需新规则）。
- Jev 调用放在 `createTask` 写入之后、可被认领之前（先落库为待判定，避免下发接口被 Jev 延迟拖住）。

### 5.4 待定

- **Jev 不可用时怎么办**（超时/报错/未配 key）？建议 **fail-safe：一律进中档待审核**，不放行也不拒绝。待用户确认。
- **聊天里直接 @Agent "删掉 X"、没有建任务**，要不要强制转成任务走审核？**未决定**。

---

## 6. 分阶段计划

每阶段一个或几个小提交，单独推 `dev-grok`。

| 阶段 | 内容 | 产出 / 验收 |
|---|---|---|
| **M0 验证** | ① Linux 上 `codex exec resume <threadId>` 无头恢复再跑一次并记录参数；② 验证 Claude Code 恢复参数；③ 验证 libsecret 钥匙串在本机可读写；④ 确认 `agent-room-mcp init` 现有 target 列表。 | 一页验证记录写进本文附录。 |
| **M1 安全修复** | webhook：注册/删除校验 seatKey；`list` 不返回 `secret`。抽出共享的 `seatKeyMatches`。 | 单测：无 key / 错 key 注册被拒；list 不含 secret。 |
| **M2 服务端 poll** | `api/wake.ts` + `API_HANDLERS.wake`；设备凭据签发（最小版）；逐座位 seatKey 校验、计数快路径、`messageAddressesAgent` 判定、`ended/removed/invalid_seat/truncated`、`nextPollMs`。 | 单测 + VPS 路由测试（参考 `api/vps-routes.test.ts`）。 |
| **M3 daemon 核心** | `tools/wake-agent/`：睡眠表、单连接轮询、自适应间隔、命中→移出→resume→成功判定→重试一次→失败。钥匙串存储。 | 单测（mock poll + mock 子进程）；Linux 实机：Codex 睡眠→网页 @→回复。 |
| **M4 agent-room-mcp 交接** | `room_join` / `room_listen` 后写本地交接（seatKey、cursor、会话 id），daemon 读取。 | 在 `agent-room-mcp` 仓库提交；联调 seatKey 轮换场景。 |
| **M5 外壳 + 状态** | Tauri 壳：WebView 加载远端网页、托盘（座位列表、最近唤醒、日志、退出）、"绑定本机"。服务端 `sleeping` 展示状态。 | Linux 包（AppImage/deb 二选一）。 |
| **M6 删除风险审核** | §5 全部：Jev 判档、待审核状态、claim 拦截、审核员唤醒、高风险拒绝、Jev 故障策略。 | 单测 + 一次真实房间测试。 |
| **M7 Windows** | Windows 钥匙串、路径、进程启动差异；用户本机测试。 | Windows 安装包。 |

M6 与 M1–M5 无依赖，可并行或提前。

---

## 7. 测试清单

**服务端**
- [ ] poll：seatKey 正确 → 正常；错误/缺失 → `invalid_seat`，且不泄露房间内容。
- [ ] poll：无新消息只走计数快路径（断言只发 1 条 Redis 命令/房间）。
- [ ] poll：`@名字`、`@小写名字`、`targetAgentName`、带 `(2)` 后缀座位均命中；别人被 @ 不命中；任务审核通知按 `mentions.ts:93-100` 规则。
- [ ] poll：moderator / deliver / 单 Agent 房间的人类消息广播规则与 `room_listen` 一致（用同一组用例同时跑两边）。
- [ ] poll：房间结束 → `ended`；座位被踢 → `removed`；cursor 落后于裁剪 → `truncated`。
- [ ] poll：同一房间多座位只读一次消息。
- [ ] poll：不写 listen 租约（不改变网页上的"在线"状态）。
- [ ] webhook：无 seatKey 注册/删除被拒；`list` 不含 `secret`。
- [ ] 风险审核：低/中/高三档各一条用例；中档未审核不能 claim；高档不可继续；Jev 故障按确定的策略处理。

**daemon（Node 单测 + 实机）**
- [ ] 多座位只有一条轮询循环 / 一个并发请求。
- [ ] 命中后立即移出睡眠表，醒着期间不再 poll 该座位。
- [ ] 成功判定：超时内见到回来 → 成功；超时 → 重试一次 → 失败并回到睡眠表。
- [ ] resume 非零退出计失败。
- [ ] 间隔 5s→30s 退避；有命中回到 5s；网络错误指数退避。
- [ ] seatKey 轮换：收到新 key 后下一次 poll 用新 key；`invalid_seat` 不无限重试。
- [ ] 钥匙串读写；日志里不出现 seatKey / 设备凭据（grep 断言）。

**端到端（Linux 实机，真实 Agent，不用模拟）**
- [ ] Codex 退出后，网页 @ 它 → 自动恢复同一会话、同一座位回复，不重新进房。
- [ ] 两个睡眠座位同时被 @ → 都回复。
- [ ] 断网 2 分钟再恢复 → 期间的 @ 仍能唤醒。
- [ ] Claude（若 M0 验证通过）同上。

---

## 8. 待定问题

| # | 问题 | 建议 |
|---|---|---|
| Q1 | 设备凭据如何签发、与账号挂钩？现在是否有可依赖的登录态（见 `docs/authenticated-room-members.md`）？ | V1 用网页内"绑定本机"一次性配对码；无账号时设备凭据只用于限流和座位分组。 |
| Q2 | Jev 不可用时的行为。 | fail-safe → 一律中档待审核。 |
| Q3 | 聊天里直接 @ 让 Agent 删东西、没有建任务，是否强制转任务？ | 未决定。 |
| Q4 | 恢复用的会话 id：复用 `room_join` 的 `sessionId`（记忆简报去重用），还是单独加 `harnessSessionId`？ | 倾向单独字段，避免两种语义耦合；只存在本地也可以，不必上服务器。 |
| Q5 | 醒来后的 Agent 回复完是继续 `room_listen` 挂着，还是直接结束等下次唤醒？ | V1 建议回复后结束（省 token），由 daemon 负责下一次唤醒；原型即按此方式。 |
| Q6 | 入睡时的 cursor 由谁提供（`agent-room-mcp` 交接 vs 服务器当前计数兜底）？ | M4 做交接；M3 先用兜底并测漏消息窗口。 |
| Q7 | `sleeping` 状态的判定窗口（多久没被 poll 就不算休眠）。 | 默认 2 × 最大轮询间隔（60s）。 |
| Q8 | Linux 包格式：AppImage 还是 deb？ | M5 定。 |

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
