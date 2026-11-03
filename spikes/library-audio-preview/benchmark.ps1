param(
  [string]$Binary = (Join-Path $PSScriptRoot 'target/release/library-audio-preview.exe'),
  [string]$FixtureDirectory = (Join-Path $PSScriptRoot '../../.tmp/audio-preview-fixtures'),
  [int]$WarmRuns = 5
)
$ErrorActionPreference = 'Stop'
$fixtureRoot = (Resolve-Path -LiteralPath $FixtureDirectory).Path
$binaryPath = (Resolve-Path -LiteralPath $Binary).Path
$runRoot = Join-Path $fixtureRoot ('benchmark-' + (Get-Date -Format 'yyyyMMdd-HHmmss'))
New-Item -ItemType Directory -Path $runRoot -Force | Out-Null
$cacheRoot = Join-Path $runRoot 'cache'
$sources = Get-Content -LiteralPath (Join-Path $fixtureRoot 'sources.json') -Raw | ConvertFrom-Json
$results = @()

function Measure-Waveform([string]$sourcePath, [string]$outputPath, [string]$revision) {
  $startInfo = New-Object System.Diagnostics.ProcessStartInfo
  $startInfo.FileName = $binaryPath
  # These paths are generated locally under this fixture; reject embedded quotes.
  $arguments = @($sourcePath, '--cache-dir', $cacheRoot, '--output', $outputPath, '--source-version', $revision)
  if ($arguments | Where-Object { $_.Contains('"') }) { throw 'Unexpected quote in fixture argument' }
  $startInfo.Arguments = ($arguments | ForEach-Object { '"' + $_ + '"' }) -join ' '
  $startInfo.UseShellExecute = $false
  $startInfo.CreateNoWindow = $true
  $startInfo.RedirectStandardOutput = $true
  $startInfo.RedirectStandardError = $true
  $process = New-Object System.Diagnostics.Process
  $process.StartInfo = $startInfo
  $clock = [System.Diagnostics.Stopwatch]::StartNew()
  $process.Start() | Out-Null
  $stdout = $process.StandardOutput.ReadToEndAsync()
  $stderr = $process.StandardError.ReadToEndAsync()
  $peakWorkingSet = 0L
  $memorySamples = 0
  while (-not $process.HasExited) {
    try {
      $process.Refresh()
      $peakWorkingSet = [Math]::Max($peakWorkingSet, $process.PeakWorkingSet64)
      $memorySamples++
    } catch [System.InvalidOperationException] { }
    Start-Sleep -Milliseconds 10
  }
  $process.WaitForExit()
  $clock.Stop()
  $errorText = $stderr.Result
  if ($process.ExitCode -ne 0) { throw $errorText }
  $result = Get-Content -LiteralPath $outputPath -Raw | ConvertFrom-Json
  $process.Dispose()
  return [pscustomobject]@{
    elapsedMs = [Math]::Round($clock.Elapsed.TotalMilliseconds, 3)
    peakWorkingSetBytes = $(if ($peakWorkingSet -gt 0) { $peakWorkingSet } else { $null })
    memorySamples = $memorySamples
    duration = $result.duration
    groups = $result.peaks.Count
    outputBytes = (Get-Item -LiteralPath $outputPath).Length
    diagnostics = $result.diagnostics
  }
}

foreach ($source in $sources) {
  $sourcePath = Join-Path $fixtureRoot $source.file
  $outputPath = Join-Path $fixtureRoot ($source.id + '.peaks.json')
  $cold = Measure-Waveform $sourcePath $outputPath ('synthetic-v1-' + $source.id)
  $warm = @()
  for ($index = 0; $index -lt $WarmRuns; $index++) {
    $warm += Measure-Waveform $sourcePath $outputPath ('synthetic-v1-' + $source.id)
  }
  $results += [pscustomobject]@{ file = $source.file; sourceBytes = (Get-Item -LiteralPath $sourcePath).Length; cold = $cold; warm = $warm }
  Write-Host ($source.file + ': cold=' + $cold.elapsedMs + 'ms; peak=' + $cold.peakWorkingSetBytes + '; cache=' + $warm[0].diagnostics.cacheHit)
}
$report = [pscustomobject]@{
  measuredAt = (Get-Date).ToString('o')
  os = [System.Environment]::OSVersion.VersionString
  logicalProcessors = [System.Environment]::ProcessorCount
  coldMeaning = 'Application waveform-cache miss; OS filesystem caches are not flushed.'
  memoryMeaning = 'Process PeakWorkingSet64 observed while running, 10 ms polling; null means process exited before a usable observation. Includes decoder process only.'
  timingMeaning = 'elapsedMs includes process startup and the polling interval; diagnostics.timingsMs is in-process work.'
  results = $results
}
$reportPath = Join-Path $runRoot 'results.json'
$report | ConvertTo-Json -Depth 12 | Set-Content -LiteralPath $reportPath -Encoding UTF8
Write-Host ('Report: ' + $reportPath)
