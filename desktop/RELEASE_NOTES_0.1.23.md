# Agent Room Desktop 0.1.23

- 弹出终端不再依赖 jsDelivr，每个窗口使用独立 WebView 目录，关闭按钮会强制销毁窗口并停靠回房间。Pop-out loads xterm from the daemon, uses its own WebView profile, and force-closes back to the dock.
- 托盘「退出」不再被主窗口隐藏取消；会结束 daemon 进程树和座位 CLI。Tray Quit is no longer cancelled by hide-on-close and kills the daemon tree plus seat CLIs.
- 展开/收回后重新 fit 内嵌终端并通知 PTY 换行。Expand and collapse refit the docked terminal.
- 「关闭」结束托管进程且不会自动再拉起；「断开」仍只取消查看。Stop ends the managed process; Disconnect still only detaches.
