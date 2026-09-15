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
Name "Bowerbird login reset test"
RequestExecutionLevel user
SilentInstall silent
!define BUNDLEID "com.bowerbird.test"
!define MAINBINARYNAME "fixture"
!define BOWERBIRD_AUTH_DATA "$INSTDIR\profile"
!include "@@HOOK@@"
OutFile "@@OUTPUT@@"
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
function Install {
    $start = [Diagnostics.ProcessStartInfo]::new($installer)
    $start.UseShellExecute = $false
    $start.CreateNoWindow = $true
    $start.Arguments = "/S /D=$destination"
    $process = [Diagnostics.Process]::Start($start)
    if (!$process.WaitForExit(30000)) { $process.Kill($true); throw 'installer timeout' }
    return $process.ExitCode
}
if ((Install) -ne 0 -or (Install) -ne 0) { throw 'install/reinstall failed' }
if ((Get-Content (Join-Path $destination 'reset-count')) -ne '2') { throw 'same-version reinstall did not reset' }
[IO.File]::WriteAllText((Join-Path $destination 'fail-reset'), '1')
if ((Install) -eq 0) { throw 'reset failure reported installation success' }
if (!(Test-Path (Join-Path $destination 'profile/installation-auth-reset.pending'))) { throw 'failure lost pending marker' }
[IO.File]::Delete((Join-Path $destination 'fail-reset'))
if ((Install) -ne 0) { throw 'retry failed' }
if ((Get-Content (Join-Path $destination 'reset-count')) -ne '3') { throw 'retry did not complete reset' }
Write-Output 'PASS: actual NSIS hook executes on install and same-version reinstall; failure aborts and retains startup gate; retry completes'
