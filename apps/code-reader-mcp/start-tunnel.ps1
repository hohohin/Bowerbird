param(
  [Parameter(Mandatory = $true)]
  [ValidatePattern('^tunnel_[A-Za-z0-9]+$')]
  [string]$TunnelId,
  [string]$TunnelClient = 'tunnel-client',
  [string]$ControlPlaneProxy = '',
  [switch]$Configure
)

$ErrorActionPreference = 'Stop'
$proxyArgs = @()
if ($ControlPlaneProxy) {
  $proxyUri = $null
  if (-not [Uri]::TryCreate($ControlPlaneProxy, [UriKind]::Absolute, [ref]$proxyUri) -or
      $proxyUri.Scheme -notin @('http', 'https') -or -not $proxyUri.Host -or $proxyUri.UserInfo -or
      $proxyUri.Query -or $proxyUri.Fragment -or $proxyUri.AbsolutePath -ne '/') {
    throw '代理地址必须是 http://主机:端口 或 https://主机:端口，不能包含账号、密码或路径。'
  }
  $proxyArgs = @('--control-plane.http-proxy', $ControlPlaneProxy)
}
$nodeCommand = (Get-Command node -CommandType Application -ErrorAction Stop | Select-Object -First 1).Source
if ($TunnelClient -eq 'tunnel-client' -and -not (Get-Command $TunnelClient -CommandType Application -ErrorAction SilentlyContinue)) {
  $TunnelClient = Join-Path $PSScriptRoot '.local/tunnel-client-v0.0.18/tunnel-client.exe'
}
$tunnelCommand = (Get-Command $TunnelClient -CommandType Application -ErrorAction Stop | Select-Object -First 1).Source
$launcher = Join-Path $PSScriptRoot 'run.mjs'
$profileName = 'bowerbird-code-reader-' + $TunnelId
$profileDir = Join-Path $PSScriptRoot '.local/profiles'
if (-not (Test-Path -LiteralPath (Join-Path $PSScriptRoot '.local/snapshot.json'))) {
  throw '先运行 node apps/code-reader-mcp/export.mjs 生成本地快照。'
}

# Fixed local command only; no project root or credentials are passed as MCP arguments.
$mcpCommand = '"{0}" "{1}"' -f $nodeCommand.Replace('\', '/'), $launcher.Replace('\', '/')
if ($Configure) {
  & $tunnelCommand init --sample sample_mcp_stdio_local --profile $profileName --profile-dir $profileDir --tunnel-id $TunnelId --mcp-command $mcpCommand
  if ($LASTEXITCODE -ne 0) { throw '本机隧道配置检查失败，请根据上方提示检查程序路径后重试；此时尚未要求输入密钥。' }
}
$previousKey = $env:CONTROL_PLANE_API_KEY
try {
  if (-not $env:CONTROL_PLANE_API_KEY) {
    $secureKey = Read-Host '输入隧道专用 runtime API key（隐藏输入，不会写入配置）' -AsSecureString
    $keyPointer = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($secureKey)
    try { $env:CONTROL_PLANE_API_KEY = [Runtime.InteropServices.Marshal]::PtrToStringBSTR($keyPointer) }
    finally { [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($keyPointer); $secureKey.Dispose() }
  }
  & $tunnelCommand doctor --profile $profileName --profile-dir $profileDir --mcp.stdio-send-initialized-notification --explain @proxyArgs
  if ($LASTEXITCODE -ne 0) { throw '隧道检查未通过；首次运行或隧道 ID 变化时请加 -Configure。' }
  & $tunnelCommand run --profile $profileName --profile-dir $profileDir --mcp.stdio-send-initialized-notification --health.listen-addr 127.0.0.1:0 --health.url-file (Join-Path $PSScriptRoot '.local/health.url') @proxyArgs
  if ($LASTEXITCODE -ne 0) { throw '隧道进程退出，检查本机网络和账号权限。' }
}
finally {
  $env:CONTROL_PLANE_API_KEY = $previousKey
}
