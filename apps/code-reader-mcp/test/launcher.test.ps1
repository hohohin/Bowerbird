$ErrorActionPreference = 'Stop'
$calls = [System.Collections.Generic.List[object]]::new()
$previousKey = $env:CONTROL_PLANE_API_KEY
$env:CONTROL_PLANE_API_KEY = 'fixture-local-only'

# Simulate two PATH matches, including the first executable path containing spaces.
function Get-Command {
  param($Name, $CommandType, $ErrorAction)
  if ($Name -eq 'node') {
    [pscustomobject]@{ Source = 'C:\Program Files\nodejs\node.exe' }
    [pscustomobject]@{ Source = 'C:\second-node\node.exe' }
  }
  elseif ($Name -eq 'fixture-tunnel') {
    [pscustomobject]@{ Source = 'Invoke-FixtureTunnel' }
    [pscustomobject]@{ Source = 'Must-Not-Run' }
  }
  else { throw "Unexpected command lookup: $Name" }
}
function Invoke-FixtureTunnel {
  $calls.Add(@($args))
  $global:LASTEXITCODE = 0
}
try {
  & (Join-Path $PSScriptRoot '../start-tunnel.ps1') -TunnelId tunnel_fixture -TunnelClient fixture-tunnel -Configure
  if ($calls.Count -ne 3) { throw 'Expected init, doctor and run' }
  if (($calls | ForEach-Object { $_[0] }) -join ',' -ne 'init,doctor,run') { throw 'Incorrect command order' }
  $initArgs = $calls[0]
  $commandIndex = [array]::IndexOf($initArgs, '--mcp-command')
  $command = $initArgs[$commandIndex + 1]
  if ($command -isnot [string] -or -not $command.StartsWith('"C:/Program Files/nodejs/node.exe" "') -or $command.Contains('System.Object[]')) {
    throw 'MCP command must use the first PATH match as a quoted scalar'
  }
  foreach ($call in $calls[1..2]) {
    if ('--mcp.stdio-send-initialized-notification' -notin $call) { throw 'Missing MCP initialization flag' }
  }
  if ($env:CONTROL_PLANE_API_KEY -ne 'fixture-local-only') { throw 'Environment was not restored' }
  Write-Output 'PASS: multiple PATH matches, space quoting, command order, initialization flags and key environment restoration'
}
finally { $env:CONTROL_PLANE_API_KEY = $previousKey }
