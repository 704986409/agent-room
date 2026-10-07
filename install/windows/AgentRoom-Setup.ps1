[CmdletBinding()]
param(
    [ValidateSet('install', 'repair', 'status', 'uninstall')]
    [string]$Action = 'install',

    [string]$BaseUrl,

    [string[]]$Clients,

    [string]$McpVersion = '0.26.24',

    [switch]$NonInteractive,

    [string]$TestRoot
)

$script:McpVersionWasExplicit = $PSBoundParameters.ContainsKey('McpVersion')
$ErrorActionPreference = 'Stop'
$script:DefaultBaseUrl = ''
$script:McpPackageName = 'agent-room-mcp'
$script:Paths = $null
$script:TranscriptStarted = $false
$script:LogPath = $null
$script:ManagedRuleBegin = '<!-- BEGIN agent-room rules'
$script:ManagedRuleEnd = '<!-- END agent-room rules -->'
$script:HookEvents = @('Stop', 'UserPromptSubmit', 'SessionStart')

function Resolve-AgentRoomEffectiveMcpVersion {
    param(
        [Parameter(Mandatory = $true)]
        [ValidateSet('install', 'repair', 'status')]
        [string]$Mode,

        [AllowNull()]
        [object]$State
    )

    if ($Mode -eq 'install') { return $McpVersion }

    $stored = if ($null -eq $State) { '' } else { [string](Get-ObjectValue $State 'mcpVersion') }
    if ($Mode -eq 'repair') {
        if ($script:McpVersionWasExplicit) { return $McpVersion }
        if (-not [string]::IsNullOrWhiteSpace($stored)) { return $stored }
        return $McpVersion
    }

    if (-not [string]::IsNullOrWhiteSpace($stored)) { return $stored }
    return $null
}

function Test-AgentRoomMcpVersion {
    param([AllowNull()][string]$Version)
    return (-not [string]::IsNullOrWhiteSpace($Version)) -and
        ($Version -match '^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$')
}

function Resolve-AgentRoomPaths {
    $userHome = $env:USERPROFILE
    if ([string]::IsNullOrWhiteSpace($userHome)) {
        $userHome = [Environment]::GetFolderPath('UserProfile')
    }
    if ([string]::IsNullOrWhiteSpace($userHome)) {
        throw 'Could not resolve the Windows user profile directory.'
    }

    $roaming = if ([string]::IsNullOrWhiteSpace($env:APPDATA)) {
        Join-Path $userHome 'AppData\Roaming'
    } else { $env:APPDATA }
    $local = if ([string]::IsNullOrWhiteSpace($env:LOCALAPPDATA)) {
        Join-Path $userHome 'AppData\Local'
    } else { $env:LOCALAPPDATA }
    $codex = if ([string]::IsNullOrWhiteSpace($env:CODEX_HOME)) {
        Join-Path $userHome '.codex'
    } else { $env:CODEX_HOME }
    $copilot = if ([string]::IsNullOrWhiteSpace($env:COPILOT_HOME)) {
        Join-Path $userHome '.copilot'
    } else { $env:COPILOT_HOME }

    if (-not [string]::IsNullOrWhiteSpace($TestRoot)) {
        $root = [IO.Path]::GetFullPath($TestRoot)
        return @{
            IsTestRoot = $true
            TestRoot = $root
            Home = Join-Path $root 'Home'
            AppData = Join-Path $root 'AppData\Roaming'
            LocalAppData = Join-Path $root 'AppData\Local'
            CodexHome = Join-Path (Join-Path $root 'Home') '.codex'
            CopilotHome = Join-Path (Join-Path $root 'Home') '.copilot'
            StateRoot = Join-Path $root 'AgentRoomState'
        }
    }

    return @{
        IsTestRoot = $false
        TestRoot = $null
        Home = $userHome
        AppData = $roaming
        LocalAppData = $local
        CodexHome = $codex
        CopilotHome = $copilot
        StateRoot = Join-Path $local 'AgentRoom'
    }
}

function Start-AgentRoomTranscript {
    $logDirectory = Join-Path $script:Paths.StateRoot 'logs'
    New-Item -ItemType Directory -Path $logDirectory -Force | Out-Null
    $script:LogPath = Join-Path $logDirectory ('AgentRoom-Setup-' + (Get-Date -Format 'yyyyMMdd-HHmmss') + '.log')
    Start-Transcript -Path $script:LogPath -Append | Out-Null
    $script:TranscriptStarted = $true
    Write-Host "Log: $script:LogPath"
}

function Stop-AgentRoomTranscript {
    if ($script:TranscriptStarted) {
        Stop-Transcript | Out-Null
        $script:TranscriptStarted = $false
    }
}

function ConvertTo-PlainJsonValue {
    param([AllowNull()][object]$Value)

    if ($null -eq $Value) { return $null }
    if ($Value -is [System.Collections.IDictionary]) {
        $result = [ordered]@{}
        foreach ($key in $Value.Keys) {
            $result[[string]$key] = ConvertTo-PlainJsonValue $Value[$key]
        }
        return ,$result
    }
    if ($Value -is [System.Management.Automation.PSCustomObject]) {
        $result = [ordered]@{}
        foreach ($property in $Value.PSObject.Properties) {
            $result[$property.Name] = ConvertTo-PlainJsonValue $property.Value
        }
        return ,$result
    }
    if ($Value -is [System.Array]) {
        $items = [System.Collections.Generic.List[object]]::new()
        foreach ($item in $Value) { $items.Add((ConvertTo-PlainJsonValue $item)) }
        return ,$items.ToArray()
    }
    return $Value
}

function Read-AgentRoomJson {
    param([Parameter(Mandatory = $true)][string]$Path)

    if (-not (Test-Path -LiteralPath $Path -PathType Leaf)) { return [ordered]@{} }
    $text = [IO.File]::ReadAllText($Path)
    if ([string]::IsNullOrWhiteSpace($text)) { return [ordered]@{} }
    $parsed = ConvertFrom-Json -InputObject $text
    $plain = ConvertTo-PlainJsonValue $parsed
    if ($plain -isnot [System.Collections.IDictionary]) {
        throw "Expected a JSON object in $Path."
    }
    return ,$plain
}

function Write-AgentRoomJsonAtomic {
    param(
        [Parameter(Mandatory = $true)][string]$Path,
        [Parameter(Mandatory = $true)][System.Collections.IDictionary]$Data
    )

    $directory = Split-Path -Parent $Path
    New-Item -ItemType Directory -Path $directory -Force | Out-Null
    $temporary = $Path + '.tmp'
    $json = ConvertTo-Json -InputObject $Data -Depth 100
    [IO.File]::WriteAllText($temporary, $json + [Environment]::NewLine, (New-Object System.Text.UTF8Encoding($false)))
    Move-Item -LiteralPath $temporary -Destination $Path -Force
}

function Get-ObjectValue {
    param([AllowNull()][object]$Object, [Parameter(Mandatory = $true)][string]$Name)

    if ($null -eq $Object) { return $null }
    if ($Object -is [System.Collections.IDictionary]) {
        foreach ($key in $Object.Keys) {
            if ([string]$key -ieq $Name) { return ,$Object[$key] }
        }
        return $null
    }
    $property = $Object.PSObject.Properties | Where-Object { $_.Name -ieq $Name } | Select-Object -First 1
    if ($null -ne $property) { return ,$property.Value }
    return $null
}

function Set-ObjectValue {
    param(
        [Parameter(Mandatory = $true)][System.Collections.IDictionary]$Object,
        [Parameter(Mandatory = $true)][string]$Name,
        [AllowNull()][object]$Value
    )

    foreach ($key in @($Object.Keys)) {
        if ([string]$key -ieq $Name) {
            $Object[$key] = $Value
            return
        }
    }
    $Object[$Name] = $Value
}

function Remove-ObjectValue {
    param(
        [Parameter(Mandatory = $true)][System.Collections.IDictionary]$Object,
        [Parameter(Mandatory = $true)][string]$Name
    )

    foreach ($key in @($Object.Keys)) {
        if ([string]$key -ieq $Name) {
            $Object.Remove($key)
            return $true
        }
    }
    return $false
}

function Test-AgentRoomHookCommand {
    param([AllowNull()][object]$Command)
    if ($Command -isnot [string]) { return $false }
    return [regex]::IsMatch($Command, '(?i)\bagent-room-mcp(?:@[^\s"'']+)?\s+hook\b')
}

function Test-AgentRoomPinnedHookCommand {
    param(
        [AllowNull()]
        [object]$Command,

        [AllowNull()]
        [string]$ExpectedMcpVersion
    )

    if ($Command -isnot [string] -or -not (Test-AgentRoomMcpVersion $ExpectedMcpVersion)) { return $false }
    $expected = "npx -y $script:McpPackageName@$ExpectedMcpVersion hook"
    return $Command.Trim() -ceq $expected
}

function Get-AgentRoomManagedEnvKeys {
    param([Parameter(Mandatory = $true)][string]$Client)

    switch ($Client) {
        'claude' { return @('CLAUDECODE', 'CLAUDE_CODE_ENTRYPOINT') }
        'gemini' { return @('ANTIGRAVITY_CLI') }
        { $_ -in @('vscode', 'copilot') } { return @('GITHUB_COPILOT') }
        default { return @() }
    }
}

function Test-NodeVersionString {
    param([AllowNull()][string]$Version)
    if ([string]::IsNullOrWhiteSpace($Version)) { return $false }
    if ($Version -notmatch '^v?(\d+)\.(\d+)\.(\d+)') { return $false }
    return ([int]$Matches[1] -ge 20)
}

function Get-NodeBootstrapPlan {
    param(
        [Parameter(Mandatory = $true)][System.Collections.IDictionary]$Runtime,
        [Parameter(Mandatory = $true)][bool]$WingetAvailable
    )

    if ($Runtime.IsReady) {
        return @{ Install = $false; Error = $null; Arguments = @() }
    }
    if (-not $WingetAvailable) {
        return @{
            Install = $false
            Error = 'Node.js 20+ is required and winget is unavailable. Install Node.js LTS from nodejs.org, then run repair.'
            Arguments = @()
        }
    }
    return @{
        Install = $true
        Error = $null
        Arguments = @('install', '--id', 'OpenJS.NodeJS.LTS', '-e', '--accept-package-agreements', '--accept-source-agreements')
    }
}

function Get-NodeRuntime {
    $nodeCommand = Get-Command node -ErrorAction SilentlyContinue | Select-Object -First 1
    $npmCommand = Get-Command npm -ErrorAction SilentlyContinue | Select-Object -First 1
    $npxCommand = Get-Command npx -ErrorAction SilentlyContinue | Select-Object -First 1
    $nodeVersion = $null
    $npmVersion = $null
    $npxVersion = $null

    if ($null -ne $nodeCommand) {
        try { $nodeVersion = (& $nodeCommand.Source -v 2>$null | Select-Object -First 1).ToString().Trim() } catch { $nodeVersion = $null }
    }
    if ($null -ne $npmCommand) {
        try { $npmVersion = (& $npmCommand.Source -v 2>$null | Select-Object -First 1).ToString().Trim() } catch { $npmVersion = $null }
    }
    if ($null -ne $npxCommand) {
        try { $npxVersion = (& $npxCommand.Source -v 2>$null | Select-Object -First 1).ToString().Trim() } catch { $npxVersion = $null }
    }

    $nodeReady = Test-NodeVersionString $nodeVersion
    return @{
        IsReady = ($nodeReady -and -not [string]::IsNullOrWhiteSpace($npmVersion) -and -not [string]::IsNullOrWhiteSpace($npxVersion))
        NodeCommand = $nodeCommand
        NpmCommand = $npmCommand
        NpxCommand = $npxCommand
        NodeVersion = $nodeVersion
        NpmVersion = $npmVersion
        NpxVersion = $npxVersion
        NodeReady = $nodeReady
    }
}

function Refresh-AgentRoomPath {
    $machinePath = [Environment]::GetEnvironmentVariable('Path', 'Machine')
    $userPath = [Environment]::GetEnvironmentVariable('Path', 'User')
    $pathEntries = @($machinePath, $userPath) |
        Where-Object { -not [string]::IsNullOrWhiteSpace($_) } |
        ForEach-Object { $_ -split ';' } |
        Where-Object { -not [string]::IsNullOrWhiteSpace($_) } |
        Select-Object -Unique
    $env:Path = $pathEntries -join ';'
}

function Ensure-NodeRuntime {
    $runtime = Get-NodeRuntime
    $winget = Get-Command winget -ErrorAction SilentlyContinue | Select-Object -First 1
    $plan = Get-NodeBootstrapPlan -Runtime $runtime -WingetAvailable ($null -ne $winget)
    if ($runtime.IsReady) {
        Write-Host "Node detected: $($runtime.NodeVersion); npm $($runtime.NpmVersion); npx $($runtime.NpxVersion)"
        return $runtime
    }
    if ($plan.Error) { throw $plan.Error }

    Write-Host 'Node.js 20+ is missing or too old. Installing Node.js LTS with winget...'
    & $winget.Source @($plan.Arguments)
    $wingetExitCode = $LASTEXITCODE
    if ($wingetExitCode -ne 0) {
        throw "winget install failed with exit code $wingetExitCode. Install Node.js LTS from nodejs.org, then run repair."
    }

    Refresh-AgentRoomPath
    $runtime = Get-NodeRuntime
    if (-not $runtime.IsReady) {
        throw 'Node.js LTS installation completed, but node, npm, and npx could not be verified. Restart PowerShell and run repair.'
    }
    Write-Host "Node detected after PATH refresh: $($runtime.NodeVersion); npm $($runtime.NpmVersion); npx $($runtime.NpxVersion)"
    return $runtime
}

function Normalize-AgentRoomBaseUrl {
    param([Parameter(Mandatory = $true)][string]$Value)

    $candidate = $Value.Trim()
    if ([string]::IsNullOrWhiteSpace($candidate)) { throw 'BaseUrl is required.' }
    $uri = $null
    if (-not [Uri]::TryCreate($candidate, [UriKind]::Absolute, [ref]$uri)) {
        throw "Invalid BaseUrl: $candidate"
    }
    if ($uri.Scheme -notin @('http', 'https')) { throw 'BaseUrl must use http or https.' }
    if (-not [string]::IsNullOrEmpty($uri.UserInfo) -or -not [string]::IsNullOrEmpty($uri.Query) -or -not [string]::IsNullOrEmpty($uri.Fragment)) {
        throw 'BaseUrl must not include credentials, a query string, or a fragment.'
    }

    $path = $uri.AbsolutePath.TrimEnd('/')
    if ($path -eq '/api/room') { $path = '' }
    if (-not [string]::IsNullOrEmpty($path)) {
        if ($path -eq '/mcp') { throw 'BaseUrl must be the Agent Room root URL; /mcp is not a room API base URL.' }
        throw 'BaseUrl may contain only the server root or /api/room.'
    }
    return $uri.GetLeftPart([UriPartial]::Authority).TrimEnd('/')
}

function Resolve-AgentRoomBaseUrl {
    param(
        [AllowNull()][object]$State,
        [switch]$AllowPrompt
    )

    $candidate = $null
    if (-not [string]::IsNullOrWhiteSpace($BaseUrl)) { $candidate = $BaseUrl }
    elseif ($null -ne $State -and -not [string]::IsNullOrWhiteSpace([string](Get-ObjectValue $State 'baseUrl'))) {
        $candidate = [string](Get-ObjectValue $State 'baseUrl')
    }
    elseif (-not [string]::IsNullOrWhiteSpace($script:DefaultBaseUrl)) { $candidate = $script:DefaultBaseUrl }
    elseif ($AllowPrompt -and -not $NonInteractive) { $candidate = Read-Host 'Agent Room server address (for example https://room.example.com)' }

    if ([string]::IsNullOrWhiteSpace($candidate)) {
        throw 'BaseUrl is required. Pass -BaseUrl, or enter the Agent Room server address when prompted.'
    }
    return Normalize-AgentRoomBaseUrl -Value $candidate
}

function Get-HttpResponseBody {
    param([AllowNull()][object]$Response)
    if ($null -eq $Response) { return '' }
    try {
        if ($Response.Content -is [string]) { return [string]$Response.Content }
        if ($Response.Content -and $Response.Content.ReadAsStringAsync) { return $Response.Content.ReadAsStringAsync().GetAwaiter().GetResult() }
        $stream = $Response.GetResponseStream()
        if ($null -ne $stream) {
            $reader = New-Object IO.StreamReader($stream)
            try { return $reader.ReadToEnd() } finally { $reader.Dispose() }
        }
    } catch { }
    return ''
}

function Get-HttpStatusCode {
    param([AllowNull()][object]$Response)
    if ($null -eq $Response) { return 0 }
    try { return [int]$Response.StatusCode } catch { return 0 }
}

function Test-AgentRoomApi {
    param([Parameter(Mandatory = $true)][string]$NormalizedBaseUrl)

    $endpoint = $NormalizedBaseUrl + '/api/room'
    try {
        $options = Invoke-WebRequest -Uri $endpoint -Method Options -TimeoutSec 8 -UseBasicParsing
        if ([int]$options.StatusCode -eq 204) { return @{ Online = $true; Detail = 'OPTIONS returned 204.' } }
    } catch {
        $status = Get-HttpStatusCode $_.Exception.Response
        if ($status -eq 204) { return @{ Online = $true; Detail = 'OPTIONS returned 204.' } }
    }

    $body = @{ action = 'get'; code = 'AAA-BBB-CCC' } | ConvertTo-Json -Compress
    try {
        $response = Invoke-WebRequest -Uri $endpoint -Method Post -ContentType 'application/json' -Body $body -TimeoutSec 8 -UseBasicParsing
        return @{ Online = $false; Detail = "Safe API probe returned HTTP $([int]$response.StatusCode), expected 404 RoomNotFoundError." }
    } catch {
        $response = $_.Exception.Response
        $status = Get-HttpStatusCode $response
        $responseText = if ($_.ErrorDetails -and $_.ErrorDetails.Message) { $_.ErrorDetails.Message } else { Get-HttpResponseBody $response }
        $parsed = $null
        try { if ($responseText) { $parsed = ConvertFrom-Json -InputObject $responseText } } catch { }
        if ($status -eq 404 -and (Get-ObjectValue $parsed 'error') -eq 'RoomNotFoundError') {
            return @{ Online = $true; Detail = 'Safe API probe returned 404 RoomNotFoundError.' }
        }
        if ($status -gt 0) { return @{ Online = $false; Detail = "HTTP $status from $endpoint." } }
        return @{ Online = $false; Detail = "Could not reach $endpoint. $($_.Exception.Message)" }
    }
}

function Get-DetectedAgentRoomClients {
    $found = [System.Collections.Generic.List[string]]::new()
    $homePath = $script:Paths.Home
    $local = $script:Paths.LocalAppData
    $roaming = $script:Paths.AppData

    if ((Get-Command claude -ErrorAction SilentlyContinue) -or
        (Test-Path -LiteralPath (Join-Path $homePath '.claude')) -or
        (Test-Path -LiteralPath (Join-Path $roaming 'Claude')) -or
        (Test-Path -LiteralPath (Join-Path $local 'Claude'))) { $found.Add('claude') }

    if ((Get-Command codex -ErrorAction SilentlyContinue) -or (Test-Path -LiteralPath $script:Paths.CodexHome)) { $found.Add('codex') }
    if ((Get-Command cursor -ErrorAction SilentlyContinue) -or
        (Test-Path -LiteralPath (Join-Path $homePath '.cursor')) -or
        (Test-Path -LiteralPath (Join-Path $local 'Programs\Cursor'))) { $found.Add('cursor') }
    if ((Get-Command gemini -ErrorAction SilentlyContinue) -or
        (Get-Command agy -ErrorAction SilentlyContinue) -or
        (Get-Command antigravity -ErrorAction SilentlyContinue) -or
        (Test-Path -LiteralPath (Join-Path $homePath '.gemini')) -or
        (Test-Path -LiteralPath (Join-Path $local 'Antigravity'))) { $found.Add('gemini') }
    if ((Get-Command code -ErrorAction SilentlyContinue) -or
        (Test-Path -LiteralPath (Join-Path $local 'Programs\Microsoft VS Code'))) { $found.Add('vscode') }
    if ((Get-Command copilot -ErrorAction SilentlyContinue) -or
        (Test-Path -LiteralPath $script:Paths.CopilotHome)) { $found.Add('copilot') }
    return $found.ToArray()
}

function Resolve-AgentRoomClientSelection {
    param([string[]]$Requested)

    $tokens = [System.Collections.Generic.List[string]]::new()
    foreach ($item in @($Requested)) {
        if ([string]::IsNullOrWhiteSpace($item)) { continue }
        foreach ($part in ($item -split ',')) {
            $name = $part.Trim().ToLowerInvariant()
            if ($name) { $tokens.Add($name) }
        }
    }
    $allowed = @('claude', 'codex', 'cursor', 'gemini', 'antigravity', 'gemini-antigravity', 'vscode', 'copilot', 'vscode-copilot', 'all')
    foreach ($token in $tokens) {
        if ($token -notin $allowed) { throw "Unsupported client '$token'. Choose: $($allowed -join ', ')." }
    }
    if ($tokens -contains 'all') { $tokens = [System.Collections.Generic.List[string]]::new(); $tokens.AddRange(@('claude', 'codex', 'cursor', 'gemini', 'antigravity', 'vscode', 'copilot')) }

    $unique = @($tokens | Select-Object -Unique)
    $clients = [System.Collections.Generic.List[string]]::new()
    $targets = [System.Collections.Generic.List[string]]::new()
    if ($unique -contains 'claude') { $clients.Add('claude'); $targets.Add('claude') }
    if ($unique -contains 'codex') { $clients.Add('codex'); $targets.Add('codex') }
    if ($unique -contains 'cursor') { $clients.Add('cursor'); $targets.Add('cursor') }
    if (($unique -contains 'gemini') -or ($unique -contains 'antigravity') -or ($unique -contains 'gemini-antigravity')) {
        $clients.Add('gemini-antigravity'); $targets.Add('gemini')
    }
    if ($unique -contains 'vscode-copilot' -or (($unique -contains 'vscode') -and ($unique -contains 'copilot'))) {
        $clients.Add('vscode-copilot'); $targets.Add('vscode'); $targets.Add('copilot')
    } else {
        if ($unique -contains 'vscode') { $clients.Add('vscode'); $targets.Add('vscode') }
        if ($unique -contains 'copilot') { $clients.Add('copilot'); $targets.Add('copilot') }
    }
    return @{ Clients = $clients.ToArray(); Targets = @($targets | Select-Object -Unique) }
}

function Expand-AgentRoomStateClients {
    param([AllowNull()][object]$StateClients)
    $selection = Resolve-AgentRoomClientSelection -Requested $StateClients
    return $selection
}

function Get-AgentRoomJsonMcpFileSpecs {
    param([string[]]$Targets)
    $specs = [System.Collections.Generic.List[object]]::new()
    foreach ($target in $Targets) {
        switch ($target) {
            'claude' {
                $specs.Add(@{ Key = 'ClaudeCli'; Client = 'claude'; Surface = 'cli'; RootKey = 'mcpServers'; Path = Join-Path $script:Paths.Home '.claude.json' })
                $specs.Add(@{ Key = 'ClaudeDesktop'; Client = 'claude'; Surface = 'desktop'; RootKey = 'mcpServers'; Path = Join-Path $script:Paths.AppData 'Claude\claude_desktop_config.json' })
            }
            'cursor' { $specs.Add(@{ Key = 'CursorMcp'; Client = 'cursor'; Surface = 'default'; RootKey = 'mcpServers'; Path = Join-Path $script:Paths.Home '.cursor\mcp.json' }) }
            'gemini' { $specs.Add(@{ Key = 'GeminiMcp'; Client = 'gemini'; Surface = 'default'; RootKey = 'mcpServers'; Path = Join-Path $script:Paths.Home '.gemini\config\mcp_config.json' }) }
            'vscode' { $specs.Add(@{ Key = 'VSCodeMcp'; Client = 'vscode'; Surface = 'default'; RootKey = 'servers'; Path = Join-Path $script:Paths.AppData 'Code\User\mcp.json' }) }
            'copilot' { $specs.Add(@{ Key = 'CopilotMcp'; Client = 'copilot'; Surface = 'default'; RootKey = 'mcpServers'; Path = Join-Path $script:Paths.CopilotHome 'mcp-config.json' }) }
        }
    }
    return $specs.ToArray()
}

function Get-AgentRoomManagedFileList {
    return @(
        @{ Key = 'Home-.claude.json'; Path = Join-Path $script:Paths.Home '.claude.json' }
        @{ Key = 'Claude-settings.json'; Path = Join-Path $script:Paths.Home '.claude\settings.json' }
        @{ Key = 'Claude-CLAUDE.md'; Path = Join-Path $script:Paths.Home '.claude\CLAUDE.md' }
        @{ Key = 'Claude-desktop-config.json'; Path = Join-Path $script:Paths.AppData 'Claude\claude_desktop_config.json' }
        @{ Key = 'Codex-config.toml'; Path = Join-Path $script:Paths.CodexHome 'config.toml' }
        @{ Key = 'Codex-AGENTS.md'; Path = Join-Path $script:Paths.CodexHome 'AGENTS.md' }
        @{ Key = 'Cursor-mcp.json'; Path = Join-Path $script:Paths.Home '.cursor\mcp.json' }
        @{ Key = 'Cursor-hooks.json'; Path = Join-Path $script:Paths.Home '.cursor\hooks.json' }
        @{ Key = 'Gemini-mcp_config.json'; Path = Join-Path $script:Paths.Home '.gemini\config\mcp_config.json' }
        @{ Key = 'Gemini-GEMINI.md'; Path = Join-Path $script:Paths.Home '.gemini\GEMINI.md' }
        @{ Key = 'VSCode-mcp.json'; Path = Join-Path $script:Paths.AppData 'Code\User\mcp.json' }
        @{ Key = 'Copilot-mcp-config.json'; Path = Join-Path $script:Paths.CopilotHome 'mcp-config.json' }
    )
}

function New-AgentRoomConfigBackup {
    $backupRoot = Join-Path (Join-Path $script:Paths.StateRoot 'backups') (Get-Date -Format 'yyyyMMdd-HHmmss-fff')
    New-Item -ItemType Directory -Path $backupRoot -Force | Out-Null
    $count = 0
    foreach ($item in (Get-AgentRoomManagedFileList)) {
        if (Test-Path -LiteralPath $item.Path -PathType Leaf) {
            Copy-Item -LiteralPath $item.Path -Destination (Join-Path $backupRoot ($item.Key + '.bak')) -Force
            $count++
        }
    }
    Write-Host "Backed up $count existing client configuration files to $backupRoot"
    return $backupRoot
}

function Get-AgentRoomExistingMcpEntries {
    param([string[]]$Targets)

    $snapshot = @{}
    foreach ($spec in (Get-AgentRoomJsonMcpFileSpecs -Targets $Targets)) {
        if (-not (Test-Path -LiteralPath $spec.Path -PathType Leaf)) { continue }
        $document = Read-AgentRoomJson $spec.Path
        $servers = Get-ObjectValue $document $spec.RootKey
        $entry = Get-ObjectValue $servers 'agent-room'
        if ($entry -is [System.Collections.IDictionary]) { $snapshot[$spec.Key] = $entry }
    }
    return $snapshot
}

function Invoke-AgentRoomUpstreamInit {
    param(
        [Parameter(Mandatory = $true)][string]$Target,
        [Parameter(Mandatory = $true)][string]$NormalizedBaseUrl,
        [Parameter(Mandatory = $true)][string]$EffectiveMcpVersion
    )

    # Prefer the cmd shim on Windows. Invoking npx.ps1 through a computed
    # PowerShell expression can make that shim re-evaluate caller variables in
    # its own script scope when it reconstructs the command line.
    $npxCommand = Get-Command npx.cmd -ErrorAction Stop | Select-Object -First 1
    $nodeCommand = Get-Command node -ErrorAction Stop | Select-Object -First 1
    $nodeDirectory = Split-Path -Parent $nodeCommand.Source
    $names = @('USERPROFILE', 'HOME', 'APPDATA', 'LOCALAPPDATA', 'CODEX_HOME', 'COPILOT_HOME', 'AGENT_ROOM_BASE_URL', 'PATH')
    $oldValues = @{}
    foreach ($name in $names) { $oldValues[$name] = [Environment]::GetEnvironmentVariable($name, 'Process') }
    $preservedCursorMcpPath = $null
    try {
        $env:USERPROFILE = $script:Paths.Home
        $env:HOME = $script:Paths.Home
        $env:APPDATA = $script:Paths.AppData
        $env:LOCALAPPDATA = $script:Paths.LocalAppData
        $env:CODEX_HOME = $script:Paths.CodexHome
        $env:COPILOT_HOME = $script:Paths.CopilotHome
        $env:AGENT_ROOM_BASE_URL = $NormalizedBaseUrl
        $systemRoot = if ([string]::IsNullOrWhiteSpace($env:SystemRoot)) { 'C:\Windows' } else { $env:SystemRoot }
        $env:PATH = @($nodeDirectory, (Join-Path $systemRoot 'System32'), $systemRoot) -join ';'
        if ($Target -eq 'cursor') {
            $cursorMcpPath = Join-Path $script:Paths.Home '.cursor\mcp.json'
            if (Test-Path -LiteralPath $cursorMcpPath -PathType Leaf) {
                # The upstream Cursor initializer atomically renames mcp.json.tmp
                # over mcp.json. Preserve the existing user file while it writes
                # its entry so other servers/settings can be merged back safely.
                $preservedCursorMcpPath = $cursorMcpPath + '.agent-room-preserve-' + [Guid]::NewGuid().ToString('N')
                Move-Item -LiteralPath $cursorMcpPath -Destination $preservedCursorMcpPath
            }
        }
        Write-Host "Running upstream init target '$Target' with $script:McpPackageName@$EffectiveMcpVersion"
        $packageSpec = $script:McpPackageName + '@' + $EffectiveMcpVersion
        $output = & $npxCommand.Source -y $packageSpec init $Target 2>&1
        $exitCode = $LASTEXITCODE
        foreach ($line in $output) { Write-Host $line }
        if ($exitCode -ne 0) { throw "agent-room-mcp init $Target failed with exit code $exitCode." }
    } finally {
        if ($null -ne $preservedCursorMcpPath) {
            $cursorMcpPath = Join-Path $script:Paths.Home '.cursor\mcp.json'
            if (Test-Path -LiteralPath $cursorMcpPath -PathType Leaf) { Remove-Item -LiteralPath $cursorMcpPath -Force }
            $temporaryCursorMcpPath = $cursorMcpPath + '.tmp'
            if (Test-Path -LiteralPath $temporaryCursorMcpPath -PathType Leaf) { Remove-Item -LiteralPath $temporaryCursorMcpPath -Force }
            Move-Item -LiteralPath $preservedCursorMcpPath -Destination $cursorMcpPath -Force
        }
        foreach ($name in $names) { [Environment]::SetEnvironmentVariable($name, $oldValues[$name], 'Process') }
    }
}

function Merge-AgentRoomEntry {
    param(
        [AllowNull()][object]$Current,
        [AllowNull()][object]$Existing,
        [Parameter(Mandatory = $true)][string]$Client
    )

    $merged = [ordered]@{}
    if ($Existing -is [System.Collections.IDictionary]) {
        foreach ($key in $Existing.Keys) { $merged[[string]$key] = $Existing[$key] }
    }
    if ($Current -is [System.Collections.IDictionary]) {
        foreach ($key in $Current.Keys) {
            if ([string]$key -ieq 'env') { continue }
            Set-ObjectValue $merged ([string]$key) $Current[$key]
        }
    }

    $environment = [ordered]@{}
    $oldEnvironment = Get-ObjectValue $Existing 'env'
    $newEnvironment = Get-ObjectValue $Current 'env'
    if ($oldEnvironment -is [System.Collections.IDictionary]) {
        foreach ($key in $oldEnvironment.Keys) { Set-ObjectValue $environment ([string]$key) $oldEnvironment[$key] }
    }
    $managedKeys = @(Get-AgentRoomManagedEnvKeys -Client $Client)
    foreach ($managedKey in $managedKeys) {
        Remove-ObjectValue $environment $managedKey | Out-Null
    }
    if ($newEnvironment -is [System.Collections.IDictionary]) {
        foreach ($key in $newEnvironment.Keys) {
            $exists = $false
            foreach ($existingKey in $environment.Keys) {
                if ([string]$existingKey -ieq [string]$key) { $exists = $true; break }
            }
            if (($managedKeys -contains [string]$key) -or -not $exists) {
                Set-ObjectValue $environment ([string]$key) $newEnvironment[$key]
            }
        }
    }
    Set-ObjectValue $merged 'env' $environment
    return ,$merged
}

function Normalize-AgentRoomPackageSpec {
    param(
        [AllowNull()][object]$Entry,
        [AllowNull()][object]$ExistingEntry,
        [Parameter(Mandatory = $true)][string]$Client,
        [Parameter(Mandatory = $true)][string]$NormalizedBaseUrl,
        [Parameter(Mandatory = $true)][string]$EffectiveMcpVersion
    )

    $normalized = Merge-AgentRoomEntry -Current $Entry -Existing $ExistingEntry -Client $Client
    $spec = $script:McpPackageName + '@' + $EffectiveMcpVersion
    if ($Client -eq 'vscode') {
        Set-ObjectValue $normalized 'type' 'stdio'
        Set-ObjectValue $normalized 'command' 'cmd'
        Set-ObjectValue $normalized 'args' @('/c', 'npx', '-y', $spec)
    } else {
        Set-ObjectValue $normalized 'command' 'npx'
        Set-ObjectValue $normalized 'args' @('-y', $spec)
    }
    $environment = Get-ObjectValue $normalized 'env'
    if ($environment -isnot [System.Collections.IDictionary]) { $environment = [ordered]@{} }
    Set-ObjectValue $environment 'AGENT_ROOM_BASE_URL' $NormalizedBaseUrl
    Set-ObjectValue $normalized 'env' $environment
    return ,$normalized
}

function Normalize-AgentRoomJsonMcpFile {
    param(
        [Parameter(Mandatory = $true)][System.Collections.IDictionary]$Spec,
        [Parameter(Mandatory = $true)][string]$NormalizedBaseUrl,
        [AllowNull()][object]$ExistingEntry,
        [Parameter(Mandatory = $true)][string]$EffectiveMcpVersion
    )

    $document = Read-AgentRoomJson $Spec.Path
    $servers = Get-ObjectValue $document $Spec.RootKey
    if ($servers -isnot [System.Collections.IDictionary]) { $servers = [ordered]@{} }
    $entry = Get-ObjectValue $servers 'agent-room'
    $entry = Normalize-AgentRoomPackageSpec -Entry $entry -ExistingEntry $ExistingEntry -Client $Spec.Client -NormalizedBaseUrl $NormalizedBaseUrl -EffectiveMcpVersion $EffectiveMcpVersion
    Set-ObjectValue $servers 'agent-room' $entry
    Set-ObjectValue $document $Spec.RootKey $servers
    Write-AgentRoomJsonAtomic -Path $Spec.Path -Data $document
}

function Normalize-AgentRoomGroupedHooks {
    param(
        [Parameter(Mandatory = $true)][System.Collections.IDictionary]$Document,
        [Parameter(Mandatory = $true)][string]$HookCommand
    )

    $hooks = Get-ObjectValue $Document 'hooks'
    if ($hooks -isnot [System.Collections.IDictionary]) { $hooks = [ordered]@{} }
    foreach ($event in $script:HookEvents) {
        $source = Get-ObjectValue $hooks $event
        $groups = if ($null -eq $source) { @() } else { @($source) }
        $result = [System.Collections.Generic.List[object]]::new()
        $seen = $false
        foreach ($groupValue in $groups) {
            $group = $groupValue
            if ($group -isnot [System.Collections.IDictionary]) { $result.Add($group); continue }
            $childValue = Get-ObjectValue $group 'hooks'
            if ($null -eq $childValue) { $result.Add($group); continue }
            $children = @($childValue)
            $nextChildren = [System.Collections.Generic.List[object]]::new()
            $hadAgentRoom = $false
            foreach ($child in $children) {
                $command = Get-ObjectValue $child 'command'
                if (Test-AgentRoomHookCommand $command) {
                    $hadAgentRoom = $true
                    if ($seen) { continue }
                    Set-ObjectValue $child 'command' $HookCommand
                    $seen = $true
                }
                $nextChildren.Add($child)
            }
            if ($hadAgentRoom -and $nextChildren.Count -eq 0 -and $group.Count -le 1) { continue }
            Set-ObjectValue $group 'hooks' $nextChildren.ToArray()
            $result.Add($group)
        }
        if (-not $seen) {
            $newChild = [ordered]@{ type = 'command'; command = $HookCommand }
            $result.Add([ordered]@{ hooks = @($newChild) })
        }
        Set-ObjectValue $hooks $event $result.ToArray()
    }
    Set-ObjectValue $Document 'hooks' $hooks
}

function Remove-AgentRoomGroupedHooks {
    param([Parameter(Mandatory = $true)][System.Collections.IDictionary]$Document)

    $hooks = Get-ObjectValue $Document 'hooks'
    if ($hooks -isnot [System.Collections.IDictionary]) { return $false }
    $changed = $false
    foreach ($event in $script:HookEvents) {
        $source = Get-ObjectValue $hooks $event
        if ($null -eq $source) { continue }
        $groups = @($source)
        $result = [System.Collections.Generic.List[object]]::new()
        foreach ($group in $groups) {
            if ($group -isnot [System.Collections.IDictionary]) { $result.Add($group); continue }
            $childValue = Get-ObjectValue $group 'hooks'
            if ($null -eq $childValue) { $result.Add($group); continue }
            $children = [System.Collections.Generic.List[object]]::new()
            $hadAgentRoom = $false
            foreach ($child in @($childValue)) {
                if (Test-AgentRoomHookCommand (Get-ObjectValue $child 'command')) { $hadAgentRoom = $true; $changed = $true; continue }
                $children.Add($child)
            }
            if ($hadAgentRoom -and $children.Count -eq 0 -and $group.Count -le 1) { continue }
            Set-ObjectValue $group 'hooks' $children.ToArray()
            $result.Add($group)
        }
        Set-ObjectValue $hooks $event $result.ToArray()
    }
    Set-ObjectValue $Document 'hooks' $hooks
    return $changed
}

function Normalize-AgentRoomCursorHooks {
    param([Parameter(Mandatory = $true)][string]$Path, [Parameter(Mandatory = $true)][string]$HookCommand)

    $document = Read-AgentRoomJson $Path
    $hooks = Get-ObjectValue $document 'hooks'
    if ($hooks -isnot [System.Collections.IDictionary]) { $hooks = [ordered]@{} }
    $source = Get-ObjectValue $hooks 'stop'
    $items = if ($null -eq $source) { @() } else { @($source) }
    $result = [System.Collections.Generic.List[object]]::new()
    $seen = $false
    foreach ($item in $items) {
        if ((Get-ObjectValue $item 'command') -is [string] -and (Test-AgentRoomHookCommand (Get-ObjectValue $item 'command'))) {
            if ($seen) { continue }
            Set-ObjectValue $item 'command' $HookCommand
            Set-ObjectValue $item 'loop_limit' $null
            $seen = $true
        }
        $result.Add($item)
    }
    if (-not $seen) { $result.Add([ordered]@{ command = $HookCommand; loop_limit = $null }) }
    Set-ObjectValue $hooks 'stop' $result.ToArray()
    Set-ObjectValue $document 'hooks' $hooks
    if ((Get-ObjectValue $document 'version') -ne 1) { Set-ObjectValue $document 'version' 1 }
    Write-AgentRoomJsonAtomic -Path $Path -Data $document
}

function Remove-AgentRoomCursorHooks {
    param([Parameter(Mandatory = $true)][System.Collections.IDictionary]$Document)

    $hooks = Get-ObjectValue $Document 'hooks'
    if ($hooks -isnot [System.Collections.IDictionary]) { return $false }
    $source = Get-ObjectValue $hooks 'stop'
    if ($null -eq $source) { return $false }
    $result = [System.Collections.Generic.List[object]]::new()
    $changed = $false
    foreach ($item in @($source)) {
        if (Test-AgentRoomHookCommand (Get-ObjectValue $item 'command')) { $changed = $true; continue }
        $result.Add($item)
    }
    Set-ObjectValue $hooks 'stop' $result.ToArray()
    Set-ObjectValue $Document 'hooks' $hooks
    return $changed
}

function Split-AgentRoomToml {
    param([AllowNull()][string]$Content)
    $normalized = if ($null -eq $Content) { '' } else { $Content.Replace("`r`n", "`n").Replace("`r", "`n") }
    return ,$normalized.Split([char]10)
}

function Join-AgentRoomToml {
    param([Parameter(Mandatory = $true)][object]$Lines, [string]$NewLine)
    if ($Lines -isnot [System.Collections.Generic.List[string]]) { throw 'TOML lines must be a mutable string list.' }
    return [string]::Join($NewLine, $Lines.ToArray())
}

function Set-AgentRoomTomlTableKey {
    param(
        [Parameter(Mandatory = $true)][object]$Lines,
        [Parameter(Mandatory = $true)][string]$Header,
        [Parameter(Mandatory = $true)][string]$Key,
        [Parameter(Mandatory = $true)][string]$Value
    )

    if ($Lines -isnot [System.Collections.Generic.List[string]]) { throw 'TOML lines must be a mutable string list.' }
    $start = -1
    $matches = 0
    for ($i = 0; $i -lt $Lines.Count; $i++) {
        if ($Lines[$i].Trim() -ceq $Header) { $start = $i; $matches++ }
    }
    if ($matches -gt 1) { throw "Codex config contains duplicate TOML table $Header." }
    if ($start -lt 0) {
        if ($Lines.Count -gt 0 -and -not [string]::IsNullOrWhiteSpace($Lines[$Lines.Count - 1])) { $Lines.Add('') }
        $Lines.Add($Header)
        $Lines.Add("$Key = $Value")
        return
    }

    $end = $Lines.Count
    for ($i = $start + 1; $i -lt $Lines.Count; $i++) {
        if ($Lines[$i] -match '^\s*\[') { $end = $i; break }
    }
    $pattern = '^(?<prefix>\s*' + [regex]::Escape($Key) + '\s*=\s*)(?<old>.*?)(?<comment>\s+#.*)?$'
    for ($i = $start + 1; $i -lt $end; $i++) {
        $match = [regex]::Match($Lines[$i], $pattern)
        if ($match.Success) {
            $Lines[$i] = $match.Groups['prefix'].Value + $Value + $match.Groups['comment'].Value
            return
        }
    }
    $Lines.Insert($end, "$Key = $Value")
}

function Format-AgentRoomTomlString {
    param([Parameter(Mandatory = $true)][string]$Value)
    return '"' + $Value.Replace('\', '\\').Replace('"', '\"') + '"'
}

function Normalize-AgentRoomCodexHookBlocks {
    param([Parameter(Mandatory = $true)][string]$Content, [Parameter(Mandatory = $true)][string]$HookCommand)

    $newLine = if ($Content.Contains("`r`n")) { "`r`n" } else { "`n" }
    $lines = [System.Collections.Generic.List[string]]::new()
    foreach ($line in (Split-AgentRoomToml $Content)) { $lines.Add([string]$line) }
    $output = [System.Collections.Generic.List[string]]::new()
    $seen = @{}
    $eventHeader = '^\[\[hooks\.(Stop|UserPromptSubmit|SessionStart)\]\]\s*$'

    for ($i = 0; $i -lt $lines.Count; $i++) {
        $outerMatch = [regex]::Match($lines[$i], $eventHeader)
        if (-not $outerMatch.Success) { $output.Add($lines[$i]); continue }
        $event = $outerMatch.Groups[1].Value
        $end = $i + 1
        while ($end -lt $lines.Count) {
            if ($lines[$end] -match '^\s*\[' -and $lines[$end].Trim() -cne "[[hooks.$event.hooks]]") { break }
            $end++
        }

        $block = [System.Collections.Generic.List[string]]::new()
        for ($n = $i; $n -lt $end; $n++) { $block.Add($lines[$n]) }
        $processed = [System.Collections.Generic.List[string]]::new()
        for ($k = 0; $k -lt $block.Count;) {
            if ($block[$k].Trim() -cne "[[hooks.$event.hooks]]") { $processed.Add($block[$k]); $k++; continue }
            $childEnd = $k + 1
            while ($childEnd -lt $block.Count -and $block[$childEnd] -notmatch '^\s*\[') { $childEnd++ }
            $child = [System.Collections.Generic.List[string]]::new()
            for ($n = $k; $n -lt $childEnd; $n++) { $child.Add($block[$n]) }
            $agentLines = @()
            for ($n = 0; $n -lt $child.Count; $n++) {
                if ($child[$n] -match '^\s*command\s*=\s*"[^"]*agent-room-mcp(?:@[^"\s]+)?\s+hook[^"\s]*"\s*$') { $agentLines += $n }
            }
            if ($agentLines.Count -gt 0) {
                if (-not $seen.ContainsKey($event)) {
                    $seen[$event] = $true
                    foreach ($n in $agentLines) { $child[$n] = 'command = ' + (Format-AgentRoomTomlString $HookCommand) }
                    foreach ($line in $child) { $processed.Add($line) }
                }
            } else {
                foreach ($line in $child) { $processed.Add($line) }
            }
            $k = $childEnd
        }
        foreach ($line in $processed) { $output.Add($line) }
        $i = $end - 1
    }

    foreach ($event in $script:HookEvents) {
        if (-not $seen.ContainsKey($event)) {
            if ($output.Count -gt 0 -and -not [string]::IsNullOrWhiteSpace($output[$output.Count - 1])) { $output.Add('') }
            $output.Add("[[hooks.$event]]")
            $output.Add('matcher = ""')
            $output.Add("[[hooks.$event.hooks]]")
            $output.Add('type = "command"')
            $output.Add('command = ' + (Format-AgentRoomTomlString $HookCommand))
        }
    }
    return Join-AgentRoomToml -Lines $output -NewLine $newLine
}

function Normalize-AgentRoomCodexConfig {
    param(
        [Parameter(Mandatory = $true)][string]$NormalizedBaseUrl,
        [Parameter(Mandatory = $true)][string]$EffectiveMcpVersion
    )

    $path = Join-Path $script:Paths.CodexHome 'config.toml'
    if (-not (Test-Path -LiteralPath $path -PathType Leaf)) { throw "Upstream init did not create $path." }
    $content = [IO.File]::ReadAllText($path)
    $newLine = if ($content.Contains("`r`n")) { "`r`n" } else { "`n" }
    $lines = [System.Collections.Generic.List[string]]::new()
    foreach ($line in (Split-AgentRoomToml $content)) { $lines.Add([string]$line) }
    $package = Format-AgentRoomTomlString ($script:McpPackageName + '@' + $EffectiveMcpVersion)
    Set-AgentRoomTomlTableKey -Lines $lines -Header '[mcp_servers.agent-room]' -Key 'command' -Value '"npx"'
    Set-AgentRoomTomlTableKey -Lines $lines -Header '[mcp_servers.agent-room]' -Key 'args' -Value ('["-y", ' + $package + ']')
    Set-AgentRoomTomlTableKey -Lines $lines -Header '[mcp_servers.agent-room.env]' -Key 'AGENT_ROOM_BASE_URL' -Value (Format-AgentRoomTomlString $NormalizedBaseUrl)
    $normalized = Join-AgentRoomToml -Lines $lines -NewLine $newLine
    $normalized = Normalize-AgentRoomCodexHookBlocks -Content $normalized -HookCommand ('npx -y ' + $script:McpPackageName + '@' + $EffectiveMcpVersion + ' hook')
    $temporary = $path + '.tmp'
    [IO.File]::WriteAllText($temporary, $normalized, (New-Object System.Text.UTF8Encoding($false)))
    Move-Item -LiteralPath $temporary -Destination $path -Force
}

function Normalize-AgentRoomRules {
    param([Parameter(Mandatory = $true)][string]$Path)
    if (-not (Test-Path -LiteralPath $Path -PathType Leaf)) { throw "Upstream init did not create managed rules file $Path." }
    $text = [IO.File]::ReadAllText($Path)
    $beginMatches = [regex]::Matches($text, '<!-- BEGIN agent-room rules[^>]*-->')
    $endMatches = [regex]::Matches($text, '<!-- END agent-room rules -->')
    if ($beginMatches.Count -ne 1 -or $endMatches.Count -ne 1 -or $beginMatches[0].Index -ge $endMatches[0].Index) {
        throw "Upstream managed rules section is missing from $Path."
    }
    # The upstream managed rules describe how to use Agent Room tools; they do
    # not launch the package, so there is no package spec to normalize here.
}

function Invoke-AgentRoomNormalization {
    param(
        [Parameter(Mandatory = $true)][string[]]$Targets,
        [Parameter(Mandatory = $true)][string]$NormalizedBaseUrl,
        [Parameter(Mandatory = $true)][System.Collections.IDictionary]$ExistingEntries,
        [Parameter(Mandatory = $true)][string]$EffectiveMcpVersion
    )

    $hookCommand = 'npx -y ' + $script:McpPackageName + '@' + $EffectiveMcpVersion + ' hook'
    foreach ($spec in (Get-AgentRoomJsonMcpFileSpecs -Targets $Targets)) {
        $existing = $ExistingEntries[$spec.Key]
        Normalize-AgentRoomJsonMcpFile -Spec $spec -NormalizedBaseUrl $NormalizedBaseUrl -ExistingEntry $existing -EffectiveMcpVersion $EffectiveMcpVersion
    }
    if ($Targets -contains 'claude') {
        $settingsPath = Join-Path $script:Paths.Home '.claude\settings.json'
        $settings = Read-AgentRoomJson $settingsPath
        Normalize-AgentRoomGroupedHooks -Document $settings -HookCommand $hookCommand
        Write-AgentRoomJsonAtomic -Path $settingsPath -Data $settings
        Normalize-AgentRoomRules (Join-Path $script:Paths.Home '.claude\CLAUDE.md')
    }
    if ($Targets -contains 'codex') {
        Normalize-AgentRoomCodexConfig -NormalizedBaseUrl $NormalizedBaseUrl -EffectiveMcpVersion $EffectiveMcpVersion
        Normalize-AgentRoomRules (Join-Path $script:Paths.CodexHome 'AGENTS.md')
    }
    if ($Targets -contains 'cursor') {
        Normalize-AgentRoomCursorHooks -Path (Join-Path $script:Paths.Home '.cursor\hooks.json') -HookCommand $hookCommand
    }
    if ($Targets -contains 'gemini') {
        Normalize-AgentRoomRules (Join-Path $script:Paths.Home '.gemini\GEMINI.md')
    }
}

function Remove-AgentRoomJsonMcpEntry {
    param([Parameter(Mandatory = $true)][System.Collections.IDictionary]$Spec)

    if (-not (Test-Path -LiteralPath $Spec.Path -PathType Leaf)) { return $false }
    $document = Read-AgentRoomJson $Spec.Path
    $servers = Get-ObjectValue $document $Spec.RootKey
    if ($servers -isnot [System.Collections.IDictionary]) { return $false }
    if (-not (Remove-ObjectValue $servers 'agent-room')) { return $false }
    Set-ObjectValue $document $Spec.RootKey $servers
    Write-AgentRoomJsonAtomic -Path $Spec.Path -Data $document
    return $true
}

function Remove-AgentRoomManagedRules {
    param([Parameter(Mandatory = $true)][string]$Path)

    if (-not (Test-Path -LiteralPath $Path -PathType Leaf)) { return $false }
    $text = [IO.File]::ReadAllText($Path)
    $pattern = '(?s)<!-- BEGIN agent-room rules[^>]*-->.*?<!-- END agent-room rules -->'
    $match = [regex]::Match($text, $pattern)
    if (-not $match.Success) { return $false }
    $next = $text.Substring(0, $match.Index) + $text.Substring($match.Index + $match.Length)
    [IO.File]::WriteAllText($Path, $next, (New-Object System.Text.UTF8Encoding($false)))
    return $true
}

function Remove-AgentRoomCodexMcpTables {
    param([Parameter(Mandatory = $true)][string]$Content)

    $newLine = if ($Content.Contains("`r`n")) { "`r`n" } else { "`n" }
    $output = [System.Collections.Generic.List[string]]::new()
    $skip = $false
    foreach ($line in (Split-AgentRoomToml $Content)) {
        if ($line -match '^\s*\[') {
            $header = $line.Trim()
            if ($header -ceq '[mcp_servers.agent-room]' -or $header -ceq '[mcp_servers.agent-room.env]') {
                $skip = $true
                continue
            }
            $skip = $false
        }
        if (-not $skip) { $output.Add([string]$line) }
    }
    return Join-AgentRoomToml -Lines $output -NewLine $newLine
}

function Remove-AgentRoomCodexHookBlocks {
    param([Parameter(Mandatory = $true)][string]$Content)

    $newLine = if ($Content.Contains("`r`n")) { "`r`n" } else { "`n" }
    $lines = [System.Collections.Generic.List[string]]::new()
    foreach ($line in (Split-AgentRoomToml $Content)) { $lines.Add([string]$line) }
    $output = [System.Collections.Generic.List[string]]::new()
    $eventHeader = '^\[\[hooks\.(Stop|UserPromptSubmit|SessionStart)\]\]\s*$'

    for ($i = 0; $i -lt $lines.Count; $i++) {
        $outerMatch = [regex]::Match($lines[$i], $eventHeader)
        if (-not $outerMatch.Success) { $output.Add($lines[$i]); continue }
        $event = $outerMatch.Groups[1].Value
        $end = $i + 1
        while ($end -lt $lines.Count) {
            if ($lines[$end] -match '^\s*\[' -and $lines[$end].Trim() -cne "[[hooks.$event.hooks]]") { break }
            $end++
        }

        $block = [System.Collections.Generic.List[string]]::new()
        for ($n = $i; $n -lt $end; $n++) { $block.Add($lines[$n]) }
        $prelude = [System.Collections.Generic.List[string]]::new()
        $children = [System.Collections.Generic.List[object]]::new()
        $hadAgentRoom = $false
        for ($k = 0; $k -lt $block.Count;) {
            if ($block[$k].Trim() -cne "[[hooks.$event.hooks]]") { $prelude.Add($block[$k]); $k++; continue }
            $childEnd = $k + 1
            while ($childEnd -lt $block.Count -and $block[$childEnd] -notmatch '^\s*\[') { $childEnd++ }
            $child = [System.Collections.Generic.List[string]]::new()
            for ($n = $k; $n -lt $childEnd; $n++) { $child.Add($block[$n]) }
            $isAgentRoom = $false
            foreach ($line in $child) {
                if ($line -match '^\s*command\s*=\s*"[^"]*agent-room-mcp(?:@[^"\s]+)?\s+hook[^"\s]*"\s*$') { $isAgentRoom = $true; break }
            }
            if ($isAgentRoom) { $hadAgentRoom = $true } else { $children.Add($child.ToArray()) }
            $k = $childEnd
        }

        if ($hadAgentRoom) {
            $onlyDefaultOuter = $true
            foreach ($line in $prelude) {
                if ([string]::IsNullOrWhiteSpace($line)) { continue }
                if ($line.Trim() -ceq "[[hooks.$event]]" -or $line.Trim() -ceq 'matcher = ""') { continue }
                $onlyDefaultOuter = $false
            }
            if (-not $onlyDefaultOuter -or $children.Count -gt 0) {
                foreach ($line in $prelude) { $output.Add($line) }
                foreach ($child in $children) { foreach ($line in $child) { $output.Add($line) } }
            }
        } else {
            foreach ($line in $block) { $output.Add($line) }
        }
        $i = $end - 1
    }
    return Join-AgentRoomToml -Lines $output -NewLine $newLine
}

function Remove-AgentRoomCodexConfig {
    param([Parameter(Mandatory = $true)][string]$Path)
    if (-not (Test-Path -LiteralPath $Path -PathType Leaf)) { return $false }
    $original = [IO.File]::ReadAllText($Path)
    $updated = Remove-AgentRoomCodexMcpTables $original
    $updated = Remove-AgentRoomCodexHookBlocks $updated
    if ($updated -ceq $original) { return $false }
    $temporary = $Path + '.tmp'
    [IO.File]::WriteAllText($temporary, $updated, (New-Object System.Text.UTF8Encoding($false)))
    Move-Item -LiteralPath $temporary -Destination $Path -Force
    return $true
}

function Get-AgentRoomCodexHookCounts {
    param([Parameter(Mandatory = $true)][string]$Content)

    $counts = @{ Stop = 0; UserPromptSubmit = 0; SessionStart = 0 }
    $lines = [System.Collections.Generic.List[string]]::new()
    foreach ($line in (Split-AgentRoomToml $Content)) { $lines.Add([string]$line) }
    $eventHeader = '^\[\[hooks\.(Stop|UserPromptSubmit|SessionStart)\]\]\s*$'
    for ($i = 0; $i -lt $lines.Count; $i++) {
        $outerMatch = [regex]::Match($lines[$i], $eventHeader)
        if (-not $outerMatch.Success) { continue }
        $event = $outerMatch.Groups[1].Value
        $end = $i + 1
        while ($end -lt $lines.Count) {
            if ($lines[$end] -match '^\s*\[' -and $lines[$end].Trim() -cne "[[hooks.$event.hooks]]") { break }
            $end++
        }
        for ($k = $i; $k -lt $end; $k++) {
            if ($lines[$k].Trim() -cne "[[hooks.$event.hooks]]") { continue }
            $childEnd = $k + 1
            while ($childEnd -lt $end -and $lines[$childEnd] -notmatch '^\s*\[') { $childEnd++ }
            for ($n = $k; $n -lt $childEnd; $n++) {
                if ($lines[$n] -match '^\s*command\s*=\s*"[^"]*agent-room-mcp(?:@[^"\s]+)?\s+hook[^"\s]*"\s*$') {
                    $counts[$event]++
                    break
                }
            }
            $k = $childEnd - 1
        }
        $i = $end - 1
    }
    return $counts
}

function Get-AgentRoomCodexPinnedHookCounts {
    param(
        [Parameter(Mandatory = $true)][string]$Content,
        [AllowNull()][string]$ExpectedMcpVersion
    )

    $counts = @{ Stop = 0; UserPromptSubmit = 0; SessionStart = 0 }
    $lines = [System.Collections.Generic.List[string]]::new()
    foreach ($line in (Split-AgentRoomToml $Content)) { $lines.Add([string]$line) }
    $eventHeader = '^\[\[hooks\.(Stop|UserPromptSubmit|SessionStart)\]\]\s*$'
    for ($i = 0; $i -lt $lines.Count; $i++) {
        $outerMatch = [regex]::Match($lines[$i], $eventHeader)
        if (-not $outerMatch.Success) { continue }
        $event = $outerMatch.Groups[1].Value
        $end = $i + 1
        while ($end -lt $lines.Count) {
            if ($lines[$end] -match '^\s*\[' -and $lines[$end].Trim() -cne "[[hooks.$event.hooks]]") { break }
            $end++
        }
        for ($k = $i; $k -lt $end; $k++) {
            if ($lines[$k].Trim() -cne "[[hooks.$event.hooks]]") { continue }
            $childEnd = $k + 1
            while ($childEnd -lt $end -and $lines[$childEnd] -notmatch '^\s*\[') { $childEnd++ }
            for ($n = $k; $n -lt $childEnd; $n++) {
                if ($lines[$n] -match '^\s*command\s*=\s*"(?<command>[^"]*)"\s*$' -and
                    (Test-AgentRoomPinnedHookCommand -Command $Matches.command -ExpectedMcpVersion $ExpectedMcpVersion)) {
                    $counts[$event]++
                    break
                }
            }
            $k = $childEnd - 1
        }
        $i = $end - 1
    }
    return $counts
}

function Get-AgentRoomExpectedManagedEnvironment {
    param(
        [Parameter(Mandatory = $true)][string]$Client,
        [Parameter(Mandatory = $true)][string]$Surface
    )

    switch ("$Client|$Surface") {
        'claude|cli' {
            return [ordered]@{ CLAUDECODE = '1' }
        }
        'claude|desktop' {
            return [ordered]@{ CLAUDECODE = '1'; CLAUDE_CODE_ENTRYPOINT = 'claude-desktop' }
        }
        'gemini|default' {
            return [ordered]@{ ANTIGRAVITY_CLI = '1' }
        }
        'vscode|default' {
            return [ordered]@{ GITHUB_COPILOT = '1' }
        }
        'copilot|default' {
            return [ordered]@{ GITHUB_COPILOT = '1' }
        }
        default {
            return [ordered]@{}
        }
    }
}

function Test-AgentRoomManagedEnvironment {
    param(
        [Parameter(Mandatory = $true)][System.Collections.IDictionary]$Environment,
        [Parameter(Mandatory = $true)][string]$Client,
        [Parameter(Mandatory = $true)][string]$Surface
    )

    $managedKeys = @(Get-AgentRoomManagedEnvKeys -Client $Client)
    $expected = Get-AgentRoomExpectedManagedEnvironment -Client $Client -Surface $Surface
    foreach ($managedKey in $managedKeys) {
        $actualValue = Get-ObjectValue $Environment $managedKey
        $expectedValue = Get-ObjectValue $expected $managedKey
        if ($null -eq $expectedValue) {
            if ($null -ne $actualValue) { return $false }
            continue
        }
        if ([string]$actualValue -cne [string]$expectedValue) { return $false }
    }
    return $true
}

function Test-AgentRoomMcpEntry {
    param(
        [Parameter(Mandatory = $true)][System.Collections.IDictionary]$Spec,
        [Parameter(Mandatory = $true)][string]$ExpectedBaseUrl,
        [AllowNull()][string]$ExpectedMcpVersion
    )

    if (-not (Test-AgentRoomMcpVersion $ExpectedMcpVersion)) { return $false }
    if (-not (Test-Path -LiteralPath $Spec.Path -PathType Leaf)) { return $false }
    $document = Read-AgentRoomJson $Spec.Path
    $servers = Get-ObjectValue $document $Spec.RootKey
    $entry = Get-ObjectValue $servers 'agent-room'
    if ($entry -isnot [System.Collections.IDictionary]) { return $false }
    $expectedPackage = $script:McpPackageName + '@' + $ExpectedMcpVersion
    $args = Get-ObjectValue $entry 'args'
    if ($Spec.Client -eq 'vscode') {
        if ((Get-ObjectValue $entry 'type') -ne 'stdio' -or (Get-ObjectValue $entry 'command') -ne 'cmd') { return $false }
        if (($args -join '|') -cne ('/c|npx|-y|' + $expectedPackage)) { return $false }
    } else {
        if ((Get-ObjectValue $entry 'command') -ne 'npx') { return $false }
        if (($args -join '|') -cne ('-y|' + $expectedPackage)) { return $false }
    }
    $environment = Get-ObjectValue $entry 'env'
    if ((Get-ObjectValue $environment 'AGENT_ROOM_BASE_URL') -cne $ExpectedBaseUrl) { return $false }
    if ($environment -isnot [System.Collections.IDictionary]) { return $false }
    return (Test-AgentRoomManagedEnvironment -Environment $environment -Client $Spec.Client -Surface $Spec.Surface)
}

function Test-AgentRoomClientConfiguration {
    param(
        [Parameter(Mandatory = $true)][string]$Client,
        [Parameter(Mandatory = $true)][string[]]$Targets,
        [Parameter(Mandatory = $true)][string]$ExpectedBaseUrl,
        [AllowNull()][string]$ExpectedMcpVersion
    )

    $mcpOk = $true
    foreach ($spec in (Get-AgentRoomJsonMcpFileSpecs -Targets $Targets)) {
        if (-not (Test-AgentRoomMcpEntry -Spec $spec -ExpectedBaseUrl $ExpectedBaseUrl -ExpectedMcpVersion $ExpectedMcpVersion)) { $mcpOk = $false }
    }
    $hookOk = $true
    $rulesOk = $true
    if ($Targets -contains 'claude') {
        $settingsPath = Join-Path $script:Paths.Home '.claude\settings.json'
        if (-not (Test-Path -LiteralPath $settingsPath -PathType Leaf)) { $hookOk = $false }
        else {
            $settings = Read-AgentRoomJson $settingsPath
            $hooks = Get-ObjectValue $settings 'hooks'
            foreach ($event in $script:HookEvents) {
                $count = 0
                $pinnedCount = 0
                $groups = Get-ObjectValue $hooks $event
                foreach ($group in $groups) {
                    $children = Get-ObjectValue $group 'hooks'
                    foreach ($child in $children) {
                        $command = Get-ObjectValue $child 'command'
                        if (Test-AgentRoomHookCommand $command) {
                            $count++
                            if (Test-AgentRoomPinnedHookCommand -Command $command -ExpectedMcpVersion $ExpectedMcpVersion) { $pinnedCount++ }
                        }
                    }
                }
                if ($count -ne 1 -or $pinnedCount -ne 1) { $hookOk = $false }
            }
        }
        $rulesOk = $rulesOk -and (Test-AgentRoomManagedRules (Join-Path $script:Paths.Home '.claude\CLAUDE.md'))
    }
    if ($Targets -contains 'codex') {
        $codexPath = Join-Path $script:Paths.CodexHome 'config.toml'
        if (-not (Test-Path -LiteralPath $codexPath -PathType Leaf)) { $mcpOk = $false; $hookOk = $false }
        else {
            $toml = [IO.File]::ReadAllText($codexPath)
            $mcpTable = [regex]::Match($toml, '(?ms)^\[mcp_servers\.agent-room\]\s*\r?\n(?<body>.*?)(?=^\[|\z)')
            $envTable = [regex]::Match($toml, '(?ms)^\[mcp_servers\.agent-room\.env\]\s*\r?\n(?<body>.*?)(?=^\[|\z)')
            $package = [regex]::Escape($script:McpPackageName + '@' + $ExpectedMcpVersion)
            if (-not $mcpTable.Success -or $mcpTable.Groups['body'].Value -notmatch '(?m)^\s*command\s*=\s*"npx"\s*$' -or
                $mcpTable.Groups['body'].Value -notmatch ('(?m)^\s*args\s*=\s*\["-y",\s*"' + $package + '"\]\s*$') -or
                -not $envTable.Success -or $envTable.Groups['body'].Value -notmatch ('(?m)^\s*AGENT_ROOM_BASE_URL\s*=\s*"' + [regex]::Escape($ExpectedBaseUrl) + '"\s*$')) { $mcpOk = $false }
            $counts = Get-AgentRoomCodexHookCounts $toml
            $pinnedCounts = Get-AgentRoomCodexPinnedHookCounts -Content $toml -ExpectedMcpVersion $ExpectedMcpVersion
            foreach ($event in $script:HookEvents) {
                if ($counts[$event] -ne 1 -or $pinnedCounts[$event] -ne 1) { $hookOk = $false }
            }
        }
        $rulesOk = $rulesOk -and (Test-AgentRoomManagedRules (Join-Path $script:Paths.CodexHome 'AGENTS.md'))
    }
    if ($Targets -contains 'cursor') {
        $hooksPath = Join-Path $script:Paths.Home '.cursor\hooks.json'
        if (-not (Test-Path -LiteralPath $hooksPath -PathType Leaf)) { $hookOk = $false }
        else {
            $hooksDoc = Read-AgentRoomJson $hooksPath
            $stop = Get-ObjectValue (Get-ObjectValue $hooksDoc 'hooks') 'stop'
            $count = 0
            $pinnedCount = 0
            foreach ($item in @($stop)) {
                $command = Get-ObjectValue $item 'command'
                if (Test-AgentRoomHookCommand $command) {
                    $count++
                    if (Test-AgentRoomPinnedHookCommand -Command $command -ExpectedMcpVersion $ExpectedMcpVersion) { $pinnedCount++ }
                }
            }
            if ($count -ne 1 -or $pinnedCount -ne 1 -or (Get-ObjectValue $hooksDoc 'version') -ne 1) { $hookOk = $false }
        }
    }
    if ($Targets -contains 'gemini') { $rulesOk = $rulesOk -and (Test-AgentRoomManagedRules (Join-Path $script:Paths.Home '.gemini\GEMINI.md')) }
    return @{ Mcp = $mcpOk; Hooks = $hookOk; Rules = $rulesOk }
}

function Test-AgentRoomManagedRules {
    param([Parameter(Mandatory = $true)][string]$Path)
    if (-not (Test-Path -LiteralPath $Path -PathType Leaf)) { return $false }
    $text = [IO.File]::ReadAllText($Path)
    return ([regex]::Matches($text, '<!-- BEGIN agent-room rules[^>]*-->').Count -eq 1 -and
        [regex]::Matches($text, '<!-- END agent-room rules -->').Count -eq 1)
}

function Get-AgentRoomState {
    $path = Join-Path $script:Paths.StateRoot 'install-state.json'
    if (-not (Test-Path -LiteralPath $path -PathType Leaf)) { return $null }
    return Read-AgentRoomJson $path
}

function Get-AgentRoomEnvironmentBaseUrl {
    if ($script:Paths.IsTestRoot) {
        $path = Join-Path $script:Paths.StateRoot 'test-env.json'
        if (-not (Test-Path -LiteralPath $path -PathType Leaf)) { return $null }
        $environment = Read-AgentRoomJson $path
        return [string](Get-ObjectValue $environment 'AGENT_ROOM_BASE_URL')
    }
    return [Environment]::GetEnvironmentVariable('AGENT_ROOM_BASE_URL', 'User')
}

function Invoke-AgentRoomStatus {
    param(
        [AllowNull()][string]$BaseUrlOverride,
        [switch]$AllowOfflineResult,
        [AllowNull()][string]$ExpectedMcpVersion
    )

    $state = Get-AgentRoomState
    Write-Host 'Agent Room Client Status'
    if ($null -eq $state) {
        Write-Host 'NOT INSTALLED'
        return 0
    }
    if ([string]::IsNullOrWhiteSpace($ExpectedMcpVersion)) {
        $ExpectedMcpVersion = Resolve-AgentRoomEffectiveMcpVersion -Mode 'status' -State $state
    }
    $expectedVersionValid = Test-AgentRoomMcpVersion $ExpectedMcpVersion
    $storedBaseUrl = [string](Get-ObjectValue $state 'baseUrl')
    $url = if ([string]::IsNullOrWhiteSpace($BaseUrlOverride)) { $storedBaseUrl } else { Normalize-AgentRoomBaseUrl $BaseUrlOverride }
    Write-Host "Base URL`n  $url"
    $api = if ([string]::IsNullOrWhiteSpace($url)) { @{ Online = $false; Detail = 'BaseUrl is missing.' } } else { Test-AgentRoomApi $url }
    if ($api.Online) { Write-Host '  API: ONLINE' } else { Write-Host "  API: OFFLINE ($($api.Detail))" }

    $runtime = Get-NodeRuntime
    if ($runtime.NodeReady) { Write-Host "Runtime`n  Node: $($runtime.NodeVersion)" } else { Write-Host 'Runtime`n  Node: NEEDS NODE.JS 20+' }
    if ($runtime.NpmVersion) { Write-Host "  npm: OK ($($runtime.NpmVersion))" } else { Write-Host '  npm: MISSING' }
    if ($runtime.NpxVersion) { Write-Host "  npx: OK ($($runtime.NpxVersion))" } else { Write-Host '  npx: MISSING' }
    if ($expectedVersionValid) {
        Write-Host "  MCP package: $script:McpPackageName@$ExpectedMcpVersion"
    } else {
        Write-Host '  MCP package: NEEDS REPAIR (install-state.mcpVersion is missing or invalid)'
    }

    $userBaseUrl = Get-AgentRoomEnvironmentBaseUrl
    $consistencyOk = (-not [string]::IsNullOrWhiteSpace($userBaseUrl)) -and
        ($userBaseUrl -ceq $storedBaseUrl) -and ($url -ceq $storedBaseUrl)
    if (-not $consistencyOk) { Write-Host '  BaseUrl consistency: NEEDS REPAIR' }
    $exitCode = 0
    if (-not $api.Online -and -not $AllowOfflineResult) { $exitCode = 1 }
    if (-not $runtime.IsReady -or -not $consistencyOk) { $exitCode = 1 }
    if (-not $expectedVersionValid) { $exitCode = 1 }

    $stateClients = Get-ObjectValue $state 'clients'
    $selection = Expand-AgentRoomStateClients $stateClients
    foreach ($client in $selection.Clients) {
        $targets = switch ($client) {
            'claude' { @('claude') }
            'codex' { @('codex') }
            'cursor' { @('cursor') }
            'gemini-antigravity' { @('gemini') }
            'vscode' { @('vscode') }
            'copilot' { @('copilot') }
            'vscode-copilot' { @('vscode', 'copilot') }
            default { @() }
        }
        $result = Test-AgentRoomClientConfiguration -Client $client -Targets $targets -ExpectedBaseUrl $storedBaseUrl -ExpectedMcpVersion $ExpectedMcpVersion
        $label = switch ($client) {
            'gemini-antigravity' { 'Gemini / Antigravity' }
            'vscode-copilot' { 'VS Code / Copilot' }
            'vscode' { 'VS Code' }
            default { (Get-Culture).TextInfo.ToTitleCase($client) }
        }
        Write-Host "Clients`n  $label"
        Write-Host "    MCP: $(if ($result.Mcp) { 'OK' } else { 'NEEDS REPAIR' })"
        if ($client -in @('claude', 'codex', 'cursor')) {
            $hookLabel = if ($client -eq 'cursor') { 'Stop hook' } else { 'Hooks' }
            $hookValue = if ($result.Hooks) { if ($client -eq 'cursor') { 'OK' } else { '3/3' } } else { 'NEEDS REPAIR' }
            Write-Host "    ${hookLabel}: $hookValue"
        }
        if ($client -in @('claude', 'codex', 'gemini-antigravity')) { Write-Host "    Rules: $(if ($result.Rules) { 'OK' } else { 'NEEDS REPAIR' })" }
        if ($client -eq 'codex') { Write-Host '    Hook trust: USER ACTION MAY BE REQUIRED (/hooks trust)' }
        if (-not $result.Mcp -or -not $result.Hooks -or -not $result.Rules) { $exitCode = 1 }
    }
    return $exitCode
}

function Set-AgentRoomBaseUrl {
    param([Parameter(Mandatory = $true)][string]$NormalizedBaseUrl)

    if ($script:Paths.IsTestRoot) {
        New-Item -ItemType Directory -Path $script:Paths.StateRoot -Force | Out-Null
        Write-AgentRoomJsonAtomic -Path (Join-Path $script:Paths.StateRoot 'test-env.json') -Data ([ordered]@{ AGENT_ROOM_BASE_URL = $NormalizedBaseUrl })
        $env:AGENT_ROOM_BASE_URL = $NormalizedBaseUrl
        Write-Host 'TestRoot mode: real Windows User environment was not changed.'
        return
    }
    [Environment]::SetEnvironmentVariable('AGENT_ROOM_BASE_URL', $NormalizedBaseUrl, 'User')
    $env:AGENT_ROOM_BASE_URL = $NormalizedBaseUrl
    Write-Host 'Saved AGENT_ROOM_BASE_URL in the current Windows user environment.'
}

function Get-AgentRoomTargetsFromClients {
    param([string[]]$StateClients)
    return (Expand-AgentRoomStateClients $StateClients).Targets
}

function Invoke-AgentRoomInstall {
    param([switch]$IsRepair)

    $previousState = Get-AgentRoomState
    if ($IsRepair -and $null -eq $previousState) { throw 'No Agent Room install state exists. Run install first.' }

    $mode = if ($IsRepair) { 'repair' } else { 'install' }
    $effectiveMcpVersion = Resolve-AgentRoomEffectiveMcpVersion -Mode $mode -State $previousState
    if (-not (Test-AgentRoomMcpVersion $effectiveMcpVersion)) {
        throw 'McpVersion must be a pinned semantic version such as 0.26.24; @latest is not supported.'
    }

    $runtime = Ensure-NodeRuntime
    $resolvedBaseUrl = Resolve-AgentRoomBaseUrl -State $previousState -AllowPrompt
    $api = Test-AgentRoomApi $resolvedBaseUrl
    $allowOffline = $false
    if (-not $api.Online) {
        Write-Host "API OFFLINE: $($api.Detail)"
        if ($IsRepair) { throw 'repair requires an online Agent Room API.' }
        if ($NonInteractive) { throw 'The Agent Room API is offline; non-interactive install cannot continue.' }
        $answer = Read-Host 'Continue installing client configuration anyway? [y/N]'
        if ($answer -notmatch '^(?i:y|yes)$') { throw 'Installation cancelled because the API is offline.' }
        $allowOffline = $true
    }

    $selection = $null
    if ($IsRepair -and $null -eq $Clients) {
        $selection = Expand-AgentRoomStateClients (Get-ObjectValue $previousState 'clients')
    } elseif ($null -ne $Clients) {
        $selection = Resolve-AgentRoomClientSelection -Requested $Clients
    } else {
        $detected = Get-DetectedAgentRoomClients
        if ($detected.Count -eq 0) {
            if ($NonInteractive) { throw 'No supported AI client was detected. Pass -Clients to select one or more clients.' }
            $chosen = Read-Host 'No supported AI client was detected. Enter clients (comma-separated), or press Enter to cancel'
            if ([string]::IsNullOrWhiteSpace($chosen)) { throw 'No client was selected.' }
            $selection = Resolve-AgentRoomClientSelection -Requested @($chosen)
        } else {
            $selection = Resolve-AgentRoomClientSelection -Requested $detected
        }
    }
    if ($selection.Clients.Count -eq 0 -or $selection.Targets.Count -eq 0) { throw 'No supported client was selected.' }

    Write-Host "Base URL: $resolvedBaseUrl"
    Write-Host ('Client targets: ' + ($selection.Clients -join ', '))
    if ($null -ne $runtime.NpxCommand) { Write-Host "Pinned MCP package: $script:McpPackageName@$effectiveMcpVersion" }

    New-AgentRoomConfigBackup | Out-Null
    $existingEntries = Get-AgentRoomExistingMcpEntries -Targets $selection.Targets
    Set-AgentRoomBaseUrl -NormalizedBaseUrl $resolvedBaseUrl

    foreach ($target in $selection.Targets) {
        Invoke-AgentRoomUpstreamInit -Target $target -NormalizedBaseUrl $resolvedBaseUrl -EffectiveMcpVersion $effectiveMcpVersion
    }
    Invoke-AgentRoomNormalization -Targets $selection.Targets -NormalizedBaseUrl $resolvedBaseUrl -ExistingEntries $existingEntries -EffectiveMcpVersion $effectiveMcpVersion

    $now = [DateTimeOffset]::UtcNow.ToString('o')
    $installedAt = if ($null -ne $previousState -and (Get-ObjectValue $previousState 'installedAt')) {
        [string](Get-ObjectValue $previousState 'installedAt')
    } else { $now }
    $state = [ordered]@{
        version = 1
        baseUrl = $resolvedBaseUrl
        mcpVersion = $effectiveMcpVersion
        installedAt = $installedAt
        updatedAt = $now
        clients = @($selection.Clients)
    }
    Write-AgentRoomJsonAtomic -Path (Join-Path $script:Paths.StateRoot 'install-state.json') -Data $state

    $statusCode = Invoke-AgentRoomStatus -BaseUrlOverride $resolvedBaseUrl -AllowOfflineResult:$allowOffline -ExpectedMcpVersion $effectiveMcpVersion
    if ($statusCode -ne 0) { throw 'Post-install status found a client configuration or runtime issue.' }
    Write-Host 'Agent Room client setup completed. Restart the selected AI clients.'
    if ($selection.Clients -contains 'codex') { Write-Host 'Codex may require the one-time /hooks trust confirmation.' }
    return 0
}

function Invoke-AgentRoomUninstall {
    $state = Get-AgentRoomState
    if ($null -eq $state) {
        Write-Host 'NOT INSTALLED'
        return 0
    }

    $selection = Expand-AgentRoomStateClients (Get-ObjectValue $state 'clients')
    New-AgentRoomConfigBackup | Out-Null
    foreach ($spec in (Get-AgentRoomJsonMcpFileSpecs -Targets $selection.Targets)) {
        Remove-AgentRoomJsonMcpEntry -Spec $spec | Out-Null
    }

    if ($selection.Targets -contains 'claude') {
        $settingsPath = Join-Path $script:Paths.Home '.claude\settings.json'
        if (Test-Path -LiteralPath $settingsPath -PathType Leaf) {
            $settings = Read-AgentRoomJson $settingsPath
            if (Remove-AgentRoomGroupedHooks $settings) { Write-AgentRoomJsonAtomic -Path $settingsPath -Data $settings }
        }
        Remove-AgentRoomManagedRules (Join-Path $script:Paths.Home '.claude\CLAUDE.md') | Out-Null
    }
    if ($selection.Targets -contains 'codex') {
        Remove-AgentRoomCodexConfig (Join-Path $script:Paths.CodexHome 'config.toml') | Out-Null
        Remove-AgentRoomManagedRules (Join-Path $script:Paths.CodexHome 'AGENTS.md') | Out-Null
    }
    if ($selection.Targets -contains 'cursor') {
        $hooksPath = Join-Path $script:Paths.Home '.cursor\hooks.json'
        if (Test-Path -LiteralPath $hooksPath -PathType Leaf) {
            $hooksDocument = Read-AgentRoomJson $hooksPath
            if (Remove-AgentRoomCursorHooks $hooksDocument) { Write-AgentRoomJsonAtomic -Path $hooksPath -Data $hooksDocument }
        }
    }
    if ($selection.Targets -contains 'gemini') {
        Remove-AgentRoomManagedRules (Join-Path $script:Paths.Home '.gemini\GEMINI.md') | Out-Null
    }

    $storedBaseUrl = [string](Get-ObjectValue $state 'baseUrl')
    if ($script:Paths.IsTestRoot) {
        $testEnvironmentPath = Join-Path $script:Paths.StateRoot 'test-env.json'
        if (Test-Path -LiteralPath $testEnvironmentPath -PathType Leaf) {
            $testEnvironment = Read-AgentRoomJson $testEnvironmentPath
            if ((Get-ObjectValue $testEnvironment 'AGENT_ROOM_BASE_URL') -ceq $storedBaseUrl) {
                Remove-Item -LiteralPath $testEnvironmentPath -Force
            }
        }
        if ($env:AGENT_ROOM_BASE_URL -ceq $storedBaseUrl) { Remove-Item Env:AGENT_ROOM_BASE_URL -ErrorAction SilentlyContinue }
    } else {
        $userBaseUrl = [Environment]::GetEnvironmentVariable('AGENT_ROOM_BASE_URL', 'User')
        if ($userBaseUrl -ceq $storedBaseUrl) {
            [Environment]::SetEnvironmentVariable('AGENT_ROOM_BASE_URL', $null, 'User')
            if ($env:AGENT_ROOM_BASE_URL -ceq $storedBaseUrl) { Remove-Item Env:AGENT_ROOM_BASE_URL -ErrorAction SilentlyContinue }
        }
    }

    Remove-Item -LiteralPath (Join-Path $script:Paths.StateRoot 'install-state.json') -Force
    Write-Host 'Agent Room MCP entries, Agent Room hooks, managed rules, install state, and matching user URL were removed.'
    Write-Host 'Backups and logs were preserved.'
    return 0
}

function Invoke-AgentRoomMain {
    $script:Paths = Resolve-AgentRoomPaths
    Start-AgentRoomTranscript
    try {
        switch ($Action) {
            'install' { return (Invoke-AgentRoomInstall) }
            'repair' { return (Invoke-AgentRoomInstall -IsRepair) }
            'status' { return (Invoke-AgentRoomStatus -BaseUrlOverride $BaseUrl) }
            'uninstall' { return (Invoke-AgentRoomUninstall) }
            default { throw "Unsupported action: $Action" }
        }
    } finally {
        Stop-AgentRoomTranscript
    }
}

if ($MyInvocation.InvocationName -ne '.') {
    try {
        $exitCode = Invoke-AgentRoomMain
    } catch {
        Write-Host "ERROR: $($_.Exception.Message)"
        Stop-AgentRoomTranscript
        $exitCode = 1
    }
    exit [int]$exitCode
}
