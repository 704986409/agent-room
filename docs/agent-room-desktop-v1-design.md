# Agent Room Desktop V1 设计文档

> 状态：设计稿 r3，评审意见已全部收敛，待用户确认后开工。基线：`origin/dev-grok` @ `fe21253`（r2，2026-10-19）。
> 分支规则：只推送 `origin/dev-grok`，不推 `dev` / `main` / `prod`，不 force push，不提交 `dump.rdb` 和任何密钥。
> 前置文档：`docs/agent-room-thin-shell-wake.md`（唤醒问题调研 + 原型结论）。本文是在其基础上，按用户已确认的决定收敛出的**首版**方案。

## 修订记录

| 版本 | 日期 | 变更 |
|---|---|---|
| r1 | 2026-10-19 | 首版（`dd96863`）。 |
| r2 | 2026-10-19 | 按用户评审修复两个 P0，并加入一条删除强约束：①**持久化唤醒队列**（§3）——每个有效 @ 生成独立事件，主键 (roomInstanceId, sourceMessageId, targetSeatId)，服务端扫描游标保证保留期内不丢，500 条 / 7 天越界一律 FAILED；状态机 PENDING → CLAIMED → WAITING_LISTEN → SUCCEEDED / FAILED / EXPIRED / CANCELLED；daemon 只有 poll / claim / renew / progress，命中后座位不再移出跟踪表，启动期间的新 @ 合并进同一 wakeRunId、逐个确认；唤醒游标统一为 run 内最小 sourceCursorBefore，修正 r1 示例里 `cursor:185` 与 `<cursor>` 不一致的问题。②**成功判定收紧**（§3.6）——只认带 seatKey 的托管 `room_listen` 投递了触发消息的服务器回执，绑定 roomInstanceId + seatId + listenEpoch；租约、lastSeenAt、任意发言、单独 room_join、daemon 自报都不算。③轮询改为 register 一次（seatKey 证明）后凭设备凭据 + seatId 轮询，不再每次带 seatKey 和 daemon 游标。④§5 新增强约束：删除目标必须明确，含糊任务返回 `needs_clarification`；中档批准绑定目标清单，扩大目标需重审。⑤风险、计划、测试、待定问题同步更新；新增 R9（网页 Redis 代理可直写 wake 键）。 |
| r3 | 2026-10-19 | 按第二轮评审（P0-4～P0-7、P1-1～P1-4）和用户决定修订：①**P0-4 网页写操作全部迁到服务器**（§4.3）：聊天发送、在线/输入状态、任务、房主操作、deliver 流程、系统消息都走可信接口；读轮询留在浏览器；网页用的 Redis 代理凭据改为**只读**（含 EVAL 一律拒绝）；服务器凭会话凭证识别写入者。②**新增账号体系**（§4.1）：只做用户名 + 密码，不开放注册，管理员页面加用户；首个管理员在 VPS 上用命令创建。③**网页访问方式 B**（§4.2）：登录用户建房、管房；没有账号的人凭房主生成的邀请链接拿房间级访客凭证进房；去掉网页"房间码直接进"。Agent 进房方式不变。④**P0-5**：去掉"`timeoutMs: 0` 当作监听"的步骤；醒来后先做经 seatKey 验证的快速读取并处理，再进入真正的 `room_listen`（§3.5、§3.6）；**只要经验证的读取投递了触发 @，事件即 SUCCEEDED**，关闭 Q9。⑤**P0-6**：删除"用服务器当前总数当起点"的游标兜底；Agent 入睡前必须通过 MCP 交接游标；唤醒读取起点 = min(交接游标, 最早未处理 @ 之前的游标)；超出保留期则从最早留存消息读并告知 Agent 有缺口（§3.2、§3.5）。修复 `room_join` 用 `msgs.length` 当游标的 bug；房间消息上限 500 → **1000**。⑥**P0-7**：Jev 定位为分流；保留低风险自动放行；删除目标写法加强为"删除目录 X 下的文件/文件夹 Y"三要素齐全（§6.2）。⑦聊天里直接 @ 删除也必须先建任务（§6.1）；Jev 默认可用，调用失败一律转人工审核（§6.3）。⑧**P1-1** M5 补 MCP 一键配置界面与 Hook 协调（监听一轮、没有 @ 就入睡）（§2.5）。⑨**P1-2** 补首次启动流程与"一个工具一个适配器"（V1 只做 CLI，桌面端 App 放 V2）（§2.4）。⑩**P1-3** 设备配对改在桌面端设置页完成，个人中心可吊销设备（§2.3）。⑪**P1-4** 轮询的座位校验改为服务端缓存绑定、即时失效；M2 加真实压测（§3.4、§3.10）。⑫风险、计划（M0～M8）、测试、待定问题同步更新，已决定的问题关闭。 |
| r3.1 | 2026-10-19 | 关闭 Q-A～Q-D：账号会话 15 天、访客凭证 1 天；MCP `room_create` 默认关闭，房间只能由人在网页创建；只读代理按房间校验会话/访客凭证（V1 做）；桌面端设置页复用 WebView 登录。 |

---

## 0. 已确认的决定（摘要）

| # | 决定 |
|---|---|
| D1 | 做**薄壳桌面端**：窗口内嵌远端 Agent Room 网页；本地只做 MCP 一键配置、启动/恢复本机 CLI Agent、@唤醒、状态回报、设备配对。房间、记忆、任务、审批、唤醒判断全部留在服务器。 |
| D2 | **设备凭据由服务器签发**，本地只保存、使用，不在本地生成。配对在桌面端设置页完成（§2.3）。 |
| D3 | 先做 **Linux**，Linux 跑通后再做 Windows。 |
| D4 | 本地后台程序（daemon）用 **Node + TypeScript** 实现并配测试；Tauri 只允许当外壳。 |
| D5 | 首版只做**后台启动/恢复（headless）**，不往开着的终端/TUI 里注入输入。V1 保证**所有支持的 CLI** 都能首次启动和恢复（Codex CLI、Claude Code、Cursor CLI、Gemini CLI 等，按适配器逐个接入）；Codex / Cursor / Claude / Antigravity 等**桌面端 App 的调起放到 V2**（§2.4）。 |
| D6 | 唤醒走 **B+ 方案**：一台设备只开一个轮询循环，不管上面睡着几个 Agent。服务器**持久化每一个唤醒事件**，只在服务器确认成功后清除。 |
| D7 | 线上跑在 **VPS 自建 Redis**，不用按命令计费的服务。上线前做一次真实压测（M2）。 |
| D8 | 删除风险审核放在**任务下发**时（不是每条命令）：每个下发的任务都交给 **Jev**（不用 BGE）判三档——低风险放行、中风险进任务审核员审核、高风险直接拒绝。**删除目标必须按"目录 + 名字 + 文件/文件夹"写全**，否则退回补充。聊天里直接 @ 让 Agent 删东西，也必须先建任务。与本地 daemon 无关（§6）。 |
| D9 | `agent-room-mcp`（https://github.com/704986409/agent-room-mcp）是用户自己的仓库，可以改。 |
| D10 | **事前审批在服务端由 Agent 之间完成**，本地 daemon 不参与。 |
| D11 | **新增账号体系（V1 最小）**：用户名 + 密码，不开放注册页、不做邮箱验证（表里预留邮箱字段，V2 再做）；管理员页面管理用户；首个管理员在 VPS 上用命令创建（§4.1）。 |
| D12 | **网页访问方式 B**：登录用户建房、管房；访客凭房主的邀请链接拿房间级凭证进房；去掉网页"房间码直接进"。Agent 仍用房间码 + `room_join` / seatKey 进房，不变（§4.2）。 |
| D13 | **网页所有写操作迁到服务器可信接口**，读轮询留在浏览器，网页 Redis 代理凭据只读（§4.3）。 |
| D14 | 唤醒成功 = 经 seatKey 验证的读取投递了触发 @（§3.6）。醒来后 Agent 处理完，进入真正的 `room_listen` 监听一轮，没有新的 @ 就交接游标并入睡（§2.5、§3.5）。 |
| D15 | 唤醒读取起点 = min(Agent 入睡前交接的游标, 最早未处理 @ 之前的游标)；不再有"用当前总数当起点"的兜底（§3.5）。房间消息上限改为 **1000** 条，`room_join` 游标改用绝对计数。 |
| D16 | 实现阶段由 AI CLI 按功能拆分支并行开发：Cursor CLI 用 Grok 4.7（普通档），或 Codex CLI 用 `gpt-6-luna` max fast；只用第一方模型；每次启动前仍按用户规则确认（§7.1）。 |

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
  3. 超时返回的"攒起来的消息"（`_mcpListen.ts:524-531`）一律不带 `addressedYou`。
  4. `room_listen` 只凭 `name` 参数认人（`_mcpTools.ts:356`），不校验 seatKey；租约也是按名字写的（`_mcpListen.ts:417-419`）。
  5. `timeoutMs: 0` 走的是即时历史读取分支（`_mcpTools.ts:358-393`），**不进入 `runListen()` 长轮询，也不建立监听租约**。所以它不能被当成"Agent 已在监听"（评审 P0-5）。
- **对设计的含义**：daemon 不复用 `room_listen`；服务器直接调用 `messageAddressesAgent` + `wakeFactsForAgent`（`_agentWake.ts:30-41`）对每个托管座位逐条判断并生成唤醒事件，规则与 listen 完全一致。由于 `room_listen` 只按名字认人，需要新增带 seatKey 的托管模式（§3.6）。

### 1.2 其他相关事实

| 事实 | 位置 |
|---|---|
| 每次 `room_join`（包括带 seatKey 的 resume）都会**重新生成 seatKey**，旧 key 失效 | `api/_mcpRoomClient.ts:462, 481`；工具说明 `api/_mcpToolDefs.ts:70` |
| 座位上只存 `seatKeyHash`（sha256），校验用 `seatKeyMatches`（定长比较）；`seatKeyHash` 存在 Room 对象里，所以校验座位要读 Room | `api/_mcpRoomClient.ts:567-575`；`packages/shared/src/types.ts:32` |
| `listMessages(fromIndex)` 的游标是**绝对计数**，按 `count − LLEN` 换算成列表下标；游标落后到已裁剪区间时从列表头开始返回 | `packages/upstash-client/src/messages.ts:442-491` |
| **游标 bug**：`room_create` / `room_join` 返回 `cursor: msgs.length`（`listMessages(…, 0)` 返回的条数），房间被裁剪后这个值小于绝对计数；`timeoutMs: 0` 分支用 `since + listed.messages.length`，`since` 落在裁剪区间时同样算错 | `api/_mcpTools.ts:238-239, 332-333, 370` |
| 每房最多保留 500 条（LTRIM），超出的老消息永久丢失。**r3 决定改为 1000** | `MAX_MESSAGES_PER_ROOM = 500`（`packages/shared/src/constants.ts:18`），使用处 `messages.ts:360, 435` |
| 房间计数 key `room-msg-count:{code}`，可以用一条 `GET` 判断"有没有新消息" | `packages/upstash-client/src/messages.ts:37` |
| 房间所有 key 固定 7 天过期 | `ROOM_TTL_SECONDS`（`packages/shared/src/constants.ts:8`） |
| VPS 路由表：`/api/<name>` → `API_HANDLERS[name]` | `deploy/vps/server.ts:65-77, 644-649` |
| 网页经 `/redis` 代理直写 Redis，代理只校验命令名白名单（含 `SET/SADD/EVAL` 等写命令），不限制 key 前缀；任务等写操作在浏览器里直接拼 Redis 命令 | `deploy/vps/server.ts:79-86, 250-330`；例如 `TaskBoard.tsx:139-140`（评审 P0-4） |
| 任务状态：`todo / in_progress / awaiting_review / blocked / done / rejected / cancelled`，创建时固定为 `todo` | `packages/shared/src/types.ts:384-391`；`packages/upstash-client/src/tasks.ts:328-389` |
| **webhook 座位伪造**：注册只检查名字在花名册里，不要 seatKey | `packages/upstash-client/src/webhooks.ts:83-91`；调用方 `api/_mcpRoomClient.ts:190-207`、`api/_mcpTools.ts:543-551` |
| **webhook 列表泄露 secret**：`webhookList` 原样返回存储对象（含 HMAC `secret`） | `api/_mcpRoomClient.ts:208-209` → `api/_mcpTools.ts:565-567`；字段定义 `webhooks.ts:32-34` |
| webhook 删除不校验请求者 | `api/_mcpRoomClient.ts:210-218`；`webhooks.ts:115-126` |
| **没有用户账号体系**：网页靠房间码 + 名字进房，Agent 靠 seatKey；房主操作靠 `hostKey`（`hostKeyHash`） | `packages/shared/src/types.ts:44, 232`；代码中无登录/注册 |
| 原型已验证 `codex exec resume <threadId>` 能让同一座位回复（~13s，不需重新进房）；其他 CLI 未验证 | `docs/agent-room-thin-shell-wake.md` "What we already proved" |
| `agent-room-mcp` 的 `init.ts` 已有客户端检测、Codex 配置和 Hooks 安装；装的 Stop Hook 会让 Agent 停下后自动续接监听 | 评审 P1-1 报告，**本仓库外，M0 核对** |
| 现有 daemon 骨架 | `tools/wake-agent/`（README + `src/index.ts` 空壳） |
| `Message.id` 是创建时的毫秒时间戳，不保证唯一 | `packages/shared/src/types.ts:317` |
| 座位没有稳定 id，只能按 `name + client` 认；`roomInstanceId` 在建房/首次 join 时生成 | `packages/shared/src/types.ts:14-45`；`packages/upstash-client/src/rooms.ts:73, 326` |

---

## 2. 产品形态

**Agent Room Desktop** = 一个窗口 + 一个后台程序。

```
┌──────────────── Agent Room Desktop（本机）────────────────────┐
│  外壳（Tauri，仅窗口/托盘/本地设置页）                          │
│   ├ WebView：加载远端 https://www.agent-room.com（账号登录后使用）│
│   └ 本地设置页：设备配对、MCP 一键配置、托管座位列表、日志        │
│                                                                │
│  daemon（Node/TS，独立进程，可无窗口运行）                     │
│   ├ 凭据：服务器签发的设备凭据 + 各座位 seatKey → 系统钥匙串    │
│   ├ MCP 一键配置：npx agent-room-mcp init <target>             │
│   ├ 启动器适配器：codex / claude / cursor-agent / gemini …      │
│   ├ 会话表：seat ↔ 适配器 ↔ sessionId ↔ PID ↔ 工作目录（状态文件）│
│   ├ 唤醒：一个循环 → /api/wake poll/claim/renew/progress        │
│   └ 进度上报：progress（成功只由服务器回执判定，§3.6）          │
└────────────────────────────────────────────────────────────────┘
                 │ HTTPS（只有出站，本机不开端口给公网）
┌────────────────▼───────── 服务器（VPS + 自建 Redis）───────────┐
│ 房间 / 消息 / 记忆 / 任务 / Jev 审核 —— 业务规则不变             │
│ 新增：账号 + 会话凭证 + 管理员页 + 邀请/访客凭证                 │
│       网页写操作接口（Redis 代理对网页只读）                      │
│       唤醒事件队列 + /api/wake + 托管读取回执 + 游标交接          │
│       设备配对 / 设备凭据 / 吊销；任务下发删除风险审核            │
└────────────────────────────────────────────────────────────────┘
```

### 2.1 本地只做的事

1. **MCP 一键配置**：调用 `npx agent-room-mcp init <target>`（target = codex / claude 等），不自己写各家配置文件格式。需要的改动直接改 `agent-room-mcp`（§2.5）。
2. **启动/恢复 CLI**：首次启动 + 后台恢复，按适配器支持各家 CLI（§2.4）；不注入 TUI。
3. **唤醒**：轮询服务器，命中后恢复对应会话（§3）。
4. **设备配对**：在本地设置页发起，领取服务器签发的设备凭据（§2.3）。
5. **进度上报**：本地日志 + 托盘显示；向服务器上报进度（`progress`），但**成功与否只由服务器根据托管读取回执判定**（§3.6）。

### 2.2 本地不做的事

- 不实现任何房间/记忆/任务/审批业务逻辑；事前审批在服务端由 Agent 之间完成（D10）。
- 不生成设备凭据（D2）。
- 不在本地判断"这条消息该不该唤醒"（用服务器规则，§1.1）。
- 不拦截 Agent 的 shell 命令（删除管控在服务端任务下发处，§6）。
- 远端网页（WebView）**不能调用任何本机命令**；本地能力只在本地设置页和 daemon 里。

### 2.3 设备配对与设备凭据

**设备配对 = 让服务器认识"这台电脑"**：服务器在有人 @ 时要通知这台电脑上的 daemon 去叫醒 Agent，必须先确认这台电脑属于某个账号，且可信，防止别人冒充去领唤醒事件。

流程（在**桌面端本地设置页**完成，远端网页不参与，不需要改网页）：

1. 用户在本地设置页点"绑定本机"。设置页要求先登录（复用 WebView 里的账号会话，或在设置页单独登录，M6 定实现）。
2. 桌面端用已登录的账号会话调 `POST /api/device/pair-start`，服务器返回**一次性配对码**：随机 32 字节，只能用一次，**5 分钟过期**，服务器只存哈希，并绑定 `userId`。
3. daemon 调 `POST /api/device/pair-complete {pairingCode, deviceName, platform}`，服务器校验后签发**长期设备凭据**（随机 32 字节，服务器只存哈希，记 `deviceId, userId, name, platform, createdAt, lastSeenAt`），同时作废配对码。daemon 把凭据存进系统钥匙串（Linux：libsecret）。**凭据只由服务器生成，本地只保存和使用。**
4. 之后 daemon 调 `/api/wake` 时都带 `Authorization: Bearer <deviceCredential>`，服务器认凭据，不认名字。
5. 座位托管：把这台设备上的 Agent 和房间座位绑起来，仍然靠现有 seatKey（`register`，§3.4）证明座位归属。

**吊销**：个人中心新增"我的设备"列表（与"登录记录"并列，§4.1），显示设备名、平台、最近在线时间；点吊销 → 设备凭据立即失效，该设备的座位绑定全部解除、未完成事件回 `PENDING`（可被重新绑定的设备领取）。管理员也可以吊销任意用户的设备。原理与吊销某次登录相同，只是对象是"某台电脑"。

- 设备凭据用途：标识设备、限流、把一台设备的多个座位绑在一起。poll 只返回事件元数据和截断预览，不返回完整房间内容。
- 一个设备凭据只属于一个账号；账号被停用 → 名下所有设备凭据一并失效。

### 2.4 本地启动：首次启动 + 恢复（启动器适配器）

r2 只写了"怎么恢复"，r3 补上"第一次怎么启动"和"daemon 重启后怎么接管"。

**适配器结构**：每个工具一个启动器适配器，接口统一：

```ts
interface LauncherAdapter {
  id: 'codex' | 'claude' | 'cursor-agent' | 'gemini' | string;
  detect(): Promise<{ installed: boolean; version?: string; path?: string }>;
  launch(opts: { cwd: string; prompt: string; env: Record<string, string> }):
    Promise<{ pid: number; sessionId: string }>;        // 首次启动，从输出里解析会话 id
  resume(opts: { sessionId: string; cwd: string; prompt: string; env: Record<string, string> }):
    Promise<{ pid: number }>;                             // 无头恢复
  parseSessionId(stdoutChunk: string): string | undefined;
}
```

- **V1 只做 CLI**，目标是所有支持的 CLI 都能首次启动和恢复：Codex CLI（`codex exec` / `codex exec resume <threadId>`，原型已验证恢复）、Claude Code（`claude -p` / `claude -p --resume <sessionId>`）、Cursor CLI、Gemini CLI 等。每个适配器的具体参数和"怎么拿到会话 id"在 M0 逐个实测，写进附录；某个 CLI 不支持无头恢复 → 该适配器注册托管时直接拒绝并说明原因。
- **V2 再做桌面端 App 调起**（Codex / Cursor / Claude / Antigravity 桌面端等）：图形界面 App 能否被外部程序打开指定会话、塞进消息，取决于各家是否提供链接跳转或插件接口，需要逐个调研。适配器接口预留，V1 不实现。

**首次启动流程**（用户在本地设置页为某个房间座位"新建托管 Agent"，或把已有座位交给 daemon）：

1. 用户选择工具（适配器）、工作目录、房间。
2. daemon 调 `adapter.launch()` 以无头模式启动，提示词让 Agent 调 `room_join` 进房（`agent-room-mcp` 负责拿到并保存 seatKey）。
3. daemon 从 CLI 输出解析出**会话 id**（Codex 的 threadId / Claude 的 sessionId 等），同时记下 **PID** 和**工作目录**。
4. Agent 进房后，`agent-room-mcp` 把 `{code, name, seatKey, cursor, sessionId}` 写进本地交接文件；daemon 读到后用 seatKey 调 `register`（§3.4），把**这个会话**绑定到这个座位。
5. 绑定信息写入本地**状态文件**（`~/.local/state/agent-room/daemon.json`，权限 0600；seatKey 和设备凭据不写进这个文件，只放钥匙串）：`seatId ↔ adapter ↔ sessionId ↔ cwd ↔ pid ↔ 状态`。

**daemon 重启后**：读状态文件 → 对每个记录检查 PID 是否还活着且确实是该适配器的进程（核对 `/proc/<pid>/cmdline`，防止 PID 复用）→ 活着就继续管理（等它退出、续租）；不在了就标记为 `idle`，等下一次被 @ 时用 `resume` 恢复。未确认的唤醒事件由服务器 lease 到期回退，不需要 daemon 记住。

### 2.5 MCP 一键配置与 Hook 协调（M5）

`agent-room-mcp` 仓库的 `init.ts` 已经有客户端检测、Codex 配置和 Hooks 安装，桌面端直接调用 `npx agent-room-mcp init <target>`，在本地设置页做成界面：

1. **检测本机 Agent**：调用各适配器 `detect()` 和 `agent-room-mcp` 的检测逻辑，列出已安装的 CLI 和版本。
2. **查看配置状态**：每个工具是否已配置 Agent Room MCP、是否装了 Hooks、版本是否最新。
3. **一键安装**：执行 `init <target>`。
4. **先备份再改**：修改任何配置文件之前先备份（带时间戳），界面上能看到备份位置。
5. **失败回滚**：安装中途失败 → 自动用备份恢复原配置，并显示失败原因。
6. **连接验证**：安装完成后做一次实际连接（MCP 工具列表能拿到、能对测试房间做只读调用），通过才显示"已配置"。
7. **Hooks 授权提示**：装 Hooks 前单独弹确认，说明这个 Hook 会做什么，用户同意才装。

**Stop Hook 改法（与 daemon 托管模式协调）**：现有 Stop Hook 会让 Agent 一停下就自动续接监听，这和"干完活就退出入睡"冲突。改成：

- Agent 停下时，Hook 让它**再监听一轮**（一次真正的 `room_listen`，`timeoutMs > 0`，托管模式带 seatKey）。
- 这一轮里**有 @ 自己的消息** → 继续处理（处理完再回到这一步）。
- **没有 @** → 调用游标交接（`room_sleep`，§3.5）把"读到第几条"交给服务器和本地交接文件，然后允许进程结束，进入睡眠，由 daemon 负责之后的唤醒。
- 用户自己手动开着的会话也用同一规则；用户想让它一直在线时，可以在配置里关掉"空闲入睡"，此时 Hook 保持原来的持续监听行为（不再写交接、不交给 daemon）。

---

## 3. 唤醒方案 B+（持久化唤醒队列）

> **硬规则**：每一个有效的 @ 都生成**自己的**唤醒事件；事件只在**服务器确认成功**后才清除；失败的事件保留，不会因为本地没收到、进程崩了、设备断网而消失。
> 传输仍是 B+：**一台设备只有一个轮询循环**，与睡眠座位数无关。"该叫谁"不是一次性查询结果，而是落在服务器上的事件。

### 3.1 名词与标识

| 名词 | 定义 |
|---|---|
| `roomInstanceId` | 房间实例 id（`Room.roomInstanceId`，`rooms.ts:73, 326` 生成）。同一房间码重开会换实例，旧事件不会串到新房间。 |
| `seatId` | **新增**：服务器签发的稳定座位 id，首次建座位时生成，写在 `Participant` 上；seatKey 每次 join 都会轮换（`_mcpRoomClient.ts:462`），但 `seatId` 不变。老座位第一次托管注册时补发。 |
| `sourceMessageIndex` | 触发消息的**绝对序号**（第几条，从 0 开始），与 `room-msg-count` 同一套计数（`messages.ts:442-447`）。`Message.id` 是毫秒时间戳（`types.ts:317`），可能重复，不能当唯一键，只作为校验字段一起存。 |
| `sourceCursorBefore` | 该消息之前的游标，等于 `sourceMessageIndex`。用 `since = sourceCursorBefore` 读取，第一条返回的就是这条消息。 |
| `handoffCursor` | **新增（r3）**：Agent 入睡前通过 MCP 交接的"我读到第几条"（绝对计数），存服务器 `seat-handoff:{roomInstanceId}:{seatId}`，本地交接文件也存一份。 |
| `oldestRetained` | 房间现存最早一条消息的绝对序号 = `room-msg-count − LLEN(room-msgs)`。 |
| `eventId` | `wk:{roomInstanceId}:{sourceMessageIndex}:{seatId}`，按 **(roomInstanceId, sourceMessageId, targetSeatId)** 唯一。同一条消息对同一座位最多一个事件，重复生成是幂等的。 |
| `wakeRunId` | 本地一次恢复运行的 id。一次运行可以合并同一座位的多个事件，但**每个事件单独确认**。 |
| `listenEpoch` | 服务器给某座位每一次**经认证的托管长轮询 `room_listen`**（`timeoutMs > 0`）发的递增编号，用于监听状态展示和日志；**不是**唤醒成功的必要条件（§3.6）。 |

### 3.2 事件从哪来（检测）

**r3 起两条路径并存，事件主键相同，`SET NX` 保证不重复：**

1. **发送时生成（主路径）**。§4.3 之后，网页聊天发送、系统消息、MCP `room_send`、REST 发送**全部走服务器代码**。消息写入后，服务器读 `wake-managed:{roomInstanceId}`（该房间托管座位集合），对每个座位用 `messageAddressesAgent(m, name, wakeFactsForAgent(room, name))`（`_agentWake.ts:30-54`，与 `room_listen` 同一套规则）判断，命中即 `SET wake-evt:{eventId} <json> NX` + `SADD wake-seat:{roomInstanceId}:{seatId} <eventId>`。所以 @ 一发出，服务器就记下"要叫醒谁"，与 Agent 是醒是睡、daemon 是否在线都无关——**Agent 正要入睡那一瞬间来的 @ 也不会漏**（评审 P0-6 的例子：消息 101 在发送时就生成了事件）。
2. **服务器扫描（兜底）**。用于：注册前就已存在的消息、发送时生成失败（进程崩溃在写消息与写事件之间）、迁移完成前仍有直写路径的过渡期。
   - 座位进入托管（§3.4 `register`）时，服务器建**服务端扫描游标** `wake-scan:{roomInstanceId}:{seatId}`，初值 = 该座位的 `handoffCursor`（注册请求里带上，或服务器已存的交接值，取较小者）。**r3 删除"拿不到就用当前计数"的兜底**：既没有交接游标、请求里也没带游标 → 注册拒绝（`cursor_required`），不会从当前总数起步。
   - 每次 `poll`（以及 §3.2.1 的巡检）对每个托管座位：
     1. `GET room-msg-count:{code}`；计数 ≤ 扫描游标 → 没有新消息，结束。
     2. 读 `[扫描游标, 计数)` 的消息，逐条用同一规则判断。
     3. 每个命中 → `SET wake-evt:{eventId} <json> NX` + `SADD`。
     4. **事件全部写成功之后**，才用 CAS（服务端 EVAL，只许前进）把扫描游标推进到计数。中途崩溃 → 下次从旧游标重扫 → `NX` 保证不重复。

**为什么在保留期内不会丢事件**

1. 所有发送路径都写同一个列表 `room-msgs:{code}`，计数器在同一个 pipeline 里加一（`messages.ts:26-37, 343-360`）；发送时生成覆盖实时路径，扫描读持久化列表覆盖其余情况。
2. 扫描游标和交接游标都存在**服务器**上；扫描游标只能前进，并且只在事件落库之后前进。daemon 断线、崩溃、重装都不影响。
3. 游标是绝对序号，裁剪后仍能定位（`messages.ts:466-480`）。

**保留期之外：必须可见，不能静默。**

- **房间消息上限改为 1000 条**（`MAX_MESSAGES_PER_ROOM` 500 → 1000，§3.11）。
- **扫描时发现缺口**：`扫描游标 < oldestRetained`，说明有消息没扫就被裁掉了。服务器生成 **gap 事件**（`eventId = wk:{roomInstanceId}:gap:{扫描游标}-{oldestRetained}:{seatId}`），状态直接是 `FAILED`，原因 `messages_trimmed`。裁剪后剩下的消息照常扫描。
- **事件已生成但触发消息被裁掉**（Agent 睡了很久、期间消息超过 1000 条）：醒来时从 `oldestRetained` 开始读，并在唤醒提示里明确告诉 Agent"`[a, b)` 这段消息已丢失"（§3.5）；源消息已不在的事件无法被投递 → `FAILED (messages_trimmed)`，房主可见。
- **房间 7 天过期**（`ROOM_TTL_SECONDS`）：事件键的过期时间 = 房间过期时间 + 1 天。下一次 poll 发现房间已不存在、而该座位还有未完成事件时，标 `FAILED (room_expired)` 回给 daemon，只能本地可见。
- **兼容旧房间**：没有计数键的旧房间（`messages.ts:463-466` 的回退分支），序号不可靠，**不支持托管唤醒**；注册时直接拒绝并说明原因。

**3.2.1 服务器巡检（M2 一起做）**：VPS 进程常驻，每 2–5 分钟对所有托管座位做一遍扫描。仓库目前没有 cron（`_mcpListen.ts:458-459` 注释），用进程内定时器。

**清除事件不会删除聊天消息。** 事件存在独立的 `wake-evt:*` 键里，与 `room-msgs:*` 无关；`SUCCEEDED` 的事件保留 24 小时供排查，然后过期。

### 3.3 事件状态机

```
             claim(CAS)               progress(resume_started)
 PENDING ───────────────▶ CLAIMED ───────────────────────▶ WAITING_ACK
    ▲  ▲                   │  lease/claimId                    │
    │  │ lease 过期 /      │                                   │ 经 seatKey 验证的读取投递了触发消息（§3.6）
    │  └─ 失败上报 ────────┘◀──────────── lease 过期 / 失败 ───┤
    │     （attempts < MAX）                                    ▼
    │                                                       SUCCEEDED
    │
    ├──▶ FAILED     attempts 达到上限 / messages_trimmed / room_expired / 启动器不可用
    ├──▶ EXPIRED    超过最大等待（默认 24h）仍未成功
    └──▶ CANCELLED  座位被移除、房间结束、托管注销、设备吊销后无人接管、房主取消
```

r3 把 r2 的 `WAITING_LISTEN` 改名为 `WAITING_ACK`：等的是"经验证的读取回执"，不是"进入监听"。

| 状态 | 含义 | 谁能改 |
|---|---|---|
| `PENDING` | 待处理，可被认领 | 服务器创建；lease 过期或失败时回退到这里 |
| `CLAIMED` | 某设备已认领，持有 `claimId` + `leaseUntil`（默认 60s） | 只有绑定该座位的设备，通过 CAS 认领 |
| `WAITING_ACK` | 本地已启动恢复，等 Agent 的托管读取；lease 延长到默认 180s，仍需 renew | daemon 通过 `progress` 上报（**这不是成功**） |
| `SUCCEEDED` | 服务器确认该座位经认证的读取投递了触发消息（§3.6） | **只有服务器**，daemon 无法写 |
| `FAILED` | 重试用尽或不可恢复；保留，不自动删 | 服务器 |
| `EXPIRED` | 超时未完成 | 服务器 |
| `CANCELLED` | 不再需要 | 服务器 / 房主 |

- **有限重试**：每次从 `CLAIMED / WAITING_ACK` 回退到 `PENDING`，`attempts + 1`；`MAX_ATTEMPTS = 2`（首次 + 重试一次），用尽 → `FAILED`。
- 所有状态迁移都由**服务端代码**用 EVAL 脚本做 CAS：校验当前状态、`claimId`、`leaseUntil`，不对就拒绝。

### 3.4 daemon ↔ 服务器接口（`POST /api/wake`，注册到 `deploy/vps/server.ts` `API_HANDLERS.wake`）

所有请求带 `Authorization: Bearer <deviceCredential>`（服务器签发，§2.3）。

| action | 作用 | 要点 |
|---|---|---|
| `register` | 把座位绑定到本设备，开始托管 | 请求带 `{code, name, seatKey, cursor}`（`cursor` = 本地交接文件里的绝对游标），服务器用 `seatKeyMatches`（`_mcpRoomClient.ts:567-575`）证明座位归属，写**绑定缓存**（见下），返回 `{roomInstanceId, seatId, scanFrom}`。没有可用游标 → 拒绝（`cursor_required`）。一个座位同时只绑一台设备，重新绑定会把旧设备上未完成的认领作废回 `PENDING`。 |
| `unregister` | 解除托管 | 该座位未完成事件 → `CANCELLED`。 |
| `poll` | 返回本设备各座位的 `PENDING` 事件 + 兜底扫描 | 同时返回本设备持有的 `CLAIMED / WAITING_ACK` 事件的最新状态，以及 `nextPollMs`。绑定失效的座位返回 `rebind_required` 或 `revoked`。 |
| `claim` | CAS 认领 | `{eventIds, wakeRunId?}`。不带 `wakeRunId` → 新建 run；带 → 合并进已有 run（同一座位、run 未结束）。返回每个事件的 `claimId`、`leaseUntil`，以及本 run 的 **`readFrom` 和 `gap`**（§3.5）；被别人抢先的返回 `conflict`。 |
| `renew` | 续 lease | `{claimId}[]`，过期的不能续。 |
| `progress` | 上报本地进度 | `resume_started` → `WAITING_ACK`；`resume_failed`（带退出码）→ 回 `PENDING` / `FAILED`。**progress 不能把事件标成成功。** |

**轮询时的座位校验（评审 P1-4）**：seatKeyHash 存在 Room 对象里，每次 poll 都读 Room 来校验座位做不到"一条 Redis 命令"。改为：

- `register` 校验通过后，服务器写**绑定缓存** `wake-bind:{seatId} = {deviceId, roomInstanceId, code, name, seatKeyHash}`，并 `SADD wake-device:{deviceId} <seatId>`、`SADD wake-managed:{roomInstanceId} <seatId>`。
- poll 只读绑定缓存（一个 pipeline：`SMEMBERS wake-device` + `MGET wake-bind:*` + `MGET room-msg-count:*`），不读 Room。
- **即时失效**：以下服务端代码路径在同一次写操作里删除或标记绑定（§4.3 之后这些写操作都在服务器上，可以保证）：
  - 座位被移除 / 被踢 / 房间结束 → 删除绑定，事件 `CANCELLED`。
  - seatKey 轮换（任何 `room_join`）→ 绑定标 `rebind_required`；poll 返回后 daemon 用本地交接文件里的新 seatKey 重新 `register`。期间事件保持 `PENDING`，不丢。
  - 设备吊销 / 账号停用 → 删除该设备全部绑定，事件回 `PENDING`。
- 测试目标相应改为"无新消息时，每设备每次 poll 一个 pipeline、命令数与座位数成线性且不读 Room"（§8）。

poll 响应示例：

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

`preview` 只是截断文本，用于托盘显示；Agent 醒来后自己通过托管读取拿完整内容。

### 3.5 本地流程（daemon）与读取起点

1. **座位一直被跟踪**：注册后座位一直在 daemon 的跟踪表里，醒着、睡着都在；**不会因为命中就把座位移出跟踪表**。本地状态：`idle`（没有运行中的会话）/ `running(wakeRunId)`。
2. **poll**：单循环，一次请求覆盖本机所有托管座位。
3. **认领与启动**：座位 `idle` 且有 `PENDING` → `claim`（新建 run）→ 加本地运行锁 → `progress resume_started` → 调对应适配器的 `resume()`（§2.4），例如 `codex exec resume <threadId> "<唤醒提示>"`。
4. **启动过程中又来了新的 @**：这些 @ 在下一次 poll 中成为各自的 `PENDING` 事件。座位处于 `running(R)` → `claim {eventIds, wakeRunId: R}` 合并进同一次运行，**不再启动第二个进程**。每个事件仍单独确认。
5. **读取起点（r3，评审 P0-6）**：服务器在 `claim` 时计算并返回：

   ```
   readFrom = min( handoffCursor,                         // Agent 入睡前交接的游标（没有则不参与）
                   min(event.sourceCursorBefore for event in run) )   // 最早未处理 @ 的前一条
   若 readFrom < oldestRetained：gap = [readFrom, oldestRetained)，readFrom = oldestRetained
   ```

   - 一般情况下两者相同：正好从 Agent 没读过的第一条开始，不多读也不漏。
   - 交接失败（没有 `handoffCursor`）：退到最早那条 @ 的前一条开始读。宁可多读，不漏。
   - **不使用 poll 时的最新计数，也不存在"用当前总数当起点"的兜底。**
   - Agent 睡太久、中间超过 1000 条被裁剪：从 `oldestRetained` 开始读，唤醒提示带上缺口说明。
   - 示例：run 包含 184 和 186，交接游标 183 → `readFrom = 183`。

6. **唤醒提示**（不放消息正文，避免本地拼接带来注入；`seatKey` 不写进提示，由 `agent-room-mcp` 从本地钥匙串取出后自动填入 `managed`）：

   ```
   你在房间 ABC-123-XYZ 被 @ 了。
   1) 先调用 room_listen({ code: "ABC-123-XYZ", name: "codex-a", since: 183, timeoutMs: 0 })
      读取未处理的消息，并处理其中给你的工作、在房间里回复。
   2) 处理完后调用 room_listen({ code: "ABC-123-XYZ", name: "codex-a", since: <上一步返回的 cursor> })
      正常监听一轮；有新的 @ 就继续处理。
   3) 一轮内没有新的 @：调用 room_sleep({ code: "ABC-123-XYZ", name: "codex-a", cursor: <最新 cursor> }) 后结束。
   [如有缺口] 注意：第 120–182 条消息已被房间清除，无法读取。
   ```

   `managed: { seatKey, wakeRunId, eventIds }` 由 `agent-room-mcp` 从 daemon 的交接文件读取后自动附加到第 1、2 步的调用上，Agent 不需要手写。

7. **游标交接 `room_sleep`（新增 MCP 工具，M3 服务端 / M5 客户端）**：`room_sleep({code, name, cursor})`，`agent-room-mcp` 自动附上 seatKey。服务器校验 seatKey、`cursor ≤ room-msg-count`，写 `seat-handoff:{roomInstanceId}:{seatId} = {cursor, at}`；`agent-room-mcp` 同时写本地交接文件。Stop Hook（§2.5）在"一轮无 @"时自动调用它，所以即使 Agent 忘了，交接也会发生。**游标交接必须在唤醒端到端联调之前完成并通过测试**（M3 + M5 先于 M4 端到端）。
8. **续租**：run 运行期间 daemon 定期 `renew` 本 run 的所有事件。
9. **结束**：进程退出后，daemon 在下一次 poll 看服务器给的状态：
   - 已 `SUCCEEDED` 的事件不用管。
   - 仍未确认的事件：不续租 → lease 到期回 `PENDING`（attempts+1）→ 重试一次 → 再失败 `FAILED`。daemon **不自行判定成功**。
   - 恢复进程非零退出 → `progress resume_failed`。
10. **同一会话不能并发恢复**：用户自己开着的会话（不是 daemon 启动的），由 `agent-room-mcp` 写本地心跳文件（pid + sessionId）；daemon 看到 pid 还活着就不启动恢复，事件保持 `PENDING`，等那个会话下一次托管读取时被确认。

如果合并进来的事件比 `readFrom` 更早（理论上不会，gap 后补扫可能出现），daemon 不改正在运行的提示，这些事件保持未确认 → lease 到期回 `PENDING` → 下一次 run 处理。

### 3.6 成功判定：经 seatKey 验证的读取投递了触发 @

**算成功（r3，评审 P0-5，用户已确认）**：目标 Agent 带 `managed`（含 seatKey）调用 `room_listen`——**无论是 `timeoutMs: 0` 的快速读取，还是 `timeoutMs > 0` 的长轮询**——服务器校验 seatKey 通过，且这次调用返回的那一批**包含触发消息**，事件即 `SUCCEEDED`。不需要等 Agent 进入长轮询监听。

**不算成功**：新的 listen 租约、`lastSeenAt` 更新、该座位发了任意一条消息、单独一次 `room_join`、daemon 自报"进程已启动/已退出"、不带 `managed` 的按名读取。

**r3 删掉的东西**：r2 把"`timeoutMs: 0` 调一次"写成"建立托管监听"，这是错的——`timeoutMs: 0` 是即时历史读取（`_mcpTools.ts:358-393`），不进入 `runListen()`，不建立租约。r3 里它只是"经验证的读取"，用来确认投递；之后 Agent 必须再进入真正的 `room_listen`（`timeoutMs > 0`）监听一轮（§3.5 第 6 步）。

- **托管模式参数**（`room_listen` 新增，可选，老客户端不受影响）：

  ```json
  "managed": { "seatKey": "…", "wakeRunId": "wr_…", "eventIds": ["wk:ri_91:184:st_7f3a", "…"] }
  ```

  `timeoutMs: 0` 分支和长轮询分支**都要**支持 `managed`。

- **服务器处理**：
  1. 用 `seatKeyMatches` 校验 seatKey，解析出 `roomInstanceId + seatId`；不通过 → 按普通（非托管）读取处理，**不能确认任何事件**。
  2. 本次返回一批消息时，对该座位所有 `PENDING / CLAIMED / WAITING_ACK` 事件检查：`since ≤ sourceMessageIndex < 返回后的 cursor`，且该序号的消息 `Message.id` 与事件里存的一致 → 写回执 `{receiptKind: 'managed_read' | 'managed_listen', wakeRunId, ackedAt, listenEpoch?}`，状态 → `SUCCEEDED`。
  3. 长轮询（`timeoutMs > 0`）另外为座位记一个新的 `listenEpoch`（`seat-listen:{roomInstanceId}:{seatId}`，服务端 EVAL 自增），用于"在线/sleeping"展示（§3.7）。
  4. `eventIds` 用来把回执归到对应 run、写日志；**判定以"批次覆盖了触发消息"为准**。同座位不在本 run 里的事件，被这一批覆盖也一并确认。
  5. 迟到的回执：事件已被新的认领接管（`claimId` 变了），旧回执仍然有效（消息确实投递了），但只确认、不改其他 run 的 lease；`FAILED / EXPIRED / CANCELLED` 不再回到 `SUCCEEDED`。
- **为什么绑 `seatId` 而不是名字**：`room_listen` 现在只凭 `name` 认人（`_mcpTools.ts:356`）。同名的另一个会话、没有 seatKey 的老式按名读取、或者知道房间码和名字的人，都**不能**确认事件。
- **`room_join` 本身不确认任何事件**，即使带了 `wakeRunId`。
- `since` 晚于触发消息（Agent 跳过了这条）→ 不确认，事件留着，最终 lease 到期重试。
- 同时修复 `timeoutMs: 0` 分支的游标计算：返回的 `cursor` 改为服务器绝对计数（§3.11），不再用 `since + messages.length`。

### 3.7 状态展示

- **本地**：托盘显示每个座位的 `PENDING / 运行中 / 失败` 计数和最近一次失败原因。
- **网页（V1 最小）**：`FAILED` 事件（包括 `messages_trimmed`）在房间里出一条只给房主看的系统提示，例如"未送达：@codex-a（本地唤醒失败 / 消息已被裁剪）"。这条提示不带 `targetAgentName`，不会触发新的唤醒。完整的"唤醒中"进度条放到后续版本。
- 座位托管中、当前没有经认证的长轮询（无有效 `listenEpoch`）→ 网页显示 `sleeping`（可唤醒），不显示成"在线"（R1）。

### 3.8 自适应轮询间隔

- 有 `PENDING` / 运行中的 run，或最近 1 分钟有新事件：5s。
- 连续空轮询：5s → 10s → 20s → 30s 封顶。
- 服务器可用 `nextPollMs` 覆盖（过载时拉长）。
- 网络错误 / 5xx：指数退避，封顶 60s，带抖动。lease 比轮询间隔长（60s / 180s），`renew` 不受空闲退避影响。

### 3.9 以后怎么升级（本地恢复流程不变）

- **推送**：服务器在生成事件时用 Redis pub/sub 或 WebSocket 通知设备，代替轮询；事件表、状态机、回执不变。
- 发送时生成在 r3 已是主路径（§3.2），扫描保留为巡检兜底。
- 升级不改 §3.5 的本地流程和 §3.6 的成功判定。

### 3.10 负载估算与压测

**以下全部为假设，不是实测**；VPS 自建 Redis 避免了按命令计费，但不代表一定扛得住，必须在 M2 实测。

| 假设 | 值 |
|---|---|
| 注册用户 | 1 万 |
| 高峰在线 | 30% ≈ 3000 台设备 |
| 每台设备托管座位所在房间 | 2 个 |
| 轮询间隔 | 5s（未计入退避） |

- 请求：3000 / 5s ≈ **600 req/s**（估算）。
- Redis：每次 poll 一个 pipeline（读设备座位集合、绑定缓存、各房间计数，约 3–5 条命令），有新消息才读消息和写事件。估 **2000–4000 条命令/s**。发送时生成事件给每条消息多加 1 条 `SMEMBERS` 和命中时的 `SET NX / SADD`。巡检约 33 次扫描/s，可以忽略。
- 网页写操作迁到服务器后（§4.3），写请求约增加 4%（心跳 30s 一次；读轮询 3s/5s，3000 个标签页约 2800 req/s，估算）。

**M2 真实压测（必做）**：
- 模拟高峰设备数（目标 3000 设备 × 2 房间，再测 2 倍）的 poll 循环，加上同时期的网页读轮询和发送。
- 记录：高峰并发连接数、Redis 命令延迟（p50 / p99）、Redis CPU 和内存（房间上限改 1000 后单房内存翻倍）、API 进程 CPU / 事件循环延迟、错误率。
- 故障注入：Redis 变慢 / API 返回 5xx 时，daemon 退避是否生效、`nextPollMs` 是否能把负载压下来、恢复后是否出现同步重连尖峰（抖动是否足够）。
- 结果写进附录，决定默认轮询间隔和是否需要提前做推送。

### 3.11 消息计数与上限修复

- `room_create` / `room_join` 返回的 `cursor` 改为服务器绝对计数 `room-msg-count:{code}`，不再用 `msgs.length`（`_mcpTools.ts:238-239, 332-333`）；`timeoutMs: 0` 分支同样改（`_mcpTools.ts:370`）。建议 `listMessages` 一并返回 `{messages, cursor: totalCount, oldestRetained}`，所有调用方统一用它。
- `MAX_MESSAGES_PER_ROOM` 500 → **1000**（`constants.ts:18`；`messages.ts:360` 的 LTRIM 和 `messages.ts:435` 的脚本参数随常量变化）。需要核对网页端是否有按 500 写死的展示或分页逻辑，以及房间报告/纪要导出是否受影响。
- 测试：房间写到 1200 条后，`room_join` 返回的 `cursor` = 1200；`since = 150`（已被裁剪）读取返回从 200 开始的消息且 `cursor` = 1200。

---

## 4. 账号、网页访问与写操作迁移（r3 新增）

> 设备配对（§2.3）和网页写操作迁移（§4.3）都要靠服务器识别"是谁"，所以账号体系排在开发计划最前面（M1a）。

### 4.1 账号体系（V1 最小）

- **只做用户名 + 密码登录**。**不开放注册页**；不做邮箱验证和"忘记密码"（用户表预留 `email` 字段，V2 再做）。
- **密码存储**：Node 内置 `crypto.scrypt`，每个用户独立随机盐，存 `{algo, salt, hash, params}`；比较用定长比较。不引入原生依赖。
- **登录限速**：按用户名和按 IP 两个维度计数（例如 15 分钟内失败 5 次锁定该用户名 15 分钟，单 IP 每分钟上限），失败提示不区分"用户不存在"和"密码错误"。
- **会话凭证由服务器签发**：登录成功生成随机 32 字节令牌，服务器只存 SHA-256 哈希 `session:{hash} = {userId, createdAt, lastSeenAt, expiresAt, ua, ip}`，`SADD user-sessions:{userId}`。网页用 `HttpOnly; Secure; SameSite=Lax` cookie；桌面端 WebView 用同一个 cookie。账号会话 **15 天**滑动过期（Q-A 已定）。
- **个人中心**：
  - 登录记录：列出该账号所有会话（设备/浏览器、IP、最近活动），可吊销单个或"退出其他所有登录"。
  - 我的设备：列出已配对设备（§2.3），可吊销。
  - 修改密码（修改后吊销其他所有会话）。
- **管理员页面**（`role = admin` 才能访问，所有操作走服务器接口并记审计日志）：
  - 添加用户（用户名 + 初始密码）。
  - 停用 / 启用用户（停用即吊销其全部会话和设备凭据）。
  - 重置密码（同时吊销其全部会话）。
  - 查看并吊销任意用户的会话和设备。
- **首个管理员**：在 VPS 上运行一条命令创建，例如 `node deploy/vps/scripts/create-admin.js --username <名字>`，密码在终端交互输入（不回显、不进 shell 历史、不写进代码和仓库、不打印到日志）。已存在管理员时命令拒绝执行，除非显式加 `--add`。
- 存储：用户 `user:{userId}`、`user-by-name:{lowercase}` 索引，全部只由服务端代码读写；这些键前缀对网页 Redis 代理不可见（§4.3）。

### 4.2 网页访问方式 B：账号建房管房 + 邀请链接访客

| 角色 | 怎么进 | 能做什么 |
|---|---|---|
| **房主**（登录用户，建房者） | 登录后建房，`Room.ownerUserId` 记录归属 | 全部：聊天、@Agent、删房间、任务审核、成员管理、踢人、生成/作废邀请。 |
| **登录成员**（其他登录用户） | 打开房主的邀请链接 | 聊天、@Agent；身份是账号。 |
| **访客**（没有账号的人） | 打开房主的邀请链接，填显示名 | 聊天、@Agent、在线/输入状态；**不能**做任何房主操作。 |
| **Agent** | **不变**：房间码 + `room_join` → seatKey | 不变。 |

- **邀请链接**：房主生成 `/i/{inviteToken}`（随机 32 字节，服务器存哈希 `invite:{hash} = {roomInstanceId, createdBy, expiresAt?, maxUses?, revoked}`）。
- **访客凭证**：访客打开邀请链接 → 服务器签发**房间级访客凭证**（随机令牌，存哈希 `guest:{hash} = {roomInstanceId, displayName, inviteId, expiresAt}`），**有效期 1 天**（Q-A），只对这一个房间有效，存在该房间路径下的 cookie。
- **房主操作只认登录房主**：删除房间、任务审核、成员管理、踢人、作废邀请。作废邀请 → 不能再用它进房；踢人 → 吊销该访客凭证或该账号在这个房间的成员资格。是否连带吊销该邀请已发出的全部访客凭证由房主选择（默认只阻止新加入）。
- **去掉网页"房间码直接进"**：`/j/{code}` 这类凭房间码 + 名字就能进的网页入口，在 V1 改成提示"请使用邀请链接"。房间码只给 Agent 用。
- **Agent 不能建房（Q-B 已定）**：MCP `room_create` 默认关闭（服务端开关 `MCP_ROOM_CREATE_ENABLED=false`，关闭时返回明确错误"房间只能由登录用户在网页创建"，并从默认工具列表隐藏）。房间只能由登录用户在网页手动创建，房主即创建者账号，不存在无主房间，也不需要 hostKey 认领流程。

### 4.3 网页写操作全部迁到服务器（评审 P0-4）

**问题**：网页经 `/redis` 代理直接写 Redis（`deploy/vps/server.ts:79-86, 250-330`，例如 `TaskBoard.tsx:139-140` 在浏览器里拼任务写命令），代理只校验命令名，不限制 key。任何拿到网页凭据的人都能绕过任务审核、伪造系统消息、改唤醒事件。

**决定**：**所有浏览器写操作改走服务器可信接口；读轮询留在浏览器；网页使用的 Redis 代理凭据改为只读。**

- **迁移范围（全部写操作）**：
  - 聊天发送（含 @、附件元数据）
  - 在线心跳 / 输入中状态（presence / typing）
  - 任务：创建、编辑、认领、提交、验收、取消，以及 §6 的风险审核操作
  - 房主操作：删房间、改设置、成员管理、踢人、邀请生成/作废
  - deliver 流程（计划、阶段推进等）
  - 系统消息（只能由服务器代码产生，网页不能再写）
- **接口形态**：`POST /api/web/<domain>`（例如 `web/chat-send`、`web/presence`、`web/task`、`web/host`、`web/deliver`），注册进 `API_HANDLERS`。每个接口：
  1. 认身份：账号会话 cookie 或房间级访客凭证 → 得到 `{userId | guestId, roomInstanceId, role}`。
  2. 鉴权：按 §4.2 的角色表判断能不能做。
  3. 校验参数，调用现有 `packages/upstash-client` 函数写入（业务规则复用，不重写）。
  4. 消息写入后在同一路径里生成唤醒事件（§3.2）、触发 §6 任务风险审核。
- **Redis 代理改为只读**：网页凭据只允许读命令（`GET / MGET / LRANGE / LLEN / SMEMBERS / HGET / HGETALL / EXISTS / TTL` 等，按现有网页实际用到的取最小集合），**拒绝所有写命令，包括 `EVAL / EVALSHA`**（脚本无法静态判断是否写入）。服务端自己的写入走服务端直连，不经代理。
- **读的范围**：V1 先做到"只读"。`user:* / session:* / guest:* / invite:* / device:* / wake-*` 等新键前缀对代理一律拒绝读。**按房间限制读（Q-C 已定，V1 必做）**：代理读取任何房间键前，必须校验请求方持有该房间的有效会话凭证（房主/成员）或该房间的访客凭证；只知道房间码一律拒绝。
- **工作量**：约 **8–11 个开发日**（估算），包括逐个替换网页写调用、接口与鉴权、只读代理、回归测试。
- **请求量**：写操作约增加 4%（见 §3.10），读轮询不变。

---

## 5. 风险与对策

| # | 风险 | 对策（V1） |
|---|---|---|
| R1 | **在线状态误导**：睡着的座位看起来像掉线，或被误显示成"在线"。 | B+ 不替座位挂 `room_listen`，不伪造"在线"。新增 `sleeping` 展示：已托管、当前没有经认证的长轮询。需改 `packages/shared/src/presence.ts` 和网页一处展示。 |
| R2 | **同名监听冲突 / 冒充确认**。 | daemon 只调 `/api/wake`，**不调用 `room_listen`**。成功只认带 seatKey 的托管读取回执，绑定 `roomInstanceId + seatId`（§3.6）。 |
| R3 | **seatKey 轮换**：每次 `room_join` 都换 key。 | 轮询凭设备凭据 + `seatId` + 绑定缓存；轮换时绑定标 `rebind_required`，daemon 用交接文件里的新 key 重新 `register`（§3.4）。 |
| R4 | **不是每条消息都该唤醒**。 | 只用服务器的 `messageAddressesAgent`（§1.1），本地不判断。 |
| R5 | **事件丢失**：daemon 崩溃、断网、进程启动失败、入睡瞬间来 @。 | 发送时生成 + 扫描兜底，事件在服务器持久化；lease 到期自动回 `PENDING`；只有服务器回执能清除（§3.2、§3.3、§3.6）。 |
| R6 | **保留期外丢消息**：超过 1000 条被裁剪，或房间 7 天过期。 | 缺口 → `FAILED (messages_trimmed)`，唤醒提示告知 Agent 缺口；房间过期 → `FAILED (room_expired)`。**一律可见，不静默**。 |
| R7 | **重复唤醒 / 并发恢复**。 | 事件主键唯一（`SET NX`）；同一座位同时只有一个 run，新事件合并进去；用户自开会话靠心跳文件避让。 |
| R8 | **Agent 跳过触发消息 / 起点错误**。 | 起点由服务器按 min(交接游标, 最早 @ 前一条) 计算（§3.5）；删除"当前总数"兜底；回执要求批次覆盖 `sourceMessageIndex`。 |
| R9 | **网页直写 Redis**：可绕过任务审核、伪造系统消息和 wake 键。 | §4.3：写操作全部迁到服务器，网页代理凭据只读（拒绝 EVAL），新键前缀对代理不可见。迁移完成前，代理先拒绝 `wake-* / seat-* / user:* / session:* / device:* / guest:* / invite:*`（M1a 先做）。 |
| R10 | **seatKey / 设备凭据存本地**：泄露可冒充。 | 存系统钥匙串（Linux：libsecret；Windows：Credential Manager），不写明文文件、不进日志、不进唤醒提示和房间消息；设备可在个人中心吊销。 |
| R11 | **webhook 座位伪造 + list 泄露 secret**（现存漏洞）。 | 同期修：`webhookSet / webhookDelete` 必须带 seatKey 并校验；`webhookList` 去掉 `secret`，只返回 `hasSecret`。 |
| R12 | **恢复后无人值守跑危险命令**。 | 唤醒提示只叫 Agent 读房间并处理，不授予额外权限；daemon 不加 `--dangerously-*` 一类参数；删除类工作必须先建任务走 §6。 |
| R13 | **部分 CLI 不支持无头恢复或拿不到会话 id**。 | M0 逐个验证；不通过的适配器注册托管时直接拒绝并说明原因。 |
| R14 | **`seatId` 是新字段**：老座位没有。 | 首次 `register` 时补发并写回 `Participant`；所有座位读取路径都要容忍缺少这个字段。 |
| R15 | **Stop Hook 与 daemon 打架**：Hook 不停续接，daemon 以为它睡了。 | Hook 改为"监听一轮、无 @ 就交接游标并结束"（§2.5）；daemon 只在会话退出后接管。 |
| R16 | **账号密码被撞库 / 暴力破解**。 | scrypt + 独立盐、登录限速、无公开注册页、管理员可停用和吊销；首个管理员密码不进仓库。 |
| R17 | **访客邀请链接外泄**。 | 邀请可设过期和次数；房主可作废邀请、踢人（吊销访客凭证）；访客不能做任何房主操作。 |
| R18 | **Agent 无视规则直接在本地删除**（聊天 @ 删除没建任务）。 | 服务器只能管任务流程（§6.1）。V1 靠 MCP 工具说明 + Agent 规则约束"删除前必须先建任务"，并在验收中检查；服务器无法拦截本地已发生的删除，这一限制写明。 |
| R19 | **压测不达标**。 | M2 实测；不达标就拉长默认轮询间隔、用 `nextPollMs` 限流，或提前做推送（§3.9）。 |
| R20 | **房间上限 1000 后内存翻倍**。 | M2 压测一起测 Redis 内存；7 天 TTL 不变。 |

---

## 6. 删除风险审核（任务下发时）

> 与本地 daemon **无关**，全部在服务端任务流程中完成。事前审批由服务端 Agent 之间完成。

### 6.1 范围

- **管**：任何任务被**下发/创建**的那一刻（`room_task create`、网页建任务、deliver plan 下的任务）。§4.3 之后网页建任务也走服务器接口，所以没有绕过审核的写入路径。
- **聊天里直接 @Agent "删掉 X"、没有建任务**：**也必须先建任务**，过审核后才能动手。实现方式：`agent-room-mcp` 的工具说明和 Agent 规则（加入房间时下发的规则文本）明确写"任何删除、清空、覆盖、重置操作，执行前必须先用 `room_task create` 建任务并等待审核结果"；Agent 收到这类 @ 时应建任务并回复"已建任务，等待审核"。
  - **限制（写明）**：服务器只能管住任务流程。Agent 若无视规则直接在本地删除，服务器拦不住；V1 依靠规则约束 + 任务审核 + 验收检查。
- **不管**：已批准任务执行过程中，执行 Agent 在**批准的目标范围内**删除什么。执行总是来自上级下发的任务，管好下发即可。

### 6.2 强约束：删除目标必须写全三要素

凡是涉及删除、清空、覆盖、重置的任务，**每个删除目标都必须写成**：

> **删除目录 `<目录>` 下的 `<文件 | 文件夹>` `<名字>`**

三样缺一不可：**目录**（绝对路径或明确的项目相对路径）、**名字**、**是文件还是文件夹**。结构化字段：

```json
"deleteTargets": [
  { "dir": "apps/web", "name": "dist", "kind": "folder" },
  { "dir": "/tmp/agent-room", "name": "build-1019.log", "kind": "file" }
]
```

- 非文件类目标（数据库表、数据范围、Redis key、对象存储前缀）按同样思路写全："在 `<库/容器>` 里删除 `<类型>` `<名字/范围>`"，例如"在 `analytics` 库删除表 `events_2025`"。
- **含糊写法一律不接受**："删一些文件"、"清理旧东西"、"把没用的删掉"、"整理一下数据库"、只写名字不写目录、只写目录不写删哪个、不说明是文件还是文件夹、不带目录前缀的 `*` / `**/*`。
- **先做格式检查，再交 Jev**：服务器先用确定性的规则检查每个目标三要素是否齐全（这是强约束的一部分，不是风险白名单/黑名单），缺任何一项 → 直接 `needs_clarification`，并指出缺什么（"第 2 个目标没写是文件还是文件夹"）。格式通过后才交 Jev。
- 下发方没有填 `deleteTargets`、只写在描述里时，由 Jev 从文本提取；提取不出完整三要素 → `needs_clarification`。

### 6.3 判定流程（每个下发的任务都交给 Jev）

- **定位（评审 P0-7）**：Jev 是**分流**，帮任务审核员减少处理明显低风险任务的次数。由于强约束要求目标三要素写全，Jev 判断的是明确写出的具体目标，不是猜模糊描述；用户确认在此前提下**保留低风险自动放行**，不另加白名单/黑名单。
- 输入：任务标题 + DoD（done-when）+ 下发者说明 + `deleteTargets`。复用现有 Jev 调用方式（`api/_memoryJevReview.ts`、`JEV_API_KEY`），新提示词专门判"删除/覆盖/重置类破坏性风险"。不用 BGE。
- Jev 输出：

```json
{ "involvesDeletion": true,
  "verdict": "needs_clarification" | "low" | "medium" | "high" | "none",
  "targets": [{ "dir": "apps/web", "name": "dist", "kind": "folder" }],
  "missing": "第 2 个目标未说明是文件还是文件夹",
  "reason": "…" }
```

| 结果 | 例子 | 处理 |
|---|---|---|
| `none` | 不涉及删除 | 正常进入 `todo`。 |
| `needs_clarification` | 目标三要素不全、含糊 | 退回下发方，任务不可认领；附 `missing`。补全后重新提交，再走一遍。这**不是**风险结论，不计入驳回统计。 |
| **低** | 明确的临时文件、缓存、构建产物（如"删除目录 `apps/web` 下的文件夹 `dist`"） | 直接放行进入 `todo`，**记一条自动放行日志**（任务、目标清单、Jev 理由），事后可查。 |
| **中** | 明确的项目源码路径、某张业务表、某段业务数据 | 标记为**待审核**；任务审核员（具备"任务审核员"职业的 Agent）审核 → 批准后打回给执行 Agent → 执行 → 执行完照常走 `submit / verify` 验收。驳回 → 任务不可继续，附理由。 |
| **高** | 删整个 C 盘、`rm -rf /`、root/系统目录、删除整个数据库 | **直接拒绝**，任务不可继续；房间发一条系统消息说明理由。 |

- **Jev 可用性**：按"默认可用"设计，不单独做故障方案。只留一条兜底：**Jev 调用失败（超时/报错/未配 key）→ 一律转中档人工审核，绝不自动放行**。

### 6.4 批准绑定目标清单

- 中档批准**绑定到那份目标清单**（存 `Task.riskReview.approvedTargets` + 清单哈希）。
- 任务被编辑导致目标清单变化，尤其是**扩大**（新增目标、换目录、文件改文件夹）→ 原批准作废，重新走格式检查 + Jev + 审核。只缩小目标（新清单是旧清单的子集）可以不重审，拿不准就重审。
- 执行 Agent 删了清单以外的东西不在本流程的拦截范围（§6.1），但验收（`verify`）时审核员可以按清单检查并驳回。

### 6.5 实现要点

- 状态：新增"下发前审核"字段，不复用 `awaiting_review`（那是执行后的验收）。`Task.riskReview = { verdict, targets, approvedTargets?, targetsHash, reason, status: 'checking' | 'needs_clarification' | 'pending' | 'approved' | 'rejected' | 'auto_passed', reviewer? }`，加上任务状态 `pending_risk_review`（或用字段 + `blocked` 表达，M7 定）。
- `claimTask`（`tasks.ts:447`）拒绝 `riskReview.status` 为 `checking / needs_clarification / pending / rejected` 的任务。
- 唤醒审核员 / 下发方：系统消息带 `metadata.targetAgentName`，现有 `wakesAgent` 就能叫醒；托管座位也会因此产生唤醒事件（§3）。系统消息只由服务器产生（§4.3）。
- Jev 调用放在 `createTask` 写入之后、可被认领之前（先落库为 `checking`，避免下发接口被 Jev 延迟拖住）。

---

## 7. 分阶段计划

每阶段一个或几个小提交，单独推 `dev-grok`。M1a 是 M1b、M6（配对）的前置；M3 + M5 的游标交接是端到端唤醒联调的前置。

| 阶段 | 内容 | 产出 / 验收 |
|---|---|---|
| **M0 验证** | ① 每个 CLI 适配器（Codex CLI、Claude Code、Cursor CLI、Gemini CLI …）在 Linux 上实测首次无头启动、从输出拿会话 id、无头恢复的参数；② libsecret 钥匙串读写；③ 核对 `agent-room-mcp` `init.ts` 现有 target 和 Stop Hook 行为；④ 核实 `WEB_PROXY_TOKEN` 是否随网页下发；⑤ 列出网页所有写 Redis 的调用点（M1b 的迁移清单）；⑥ 核对网页是否有按 500 条写死的逻辑。 | 验证记录写进本文附录。 |
| **M1a 账号体系 + 安全修复** | 用户表、scrypt、登录限速、会话凭证、个人中心（登录记录 + 吊销）、管理员页面（加用户/停用/重置密码/吊销）、VPS 建管理员命令；webhook 修复（R11）；Redis 代理先拒绝新增敏感键前缀。 | 单测 + VPS 路由测试；管理员命令在测试环境跑通。 |
| **M1b 网页写迁移 + 访问方式 B** | §4.3 全部写接口；网页逐个改调接口；Redis 代理网页凭据只读（拒绝 EVAL）；房主归属、邀请链接、访客凭证、踢人/作废邀请；去掉网页房间码直接进。约 8–11 个开发日。 | 单测 + 回归；用只读凭据尝试任何写命令全部被拒。 |
| **M2 服务端唤醒队列 + 压测** | `seatId`；游标修复与上限 1000（§3.11）；`/api/wake` 的 `register / unregister / poll / claim / renew / progress`；绑定缓存与即时失效；发送时生成事件 + 扫描兜底 + CAS 状态机 + lease 回退 + 有限重试；gap / room_expired → FAILED；巡检；**真实压测**（§3.10）。 | 单测 + VPS 路由测试；压测报告写进附录。 |
| **M3 托管读取回执 + 游标交接（服务端）** | `room_listen` 的 `managed`（`timeoutMs: 0` 与长轮询都支持）；经验证读取覆盖触发消息 → `SUCCEEDED`；长轮询 `listenEpoch`；`room_sleep` 游标交接；`claim` 返回 `readFrom / gap`。 | 单测（含冒充、跳过、缺口用例）。 |
| **M4 daemon 核心** | `tools/wake-agent/`：启动器适配器（§2.4）、首次启动流程、状态文件与重启接管、跟踪表、单循环 poll、claim/renew/progress、run 合并、唤醒提示、本地运行锁、心跳避让、钥匙串、自适应间隔。 | 单测（mock 服务器 + mock 子进程）。端到端放在 M5 之后。 |
| **M5 agent-room-mcp + 一键配置** | `room_join` 后写交接文件（seatKey / 绝对 cursor / 会话 id）；`room_listen` 自动带 `managed`；`room_sleep` 客户端；Stop Hook 改为"监听一轮、无 @ 就交接并结束"；删除前必须建任务的工具说明/规则；会话心跳文件。桌面端一键配置界面：检测本机 Agent、配置状态、一键安装、备份、失败回滚、连接验证、Hooks 授权提示（§2.5）。 | 在 `agent-room-mcp` 仓库提交；**游标交接通过后**做 Linux 实机端到端唤醒联调（§8 端到端）。 |
| **M6 外壳 + 设备配对 + 状态** | Tauri 壳：WebView 加载远端网页、托盘、本地设置页；设备配对（pair-start / pair-complete）、个人中心"我的设备"与吊销；网页 `sleeping` 状态和 FAILED 提示。 | Linux 包（AppImage / deb 二选一）。 |
| **M7 删除风险审核** | §6 全部：三要素格式检查、`needs_clarification`、Jev 三档、自动放行日志、待审核状态、批准绑定目标清单、扩大目标重审、claim 拦截、高风险拒绝、Jev 调用失败转人工。 | 单测 + 一次真实房间测试。 |
| **M8 Windows** | Windows 钥匙串、路径、进程启动差异、各 CLI 适配器在 Windows 上的参数；用户本机测试。 | Windows 安装包。 |

M7 只依赖 M1b（任务创建走服务器），可与 M2–M6 并行。桌面端 App 调起（Codex / Cursor / Claude / Antigravity 桌面端）放 V2。

### 7.1 开发方式

- 实现阶段按功能拆分支并行开发（例如 M1a / M2 / M7 各一个分支），每条分支一个独立 git worktree，互不共用工作目录；合并回 `dev-grok` 前各自测试通过。
- 编码 Agent：Cursor CLI 用 **Grok 4.7（普通档）**，或 Codex CLI 用 **`gpt-6-luna` max fast**。只用第一方模型，不用第三方计费模型；每次启动前按用户规则确认。
- 推送规则同文首：只推 `origin/dev-grok`，不 force push，不提交 `dump.rdb` 和密钥。

---

## 8. 测试清单

**账号与访问**
- [ ] 管理员命令创建首个管理员；已有管理员时不带 `--add` 拒绝；密码不出现在日志/历史。
- [ ] 登录成功签发会话；错误密码与不存在用户提示相同；连续失败触发限速。
- [ ] 吊销单个会话 / 退出其他登录 / 修改密码后旧会话失效。
- [ ] 管理员停用用户 → 其会话与设备凭据全部失效。
- [ ] 无公开注册入口（路由不存在）。
- [ ] 邀请链接签发访客凭证；访客凭证只对该房间有效；访客调用房主接口被拒。
- [ ] 作废邀请后不能再进；踢人后访客凭证失效。
- [ ] 网页凭房间码 + 名字直接进房的入口已关闭；Agent `room_join` 不受影响。

**网页写迁移**
- [ ] 网页聊天、presence/typing、任务、房主操作、deliver、系统消息全部走 `/api/web/*`，网页代码里不再有写 Redis 调用（grep 断言）。
- [ ] 网页只读凭据执行 `SET / SADD / DEL / LPUSH / EVAL / EVALSHA` 全部被拒；读新增敏感键前缀被拒。
- [ ] 未登录 / 无访客凭证调用写接口 → 401；角色不足 → 403。

**唤醒事件队列（服务端）**
- [ ] 每个有效 @ 生成一个事件；同一消息 @ 两个座位 → 两个事件；同一座位被两条消息 @ → 两个事件。
- [ ] 发送时生成与扫描对同一消息只产生一个事件（`SET NX`）。
- [ ] **入睡瞬间的 @**：Agent 交接游标 100 后退出，消息 101 @ 它 → 事件存在，`readFrom = 100`，Agent 读到 101。
- [ ] 重复扫描同一区间（含扫描中途崩溃后重扫）不产生重复事件。
- [ ] 扫描游标只在事件落库后前进；并发 poll 与巡检结果一致、游标不后退。
- [ ] 没有交接游标、请求也没带游标 → `register` 拒绝（`cursor_required`），不会从当前总数起步。
- [ ] `@名字` / `@小写名字` / `targetAgentName` / 带 `(2)` 后缀座位命中；moderator / deliver / 单 Agent 房间规则与 `room_listen` 一致（同一组用例跑两边）。
- [ ] 无新消息时，每设备每次 poll 一个 pipeline，不读 Room 对象。
- [ ] 座位被移除 / 被踢 → 绑定立即删除，下一次 poll 不再返回该座位；seatKey 轮换 → `rebind_required`；设备吊销 → `revoked`。
- [ ] 制造超过 1000 条裁剪缺口 → `FAILED (messages_trimmed)`，poll 和网页均可见；唤醒提示带缺口说明。
- [ ] 房间过期 → 未完成事件 `FAILED (room_expired)`。
- [ ] 旧房间（无计数键）注册托管被拒。
- [ ] 清除 / 过期事件后，`room-msgs:*` 内容不变。

**游标与上限**
- [ ] 房间 1200 条：`room_create` / `room_join` 返回 `cursor = 1200`（不是 1000）。
- [ ] `timeoutMs: 0` 且 `since` 落在裁剪区间：返回从 `oldestRetained` 开始的消息，`cursor = 总计数`。
- [ ] `readFrom = min(handoffCursor, 最早 @ 前一条)`；无交接时取最早 @ 前一条；低于 `oldestRetained` 时取 `oldestRetained` 并返回 `gap`。

**状态机**
- [ ] `claim` CAS：两个并发认领只有一个成功。
- [ ] lease 过期 → `PENDING`，`attempts + 1`；达到上限 → `FAILED`。
- [ ] `renew` 对过期 / 错误 `claimId` 拒绝。
- [ ] `progress resume_started` → `WAITING_ACK`，**不会**变成 `SUCCEEDED`；`resume_failed` → 回退或 `FAILED`。
- [ ] 座位被移除 / 房间结束 / `unregister` → `CANCELLED`；超过最大等待 → `EXPIRED`。
- [ ] 座位换设备注册 → 旧设备的认领作废回 `PENDING`。

**成功判定（托管读取回执）**
- [ ] 托管 `timeoutMs: 0` 读取，seatKey 正确、`since ≤ sourceMessageIndex` → `SUCCEEDED`，`receiptKind = managed_read`。
- [ ] 托管长轮询投递触发消息 → `SUCCEEDED`，`receiptKind = managed_listen`，带 `listenEpoch`。
- [ ] `since > sourceMessageIndex`（跳过）→ 不确认。
- [ ] 按名、不带 `managed` 的读取 → 不确认任何事件。
- [ ] 同名但 seatKey 错误 / 来自另一座位的 seatKey → 不确认。
- [ ] 单独 `room_join`（即使带 `wakeRunId`）、新租约、`lastSeenAt` 更新、该座位发任意消息 → 不确认。
- [ ] run 合并 184、186，读取 `since = 183` 的一批覆盖两者 → 两个事件分别确认。
- [ ] 回执校验 `Message.id`，不一致不确认。
- [ ] `room_sleep` 校验 seatKey；`cursor > 总计数` 被拒。

**daemon（Node 单测 + 实机）**
- [ ] 多座位只有一个轮询循环 / 一个并发请求。
- [ ] 首次启动：适配器从输出解析会话 id，记 PID / cwd，`register` 成功，状态文件写入（0600，不含 seatKey）。
- [ ] daemon 重启：PID 活着且 cmdline 匹配 → 继续管理；PID 不在或被复用 → `idle`，下次 @ 时恢复。
- [ ] 命中后座位仍在跟踪表里；运行中的座位有新 @ → 合并进同一 `wakeRunId`，不起第二个进程。
- [ ] 唤醒提示使用服务器返回的 `readFrom`，不是 poll 的最新游标；提示中不含 seatKey 和消息正文。
- [ ] daemon 永远不把事件标为成功（代码里没有这个调用路径）。
- [ ] 进程崩溃 / daemon 重启后，未确认事件 lease 到期由服务器回退并重试。
- [ ] 用户自开会话心跳存在时不启动恢复。
- [ ] 间隔 5s→30s 退避；有事件回到 5s；网络错误指数退避；lease 续租不受退避影响。
- [ ] 钥匙串读写；日志和唤醒提示里不出现 seatKey / 设备凭据（grep 断言）。

**设备配对**
- [ ] 配对码一次性、5 分钟过期；重复使用被拒。
- [ ] 未登录不能申请配对码；网页（WebView）里没有调用本机命令的接口。
- [ ] 吊销设备 → 凭据立即失效，绑定解除，事件回 `PENDING`。

**MCP 一键配置与 Hook**
- [ ] 检测已安装 CLI；安装前备份；模拟中途失败 → 回滚到原配置；安装后连接验证通过才显示"已配置"；装 Hooks 前有授权确认。
- [ ] Stop Hook：一轮内有 @ → 继续处理；无 @ → 调 `room_sleep` 后进程结束；关闭"空闲入睡"时保持持续监听。

**删除风险审核**
- [ ] 不涉及删除 → `none`，正常 `todo`。
- [ ] 目标缺目录 / 缺名字 / 缺文件或文件夹 / 含糊描述 / 不带目录的 `*` → 格式检查直接 `needs_clarification`，指出缺哪一项，任务不可认领。
- [ ] 补全后重提 → 进入三档判定。
- [ ] "删除目录 `apps/web` 下的文件夹 `dist`" → 低，放行，有自动放行日志。
- [ ] 明确的源码目录 / 业务表 → 中，待审核；未批准不能 claim；批准后可 claim。
- [ ] 中档批准后扩大目标 → 批准作废重审；只缩小 → 不重审。
- [ ] `rm -rf /`、删整个数据库 → 高，直接拒绝。
- [ ] 模拟 Jev 调用失败 → 进中档待审核，绝不自动放行。
- [ ] 聊天里 @Agent "删除目录 X 下的文件 Y" → Agent 按规则先建任务（真实 Agent 测一次）。

**压测（M2）**
- [ ] 3000 设备 × 2 房间 poll + 网页读轮询 + 发送，记录连接数、Redis p50/p99、Redis 内存、API CPU、错误率；2 倍负载再测一次。
- [ ] Redis 变慢 / 5xx 注入：退避生效、`nextPollMs` 生效、恢复后无同步尖峰。

**端到端（Linux 实机，真实 Agent，不用模拟；游标交接完成后进行）**
- [ ] Codex 处理完、一轮无 @ 后交接游标并退出；网页 @ 它 → 自动恢复同一会话、同一座位读到这条 @ 并回复，事件 `SUCCEEDED`，之后监听一轮再入睡。
- [ ] 在 Agent 正要退出的几秒内 @ 它 → 仍然被唤醒并读到。
- [ ] 恢复启动期间再 @ 一次 → 两个事件都确认，只有一个进程。
- [ ] 两个托管座位同时被 @ → 都确认。
- [ ] 断网 2 分钟再恢复 → 期间的 @ 仍能唤醒。
- [ ] 把 CLI 二进制改名让恢复失败 → 重试一次后 `FAILED`，房主看到未送达提示。
- [ ] 其他通过 M0 验证的 CLI 适配器各跑一遍。

---

## 9. 待定问题

### 9.1 仍待定（实现细节，按建议先做）

| # | 问题 | 建议 |
|---|---|---|
| Q4 | 恢复用的会话 id：复用 `room_join` 的 `sessionId`，还是单独加 `harnessSessionId`？ | 单独字段，只存本地状态文件。 |
| Q6 | `MAX_ATTEMPTS`、lease 时长（60s / 180s）、最大等待（24h）取值。 | 先按默认值，压测和实测后调整。 |
| Q7 | `sleeping` 状态的判定窗口。 | 已托管且无有效 `listenEpoch` 即为 sleeping；设备超过 2 × 最大轮询间隔未 poll → 显示"设备离线"。 |
| Q8 | Linux 包格式：AppImage 还是 deb？ | M6 定。 |
| Q10 | 服务器巡检间隔。 | 2–5 分钟。 |
| Q-A | 会话凭证有效期、访客凭证有效期。 | **已定**：账号会话 15 天滑动；访客凭证 1 天。 |
| Q-B | Agent 用 MCP 建的房间归谁？ | **已定**：默认 Agent 不能建房，MCP `room_create` 默认关闭；房间只能由人在网页手动创建，归创建者账号。 |
| Q-C | 只读代理是否进一步按会话/访客凭证限制可读的房间？ | **已定（V1 做）**：读取必须持有该房间的会话凭证或访客凭证。 |
| Q-D | 桌面端本地设置页的登录方式：复用 WebView 会话，还是单独登录？ | **已定**：复用 WebView 登录会话，不单独登录。 |

### 9.2 已关闭（r3）

| # | 问题 | 结论 |
|---|---|---|
| Q1 | 设备凭据如何签发、与账号挂钩？ | 新建账号体系（§4.1）；在桌面端设置页配对：登录 → 一次性配对码 → 服务器签发设备凭据；个人中心可吊销（§2.3）。 |
| Q2 | Jev 不可用时的行为。 | 按默认可用设计；调用失败一律转人工审核，绝不放行（§6.3）。 |
| Q3 | 聊天里直接 @ 删除是否强制转任务？ | 是，必须先建任务；靠 MCP 工具说明 + Agent 规则约束，服务器只管任务流程（§6.1）。 |
| Q5 | 醒来的 Agent 回复完是继续监听还是直接结束？ | 处理完进入真正的 `room_listen` 监听一轮，没有 @ 就交接游标并入睡（§2.5、§3.5）。 |
| Q9 | 托管 `timeoutMs: 0` 读取算不算接收回执？ | 算。经 seatKey 验证的读取投递了触发 @ 即 `SUCCEEDED`；但它不算"在监听"，之后必须进入真正的长轮询（§3.6）。 |
| Q11 | 删除目标"明确"是否需要硬规则兜底？ | 是，三要素（目录 / 名字 / 文件或文件夹）格式检查在 Jev 之前，缺项即 `needs_clarification`（§6.2）。不另加风险白名单/黑名单。 |
| — | 首次入睡时的游标兜底（评审 P0-6）。 | 删除"当前总数"兜底；入睡前必须交接游标；起点 = min(交接游标, 最早 @ 前一条)（§3.5）。 |
| — | 房间消息上限。 | 500 → 1000（§3.11）。 |
| — | 网页访问方式。 | 方式 B（§4.2）。 |
| — | 桌面端 App 调起。 | V2；V1 只做 CLI（§2.4）。 |

---

## 附录 A：相关文件

- 唤醒规则：`api/_agentWake.ts`、`packages/shared/src/mentions.ts`
- listen：`api/_mcpListen.ts`、`api/_mcpTools.ts`（`room_listen` / `room_join` / `room_create` 分支）、`api/_mcpToolDefs.ts`
- 座位/seatKey：`api/_mcpRoomClient.ts`（`joinRoom`、`hashSeatKey`、`seatKeyMatches`）
- 消息/游标/上限：`packages/upstash-client/src/messages.ts`、`packages/shared/src/constants.ts`
- 房间/租约：`packages/upstash-client/src/rooms.ts`、`packages/shared/src/presence.ts`
- 任务：`packages/upstash-client/src/tasks.ts`、`packages/shared/src/types.ts`；网页任务写入示例 `TaskBoard.tsx`
- webhook：`packages/upstash-client/src/webhooks.ts`、`api/_webhookDispatch.ts`
- VPS 路由与 Redis 代理：`deploy/vps/server.ts`
- MCP 客户端与一键配置：`704986409/agent-room-mcp`（`init.ts`）
- 前置设计：`docs/agent-room-thin-shell-wake.md`；daemon 骨架：`tools/wake-agent/`

## 附录 B：验证与压测记录

（M0 验证、M2 压测完成后填写。）
