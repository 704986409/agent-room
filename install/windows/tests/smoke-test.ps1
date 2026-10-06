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
        (Join-Path $sandboxHome '.gemini\GEMINI.md'),
        (Join-Path $sandboxRoot 'AppData\Roaming\Code\User\mcp.json'),
        (Join-Path $sandboxHome '.copilot\mcp-config.json')
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

    $vscode = Read-JsonFile (Join-Path $sandboxRoot 'AppData\Roaming\Code\User\mcp.json')
    Assert-True ($vscode.userSetting -ceq 'must-survive') 'VS Code userSetting was not preserved.'
    Assert-True ($vscode.servers['keep-me'].command -ceq 'keep.exe') 'VS Code keep-me MCP entry was not preserved.'
    $copilot = Read-JsonFile (Join-Path $sandboxHome '.copilot\mcp-config.json')
    Assert-True ($copilot.userSetting -ceq 'must-survive') 'Copilot userSetting was not preserved.'
    Assert-True ($copilot.mcpServers['keep-me'].command -ceq 'keep.exe') 'Copilot keep-me MCP entry was not preserved.'

    foreach ($rulesPath in @(
        (Join-Path $sandboxHome '.claude\CLAUDE.md'),
        (Join-Path $sandboxHome '.codex\AGENTS.md'),
        (Join-Path $sandboxHome '.gemini\GEMINI.md')
    )) {
        $rules = [IO.File]::ReadAllText($rulesPath)
        Assert-True ($rules.Contains('USER TEXT BEFORE') -and $rules.Contains('USER TEXT AFTER')) "User rules text was not preserved in $rulesPath."
    }
}

function Set-AgentRoomTestEnvValue {
    param([string]$Path, [string]$RootKey, [string]$Name, [string]$Value)
    $document = Read-JsonFile $Path
    $entry = $document[$RootKey]['agent-room']
    $environment = $entry.env
    $found = $false
    foreach ($key in @($environment.Keys)) {
        if ([string]$key -ieq $Name) {
            $environment[$key] = $Value
            $found = $true
            break
        }
    }
    if (-not $found) { $environment[$Name] = $Value }
    Write-JsonFile $Path $document
}

function Get-AgentRoomTestEnvValue {
    param([string]$Path, [string]$RootKey, [string]$Name)
    $document = Read-JsonFile $Path
    $environment = $document[$RootKey]['agent-room'].env
    foreach ($key in $environment.Keys) {
        if ([string]$key -ieq $Name) { return $environment[$key] }
    }
    return $null
}

function Set-AgentRoomTestHookVersion {
    param([string]$Client, [string]$FromVersion, [string]$ToVersion)
    $oldCommand = "npx -y agent-room-mcp@$FromVersion hook"
    $newCommand = "npx -y agent-room-mcp@$ToVersion hook"
    switch ($Client) {
        'claude' {
            $path = Join-Path $sandboxRoot 'Home\.claude\settings.json'
            $document = Read-JsonFile $path
            foreach ($group in @($document.hooks.Stop)) {
                foreach ($hook in @($group.hooks)) {
                    if ($hook.command -ceq $oldCommand) { $hook.command = $newCommand; Write-JsonFile $path $document; return }
                }
            }
            throw 'Could not find the Claude Stop Hook to change its test version.'
        }
        'codex' {
            $path = Join-Path $sandboxRoot 'Home\.codex\config.toml'
            $content = [IO.File]::ReadAllText($path)
            $oldLine = 'command = "' + $oldCommand + '"'
            $newLine = 'command = "' + $newCommand + '"'
            $lines = [System.Collections.Generic.List[string]]::new()
            foreach ($line in ($content.Replace("`r`n", "`n").Split([char]10))) { $lines.Add([string]$line) }
            $inStop = $false
            for ($index = 0; $index -lt $lines.Count; $index++) {
                if ($lines[$index].Trim() -ceq '[[hooks.Stop]]') { $inStop = $true; continue }
                if ($lines[$index].Trim() -ceq '[[hooks.Stop.hooks]]') { continue }
                if ($lines[$index] -match '^\s*\[') { $inStop = $false; continue }
                if ($inStop -and $lines[$index].Trim() -ceq $oldLine) {
                    $lines[$index] = $newLine
                    $newline = if ($content.Contains("`r`n")) { "`r`n" } else { "`n" }
                    [IO.File]::WriteAllText($path, [string]::Join($newline, $lines.ToArray()), [Text.UTF8Encoding]::new($false))
                    return
                }
            }
            throw 'Could not find the Codex Stop Hook to change its test version.'
        }
        'cursor' {
            $path = Join-Path $sandboxRoot 'Home\.cursor\hooks.json'
            $document = Read-JsonFile $path
            foreach ($hook in @($document.hooks.stop)) {
                if ($hook.command -ceq $oldCommand) { $hook.command = $newCommand; Write-JsonFile $path $document; return }
            }
            throw 'Could not find the Cursor Stop Hook to change its test version.'
        }
        default { throw "Unsupported smoke-test hook client '$Client'." }
    }
}

function Assert-AgentRoomPackageAndHookVersion {
    param([string]$Version)
    foreach ($path in @(
        (Join-Path $sandboxRoot 'Home\.claude.json'),
        (Join-Path $sandboxRoot 'AppData\Roaming\Claude\claude_desktop_config.json'),
        (Join-Path $sandboxRoot 'Home\.cursor\mcp.json'),
        (Join-Path $sandboxRoot 'Home\.gemini\config\mcp_config.json'),
        (Join-Path $sandboxRoot 'AppData\Roaming\Code\User\mcp.json'),
        (Join-Path $sandboxRoot 'Home\.copilot\mcp-config.json')
    )) {
        $document = Read-JsonFile $path
        $isVsCode = $path -like '*Code\User\mcp.json'
        $rootKey = if ($isVsCode) { 'servers' } else { 'mcpServers' }
        $entry = $document[$rootKey]['agent-room']
        $expectedArgs = if ($isVsCode) { "/c|npx|-y|agent-room-mcp@$Version" } else { "-y|agent-room-mcp@$Version" }
        Assert-True ((@($entry.args) -join '|') -ceq $expectedArgs) "MCP package version $Version was not written in $path."
    }
    foreach ($path in @(
        (Join-Path $sandboxRoot 'Home\.claude\settings.json'),
        (Join-Path $sandboxRoot 'Home\.cursor\hooks.json'),
        (Join-Path $sandboxRoot 'Home\.codex\config.toml')
    )) {
        Assert-True ([IO.File]::ReadAllText($path).Contains("agent-room-mcp@$Version hook")) "Hook version $Version was not written in $path."
    }
}

$resolverProbe = {
    param([string]$InstallerPath, [bool]$Explicit, [string]$Version, [string]$Mode, [AllowNull()][object]$State)
    if ($Explicit) { . $InstallerPath -McpVersion $Version } else { . $InstallerPath }
    Resolve-AgentRoomEffectiveMcpVersion -Mode $Mode -State $State
}
$resolverState = [ordered]@{ mcpVersion = '1.2.3' }
Assert-True ((& $resolverProbe $installer $false '9.9.9' 'install' $null) -ceq '0.26.24') 'Install resolver did not use its default version when the option was omitted.'
Assert-True ((& $resolverProbe $installer $true '9.9.9' 'install' $null) -ceq '9.9.9') 'Install resolver ignored an explicitly supplied version.'
Assert-True ((& $resolverProbe $installer $false '9.9.9' 'repair' $resolverState) -ceq '1.2.3') 'Repair resolver did not inherit the saved state version.'
Assert-True ((& $resolverProbe $installer $true '9.9.9' 'repair' $resolverState) -ceq '9.9.9') 'Repair resolver ignored an explicit version override.'
Assert-True ((& $resolverProbe $installer $true '9.9.9' 'status' $resolverState) -ceq '1.2.3') 'Status resolver did not use the state version.'
Assert-True ($null -eq (& $resolverProbe $installer $false '9.9.9' 'status' ([ordered]@{}))) 'Status resolver accepted a state without a version.'

if (Test-Path -LiteralPath $sandboxRoot) {
    $resolvedSandbox = [IO.Path]::GetFullPath((Resolve-Path -LiteralPath $sandboxRoot).Path)
    if ($resolvedSandbox -cne $expectedSandbox) { throw "Refusing to reset unexpected test directory: $resolvedSandbox" }
    Remove-Item -LiteralPath $resolvedSandbox -Recurse -Force
}

$homeRoot = Join-Path $sandboxRoot 'Home'
$wrongBaseUrl = 'https://wrong.example'
$claudeServers = [ordered]@{
    'keep-me' = [ordered]@{ command = 'keep.exe' }
    'agent-room' = [ordered]@{
        command = 'npx'
        args = @('-y', 'agent-room-mcp')
        env = [ordered]@{
            claudecode = 'BROKEN'
            CUSTOM_USER_VAR = 'keep-me'
            HTTP_PROXY = 'http://127.0.0.1:7890'
            AGENT_ROOM_BASE_URL = $wrongBaseUrl
        }
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
    mcpServers = [ordered]@{
        'keep-me' = [ordered]@{ command = 'keep.exe' }
        'agent-room' = [ordered]@{
            env = [ordered]@{
                CLAUDECODE = 'BROKEN'
                CLAUDE_CODE_ENTRYPOINT = 'BROKEN'
                CUSTOM_USER_VAR = 'keep-me'
                HTTP_PROXY = 'http://127.0.0.1:7890'
                AGENT_ROOM_BASE_URL = $wrongBaseUrl
            }
        }
    }
    userSetting = 'must-survive'
})
Write-Utf8File (Join-Path $homeRoot '.claude\CLAUDE.md') "USER TEXT BEFORE`nUSER TEXT AFTER`n"

Write-JsonFile (Join-Path $homeRoot '.cursor\mcp.json') ([ordered]@{
    mcpServers = [ordered]@{
        'keep-me' = [ordered]@{ command = 'keep.exe' }
        'agent-room' = [ordered]@{
            env = [ordered]@{
                CUSTOM_USER_VAR = 'keep-me'
                HTTP_PROXY = 'http://127.0.0.1:7890'
                AGENT_ROOM_BASE_URL = $wrongBaseUrl
            }
        }
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
        'agent-room' = [ordered]@{
            env = [ordered]@{
                ANTIGRAVITY_CLI = 'BROKEN'
                CUSTOM_USER_VAR = 'keep-me'
                HTTP_PROXY = 'http://127.0.0.1:7890'
                AGENT_ROOM_BASE_URL = $wrongBaseUrl
            }
        }
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

$vscodePath = Join-Path $sandboxRoot 'AppData\Roaming\Code\User\mcp.json'
Write-JsonFile $vscodePath ([ordered]@{
    servers = [ordered]@{
        'keep-me' = [ordered]@{ command = 'keep.exe' }
        'agent-room' = [ordered]@{
            env = [ordered]@{
                GITHUB_COPILOT = 'BROKEN'
                CUSTOM_USER_VAR = 'keep-me'
                HTTP_PROXY = 'http://127.0.0.1:7890'
                AGENT_ROOM_BASE_URL = $wrongBaseUrl
            }
        }
    }
    userSetting = 'must-survive'
})
Write-JsonFile (Join-Path $homeRoot '.copilot\mcp-config.json') ([ordered]@{
    mcpServers = [ordered]@{
        'keep-me' = [ordered]@{ command = 'keep.exe' }
        'agent-room' = [ordered]@{
            env = [ordered]@{
                GITHUB_COPILOT = 'BROKEN'
                CUSTOM_USER_VAR = 'keep-me'
                HTTP_PROXY = 'http://127.0.0.1:7890'
                AGENT_ROOM_BASE_URL = $wrongBaseUrl
            }
        }
    }
    userSetting = 'must-survive'
})

$stateVersionUnderTest = '0.26.23'
$wrongHookVersion = '0.25.0'
$defaultMcpVersion = '0.26.24'
$allClients = 'claude,codex,cursor,gemini,vscode,copilot'
$installArgs = @('install', '-BaseUrl', $BaseUrl, '-Clients', $allClients, '-McpVersion', $stateVersionUnderTest)
Write-Host 'Sandbox install'
Invoke-Installer -Arguments $installArgs | Out-Null
Assert-UserDataPreserved

$statePath = Join-Path $sandboxRoot 'AgentRoomState\install-state.json'
$state = Read-JsonFile $statePath
Assert-True ($state.baseUrl -ceq ($BaseUrl.TrimEnd('/'))) 'Install state contains an unexpected BaseUrl.'
Assert-True ($state.mcpVersion -ceq $stateVersionUnderTest) 'Install state contains an unexpected MCP version.'
Assert-True (@($state.clients) -contains 'gemini-antigravity') 'Gemini and Antigravity were not normalized to one target.'
Assert-True (@($state.clients) -contains 'vscode-copilot') 'VS Code and Copilot were not normalized to one target.'

$markerSpecs = @(
    @{ Path = (Join-Path $homeRoot '.claude.json'); RootKey = 'mcpServers'; Name = 'CLAUDECODE' }
    @{ Path = (Join-Path $sandboxRoot 'AppData\Roaming\Claude\claude_desktop_config.json'); RootKey = 'mcpServers'; Name = 'CLAUDECODE' }
    @{ Path = (Join-Path $sandboxRoot 'AppData\Roaming\Claude\claude_desktop_config.json'); RootKey = 'mcpServers'; Name = 'CLAUDE_CODE_ENTRYPOINT' }
    @{ Path = (Join-Path $homeRoot '.gemini\config\mcp_config.json'); RootKey = 'mcpServers'; Name = 'ANTIGRAVITY_CLI' }
    @{ Path = $vscodePath; RootKey = 'servers'; Name = 'GITHUB_COPILOT' }
    @{ Path = (Join-Path $homeRoot '.copilot\mcp-config.json'); RootKey = 'mcpServers'; Name = 'GITHUB_COPILOT' }
)
$markerSnapshot = @{}
foreach ($spec in $markerSpecs) {
    $actual = [string](Get-AgentRoomTestEnvValue -Path $spec.Path -RootKey $spec.RootKey -Name $spec.Name)
    Assert-True (-not [string]::IsNullOrWhiteSpace($actual) -and $actual -cne 'BROKEN') "Upstream marker $($spec.Name) was not normalized from the current init output in $($spec.Path)."
    $markerSnapshot[($spec.Path + '|' + $spec.Name)] = $actual
}
$claudeCliEntry = (Read-JsonFile (Join-Path $homeRoot '.claude.json')).mcpServers['agent-room']
Assert-True (@($claudeCliEntry.env.Keys | Where-Object { [string]$_ -ieq 'CLAUDECODE' }).Count -eq 1) 'Claude marker merge created a case-duplicate environment key.'
foreach ($path in @(
    (Join-Path $homeRoot '.claude.json'),
    (Join-Path $sandboxRoot 'AppData\Roaming\Claude\claude_desktop_config.json'),
    (Join-Path $homeRoot '.cursor\mcp.json'),
    (Join-Path $homeRoot '.gemini\config\mcp_config.json'),
    $vscodePath,
    (Join-Path $homeRoot '.copilot\mcp-config.json')
)) {
    $document = Read-JsonFile $path
    $rootKey = if ($path -ceq $vscodePath) { 'servers' } else { 'mcpServers' }
    $entry = $document[$rootKey]['agent-room']
    Assert-True ($entry.env.AGENT_ROOM_BASE_URL -ceq $BaseUrl.TrimEnd('/')) "Installer did not override AGENT_ROOM_BASE_URL in $path."
    Assert-True ($entry.env.CUSTOM_USER_VAR -ceq 'keep-me') "CUSTOM_USER_VAR was not preserved in $path."
    Assert-True ($entry.env.HTTP_PROXY -ceq 'http://127.0.0.1:7890') "HTTP_PROXY was not preserved in $path."
}
Assert-AgentRoomPackageAndHookVersion $stateVersionUnderTest

Write-Host 'Corrupt managed markers, then repair using state version'
foreach ($spec in $markerSpecs) { Set-AgentRoomTestEnvValue -Path $spec.Path -RootKey $spec.RootKey -Name $spec.Name -Value 'BROKEN' }
Invoke-Installer -Arguments @('repair') | Out-Null
$state = Read-JsonFile $statePath
Assert-True ($state.mcpVersion -ceq $stateVersionUnderTest) 'Repair without -McpVersion did not inherit install-state.mcpVersion.'
foreach ($spec in $markerSpecs) {
    $actual = [string](Get-AgentRoomTestEnvValue -Path $spec.Path -RootKey $spec.RootKey -Name $spec.Name)
    Assert-True ($actual -ceq $markerSnapshot[($spec.Path + '|' + $spec.Name)]) "Repair did not restore upstream marker $($spec.Name) in $($spec.Path)."
}
Assert-AgentRoomPackageAndHookVersion $stateVersionUnderTest
Assert-UserDataPreserved

Write-Host 'Repair idempotency x2 without an explicit version'
Invoke-Installer -Arguments @('repair') | Out-Null
Invoke-Installer -Arguments @('repair') | Out-Null
Assert-True ((Read-JsonFile $statePath).mcpVersion -ceq $stateVersionUnderTest) 'Repeated repair changed the saved MCP version.'
Assert-AgentRoomPackageAndHookVersion $stateVersionUnderTest
Assert-UserDataPreserved

Write-Host 'Explicit repair version override'
Invoke-Installer -Arguments @('repair', '-McpVersion', $defaultMcpVersion) | Out-Null
Assert-True ((Read-JsonFile $statePath).mcpVersion -ceq $defaultMcpVersion) 'Explicit repair version did not update install state.'
Assert-AgentRoomPackageAndHookVersion $defaultMcpVersion

Write-Host 'Status online'
$statusOutput = Invoke-Installer -Arguments @('status') -CaptureOutput
Assert-True ($statusOutput.Contains('API: ONLINE')) 'Status did not report API ONLINE.'
Assert-True ($statusOutput.Contains('MCP package: agent-room-mcp@' + $defaultMcpVersion)) 'Status did not use the saved MCP package version.'
Assert-True ($statusOutput.Contains('Claude') -and $statusOutput.Contains('Codex') -and $statusOutput.Contains('Cursor') -and $statusOutput.Contains('Gemini / Antigravity') -and $statusOutput.Contains('VS Code / Copilot')) 'Status omitted one or more installed clients.'
$explicitStatusOutput = Invoke-Installer -Arguments @('status', '-McpVersion', '9.9.9') -CaptureOutput
Assert-True ($explicitStatusOutput.Contains('MCP package: agent-room-mcp@' + $defaultMcpVersion)) 'Status incorrectly used the command-line version instead of install-state.mcpVersion.'

Write-Host 'Status with missing saved version is read-only and needs repair'
$savedState = Read-JsonFile $statePath
$savedVersion = $savedState.mcpVersion
$savedState.Remove('mcpVersion')
Write-JsonFile $statePath $savedState
$missingVersionConfigHashes = Get-ConfigHashes
$missingVersionStateHash = (Get-FileHash -LiteralPath $statePath -Algorithm SHA256).Hash
$missingVersionOutput = Invoke-Installer -Arguments @('status') -ExpectedExitCode 1 -CaptureOutput
Assert-True ($missingVersionOutput.Contains('MCP package: NEEDS REPAIR')) 'Status did not report a missing install-state MCP version.'
Assert-True ((ConvertTo-Json $missingVersionConfigHashes -Compress) -ceq (ConvertTo-Json (Get-ConfigHashes) -Compress)) 'Status with a missing version modified client configuration.'
Assert-True ($missingVersionStateHash -ceq (Get-FileHash -LiteralPath $statePath -Algorithm SHA256).Hash) 'Status with a missing version modified install state.'
$savedState.mcpVersion = $savedVersion
Write-JsonFile $statePath $savedState

Write-Host 'Wrong pinned Hook version matrix: read-only status, then state-version repair'
foreach ($client in @('claude', 'codex', 'cursor')) {
    Set-AgentRoomTestHookVersion -Client $client -FromVersion $defaultMcpVersion -ToVersion $wrongHookVersion
    $beforeWrongVersionStatus = Get-ConfigHashes
    $wrongVersionOutput = Invoke-Installer -Arguments @('status') -ExpectedExitCode 1 -CaptureOutput
    $afterWrongVersionStatus = Get-ConfigHashes
    Assert-True ($wrongVersionOutput.Contains('NEEDS REPAIR')) "Status did not detect the wrong pinned $client Hook version."
    Assert-True ((ConvertTo-Json $beforeWrongVersionStatus -Compress) -ceq (ConvertTo-Json $afterWrongVersionStatus -Compress)) "Status changed configuration while detecting the wrong $client Hook version."
    Invoke-Installer -Arguments @('repair') | Out-Null
    Assert-True ((Read-JsonFile $statePath).mcpVersion -ceq $defaultMcpVersion) "Repair changed the saved version while restoring $client hooks."
    Assert-AgentRoomPackageAndHookVersion $defaultMcpVersion
    $repairedStatus = Invoke-Installer -Arguments @('status') -CaptureOutput
    Assert-True ($repairedStatus.Contains('API: ONLINE')) "Status did not pass after repairing the $client Hook version."
}

Write-Host 'Status offline and read-only check'
$beforeOffline = Get-ConfigHashes
$offlineOutput = Invoke-Installer -Arguments @('status', '-BaseUrl', 'http://127.0.0.1:39999') -ExpectedExitCode 1 -CaptureOutput
$afterOffline = Get-ConfigHashes
Assert-True ($offlineOutput.Contains('API: OFFLINE')) 'Offline status did not report API OFFLINE.'
Assert-True ((ConvertTo-Json $beforeOffline -Compress) -ceq (ConvertTo-Json $afterOffline -Compress)) 'Offline status modified client configuration.'

Write-Host 'Leave an old-version Hook for uninstall ownership check'
foreach ($client in @('claude', 'codex', 'cursor')) {
    Set-AgentRoomTestHookVersion -Client $client -FromVersion $defaultMcpVersion -ToVersion $wrongHookVersion
}

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
Assert-True (-not ($codexAfterUninstall -match '(?i)agent-room-mcp(?:@[^\s"'']+)?\s+hook')) 'Codex old-version Agent Room Hook remains after uninstall.'
Assert-True ($codexAfterUninstall -match '(?m)^trusted_hash\s*=\s*"DO-NOT-TOUCH"\s*$') 'Codex trusted_hash was removed during uninstall.'
$claudeHooksAfterUninstall = Read-JsonFile (Join-Path $homeRoot '.claude\settings.json')
foreach ($event in @('Stop', 'UserPromptSubmit', 'SessionStart')) {
    $groups = $claudeHooksAfterUninstall.hooks[$event]
    $agentHookCount = @($groups | ForEach-Object { $_.hooks } | ForEach-Object { $_ } | Where-Object { $_.command -match '(?i)agent-room-mcp.*\bhook\b' }).Count
    Assert-True ($agentHookCount -eq 0) "Claude Agent Room $event hook remains after uninstall."
}
$cursorHooksAfterUninstall = Read-JsonFile (Join-Path $homeRoot '.cursor\hooks.json')
$cursorAgentHookCount = @($cursorHooksAfterUninstall.hooks.stop | Where-Object { $_.command -match '(?i)agent-room-mcp.*\bhook\b' }).Count
Assert-True ($cursorAgentHookCount -eq 0) 'Cursor old-version Agent Room Hook remains after uninstall.'
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
Invoke-Installer -Arguments @('install', '-BaseUrl', $BaseUrl, '-Clients', $allClients) | Out-Null
Assert-UserDataPreserved
Assert-True ((Read-JsonFile $statePath).mcpVersion -ceq $defaultMcpVersion) 'Install without -McpVersion did not use the default version.'
Assert-AgentRoomPackageAndHookVersion $defaultMcpVersion

$realUserBaseUrlAfter = [Environment]::GetEnvironmentVariable('AGENT_ROOM_BASE_URL', 'User')
Assert-True ($realUserBaseUrlBefore -ceq $realUserBaseUrlAfter) 'TestRoot changed the real Windows User AGENT_ROOM_BASE_URL.'
Write-Host 'Sandbox smoke test PASS'
