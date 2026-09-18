param(
    [switch]$SkipTests,
    [switch]$Clean,
    [string]$DownloadBaseUrl = "https://bowerbird.cn/downloads",
    [string]$ReleaseNotesFile
)

$ErrorActionPreference = "Stop"
$OriginalSigningKey = $env:TAURI_SIGNING_PRIVATE_KEY
$SigningKey = $OriginalSigningKey
$LocalSigningKey = Join-Path $PSScriptRoot ".signing/updater.key"
if (-not $env:TAURI_SIGNING_PRIVATE_KEY -and -not $env:TAURI_SIGNING_PRIVATE_KEY_PATH) {
    if (-not (Test-Path -LiteralPath $LocalSigningKey)) {
        throw "Updater signing key missing. Set TAURI_SIGNING_PRIVATE_KEY to the existing release key. Do not generate a replacement key for an existing release channel."
    }
    $SigningKey = $LocalSigningKey
}
if ($ReleaseNotesFile) { $ReleaseNotesFile = (Resolve-Path -LiteralPath $ReleaseNotesFile).Path }
$WorkDir = & (Join-Path $PSScriptRoot "prepare.ps1") -Clean:$Clean | Select-Object -Last 1
$DistDir = Join-Path $PSScriptRoot "dist"

Push-Location $WorkDir
try {
    $env:TAURI_SIGNING_PRIVATE_KEY = $SigningKey
    pnpm install --frozen-lockfile
    if ($LASTEXITCODE -ne 0) { throw "pnpm install failed." }

    if (-not $SkipTests) {
        pnpm lint
        if ($LASTEXITCODE -ne 0) { throw "TypeScript checks failed." }
        cargo test --manifest-path apps/desktop/src-tauri/Cargo.toml
        if ($LASTEXITCODE -ne 0) { throw "Rust tests failed." }
    }

    pnpm tauri build --ci --bundles nsis
    if ($LASTEXITCODE -ne 0) { throw "NSIS installer build failed." }

    New-Item -ItemType Directory -Force $DistDir | Out-Null
    $Version = (Get-Content "apps/desktop/src-tauri/tauri.conf.json" -Raw | ConvertFrom-Json).version
    $InstallerName = "Bowerbird_${Version}_x64-setup.exe"
    $Installer = Join-Path $WorkDir "apps/desktop/src-tauri/target/release/bundle/nsis/$InstallerName"
    if (-not (Test-Path -LiteralPath "$Installer.sig")) { throw "Signed updater artifact missing: $Installer.sig" }
    Copy-Item -LiteralPath $Installer, "$Installer.sig" -Destination $DistDir -Force
    $ManifestArgs = @((Join-Path $DistDir $InstallerName), "$($DownloadBaseUrl.TrimEnd('/'))/$InstallerName", (Join-Path $DistDir "windows-x86_64.json"))
    if ($ReleaseNotesFile) { $ManifestArgs += $ReleaseNotesFile }
    node (Join-Path $PSScriptRoot "update-manifest.mjs") @ManifestArgs
    if ($LASTEXITCODE -ne 0) { throw "Updater manifest generation failed." }
}
finally {
    $env:TAURI_SIGNING_PRIVATE_KEY = $OriginalSigningKey
    Pop-Location
}

Write-Host "Windows installer output: $DistDir" -ForegroundColor Green
Get-ChildItem $DistDir -Filter "*.exe" | Select-Object FullName, Length, LastWriteTime
