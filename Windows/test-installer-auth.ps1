$ErrorActionPreference = 'Stop'
$workspace = Split-Path $PSScriptRoot -Parent
$testDirectory = Join-Path $workspace ('.tmp/installer-auth-' + [Guid]::NewGuid().ToString('N'))
New-Item -ItemType Directory -Path $testDirectory | Out-Null
$fixture = Join-Path $testDirectory 'fixture.exe'
& rustc --edition 2021 (Join-Path $workspace 'apps/desktop/src-tauri/tests/fixtures/installer-auth-reset.rs') -o $fixture
if ($LASTEXITCODE -ne 0) { throw 'fixture build failed' }
$hook = Join-Path $workspace 'apps/desktop/src-tauri/windows/installer-hooks.nsh'
$installer = Join-Path $testDirectory 'test-setup.exe'
$script = @'
Unicode true
!include LogicLib.nsh
!include FileFunc.nsh
Name "Bowerbird login reset test"
RequestExecutionLevel user
SilentInstall silent
!define BUNDLEID "com.bowerbird.test"
!define MAINBINARYNAME "fixture"
!define BOWERBIRD_AUTH_DATA "$INSTDIR\profile"
!include "@@HOOK@@"
OutFile "@@OUTPUT@@"
Var UpdateMode
Function .onInit
  ${GetOptions} $CMDLINE "/UPDATE" $UpdateMode
  ${IfNot} ${Errors}
    StrCpy $UpdateMode 1
  ${EndIf}
FunctionEnd
Section
SetOutPath "$INSTDIR"
File /oname=fixture.exe "@@FIXTURE@@"
!insertmacro NSIS_HOOK_POSTINSTALL
SectionEnd
'@
$script = $script.Replace('@@HOOK@@', $hook).Replace('@@OUTPUT@@', $installer).Replace('@@FIXTURE@@', $fixture)
$source = Join-Path $testDirectory 'installer.nsi'
[IO.File]::WriteAllText($source, $script)
$makensis = Join-Path $env:LOCALAPPDATA 'tauri/NSIS/makensis.exe'
& $makensis $source | Out-Null
if ($LASTEXITCODE -ne 0) { throw 'NSIS fixture compile failed' }
$destination = Join-Path $testDirectory 'installed app'
function Install([string]$flags = '') {
    $start = [Diagnostics.ProcessStartInfo]::new($installer)
    $start.UseShellExecute = $false
    $start.CreateNoWindow = $true
    $start.Arguments = "/S $flags /D=$destination"
    $process = [Diagnostics.Process]::Start($start)
    if (!$process.WaitForExit(30000)) { $process.Kill($true); throw 'installer timeout' }
    return $process.ExitCode
}
if ((Install) -ne 0 -or (Install) -ne 0) { throw 'install/reinstall failed' }
if ((Get-Content (Join-Path $destination 'reset-count')) -ne '2') { throw 'same-version reinstall did not reset' }
# Fake login bytes and a reset failure tripwire: update must not launch reset at all.
$loginFile = Join-Path $destination 'profile/login-fixture.json'
$login = '{"account":"fake-login","codex":"fake-private-cli","dreamina":"fake-private-cli","entitlement":"fake-cache"}'
[IO.File]::WriteAllText($loginFile, $login)
[IO.File]::WriteAllText((Join-Path $destination 'fail-reset'), '1')
foreach ($flags in @('/UPDATE /P', '/UPDATE')) {
    if ((Install $flags) -ne 0) { throw 'application update unexpectedly reset login' }
    if ((Get-Content (Join-Path $destination 'reset-count')) -ne '2') { throw 'update called reset' }
    if ([IO.File]::ReadAllText($loginFile) -ne $login) { throw 'update changed login bytes' }
    if (Test-Path (Join-Path $destination 'profile/installation-auth-reset.pending')) { throw 'update created a logout marker' }
}
if ((Install) -eq 0) { throw 'reset failure reported installation success' }
if (!(Test-Path (Join-Path $destination 'profile/installation-auth-reset.pending'))) { throw 'failure lost pending marker' }
if ((Install '/UPDATE /P') -ne 0) { throw 'update tried to run an earlier failed reinstall reset' }
if (!(Test-Path (Join-Path $destination 'profile/installation-auth-reset.pending'))) { throw 'update bypassed an earlier pending reset' }
if ([IO.File]::ReadAllText($loginFile) -ne $login) { throw 'update changed login bytes after a failed reinstall' }
[IO.File]::Delete((Join-Path $destination 'fail-reset'))
if ((Install) -ne 0) { throw 'retry failed' }
if ((Get-Content (Join-Path $destination 'reset-count')) -ne '3') { throw 'retry did not complete reset' }
Write-Output 'PASS: actual NSIS hook preserves login on passive/silent UPDATE without calling reset or creating a marker; ordinary reinstall resets; earlier failed reset remains pending; retry completes'
