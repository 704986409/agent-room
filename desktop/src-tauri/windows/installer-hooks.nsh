!include LogicLib.nsh
!include FileFunc.nsh

; Kill the shell + any process still holding install-dir files (bundled
; node.exe → conpty.node / conpty.dll / OpenConsole.exe, or a system node
; running agent-room-daemon.mjs). Used on upgrade before file replace.
!macro AgentRoomKillLockedProcs
  DetailPrint "Closing Agent Room and releasing file locks (conpty/node)..."
  nsExec::ExecToLog 'taskkill /F /IM "Agent Room.exe" /T'
  Pop $0
  ; ExecutablePath under $INSTDIR covers bundled node + OpenConsole; CommandLine
  ; match covers AGENT_ROOM_NODE / PATH node hosting agent-room-daemon.mjs.
  nsExec::ExecToLog 'powershell -NoProfile -ExecutionPolicy Bypass -Command "$$ErrorActionPreference=''SilentlyContinue''; $$root = [regex]::Escape(''$INSTDIR''); $$daemon = ''agent-room-daemon''; 1..3 | ForEach-Object { Get-CimInstance Win32_Process | Where-Object { ($$_.ExecutablePath -and $$_.ExecutablePath -match $$root) -or ($$_.CommandLine -and $$_.CommandLine -match $$daemon) } | ForEach-Object { Stop-Process -Id $$_.ProcessId -Force -ErrorAction SilentlyContinue }; Start-Sleep -Milliseconds 900 }"'
  Pop $0
  Sleep 1500
!macroend

!macro NSIS_HOOK_PREINSTALL
  !insertmacro AgentRoomKillLockedProcs
!macroend

!macro NSIS_HOOK_PREUNINSTALL
  !insertmacro AgentRoomKillLockedProcs
!macroend
