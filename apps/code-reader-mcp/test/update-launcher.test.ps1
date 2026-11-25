$ErrorActionPreference = 'Stop'
$fixtureDir = Join-Path ([IO.Path]::GetTempPath()) ('mcp-update-' + [guid]::NewGuid().ToString('N'))
$previousKey = $env:CONTROL_PLANE_API_KEY
$events = [System.Collections.Generic.List[string]]::new()
$exportFails = $false
$hasTunnel = $true
$runningProxy = ''
function Get-Command {
  param($Name, $CommandType, $ErrorAction)
  if ($Name -eq 'node') { [pscustomobject]@{ Source = 'Invoke-FixtureNode' } }
  elseif ($Name -eq 'fixture-tunnel') { [pscustomobject]@{ Source = 'Invoke-FixtureTunnel' } }
  else { throw 'Unexpected executable lookup' }
}
function Get-CimInstance {
  param($ClassName, $Filter)
  if ($hasTunnel) { [pscustomobject]@{ ExecutablePath = 'Invoke-FixtureTunnel'; CommandLine = ('"Invoke-FixtureTunnel" run --profile "bowerbird-code-reader-tunnel_fixture" ' + $runningProxy); ProcessId = 123 } }
  [pscustomobject]@{ ExecutablePath = 'Invoke-FixtureTunnel'; CommandLine = '"Invoke-FixtureTunnel" run --profile other'; ProcessId = 456 }
  [pscustomobject]@{ ExecutablePath = 'Invoke-FixtureTunnel'; CommandLine = '"Invoke-FixtureTunnel" run --profile bowerbird-code-reader-tunnel_fixture_other'; ProcessId = 789 }
  [pscustomobject]@{ ExecutablePath = 'Invoke-FixtureTunnel'; CommandLine = '"Invoke-FixtureTunnel" doctor --profile bowerbird-code-reader-tunnel_fixture --explain run'; ProcessId = 912 }
}
function Test-Path {
  param($LiteralPath, $PathType)
  if ($LiteralPath -match '[\\/]\.local[\\/]snapshot\.json$') { return $true }
  if ($PathType) { return Microsoft.PowerShell.Management\Test-Path -LiteralPath $LiteralPath -PathType $PathType }
  Microsoft.PowerShell.Management\Test-Path -LiteralPath $LiteralPath
}
function Stop-Process {
  param($Id, $ErrorAction)
  if ($Id -ne 123) { throw 'Unrelated process selected' }
  $events.Add('stop')
}
function Invoke-FixtureNode {
  $events.Add('export')
  $global:LASTEXITCODE = [int]$exportFails
}
function Invoke-FixtureTunnel {
  if ($env:CONTROL_PLANE_API_KEY -ne 'fixture-file-key') { throw 'File credential was not loaded' }
  if (($args -join ' ') -match 'fixture-file-key') { throw 'Credential leaked to arguments' }
  $events.Add($args[0])
  $global:LASTEXITCODE = 0
}
try {
  New-Item -ItemType Directory -Path $fixtureDir | Out-Null
  $keyFile = Join-Path $fixtureDir 'key.env'
  $env:CONTROL_PLANE_API_KEY = 'fixture-original-key'
  foreach ($value in @('fixture-file-key', '"fixture-file-key"', "'fixture-file-key'")) {
    [IO.File]::WriteAllText($keyFile, "# local fixture`nMCP_UPDATE_KEY=$value`n")
    $events.Clear()
    & (Join-Path $PSScriptRoot '../start-tunnel.ps1') -TunnelId tunnel_fixture -TunnelClient fixture-tunnel -KeyFile $keyFile -UpdateSnapshot
    if (($events -join ',') -ne 'export') { throw 'Running tunnel must be reused' }
    if ($env:CONTROL_PLANE_API_KEY -ne 'fixture-original-key') { throw 'Environment not restored' }
  }
  foreach ($invalid in @('', 'MCP_UPDATE_KEY=', "MCP_UPDATE_KEY=a`nMCP_UPDATE_KEY=b")) {
    [IO.File]::WriteAllText($keyFile, $invalid)
    $events.Clear()
    $rejected = $false
    try { & (Join-Path $PSScriptRoot '../start-tunnel.ps1') -TunnelId tunnel_fixture -TunnelClient fixture-tunnel -KeyFile $keyFile -UpdateSnapshot }
    catch { $rejected = $true }
    if (-not $rejected -or $events.Count) { throw 'Invalid key must fail before stopping or exporting' }
    if ($env:CONTROL_PLANE_API_KEY -ne 'fixture-original-key') { throw 'Environment not restored on invalid key' }
  }
  [IO.File]::WriteAllText($keyFile, 'MCP_UPDATE_KEY=fixture-file-key')
  $runningProxy = '--control-plane.http-proxy http://127.0.0.1:7890'
  $events.Clear()
  & (Join-Path $PSScriptRoot '../start-tunnel.ps1') -TunnelId tunnel_fixture -TunnelClient fixture-tunnel -KeyFile $keyFile -UpdateSnapshot -ControlPlaneProxy http://127.0.0.1:7897
  if (($events -join ',') -ne 'export,stop,doctor,run') { throw 'A changed proxy must replace the old tunnel' }
  $runningProxy = '--control-plane.http-proxy=http://127.0.0.1:7897'
  $events.Clear()
  & (Join-Path $PSScriptRoot '../start-tunnel.ps1') -TunnelId tunnel_fixture -TunnelClient fixture-tunnel -KeyFile $keyFile -UpdateSnapshot -ControlPlaneProxy http://127.0.0.1:7897
  if (($events -join ',') -ne 'export') { throw 'An unchanged proxy must reuse the tunnel' }
  $runningProxy = ''
  $events.Clear()
  & (Join-Path $PSScriptRoot '../start-tunnel.ps1') -TunnelId tunnel_fixture -TunnelClient fixture-tunnel -KeyFile $keyFile -UpdateSnapshot -RestartTunnel
  if (($events -join ',') -ne 'export,stop,doctor,run') { throw 'Explicit restart sequence failed' }
  $events.Clear()
  & (Join-Path $PSScriptRoot '../start-tunnel.ps1') -TunnelId tunnel_fixture -TunnelClient fixture-tunnel -KeyFile $keyFile -ReuseRunning
  if ($events.Count) { throw 'Run button must leave a running tunnel alone' }
  $hasTunnel = $false
  $events.Clear()
  & (Join-Path $PSScriptRoot '../start-tunnel.ps1') -TunnelId tunnel_fixture -TunnelClient fixture-tunnel -KeyFile $keyFile -ReuseRunning
  if (($events -join ',') -ne 'doctor,run') { throw 'Run button must start a stopped tunnel without exporting' }
  $events.Clear()
  & (Join-Path $PSScriptRoot '../start-tunnel.ps1') -TunnelId tunnel_fixture -TunnelClient fixture-tunnel -KeyFile $keyFile -UpdateSnapshot
  if (($events -join ',') -ne 'export,doctor,run') { throw 'A stopped tunnel must start after export' }
  $hasTunnel = $true
  $exportFails = $true
  $events.Clear()
  $rejected = $false
  try { & (Join-Path $PSScriptRoot '../start-tunnel.ps1') -TunnelId tunnel_fixture -TunnelClient fixture-tunnel -KeyFile $keyFile -UpdateSnapshot }
  catch { $rejected = $true }
  if (-not $rejected -or ($events -join ',') -ne 'export') { throw 'Export failure must preserve the current tunnel' }
  if ($env:CONTROL_PLANE_API_KEY -ne 'fixture-original-key') { throw 'Environment not restored on export failure' }
  Write-Output 'PASS: file credential parsing, scoped restart, update order, failure handling and environment restoration'
}
finally {
  $env:CONTROL_PLANE_API_KEY = $previousKey
  if (Test-Path -LiteralPath $keyFile) { Remove-Item -LiteralPath $keyFile -Force }
  Remove-Item -LiteralPath $fixtureDir -Force
}
