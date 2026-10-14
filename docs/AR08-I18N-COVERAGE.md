# AR-08 Web 简体中文覆盖审计

审计日期：2026-10-15  
分支：`feat/v1.2-ar08-web-zh-cn`  
基线：`bbed6fb`（`origin/fix/v1.1-p0-ar06-ar09`）

## 覆盖范围

| 页面/路由 | 覆盖内容 | 状态 |
|---|---|---|
| `/` 首页 | 标题、介绍、创建/加入入口、复制反馈、代码提示、页脚 | 已接入双语字典；此前做过桌面浏览器检查 |
| `/new` 创建 | 7 种模板、Topic/姓名/角色、验证、错误、创建状态 | 已接入双语字典；此前检查过英文切换与表单值保留 |
| `/j`、`/j/:code` 加入 | 邀请码、主持人/人数、错误、辅助标签、Agent 接入提示 | 已接入双语字典；本轮复核了 `/j` 中文画面及无障碍树 |
| `/r/:code/lobby` 大厅 | 邀请、复制反馈、成员和建议角色 | 已接入双语字典；缺少可用隔离后端的真实房间画面 |
| `/r/:code` 聊天室 | 聊天、附件、模式、成员、状态、确认框、错误、任务板 | 已接入双语字典；API/房间连接未作真实隔离联调 |
| `/r/:code/report` 报告 | 标题、统计、摘要标签、时间、导出、分享、空态 | 已接入双语字典；没有隔离房间报告可供端到端检查 |
| `/mcp`、`/tools` MCP 指南 | 安装说明、客户端步骤、协议/工具说明、复制文本、页面元数据 | 已接入双语字典；命令及 Agent 可执行英文说明保留 |

## 组件、内容源和静态页面

- `apps/web/src/i18n/messages.ts`：英文与简体中文各 **445 个 key**；`messages.test.ts` 检查 key 集和占位符集合一致。语言解析无值或非法值时回退 `zh-CN`。
- `LocaleProvider.tsx`、`LocaleSwitcher.tsx`、`main.tsx`、`TopNav.tsx`：语言状态保存在 `agent-room:locale`；切换不重载应用；同步页面 `lang`、标题及描述。
- `TaskBoard.tsx`、`Bubble.tsx`、`VoiceButton.tsx`、`CodeInput.tsx`、`Toast.tsx`、`AgentJoinQuickstart.tsx`、`AgentJoinNotice.tsx`：固定界面文案、表单辅助文案、结构化系统事件、错误概述及复制提示已本地化；Agent 接入提示中文优先并保留简短英文 MCP 指令。
- `useTaskBoard.ts`、`copy.ts`：界面通知和复制结果接入当前语言；未更改任务数据流。
- `lib/templates.ts`：7 个模板的标题、说明、Topic seed 和新房间 opener 随当前语言显示。测试确认模板 ID、角色 ID、`[DECISION]`、`[TODO]`、`[STATUS]`、`[RESULT]` 不变。
- `index.html`、`site.webmanifest`、`scripts/prerender.mjs`：默认静态元数据为中文；预渲染加入页/房间壳以中文说明在网页表单上方，并保留完整英文机器指令供无 JS 客户端读取。

## 英文残留审计

源码扫描与页面抽检未发现普通访客固定控件存在仅英文文案遗漏。保留内容按以下类别处理：

1. 产品名/品牌：`Agent Room`、Claude、Cursor、Codex、Gemini。
2. MCP 协议标识、工具名、参数、配置片段、命令和代码：如 `room_join`、`room_listen`、`ALL_TOOLS`、`npx agent-room-mcp init`、URL、`CLI`。
3. 结构化状态值、marker、路由及机器字段：如 `open`、`sequential`、`moderator`、任务状态和 JSON key；仅在 UI 映射为翻译。
4. 用户/Agent 输入和历史数据：姓名、Topic、消息、任务标题、证据、报告原始内容，不作机器翻译。
5. `/j` 与预渲染的 Agent 接入提示保留一条简短英文兼容指令；其余可见说明先显示中文。该英文用于保持 Agent 对 `room_join`、`room_listen` 和“不回退网页表单”的明确提示。
6. 未识别的服务端/浏览器异常正文仍作为诊断细节保留；其周围的错误标题和说明为当前界面语言。浏览器语音识别和底层网络异常文本可能由客户端/服务端返回英文。

`AgentRoomLogo` 中的 `Agent Room` 是品牌辅助名；`Avatar` 只显示用户首字母；`MeetingCodePill` 只显示原始房间码，没有漏掉固定 UI 文案。

## 高风险行为保护

- AR-11 Presence：`Room.tsx` 的改动只将三个状态标签接入本地化字典，并把翻译函数传给显示映射。`listenUntil`、`PRESENCE_STALE_MS`、`PRESENCE_DISCONNECTED_MS` 的条件和阈值未改；未改租约、心跳或服务端 Presence。
- AR-06/M08：不改审核 CAS、Lua、API 错误结构或 Redis。API 审核相关现有测试通过；没有运行需要隔离后端的网页 Approve 真机测试。
- MCP：工具名、URL、参数及复制的命令保持英文/原值；预渲染和浏览器驱动 Agent 可读取的提示仍在 accessibility tree 中，没有使用隐藏或折叠区。
- 报告/历史：语言切换只改变固定显示文案和格式；不改持久化消息、证据、Room JSON、游标或 TTL。模板测试验证机器标识与 marker 不变。

## 测试矩阵

| ID | 结果 | 证据/未完成项 |
|---|---|---|
| I18N-01 默认语言 | PASS | 字典默认与非法值回退测试；静态 HTML 中文 lang；本轮 `/j` 浏览器页面显示中文。未使用全新浏览器配置文件。 |
| I18N-02 英文切换 | PASS | 前序浏览器检查确认英文切换；字典双语 parity 测试。 |
| I18N-03 记住语言 | PARTIAL | `localStorage` 稳定键、跨页 Provider 与前序导航检查；未实测刷新后再次进入实时 Room。 |
| I18N-04 字典完整 | PASS | 445/445 key、445/445 占位符 parity 自动测试通过。 |
| I18N-05 首页/创建 | PASS | 前序桌面首页及创建页检查；语言切换时创建表单值保留。 |
| I18N-06 七个模板 | PASS | 自动测试覆盖 7/7 模板文案、opener、ID、角色值与 marker。 |
| I18N-07 加入/大厅 | PARTIAL | `/j` 已在本轮真实浏览器复核；大厅无隔离房间数据，未完成成功/禁止发言场景。 |
| I18N-08 聊天室 | PARTIAL | 固定界面文案已接入；缺少隔离房间，未实测实时发送、附件、结束/恢复等状态。 |
| I18N-09 Presence | PARTIAL | diff 与代码检查确认仅文案变化；共享 Presence 测试通过；未跑 AR-11 在线/断线真机流程。 |
| I18N-10 任务看板 | PARTIAL | TaskBoard 与 FollowUp 自动测试通过；未用隔离房间逐一操作看板界面。 |
| I18N-11 AR-06/M08 | PARTIAL | `test:api` 82/82 通过，Web/全仓测试通过；没有隔离环境，未复测网页 Approve/ACL。 |
| I18N-12 MCP 引导 | PASS | MCP 指南、复制内容与 AgentJoin/prerender 自动检查；本轮 `/j` accessibility tree 包含中文说明及 MCP 工具指令。 |
| I18N-13 会议报告 | PARTIAL | 报告界面固定标签已本地化；缺少隔离房间报告样本，未端到端检查导出/分享。 |
| I18N-14 输入保持 | PARTIAL | 前序创建页切换语言时表单值保持；聊天草稿、附件及任务表单未全部实测。 |
| I18N-15 可访问性 | PARTIAL | `/j` AX 树确认中文标题、说明、字段标签；源码测试确认 Agent 引导不被移出树；未覆盖所有页面键盘流程。 |
| I18N-16 静态元数据 | PASS | `build:ordered` 和 prerender tests 通过，默认 HTML/manifest 已更新。 |
| I18N-17 响应式 | PARTIAL | 前序检查了 360px 创建页与 MCP 指南；本轮浏览器 `/j` 确认文字换行，但没做 360/390px 截图矩阵。 |
| I18N-18 历史数据 | PASS（代码审查） | 本地化仅改 UI 展示；模板测试确保 payload 标识不变；未连接 Redis 做存储对照。 |
| I18N-19 英文审计 | PARTIAL | 对路由/组件/固定辅助文案做源码扫描与页面抽检；保留项已逐类说明。未穷举所有服务端异常正文。 |
| I18N-20 回归 | PASS | `build:ordered`、`test:api`、`npm test`、Web 专项测试通过；Postgres 集成测试 7 项因现有条件跳过。 |

## 浏览器检查与限制

- 本轮打开本地 `http://127.0.0.1:4178/j`，屏幕和无障碍树均显示中文说明，房间码字段仍有中文名称；英文保留为短的 Agent 兼容提示。只连接本地预览，没有访问生产服务。
- 前序工作已检查桌面首页、英文切换/导航、创建页切换时表单保留，以及 360px 创建页和 MCP 指南。由于隔离后端不可用，不能将大厅、实时聊天室、任务审核或报告场景记作完成。
- 本轮 AR-08 仍是 **PARTIAL**：需人工在隔离后端完成大厅/房间/报告/任务状态与小屏幕最终验收后，才能提升覆盖状态。
