$ErrorActionPreference = 'Stop'
# One export feeds both transports. Running Gemini reloads it on the next tool call.
Write-Host 'Updating the shared GPT/Gemini snapshot. Running Gemini keeps its OAuth session.'
& (Join-Path $PSScriptRoot 'apps/code-reader-mcp/start-tunnel.ps1') `
  -TunnelId 'tunnel_6adc8e09721481918bb2d5c1390166c6' `
  -ControlPlaneProxy 'http://127.0.0.1:7890' `
  -KeyFile (Join-Path $PSScriptRoot '.env.tunnel') `
  -UpdateSnapshot -EnsureGemini
