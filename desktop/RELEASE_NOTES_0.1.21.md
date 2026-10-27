# Agent Room Desktop 0.1.21

- 「本机托管」改为与「+」相同的对话框：选角色、写职业设定、选 CLI 与模型后再托管，不再默认 Codex。Host-local dialog: role, profile, CLI, and model before hosting (no default Codex).
- 一键托管后后台已用邀请码进房；座位 Agent 禁止再调 `room_join`、不再向用户索要邀请码。Hosted seat is already joined — no invite re-ask / no second `room_join`.
- 内嵌终端 Ctrl+V / Cmd+V 粘贴剪贴板文字；有文本时不再当成贴图。Docked terminal pastes clipboard text on Ctrl/Cmd+V.
