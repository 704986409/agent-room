[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)]
    [string]$BaseUrl,

    [string]$TestRoot
)

$ErrorActionPreference = 'Stop'
$repoRoot = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..\..\..'))
$installer = Join-Path $PSScriptRoot '..\AgentRoom-Setup.ps1'
$installer = [IO.Path]::GetFullPath($installer)
$sandboxRoot = if ([string]::IsNullOrWhiteSpace($TestRoot)) {
    Join-Path $repoRoot '.local-installer-e2e\sandbox'
} else {
    [IO.Path]::GetFullPath($TestRoot)
}
$expectedSandbox = [IO.Path]::GetFullPath((Join-Path $repoRoot '.local-installer-e2e\sandbox'))
if ($sandboxRoot -cne $expectedSandbox) {
    throw "Smoke tests may only reset the repository sandbox at $expectedSandbox."
}

$pwsh = Get-Command pwsh -ErrorAction Stop | Select-Object -First 1
$realUserBaseUrlBefore = [Environment]::GetEnvironmentVariable('AGENT_ROOM_BASE_URL', 'User')

function Assert-True {
    param([bool]$Condition, [string]$Message)
    if (-not $Condition) { throw $Message }
}

function Write-Utf8File {
    param([string]$Path, [string]$Content)
    $directory = Split-Path -Parent $Path
    New-Item -ItemType Directory -Path $directory -Force | Out-Null
    [IO.File]::WriteAllText($Path, $Content, [Text.UTF8Encoding]::new($false))
}

function Write-JsonFile {
    param([string]$Path, [System.Collections.IDictionary]$Value)
    Write-Utf8File -Path $Path -Content (ConvertTo-Json -InputObject $Value -Depth 100)
}

function Read-JsonFile {
    param([string]$Path)
    return (ConvertFrom-Json -InputObject ([IO.File]::ReadAllText($Path)) -AsHashtable)
}

function Get-ConfigPaths {
    $sandboxHome = Join-Path $sandboxRoot 'Home'
    $roaming = Join-Path $sandboxRoot 'AppData\Roaming'
    return @(
        (Join-Path $sandboxHome '.claude.json'),
        (Join-Path $sandboxHome '.claude\settings.json'),
        (Join-Path $sandboxHome '.claude\CLAUDE.md'),
        (Join-Path $roaming 'Claude\claude_desktop_config.json'),
        (Join-Path $sandboxHome '.codex\config.toml'),
        (Join-Path $sandboxHome '.codex\AGENTS.md'),
        (Join-Path $sandboxHome '.cursor\mcp.json'),
        (Join-Path $sandboxHome '.cursor\hooks.json'),
        (Join-Path $sandboxHome '.gemini\config\mcp_config.json'),
        (Join-Path $sandboxHome '.gemini\GEMINI.md')
    )
}

function Get-ConfigHashes {
    $hashes = [ordered]@{}
    foreach ($path in (Get-ConfigPaths)) {
        if (Test-Path -LiteralPath $path -PathType Leaf) {
            $hashes[$path] = (Get-FileHash -LiteralPath $path -Algorithm SHA256).Hash
        }
    }
    return $hashes
}

function Invoke-Installer {
    param(
        [Parameter(Mandatory = $true)][string[]]$Arguments,
        [int]$ExpectedExitCode = 0,
        [switch]$CaptureOutput
    )

    $fullArguments = @('-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', $installer) + $Arguments + @('-NonInteractive', '-TestRoot', $sandboxRoot)
    $output = & $pwsh.Source @fullArguments 2>&1
    $actualExitCode = $LASTEXITCODE
    $text = ($output | ForEach-Object { [string]$_ }) -join [Environment]::NewLine
    if ($actualExitCode -ne $ExpectedExitCode) {
        throw "Installer exited $actualExitCode; expected $ExpectedExitCode. Output:`n$text"
    }
    if ($CaptureOutput) { return $text }
    foreach ($line in $output) { Write-Host $line }
}

function Assert-UserDataPreserved {
    $sandboxHome = Join-Path $sandboxRoot 'Home'
    $claude = Read-JsonFile (Join-Path $sandboxHome '.claude.json')
    Assert-True ($claude.userSetting -ceq 'must-survive') 'Claude userSetting was not preserved.'
    Assert-True ($claude.mcpServers['keep-me'].command -ceq 'keep.exe') 'Claude keep-me MCP entry was not preserved.'
    $claudeSettings = Read-JsonFile (Join-Path $sandboxHome '.claude\settings.json')
    $claudeUserHooks = @($claudeSettings.hooks.Stop | ForEach-Object { $_.hooks } | ForEach-Object { $_ } | Where-Object { $_.command -ceq 'keep-user-hook' })
    Assert-True ($claudeUserHooks.Count -eq 1) 'Claude user hook was not preserved.'

    $claudeDesktop = Read-JsonFile (Join-Path $sandboxRoot 'AppData\Roaming\Claude\claude_desktop_config.json')
    Assert-True ($claudeDesktop.userSetting -ceq 'must-survive') 'Claude Desktop userSetting was not preserved.'
    Assert-True ($claudeDesktop.mcpServers['keep-me'].command -ceq 'keep.exe') 'Claude Desktop keep-me MCP entry was not preserved.'

    $cursor = Read-JsonFile (Join-Path $sandboxHome '.cursor\mcp.json')
    Assert-True ($cursor.userSetting -ceq 'must-survive') 'Cursor userSetting was not preserved.'
    Assert-True ($cursor.mcpServers['keep-me'].command -ceq 'keep.exe') 'Cursor keep-me MCP entry was not preserved.'
    $cursorHooks = Read-JsonFile (Join-Path $sandboxHome '.cursor\hooks.json')
    $cursorUserHooks = @($cursorHooks.hooks.stop | Where-Object { $_.command -ceq 'keep-user-hook' })
    Assert-True ($cursorUserHooks.Count -eq 1 -and $cursorUserHooks[0].loop_limit -eq 7) 'Cursor user hook was not preserved.'

    $codex = [IO.File]::ReadAllText((Join-Path $sandboxHome '.codex\config.toml'))
    Assert-True ($codex -match '(?m)^model\s*=\s*"gpt-test"\s*$') 'Codex model was not preserved.'
    Assert-True ($codex -match '(?m)^command\s*=\s*"keep\.exe"\s*$') 'Codex keep-me MCP entry was not preserved.'
    Assert-True ($codex -match '(?m)^trusted_hash\s*=\s*"DO-NOT-TOUCH"\s*$') 'Codex hooks.state trusted_hash was changed.'
    Assert-True ($codex -match '(?m)^command\s*=\s*"keep-user-hook"\s*$') 'The user Codex hook was not preserved.'

    $gemini = Read-JsonFile (Join-Path $sandboxHome '.gemini\config\mcp_config.json')
    Assert-True ($gemini.mcpServers['keep-me'].command -ceq 'keep.exe') 'Gemini keep-me MCP entry was not preserved.'

    foreach ($rulesPath in @(
        (Join-Path $sandboxHome '.claude\CLAUDE.md'),
        (Join-Path $sandboxHome '.codex\AGENTS.md'),
        (Join-Path $sandboxHome '.gemini\GEMINI.md')
    )) {
        $rules = [IO.File]::ReadAllText($rulesPath)
        Assert-True ($rules.Contains('USER TEXT BEFORE') -and $rules.Contains('USER TEXT AFTER')) "User rules text was not preserved in $rulesPath."
    }
}

if (Test-Path -LiteralPath $sandboxRoot) {
    $resolvedSandbox = [IO.Path]::GetFullPath((Resolve-Path -LiteralPath $sandboxRoot).Path)
    if ($resolvedSandbox -cne $expectedSandbox) { throw "Refusing to reset unexpected test directory: $resolvedSandbox" }
    Remove-Item -LiteralPath $resolvedSandbox -Recurse -Force
}

$homeRoot = Join-Path $sandboxRoot 'Home'
$claudeServers = [ordered]@{
    'keep-me' = [ordered]@{ command = 'keep.exe' }
    'agent-room' = [ordered]@{
        command = 'npx'
        args = @('-y', 'agent-room-mcp')
        env = [ordered]@{ CLAUDECODE = 'keep-claude-marker'; CLAUDE_CODE_ENTRYPOINT = 'keep-entrypoint' }
    }
}
Write-JsonFile (Join-Path $homeRoot '.claude.json') ([ordered]@{
    mcpServers = $claudeServers
    userSetting = 'must-survive'
})
Write-JsonFile (Join-Path $homeRoot '.claude\settings.json') ([ordered]@{
    hooks = [ordered]@{
        Stop = @([ordered]@{ hooks = @([ordered]@{ type = 'command'; command = 'keep-user-hook' }) })
    }
})
Write-JsonFile (Join-Path $sandboxRoot 'AppData\Roaming\Claude\claude_desktop_config.json') ([ordered]@{
    mcpServers = [ordered]@{ 'keep-me' = [ordered]@{ command = 'keep.exe' } }
    userSetting = 'must-survive'
})
Write-Utf8File (Join-Path $homeRoot '.claude\CLAUDE.md') "USER TEXT BEFORE`nUSER TEXT AFTER`n"

Write-JsonFile (Join-Path $homeRoot '.cursor\mcp.json') ([ordered]@{
    mcpServers = [ordered]@{
        'keep-me' = [ordered]@{ command = 'keep.exe' }
    }
    userSetting = 'must-survive'
})
Write-JsonFile (Join-Path $homeRoot '.cursor\hooks.json') ([ordered]@{
    version = 1
    hooks = [ordered]@{
        stop = @([ordered]@{ command = 'keep-user-hook'; loop_limit = 7 })
    }
})

Write-JsonFile (Join-Path $homeRoot '.gemini\config\mcp_config.json') ([ordered]@{
    mcpServers = [ordered]@{
        'keep-me' = [ordered]@{ command = 'keep.exe' }
        'agent-room' = [ordered]@{ env = [ordered]@{ GEMINI_USER_MARKER = 'keep-gemini-marker' } }
    }
})
Write-Utf8File (Join-Path $homeRoot '.gemini\GEMINI.md') "USER TEXT BEFORE`nUSER TEXT AFTER`n"

Write-Utf8File (Join-Path $homeRoot '.codex\config.toml') @'
model = "gpt-test"

[mcp_servers.keep-me]
command = "keep.exe"

[[hooks.Stop]]
matcher = ""
[[hooks.Stop.hooks]]
type = "command"
command = "keep-user-hook"

[hooks.state]
trusted_hash = "DO-NOT-TOUCH"
'@
Write-Utf8File (Join-Path $homeRoot '.codex\AGENTS.md') "USER TEXT BEFORE`nUSER TEXT AFTER`n"

$installArgs = @('install', '-BaseUrl', $BaseUrl, '-Clients', 'claude,codex,cursor,gemini', '-McpVersion', '0.26.24')
Write-Host 'Sandbox install'
Invoke-Installer -Arguments $installArgs | Out-Null
Assert-UserDataPreserved

$statePath = Join-Path $sandboxRoot 'AgentRoomState\install-state.json'
$state = Read-JsonFile $statePath
Assert-True ($state.baseUrl -ceq ($BaseUrl.TrimEnd('/'))) 'Install state contains an unexpected BaseUrl.'
Assert-True ($state.mcpVersion -ceq '0.26.24') 'Install state contains an unexpected MCP version.'
Assert-True (@($state.clients) -contains 'gemini-antigravity') 'Gemini and Antigravity were not normalized to one target.'

$gemini = Read-JsonFile (Join-Path $homeRoot '.gemini\config\mcp_config.json')
Assert-True ($gemini.mcpServers['agent-room'].env['GEMINI_USER_MARKER'] -ceq 'keep-gemini-marker') 'Gemini user environment marker was not preserved.'
$claude = Read-JsonFile (Join-Path $homeRoot '.claude.json')
Assert-True ($claude.mcpServers['agent-room'].env['CLAUDECODE'] -ceq 'keep-claude-marker') 'Claude environment marker was not preserved.'
Assert-True ($claude.mcpServers['agent-room'].env['CLAUDE_CODE_ENTRYPOINT'] -ceq 'keep-entrypoint') 'Claude entrypoint marker was not preserved.'

foreach ($path in @(
    (Join-Path $homeRoot '.claude.json'),
    (Join-Path $homeRoot '.cursor\mcp.json'),
    (Join-Path $homeRoot '.gemini\config\mcp_config.json')
)) {
    $document = Read-JsonFile $path
    $entry = $document.mcpServers['agent-room']
    Assert-True ((@($entry.args) -join '|') -ceq '-y|agent-room-mcp@0.26.24') "MCP package was not pinned in $path."
    Assert-True ($entry.env.AGENT_ROOM_BASE_URL -ceq $BaseUrl.TrimEnd('/')) "BaseUrl was not written to $path."
}

Write-Host 'Repair idempotency x2'
Invoke-Installer -Arguments (@('repair', '-McpVersion', '0.26.24')) | Out-Null
Invoke-Installer -Arguments (@('repair', '-McpVersion', '0.26.24')) | Out-Null
Assert-UserDataPreserved

Write-Host 'Status online'
$statusOutput = Invoke-Installer -Arguments @('status') -CaptureOutput
Assert-True ($statusOutput.Contains('API: ONLINE')) 'Status did not report API ONLINE.'
Assert-True ($statusOutput.Contains('Claude') -and $statusOutput.Contains('Codex') -and $statusOutput.Contains('Cursor') -and $statusOutput.Contains('Gemini / Antigravity')) 'Status omitted one or more installed clients.'

Write-Host 'Status offline and read-only check'
$beforeOffline = Get-ConfigHashes
$offlineOutput = Invoke-Installer -Arguments @('status', '-BaseUrl', 'http://127.0.0.1:39999') -ExpectedExitCode 1 -CaptureOutput
$afterOffline = Get-ConfigHashes
Assert-True ($offlineOutput.Contains('API: OFFLINE')) 'Offline status did not report API OFFLINE.'
Assert-True ((ConvertTo-Json $beforeOffline -Compress) -ceq (ConvertTo-Json $afterOffline -Compress)) 'Offline status modified client configuration.'

Write-Host 'Uninstall and verify preserved user content'
Invoke-Installer -Arguments @('uninstall') | Out-Null
$claude = Read-JsonFile (Join-Path $homeRoot '.claude.json')
Assert-True ($null -eq $claude.mcpServers['agent-room']) 'Claude Agent Room MCP entry remains after uninstall.'
Assert-True ($claude.mcpServers['keep-me'].command -ceq 'keep.exe') 'Claude keep-me entry was removed during uninstall.'
Assert-True ($claude.userSetting -ceq 'must-survive') 'Claude userSetting was changed during uninstall.'
$cursor = Read-JsonFile (Join-Path $homeRoot '.cursor\mcp.json')
Assert-True ($null -eq $cursor.mcpServers['agent-room']) 'Cursor Agent Room MCP entry remains after uninstall.'
Assert-True ($cursor.mcpServers['keep-me'].command -ceq 'keep.exe') 'Cursor keep-me entry was removed during uninstall.'
$gemini = Read-JsonFile (Join-Path $homeRoot '.gemini\config\mcp_config.json')
Assert-True ($null -eq $gemini.mcpServers['agent-room']) 'Gemini Agent Room MCP entry remains after uninstall.'
Assert-True ($gemini.mcpServers['keep-me'].command -ceq 'keep.exe') 'Gemini keep-me entry was removed during uninstall.'
foreach ($rulesPath in @(
    (Join-Path $homeRoot '.claude\CLAUDE.md'),
    (Join-Path $homeRoot '.codex\AGENTS.md'),
    (Join-Path $homeRoot '.gemini\GEMINI.md')
)) {
    $rules = [IO.File]::ReadAllText($rulesPath)
    Assert-True (-not $rules.Contains('<!-- BEGIN agent-room rules')) "Managed Agent Room rules remain in $rulesPath."
}
$codexAfterUninstall = [IO.File]::ReadAllText((Join-Path $homeRoot '.codex\config.toml'))
Assert-True (-not $codexAfterUninstall.Contains('[mcp_servers.agent-room]')) 'Codex Agent Room MCP table remains after uninstall.'
Assert-True ($codexAfterUninstall -match '(?m)^trusted_hash\s*=\s*"DO-NOT-TOUCH"\s*$') 'Codex trusted_hash was removed during uninstall.'
$claudeHooksAfterUninstall = Read-JsonFile (Join-Path $homeRoot '.claude\settings.json')
foreach ($event in @('Stop', 'UserPromptSubmit', 'SessionStart')) {
    $groups = $claudeHooksAfterUninstall.hooks[$event]
    $agentHookCount = @($groups | ForEach-Object { $_.hooks } | ForEach-Object { $_ } | Where-Object { $_.command -match '(?i)agent-room-mcp.*\bhook\b' }).Count
    Assert-True ($agentHookCount -eq 0) "Claude Agent Room $event hook remains after uninstall."
}
Assert-UserDataPreserved
$desktopAfterUninstall = Read-JsonFile (Join-Path $sandboxRoot 'AppData\Roaming\Claude\claude_desktop_config.json')
Assert-True ($null -eq $desktopAfterUninstall.mcpServers['agent-room']) 'Claude Desktop Agent Room MCP entry remains after uninstall.'
$testEnvPath = Join-Path $sandboxRoot 'AgentRoomState\test-env.json'
Assert-True (-not (Test-Path -LiteralPath $testEnvPath)) 'Matching TestRoot environment record was not removed by uninstall.'
$backupFiles = @(Get-ChildItem -LiteralPath (Join-Path $sandboxRoot 'AgentRoomState\backups') -Filter '*.bak' -Recurse -File)
Assert-True ($backupFiles.Count -gt 0) 'Existing client configuration files were not backed up.'
$uninstalledStatus = Invoke-Installer -Arguments @('status') -CaptureOutput
Assert-True ($uninstalledStatus.Contains('NOT INSTALLED')) 'Uninstall status did not report NOT INSTALLED.'

Write-Host 'Reinstall'
Invoke-Installer -Arguments $installArgs | Out-Null
Assert-UserDataPreserved

$realUserBaseUrlAfter = [Environment]::GetEnvironmentVariable('AGENT_ROOM_BASE_URL', 'User')
Assert-True ($realUserBaseUrlBefore -ceq $realUserBaseUrlAfter) 'TestRoot changed the real Windows User AGENT_ROOM_BASE_URL.'
Write-Host 'Sandbox smoke test PASS'
