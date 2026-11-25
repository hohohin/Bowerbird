param(
  [Parameter(Mandatory = $true)]
  [ValidatePattern('^tunnel_[A-Za-z0-9]+$')]
  [string]$TunnelId,
  [string]$TunnelClient = 'tunnel-client',
  [string]$ControlPlaneProxy = '',
  [switch]$UseSystemProxy,
  [string]$KeyFile = '',
  [switch]$UpdateSnapshot,
  [switch]$ReuseRunning,
  [switch]$RestartTunnel,
  [switch]$Configure,
  [switch]$EnsureGemini
)

$ErrorActionPreference = 'Stop'
$proxyArgs = @()
if ($UseSystemProxy -and -not $ControlPlaneProxy) {
  $destination = [Uri]'https://api.openai.com'
  $resolved = [Net.WebRequest]::GetSystemWebProxy().GetProxy($destination)
  if ($resolved -and $resolved -ne $destination) {
    if (-not $resolved.IsLoopback) { throw '自动选择仅支持本机代理；其他代理请显式指定 -ControlPlaneProxy。' }
    $ControlPlaneProxy = $resolved.AbsoluteUri.TrimEnd('/')
  }
}
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
function Find-ProjectTunnel {
  Get-CimInstance Win32_Process -Filter "Name = 'tunnel-client.exe'" | Where-Object {
    $_.ExecutablePath -eq $tunnelCommand -and $_.CommandLine -match '^(?:"[^"]+"|\S+)\s+run(?:\s|$)' -and
      $_.CommandLine -match ('(?:^|\s)--profile(?:=|\s+)"?' + [regex]::Escape($profileName) + '"?(?=\s|$)')
  }
}
if ($ReuseRunning) {
  $running = @(Find-ProjectTunnel)
  if ($running.Count -gt 1) { throw '发现多个同项目隧道，请先关闭多余窗口。' }
  if ($running.Count -eq 1) {
    Write-Host 'The GPT tunnel is already running.'
    return
  }
}
if (-not $UpdateSnapshot -and -not (Test-Path -LiteralPath (Join-Path $PSScriptRoot '.local/snapshot.json'))) {
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
  if ($KeyFile) {
    if (-not (Test-Path -LiteralPath $KeyFile -PathType Leaf)) { throw '找不到隧道密钥文件。' }
    $keyLines = @([IO.File]::ReadAllLines($KeyFile, [Text.Encoding]::UTF8) | Where-Object { $_ -match '^\s*MCP_UPDATE_KEY\s*=' })
    if ($keyLines.Count -ne 1) { throw '密钥文件必须包含唯一的 MCP_UPDATE_KEY 配置。' }
    $runtimeKey = ($keyLines[0] -replace '^\s*MCP_UPDATE_KEY\s*=\s*', '').Trim()
    if ($runtimeKey.Length -ge 2 -and (($runtimeKey.StartsWith('"') -and $runtimeKey.EndsWith('"')) -or
        ($runtimeKey.StartsWith("'") -and $runtimeKey.EndsWith("'")))) {
      $runtimeKey = $runtimeKey.Substring(1, $runtimeKey.Length - 2)
    }
    if (-not $runtimeKey -or $runtimeKey -match '\s|["'']') { throw 'MCP_UPDATE_KEY 为空或格式无效。' }
    $env:CONTROL_PLANE_API_KEY = $runtimeKey
    $runtimeKey = $null
    $keyLines = $null
  }
  if (-not $env:CONTROL_PLANE_API_KEY) {
    $secureKey = Read-Host '输入隧道专用 runtime API key（隐藏输入，不会写入配置）' -AsSecureString
    $keyPointer = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($secureKey)
    try { $env:CONTROL_PLANE_API_KEY = [Runtime.InteropServices.Marshal]::PtrToStringBSTR($keyPointer) }
    finally { [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($keyPointer); $secureKey.Dispose() }
  }
  $reuseTunnel = $false
  if ($UpdateSnapshot) {
    & $nodeCommand (Join-Path $PSScriptRoot 'export.mjs')
    if ($LASTEXITCODE -ne 0) { throw '快照导出失败，现有隧道继续使用原快照。' }
  }
  if ($UpdateSnapshot -or $RestartTunnel) {
    $targets = @(Find-ProjectTunnel)
    if ($targets.Count -gt 1) { throw '发现多个同项目隧道，请先关闭多余窗口。' }
    if ($targets.Count -eq 1) {
      $runningProxy = ''
      if ($targets[0].CommandLine -match '(?:^|\s)--control-plane\.http-proxy(?:=|\s+)"?([^"\s]+)') { $runningProxy = $Matches[1].TrimEnd('/') }
      if ($RestartTunnel -or $runningProxy -ne $ControlPlaneProxy.TrimEnd('/')) { Stop-Process -Id $targets[0].ProcessId -ErrorAction Stop }
      else { $reuseTunnel = $true }
    }
  }
  if ($EnsureGemini) { & (Join-Path $PSScriptRoot 'ensure-gemini.ps1') }
  if ($reuseTunnel) {
    Write-Host 'Snapshot updated. The running tunnel will load it on the next tool call.'
    return
  }
  & $tunnelCommand doctor --profile $profileName --profile-dir $profileDir --mcp.stdio-send-initialized-notification --explain @proxyArgs
  if ($LASTEXITCODE -ne 0) { throw '隧道检查未通过；首次运行或隧道 ID 变化时请加 -Configure。' }
  & $tunnelCommand run --profile $profileName --profile-dir $profileDir --mcp.stdio-send-initialized-notification --health.listen-addr 127.0.0.1:0 --health.url-file (Join-Path $PSScriptRoot '.local/health.url') @proxyArgs
  if ($LASTEXITCODE -ne 0) { throw '隧道进程退出，检查本机网络和账号权限。' }
}
finally {
  $env:CONTROL_PLANE_API_KEY = $previousKey
}
