# Agent Room Windows Credential Manager helper (GENERIC credentials).
# Usage: win-cred.ps1 get|set|delete <key> [value]
param(
  [Parameter(Mandatory = $true)][ValidateSet('get', 'set', 'delete')][string]$Action,
  [Parameter(Mandatory = $true)][string]$Key,
  [string]$Value = ''
)

$ErrorActionPreference = 'Stop'
$Target = "AgentRoom/$Key"

Add-Type -TypeDefinition @"
using System;
using System.Runtime.InteropServices;
using System.Text;

public static class AgentRoomCred {
  [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
  public struct CREDENTIAL {
    public uint Flags;
    public uint Type;
    public string TargetName;
    public string Comment;
    public System.Runtime.InteropServices.ComTypes.FILETIME LastWritten;
    public uint CredentialBlobSize;
    public IntPtr CredentialBlob;
    public uint Persist;
    public uint AttributeCount;
    public IntPtr Attributes;
    public string TargetAlias;
    public string UserName;
  }

  [DllImport("advapi32.dll", SetLastError = true, CharSet = CharSet.Unicode)]
  public static extern bool CredWrite(ref CREDENTIAL userCredential, uint flags);

  [DllImport("advapi32.dll", SetLastError = true, CharSet = CharSet.Unicode)]
  public static extern bool CredRead(string target, uint type, uint reservedFlag, out IntPtr credentialPtr);

  [DllImport("advapi32.dll", SetLastError = true)]
  public static extern bool CredDelete(string target, uint type, uint flags);

  [DllImport("advapi32.dll", SetLastError = true)]
  public static extern void CredFree(IntPtr buffer);

  public const uint CRED_TYPE_GENERIC = 1;
  public const uint CRED_PERSIST_LOCAL_MACHINE = 2;
}
"@

function Set-Cred([string]$target, [string]$secret) {
  $bytes = [Text.Encoding]::UTF8.GetBytes($secret)
  $ptr = [Runtime.InteropServices.Marshal]::AllocHGlobal($bytes.Length)
  try {
    [Runtime.InteropServices.Marshal]::Copy($bytes, 0, $ptr, $bytes.Length)
    $cred = New-Object AgentRoomCred+CREDENTIAL
    $cred.Type = [AgentRoomCred]::CRED_TYPE_GENERIC
    $cred.TargetName = $target
    $cred.UserName = 'agent-room'
    $cred.CredentialBlobSize = [uint32]$bytes.Length
    $cred.CredentialBlob = $ptr
    $cred.Persist = [AgentRoomCred]::CRED_PERSIST_LOCAL_MACHINE
    if (-not [AgentRoomCred]::CredWrite([ref]$cred, 0)) {
      throw "CredWrite failed: $([ComponentModel.Win32Exception]::new([Runtime.InteropServices.Marshal]::GetLastWin32Error()).Message)"
    }
  } finally {
    [Runtime.InteropServices.Marshal]::FreeHGlobal($ptr)
  }
}

function Get-Cred([string]$target) {
  $ptr = [IntPtr]::Zero
  if (-not [AgentRoomCred]::CredRead($target, [AgentRoomCred]::CRED_TYPE_GENERIC, 0, [ref]$ptr)) {
    exit 2
  }
  try {
    $cred = [Runtime.InteropServices.Marshal]::PtrToStructure($ptr, [type][AgentRoomCred+CREDENTIAL])
    if ($cred.CredentialBlobSize -eq 0 -or $cred.CredentialBlob -eq [IntPtr]::Zero) { return '' }
    $bytes = New-Object byte[] $cred.CredentialBlobSize
    [Runtime.InteropServices.Marshal]::Copy($cred.CredentialBlob, $bytes, 0, $cred.CredentialBlobSize)
    return [Text.Encoding]::UTF8.GetString($bytes)
  } finally {
    [AgentRoomCred]::CredFree($ptr)
  }
}

function Remove-Cred([string]$target) {
  [void][AgentRoomCred]::CredDelete($target, [AgentRoomCred]::CRED_TYPE_GENERIC, 0)
}

switch ($Action) {
  'set' { Set-Cred $Target $Value; Write-Output 'ok' }
  'get' { Write-Output (Get-Cred $Target) }
  'delete' { Remove-Cred $Target; Write-Output 'ok' }
}
