# Desktop 0.1.24

## Fix: 弹出黑屏 + 关不掉

0.1.23 给每个 `terminal-<seat>` 单独建 WebView2 用户目录。Windows 上每次弹出都冷启动一个 Environment，窗口只剩 `#1e1e1e` 背景色，X 在 `prevent_close` + 排队 `destroy` 时也走不完。

- 设置页和所有 `terminal-*` 共用 `…-profiles/local-control`（仍与 `main` 隔离）
- 关闭时同步 `destroy`；若仍在则先 hide 再补一次
- 弹出页用 `html.popout` 首屏绘制工具条/「正在连接…」，xterm 改为 `defer`

请装本版后：弹出应看到深色终端（至少有工具条与连接文案），点 X 应收回右栏且不杀进程。
