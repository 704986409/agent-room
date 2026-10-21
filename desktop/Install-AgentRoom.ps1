#Requires -Version 5.1
<#
.SYNOPSIS
  Installs Agent Room wake daemon (Node) for Windows.
  Full Tauri shell (.msi/.exe) is produced by desktop-release.yml on windows-latest,
  or locally: cd desktop; npm ci; npm run package:windows
#>
$ErrorActionPreference = 'Stop'
$Root = Split-Path -Parent $MyInvocation.MyCommand.Path
$Dest = Join-Path $env:LOCALAPPDATA 'AgentRoom\Desktop'
New-Item -ItemType Directory -Force -Path $Dest | Out-Null
New-Item -ItemType Directory -Force -Path (Join-Path $Dest 'daemon') | Out-Null
Copy-Item -Force (Join-Path $Root 'daemon\*') (Join-Path $Dest 'daemon\')
Copy-Item -Force (Join-Path $Root 'scripts\win-cred.ps1') (Join-Path $Dest 'daemon\') -ErrorAction SilentlyContinue

$DefaultServer = 'https://ai-room.pupgo.top'
$CfgDir = Join-Path $env:APPDATA 'agent-room'
New-Item -ItemType Directory -Force -Path $CfgDir | Out-Null
$Cfg = Join-Path $CfgDir 'desktop.json'
$ConfigExists = Test-Path -LiteralPath $Cfg
$CfgSettings = $null
$ConfigRead = $false
$ConfigServer = $null
if ($ConfigExists) {
  try {
    $CfgSettings = Get-Content -Raw -LiteralPath $Cfg | ConvertFrom-Json
    $ConfigRead = $true
    if ($null -ne $CfgSettings) {
      $ServerProperty = $CfgSettings.PSObject.Properties['serverUrl']
      if ($null -ne $ServerProperty -and $ServerProperty.Value -is [string] -and
          -not [string]::IsNullOrWhiteSpace($ServerProperty.Value)) {
        $ConfigServer = $ServerProperty.Value.Trim()
      }
    }
  } catch {
    Write-Warning "Could not read serverUrl from $Cfg; falling back to AGENT_ROOM_SERVER or the default."
  }
}

if ($ConfigServer) {
  $ServerUrl = $ConfigServer
} elseif (-not [string]::IsNullOrWhiteSpace($env:AGENT_ROOM_SERVER)) {
  $ServerUrl = $env:AGENT_ROOM_SERVER.Trim()
} else {
  $ServerUrl = $DefaultServer
}

# Keep a usable config file for the Tauri shell and later installer runs.
if (-not $ConfigExists) {
  $CfgSettings = [pscustomobject]@{ serverUrl = $DefaultServer }
} elseif ($ConfigRead -and -not $ConfigServer) {
  if ($CfgSettings -isnot [System.Management.Automation.PSCustomObject]) {
    $CfgSettings = [pscustomobject]@{}
  }
  $CfgSettings | Add-Member -MemberType NoteProperty -Name 'serverUrl' -Value $DefaultServer -Force
}
if (-not $ConfigExists -or ($ConfigRead -and -not $ConfigServer)) {
  $CfgSettings | ConvertTo-Json -Depth 100 | Set-Content -Encoding UTF8 -Path $Cfg
  Write-Host "Wrote default server URL to $Cfg."
}

$Node = Get-Command node -ErrorAction SilentlyContinue
if (-not $Node) {
  Write-Warning 'Node.js >= 20 not found on PATH. Install from https://nodejs.org then re-run.'
} else {
  $ver = & node -v
  Write-Host "Found Node $ver"
}

$DaemonPath = Join-Path $Dest 'daemon\agent-room-daemon.mjs'
$Wsh = New-Object -ComObject WScript.Shell
$Shortcut = $Wsh.CreateShortcut((Join-Path ([Environment]::GetFolderPath('Desktop')) 'Agent Room Daemon.lnk'))
$Shortcut.TargetPath = 'node'
$Shortcut.Arguments = "`"$DaemonPath`" serve --server `"$ServerUrl`""
$Shortcut.WorkingDirectory = Join-Path $Dest 'daemon'
$Shortcut.IconLocation = 'shell32.dll,13'
$Shortcut.Save()

Write-Host "Installed daemon to $Dest"
Write-Host "Using Agent Room server: $ServerUrl"
Write-Host "Start via Desktop shortcut 'Agent Room Daemon' or:"
Write-Host "  node `"$DaemonPath`" serve --server `"$ServerUrl`""
Write-Host "Then open settings / pair device. Need Node>=20 and a supported agent CLI."
