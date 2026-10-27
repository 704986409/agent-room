# Agent Room Desktop 0.1.22

- 「本机托管」对话框：选角色、写职业设定、选 CLI 与模型后再托管。HostLocal dialog: role, profile, CLI, and model before hosting.
- 一键托管后座位已进房；禁止再调 `room_join`、不再索要邀请码。firstRun forbids room_join / invite re-ask.
- 内嵌终端 Ctrl+V / Cmd+V 经 daemon 读系统剪贴板再写入（Linux xclip `CLIPBOARD` + Windows Get-Clipboard）。Docked Ctrl+V via daemon OS clipboard.
