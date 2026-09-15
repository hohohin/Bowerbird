param([Parameter(Mandatory=$true)][string]$HelperDirectory)
$ErrorActionPreference = 'Stop'
$workspace = Split-Path $PSScriptRoot -Parent
$nonce = [Guid]::NewGuid().ToString('N')
$testDirectory = Join-Path $workspace ".tmp/cli-isolation-$nonce"
New-Item -ItemType Directory -Path $testDirectory | Out-Null
$probe = Join-Path $testDirectory 'probe with spaces.exe'
& rustc --edition 2021 (Join-Path $workspace 'apps/desktop/src-tauri/tests/fixtures/cli-registry-probe.rs') -o $probe
if ($LASTEXITCODE -ne 0) { throw 'probe compile failed' }
$launcher = Join-Path (Resolve-Path $HelperDirectory) 'cli-launcher.exe'
$scope = "Software\Bowerbird\CliAuthTests\$nonce"
$globalProbe = "Software\Bowerbird\CliAuthTestsProbe\$nonce"
function Run([string]$file, [string[]]$arguments, [bool]$isolated, [string]$inputText = '', [string]$rawArguments = '') {
    $start = [System.Diagnostics.ProcessStartInfo]::new($file)
    $start.UseShellExecute = $false
    $start.CreateNoWindow = $true
    $start.RedirectStandardOutput = $true
    $start.RedirectStandardError = $true
    $start.RedirectStandardInput = $true
    foreach ($arg in $arguments) { $start.ArgumentList.Add($arg) }
    if ($rawArguments) { $start.Arguments = $rawArguments }
    if ($isolated) {
        $start.Environment['BOWERBIRD_DREAMINA_REGISTRY'] = $scope
        $start.Environment['USERPROFILE'] = $testDirectory
        $start.Environment['HOME'] = $testDirectory
        $start.Environment['APPDATA'] = Join-Path $testDirectory 'roaming'
        $start.Environment['LOCALAPPDATA'] = Join-Path $testDirectory 'local'
        $start.Environment['CODEX_HOME'] = Join-Path $testDirectory 'codex'
        foreach ($name in @('OPENAI_API_KEY','CODEX_API_KEY','CODEX_AUTH_JSON')) { $start.Environment.Remove($name) | Out-Null }
    }
    $process = [System.Diagnostics.Process]::Start($start)
    if ($inputText) { $process.StandardInput.WriteLine($inputText) }
    $process.StandardInput.Close()
    $stdout = $process.StandardOutput.ReadToEndAsync()
    $stderr = $process.StandardError.ReadToEndAsync()
    if (!$process.WaitForExit(30000)) { $process.Kill($true); throw 'CLI test timed out' }
    if ($process.ExitCode -ne 0) { throw "CLI exit $($process.ExitCode): $($stderr.Result)" }
    return $stdout.Result.Trim()
}
try {
    if ((Run $probe @($nonce, 'global-sentinel') $false) -ne 'global-sentinel') { throw 'global fixture failed' }
    if ((Run $launcher @($probe, $nonce) $true) -ne 'absent') { throw 'shared registry leaked' }
    if ((Run $launcher @($probe, $nonce, 'private-sentinel') $true) -ne 'private-sentinel') { throw 'private write failed' }
    if ((Run $probe @($nonce) $false) -ne 'global-sentinel') { throw 'shared registry changed' }
    if ((Run $launcher @($probe, $nonce) $true) -ne 'private-sentinel') { throw 'private restart persistence failed' }
    [Microsoft.Win32.Registry]::CurrentUser.DeleteSubKeyTree($scope)
    if ((Run $launcher @($probe, $nonce) $true) -ne 'absent') { throw 'reinstall reset failed' }
    if ((Run $probe @($nonce) $false) -ne 'global-sentinel') { throw 'reset changed shared registry' }
    if ((Run $launcher @('--plain', $probe, $nonce) $true) -ne 'global-sentinel') { throw 'plain process mode failed' }
    $shim = Join-Path $testDirectory 'codex shim.cmd'
    [IO.File]::WriteAllText($shim, "@echo off`r`n`"$probe`" %*`r`n")
    if ((Run $launcher @('--plain', 'cmd.exe', '/D', '/S', '/C', $shim, $nonce) $true) -ne 'global-sentinel') { throw 'npm cmd shim failed' }
    foreach ($cli in @(('"' + $probe + '"'), ('cmd.exe /D /S /C "' + $shim + '"'))) {
        # Same terminal command quoting as resume; /C keeps the fixture finite.
        $raw = '/D /S /C ""' + $launcher + '" --plain ' + $cli + ' ' + $nonce + '"'
        $terminalResult = Run 'cmd.exe' @() $true '' $raw
        if ($terminalResult -ne 'global-sentinel') { throw "terminal CLI quoting failed: $cli => $terminalResult" }
    }
    $sentinel = 'quoted "value" with spaces and trailing slash\'
    if ((Run $launcher @($probe, $nonce, $sentinel) $true) -ne $sentinel) { throw 'argument quoting changed' }
    $savedScope = $scope
    try {
        $scope = 'Software\UnrelatedApplication'
        $refused = $false
        try { Run $launcher @($probe, $nonce, 'must-not-write') $true | Out-Null } catch { $refused = $true }
        if (!$refused) { throw 'invalid namespace was accepted' }
    } finally { $scope = $savedScope }
    if ((Run $probe @($nonce) $false) -ne 'global-sentinel') { throw 'failure used shared registry' }
    $dreamina = Join-Path $env:USERPROFILE 'bin/dreamina.exe'
    if (Test-Path $dreamina) {
        Run $launcher @($dreamina, 'version') $true | Out-Null
        Run $launcher @($dreamina, 'logout') $true | Out-Null
    }
    $codex = (Get-ChildItem (Join-Path $env:APPDATA 'com.bowerbird.desktop/codex-cli/vendor/*/bin/codex.exe') -ErrorAction SilentlyContinue | Select-Object -First 1).FullName
    if (!$codex) { $codex = (Get-Command codex.exe -ErrorAction Stop).Source }
    New-Item -ItemType Directory -Path (Join-Path $testDirectory 'codex') -Force | Out-Null
    [IO.File]::WriteAllText((Join-Path $testDirectory 'codex/config.toml'), 'cli_auth_credentials_store = "file"')
    Run $launcher @('--plain', $codex, 'login', '--with-api-key') $true 'bb-isolation-test-not-a-real-key' | Out-Null
    if (!(Test-Path (Join-Path $testDirectory 'codex/auth.json'))) { throw 'Codex did not use private file storage' }
    Run $launcher @('--plain', $codex, 'logout') $true | Out-Null
    if (Test-Path (Join-Path $testDirectory 'codex/auth.json')) { throw 'private Codex logout failed' }
    Write-Output 'PASS: private HKCU read/write/restart/reset, shared sentinel unchanged, native/npm/terminal argument quoting, refusal without fallback, native Dreamina private logout, native Codex synthetic-key login/logout'
} finally {
    [Microsoft.Win32.Registry]::CurrentUser.DeleteSubKeyTree($scope, $false)
    [Microsoft.Win32.Registry]::CurrentUser.DeleteSubKeyTree($globalProbe, $false)
}
