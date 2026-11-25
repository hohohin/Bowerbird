param([switch]$RestartTunnel, [switch]$StartTunnelOnly)
$ErrorActionPreference = 'Stop'
$profile = Get-Content -Raw -LiteralPath (Join-Path $PSScriptRoot 'apps/code-reader-mcp/tunnel-profile.json') | ConvertFrom-Json
$launcher = Join-Path $PSScriptRoot 'apps/code-reader-mcp/start-tunnel.ps1'
$options = @{ TunnelId = $profile.tunnelId; UseSystemProxy = $true; KeyFile = (Join-Path $PSScriptRoot '.env.tunnel') }
if ($StartTunnelOnly) {
  & $launcher @options -ReuseRunning
  return
}
# Both running readers reload the shared snapshot on the next tool call.
Write-Host 'Updating the shared GPT/Gemini snapshot. Running Gemini keeps its OAuth session.'
& $launcher @options -UpdateSnapshot -EnsureGemini -RestartTunnel:$RestartTunnel
