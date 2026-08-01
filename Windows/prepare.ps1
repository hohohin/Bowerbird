param(
    [switch]$Clean
)

$ErrorActionPreference = "Stop"
$WindowsDir = $PSScriptRoot
$RepoRoot = Split-Path -Parent $WindowsDir
$WorkDir = Join-Path $WindowsDir ".work"

function Require-Command([string]$Name, [string]$InstallHint) {
    if (-not (Get-Command $Name -ErrorAction SilentlyContinue)) {
        throw "缺少 $Name。$InstallHint"
    }
}

Require-Command "node" "Install Node.js 22 LTS or newer."
Require-Command "pnpm" "Run corepack enable and install the pnpm version from package.json."
Require-Command "rustc" "Install the Rust MSVC toolchain from https://rustup.rs."
Require-Command "cargo" "Install the Rust MSVC toolchain from https://rustup.rs."

$RustHost = (& rustc -vV | Select-String '^host:').ToString()
if ($RustHost -notmatch 'pc-windows-msvc') {
    throw "Rust host is not MSVC: $RustHost. Install stable-x86_64-pc-windows-msvc."
}

if ($Clean -and (Test-Path $WorkDir)) {
    Remove-Item -LiteralPath $WorkDir -Recurse -Force
}
New-Item -ItemType Directory -Force $WorkDir | Out-Null

# Keep the entire generated worktree under Windows/ and exclude it from recursion.
& robocopy $RepoRoot $WorkDir /MIR /XD .git Windows node_modules target dist /XF AGENTS.md | Out-Null
if ($LASTEXITCODE -ge 8) {
    throw "Failed to copy the project into Windows/.work (robocopy exit $LASTEXITCODE)."
}

# Windows 平台差异已并入 canonical 源码；.work 直接使用上面复制的项目内容。

Write-Host "Windows worktree prepared: $WorkDir" -ForegroundColor Green
Write-Output $WorkDir
