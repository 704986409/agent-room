# 0.1.27-v5：Cursor 首次提交、MCP 工具预授权、休眠游标、listen 瘦身

分支 `feat/0.1.27-v5-wake-auth-cursor-listen`。未打 tag，未发版，未部署。

## 1. Cursor 首次托管不自动回车

根因：首次把唤醒句放在 argv 上，CLI 只把它预填进输入框；第二次唤醒走 PTY 打字再送 CR，所以能提交。HostLocal 默认是嵌入 PTY（Linux 和 Windows 都是 `terminalMode=embedded`）。`AGENT_ROOM_TERMINAL=system` 才是系统控制台，没有可写的 PTY。

改了什么：

- 嵌入 PTY（有 `writeSeatStdin`）：argv 不带唤醒句。进程起来后用和第二次唤醒相同的路径打字并送 `\r`，日志 `cursor first-submit ... enter=1`。
- 系统控制台：同样不把唤醒句放进 argv。`seat-launch` 把原文和 CR 写进 CLI 的 stdin（`stdinSubmit`），然后若 stdin 是 TTY 就继续转发键盘。Linux 系统控制台走 `stdinSubmitCommand` + 可见终端；Windows 走原来的控制台启动器，spec 里 `stdinSubmit: true`、`promptIndex: -1`。
- `create-chat` 的 cwd 是席位目录，且发生在席位文件写完之后。

如何验证：`daemon.test.ts` 断言嵌入模式写入正文后紧跟 `\r`，且 argv 不含唤醒句；系统模式断言 `stdinSubmit`、正文在 prompt 字段、argv 不含唤醒句、不会再往 PTY 写。`cliLaunchPlan` / `prepareWindowsSeatLaunch` / `stdinSubmitCommand` 覆盖 CR 和 prompt 文件。

未覆盖：没有在本机做完整 HostLocal 托管点测，也没有 Windows 点测。单元测试不能代替点测。

## 2. 首次仍弹出 MCP 工具授权

根因：`--approve-mcps` 只自动批准 MCP **服务器**。每个工具调用仍走 `permissions.allow` 里的 `Mcp(server:tool)`。此前席位进程的 cwd / 会话工作区经常不是已经写好 `.cursor/cli.json` 的席位目录，所以首次会话看不到 allowlist。

改了什么：

- 启动参数保留 `--approve-mcps`，不含 `--yolo` / `--force`。`rejectUnsafe` 继续拒绝这两个旗标。
- 启动前写席位 `.cursor/cli.json`，只有 `permissions.allow: ["Mcp(<alias>:*)"]`。不写 `approvalMode`，不写 `deny`，避免覆盖用户的 deny。
- `create-chat` 和 CLI 的 cwd 都是席位目录，首次会话就能读到这份 allowlist。日志：`cursor preauth ... promptDelivery=... allow=Mcp(agent-room:*)`。

如何验证：`seatFiles.test.ts` 断言 cli.json 无 `approvalMode`、无 `deny`、allow 为 `Mcp(agent-room:*)`。`adapter.test.ts` 断言 argv 含 `--approve-mcps` 且不含 `--yolo`/`--force`，并且 `create-chat` 收到席位 cwd。

未覆盖：没有在已登录的 Cursor 里点一次 `room_send` 确认弹窗消失。配置写入和启动参数由测试证明；工具弹窗本身未做点测。

## 3. Codex 休眠后再醒，动作游标一直是 0

根因：handoff 脚本用更小的 cursor 覆盖已经记下的更大 cursor。`room_sleep(0)` 会把 7/11 写回 0。`readStart` 再取 `min(事件 sourceCursorBefore, handoff)`，于是 claim 的 `readFrom` 变成 0。模型还容易把唤醒句里的起始动作游标当成 sleep cursor。

改了什么：

- handoff 只允许前进。请求的 cursor 更小时保持原值并打 `sleep keep-higher`。MCP 与 HTTP 都记录 via、请求值、先前值、最终 stored。
- 返回的 cursor 是实际 stored 值。
- 席位规则和唤醒句写明：`room_sleep` 必须用最近一次 `room_listen` 返回的 cursor，禁止用唤醒句里的起始动作游标。
- claim 日志包含 `handoffCursor`、`sourceCursorBefore`、`readFrom`。
- 仍有 `sourceCursorBefore=0` 的活跃事件时，`readFrom` 仍可以是 0，不丢旧消息。

如何验证：`_wakeRedis.test.ts` 先 sleep 7，再 sleep 0，handoff 仍是 7，然后再前进到 11。`_wakeService.test.ts` 断言 claim 日志三字段。`_wakeCore.test.ts` 断言 handoff 7 + 事件 8 得到 7，同时事件 0 仍把 readFrom 留在 0。

未覆盖：没有连真实 Redis 和真实 Codex 会话做点测。测试 Redis 实现了同一条「不回退」规则。

## 4. room_listen 返回过长

根因：每次结果都重复 `roomPolicy` 长文、active 时的长 `meaning`，以及续听说明。这些规则已经在工具描述和席位 `AGENTS.md` 里。

改了什么：

- 无新消息时只留游标、`listenStatus` / `stay` 和 `nextAction`（托管静默时是 `room_sleep` 及其 arguments）。
- 有消息时保留正文、发送者、每条消息的 `cursor`、返回游标。`replyMode` 仍在。长 `roomPolicy` 不在每次 listen 里重复（进房结果里仍有一次）。
- 超过 20 条时返回 `more: true` 和本页结束游标，下一轮用该游标接着读。不把 `timeoutMs: 0` 写回 `nextAction`，避免连跳。已在房间里的后续消息会在下一次 listen 立刻返回。
- 结束 / 被移出房间的短 `meaning` 保留。被 @ 时仍保留一句回复提示。

如何验证：`mcp.leanListen.test.ts`。分页用例先拿 20 条、`more`、cursor 20，再从 20 读到剩余 5 条。

未覆盖：没有用真实模型看一轮 listen 的 token。daemon / shim 不解析 listen 正文，控制字段仍在结果里。
