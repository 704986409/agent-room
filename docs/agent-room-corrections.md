# Agent Room V1.1 文档修正与补充清单

## 说明

本文件用于补充 `agent-room-2-keypoints.md` 中遗漏和需要修正的工程细节。

标记：
- 已确认：来自项目验收记录
- 待确认：目前没有足够证据

---

# 1. AR-09 MCP状态修正

## 原描述问题

“AR-09验证通过”容易被理解为所有客户端已通过。

## 正确状态

### 服务端协议

已完成：

- Streamable HTTP `/mcp`
- Legacy SSE `/sse`
- SSE endpoint事件
- session管理
- reconnect支持


### 自动化验证

已通过：

- initialize
- tools/list
- room_create
- room_join
- room_send
- room_listen


### Antigravity GUI

状态：

待最终确认。

需要验证：

- 工具注入
- 房间调用
- 重连


---

# 2. AR-06 FollowUp补充

当前审核链：

verifyTask()
→ Redis Lua
→ CAS更新
→ system notification
→ Agent收到通知


支持字段：

- followUp.agent
- followUp.client


限制：

目前依据 Agent 名称和 Client 类型匹配，不是完整账号系统。

---

# 3. R9 TTL

目标：

Room创建后固定7天。

配置：

ROOM_TTL_SECONDS=604800


实现：

- SET KEEPTTL
- EXPIREAT ... LT


目的：

send/join/task/verify不能延长生命周期。


已验证：

操作过程中TTL不会增加。


待验证：

Redis重启恢复。

历史异常：

- TTL=-1
- task状态回退
- AOF出现NOPERM/EXEC


---

# 4. VPS生产配置

系统：

Debian 12


IP：

103.204.174.252


域名：

ai-room.pupgo.top


DNS：

A记录：

103.204.174.252


Cloudflare：

DNS Only


---

# 5. Caddy与端口

入口：

https://ai-room.pupgo.top


反代：

127.0.0.1:3100


Agent Room：

容器：

3000


宿主：

127.0.0.1:3100


公网3100：

不开放。


---

# 6. Redis

版本：

Redis 7.4.x


安全：

6379不公网暴露。


已有组件：

- redis-rest-private
- redis-rest-web


已验证禁止：

- FLUSHALL
- KEYS
- EVAL KEYS


具体ACL命令：

待进一步确认。


---

# 7. MCP工具

已确认：

- room_create
- room_join
- room_send
- room_listen
- room_task相关工具
- room_end


完整tools/list建议以后以运行结果为准。

---

# 8. API错误码

400:

bad_request

场景：

- rejected无reason
- followUp目标不存在


403:

权限失败

场景：

- HostKey错误


409:

冲突

场景：

- 重复审核
- 状态竞争


503:

redis_upstream_unavailable

场景：

- Web审核Redis链路异常


---

# 9. Task字段

核心字段：

- id
- title
- owner
- ownerClient
- verifier
- verifierClient
- dod
- state
- evidence
- verdict
- followUp


状态：

created
→ claimed
→ working
→ submitted
→ review
→ done/rejected


Evidence：

- fileListing
- fileExcerpt
- checks
- submittedBy
- submittedClient
- at


---

# 10. Windows Installer

状态：

已通过TestRoot隔离安装测试。


验证：

- API ONLINE
- 安装
- 卸载


当前限制：

依赖npm包：

agent-room-mcp


registry版本：

0.26.24


修复版尚未正式发布。

---

# 11. npm状态

包：

agent-room-mcp


latest：

0.26.24


源码修复：

已完成：

- self-host Join URL
- Report URL
- instructions


发布：

未完成。

原因：

npm账号权限需要确认。

---

# 12. 当前生产状态

已上线：

- HTTPS域名
- Web
- API
- MCP
- Redis
- Caddy


已验证：

- healthz
- readyz
- MCP基础流程


待完成：

- Redis重启恢复
- M08 Web Approve定位
- Antigravity真实GUI验证
- AR-11在线状态


---

# 13. 后续开发约束

不能破坏：

/mcp

/sse


审核闭环：

verifyTask
→ Lua
→ CAS
→ notification


TTL：

禁止普通操作增加Room生命周期。


Token优化：

从完整返回：

- board
- history
- snapshot

转向：

- diff
- incremental
- compact response
