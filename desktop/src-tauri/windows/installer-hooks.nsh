!include LogicLib.nsh
!include FileFunc.nsh

!macro NSIS_HOOK_PREINSTALL
  DetailPrint "Closing Agent Room and releasing file locks..."
  nsExec::ExecToLog 'taskkill /F /IM "Agent Room.exe" /T'
  Pop $0
  ; Daemon keeps ...\Agent Room\node\node.exe open; kill node whose path is under $INSTDIR.
  nsExec::ExecToLog 'powershell -NoProfile -ExecutionPolicy Bypass -Command "$$root = [regex]::Escape(''$INSTDIR''); Get-CimInstance Win32_Process -Filter \"Name=''node.exe''\" | Where-Object { $$_.ExecutablePath -and $$_.ExecutablePath -match $$root } | ForEach-Object { Stop-Process -Id $$_.ProcessId -Force -ErrorAction SilentlyContinue }"'
  Pop $0
  Sleep 2500
!macroend
