$ErrorActionPreference = "Stop"
$WorkDir = & (Join-Path $PSScriptRoot "prepare.ps1") | Select-Object -Last 1

Push-Location $WorkDir
try {
    pnpm install --frozen-lockfile
    if ($LASTEXITCODE -ne 0) { throw "pnpm install failed." }
    pnpm tauri dev
    if ($LASTEXITCODE -ne 0) { throw "Tauri development startup failed." }
}
finally {
    Pop-Location
}
