$ErrorActionPreference = 'Stop'
$runner = Join-Path $PSScriptRoot 'run-gemini.mjs'
$local = Join-Path $PSScriptRoot '.local/gemini'
$configFile = Join-Path $local 'config.json'
if (-not (Test-Path -LiteralPath $configFile)) { throw 'Gemini config missing. Run setup-gemini.mjs first.' }
$config = Get-Content -LiteralPath $configFile -Raw | ConvertFrom-Json
$port = [int]$config.port
if ($port -le 0 -or $port -gt 65535) { throw 'Invalid Gemini port.' }
# Serialize startup without restarting an existing OAuth session.
$hash = [Security.Cryptography.SHA256]::Create()
try { $identity = [BitConverter]::ToString($hash.ComputeHash([Text.Encoding]::UTF8.GetBytes($runner.ToLowerInvariant()))).Replace('-', '') }
finally { $hash.Dispose() }
$mutex = [Threading.Mutex]::new($false, ('Local\BowerbirdMcpGemini-' + $identity))
$held = $false
try {
  try { $held = $mutex.WaitOne(15000) } catch [Threading.AbandonedMutexException] { $held = $true }
  if (-not $held) { throw 'Another Gemini startup is still in progress. Retry shortly.' }
  $pattern = '(?i)(?:^|[\s"])' + [regex]::Escape($runner) + '(?=["\s]|$)'
  $running = @(Get-CimInstance Win32_Process -Filter "Name='node.exe'" | Where-Object { $_.CommandLine -match $pattern })
  if ($running.Count -gt 1) { throw 'Multiple Gemini launchers found. Close duplicate instances.' }
  $started = $false
  if ($running.Count -eq 0) {
    $node = (Get-Command node -CommandType Application -ErrorAction Stop | Select-Object -First 1).Source
    $process = Start-Process -FilePath $node -ArgumentList ('"' + $runner + '"') -WorkingDirectory $PSScriptRoot -WindowStyle Hidden -RedirectStandardOutput (Join-Path $local 'run.out.log') -RedirectStandardError (Join-Path $local 'run.err.log') -PassThru
    $launcherId = $process.Id
    $started = $true
  } else { $launcherId = $running[0].ProcessId }
  $deadline = [DateTime]::UtcNow.AddSeconds(15)
  do {
    if (-not (Get-Process -Id $launcherId -ErrorAction SilentlyContinue)) { throw 'Gemini launcher exited. Check .local/gemini/run.err.log.' }
    $children = @(Get-CimInstance Win32_Process -Filter "ParentProcessId=$launcherId AND Name='node.exe'" | Where-Object { $_.CommandLine -like ('*' + (Join-Path $PSScriptRoot 'http-server.mjs') + '*') })
    if ($children.Count -eq 1) {
      try {
        $health = Invoke-WebRequest -UseBasicParsing -Uri ("http://127.0.0.1:$port/healthz") -TimeoutSec 2
        if ($health.StatusCode -eq 204) {
          if ($started) { Write-Host 'Gemini started in the background; SSH connects automatically.' }
          else { Write-Host 'Gemini is already running; OAuth session retained.' }
          return
        }
      } catch { }
    }
    Start-Sleep -Milliseconds 250
  } while ([DateTime]::UtcNow -lt $deadline)
  throw 'Gemini did not become ready. Check .local/gemini/run.err.log.'
} finally {
  if ($held) { $mutex.ReleaseMutex() }
  $mutex.Dispose()
}
