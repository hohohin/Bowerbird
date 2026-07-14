param(
    [switch]$SkipTests,
    [switch]$Clean
)

$ErrorActionPreference = "Stop"
$WorkDir = & (Join-Path $PSScriptRoot "prepare.ps1") -Clean:$Clean | Select-Object -Last 1
$DistDir = Join-Path $PSScriptRoot "dist"

Push-Location $WorkDir
try {
    pnpm install --frozen-lockfile
    if ($LASTEXITCODE -ne 0) { throw "pnpm install failed." }

    if (-not $SkipTests) {
        pnpm lint
        if ($LASTEXITCODE -ne 0) { throw "TypeScript checks failed." }
        cargo test --manifest-path apps/desktop/src-tauri/Cargo.toml
        if ($LASTEXITCODE -ne 0) { throw "Rust tests failed." }
    }

    pnpm tauri build --bundles nsis
    if ($LASTEXITCODE -ne 0) { throw "NSIS installer build failed." }

    New-Item -ItemType Directory -Force $DistDir | Out-Null
    Get-ChildItem "apps/desktop/src-tauri/target/release/bundle/nsis" -Filter "*.exe" |
        Copy-Item -Destination $DistDir -Force
}
finally {
    Pop-Location
}

Write-Host "Windows installer output: $DistDir" -ForegroundColor Green
Get-ChildItem $DistDir -Filter "*.exe" | Select-Object FullName, Length, LastWriteTime
