$ErrorActionPreference = 'Stop'
$node = (Get-Command node -CommandType Application -ErrorAction Stop | Select-Object -First 1).Source
& $node (Join-Path $PSScriptRoot 'apps/code-reader-mcp/export.mjs')
if ($LASTEXITCODE -ne 0) { throw '快照导出失败。' }
& $node (Join-Path $PSScriptRoot 'apps/code-reader-mcp/run-gemini.mjs')
if ($LASTEXITCODE -ne 0) { throw 'Gemini MCP 已停止，请检查上方连接提示。' }
