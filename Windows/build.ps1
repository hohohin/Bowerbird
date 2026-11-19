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
    & (Join-Path $PSScriptRoot "verify-installer.ps1") -Installer $Installer -Version $Version
    if (-not (Test-Path -LiteralPath "$Installer.sig")) { throw "Signed updater artifact missing: $Installer.sig" }
    $ManifestTool = Join-Path $PSScriptRoot "update-manifest.mjs"
    $Inspection = node $ManifestTool --inspect $Installer
    if ($LASTEXITCODE -ne 0) { throw "Updater signature verification failed." }
    $InstallerHash = ($Inspection | ConvertFrom-Json).sha256
    if ($SkipTests) {
        $DistDir = Join-Path $DistDir "untested/$InstallerHash"
        [void][IO.Directory]::CreateDirectory($DistDir)
    }
    $Verification = [ordered]@{
        version = $Version
        platform = "windows-x86_64"
        installer = $InstallerName
        sha256 = $InstallerHash
        updaterSignatureVerified = $true
        typecheckAndRustTests = if ($SkipTests) { "skipped" } else { "passed" }
    }
    $Verification | ConvertTo-Json | Set-Content -Encoding utf8 "$Installer.verification.json"
    $Outputs = @($Installer, "$Installer.sig", "$Installer.verification.json")
    if (-not $SkipTests) {
        $CandidateManifest = Join-Path (Split-Path $Installer) "windows-x86_64.json"
        $ManifestArgs = @($Installer, "$($DownloadBaseUrl.TrimEnd('/'))/$InstallerName", $CandidateManifest)
        if ($ReleaseNotesFile) { $ManifestArgs += $ReleaseNotesFile }
        node $ManifestTool @ManifestArgs
        if ($LASTEXITCODE -ne 0) { throw "Updater manifest generation failed." }
        $Outputs += $CandidateManifest
    }
    Copy-Item -LiteralPath $Outputs -Destination $DistDir -Force
}
finally {
    $env:TAURI_SIGNING_PRIVATE_KEY = $OriginalSigningKey
    Pop-Location
}

Write-Host "Windows installer output: $DistDir" -ForegroundColor Green
Get-ChildItem $DistDir -Filter "*.exe" | Select-Object FullName, Length, LastWriteTime
