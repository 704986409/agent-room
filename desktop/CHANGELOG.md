# Changelog

## 0.1.20

- 房间右栏「任务 | 终端」内嵌托管终端；座位托管后不再自动弹出独立窗口。Embedded managed terminal on the room right rail; no auto pop-out after hosting.
- 成员列表上的终端图标可以点击，切换到对应座位的终端（修复文案盖住按钮、点不到）。Member-list terminal glyph switches the docked seat.
- 多个座位来回切换时丢弃过期 WebSocket 帧，避免上一个座位的输出残留、串台。Stale PTY frames are dropped on seat switch.
- Daemon 附着终端时回放约 256KiB 的 PTY scrollback，休眠座位（例如 Cursor）重新打开不再是空白。Attach replays about 256KiB of PTY scrollback.
- 本机设置页和弹出终端可以接管已经在跑的 daemon（读取 `control.json`）。Settings and pop-out can adopt a live daemon.
- 安装包里的 daemon-dist / AppImage 只打进当前主机 glibc 版 `node-pty`，避免 `pty_unavailable`，也避免 linuxdeploy 去扫 musl 预编译库。Host glibc `node-pty` only.

## 0.1.19

- 把 `@homebridge/node-pty-prebuilt-multiarch` 打进 daemon-dist，打包后的托管终端不再依赖手工软链。
