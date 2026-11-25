$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Windows.Forms, System.Drawing, System.Net.Http
[Windows.Forms.Application]::EnableVisualStyles()

$root = (Resolve-Path (Join-Path $PSScriptRoot '../..')).Path
$snapshotPath = Join-Path $PSScriptRoot '.local\snapshot.json'
$origin = 'http://127.0.0.1:48733'
$identity = ConvertTo-Json -InputObject @($root, $snapshotPath) -Compress
$hash = [Security.Cryptography.SHA256]::Create()
try { $instance = [BitConverter]::ToString($hash.ComputeHash([Text.Encoding]::UTF8.GetBytes($identity))).Replace('-', '').ToLowerInvariant() }
finally { $hash.Dispose() }

function Color($hex) { [Drawing.ColorTranslator]::FromHtml($hex) }
$theme = Get-ItemProperty -LiteralPath 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Themes\Personalize' -ErrorAction SilentlyContinue
$light = $theme.AppsUseLightTheme -eq 1
$paper = if ($light) { Color '#F7F7F7' } else { Color '#1E1E1E' }
$bar = if ($light) { Color '#EFEFEF' } else { Color '#181818' }
$rule = if ($light) { Color '#C5C5C5' } else { Color '#3D3D3D' }
$ink = if ($light) { Color '#2B2B2B' } else { Color '#DCDCDC' }
$muted = if ($light) { Color '#646464' } else { Color '#949494' }
$accent = if ($light) { Color '#496775' } else { Color '#8FAAB8' }
$good = Color '#3FA679'
$warning = Color '#D9953B'
$failure = if ($light) { Color '#A13D3D' } else { Color '#D46363' }

$form = [Windows.Forms.Form]::new()
$form.Text = 'Bowerbird MCP Mini'
$form.FormBorderStyle = 'None'
$form.ClientSize = [Drawing.Size]::new(248, 72)
$form.TopMost = $true
$form.StartPosition = 'Manual'
$form.AutoScaleDimensions = [Drawing.SizeF]::new(96, 96)
$form.AutoScaleMode = 'Dpi'
$form.Font = [Drawing.Font]::new('Microsoft YaHei UI', 8.5)
$form.BackColor = $rule
$form.Padding = [Windows.Forms.Padding]::new(1)
$surface = [Windows.Forms.Panel]::new()
$surface.BackColor = $paper
$surface.Dock = 'Fill'
$form.Controls.Add($surface)
$tips = [Windows.Forms.ToolTip]::new()
$tips.ShowAlways = $true

function New-Badge($text, $x, $y, $width, $height) {
  $label = [Windows.Forms.Label]::new()
  $label.UseMnemonic = $false
  $label.Text = $text
  $label.TextAlign = 'MiddleLeft'
  $label.AutoEllipsis = $true
  $label.ForeColor = $ink
  $label.SetBounds($x, $y, $width, $height)
  $surface.Controls.Add($label)
  return $label
}
function New-Action($text, $name, $x, $width, $color) {
  $button = [Windows.Forms.Button]::new()
  $button.Text = $text
  $button.AccessibleName = $name
  $button.UseMnemonic = $false
  $button.FlatStyle = 'Flat'
  $button.FlatAppearance.BorderSize = 0
  $button.FlatAppearance.MouseOverBackColor = $rule
  $button.BackColor = $bar
  $button.ForeColor = $color
  $button.SetBounds($x, 7, $width, 27)
  $surface.Controls.Add($button)
  $tips.SetToolTip($button, $name)
  return $button
}

$dot = [Windows.Forms.Panel]::new()
$dot.SetBounds(9, 18, 6, 6)
$surface.Controls.Add($dot)
$tunnel = New-Badge '检测中…' 21 7 64 27
$run = New-Action '▶ 运行' '启动未运行的 MCP 服务' 7 77 $ink
$run.Visible = $false
$update = New-Action '更新快照' '更新当前工作区快照' 86 73 $accent
$update.Enabled = $false
$refresh = New-Action '↻' '刷新状态与快照' 161 25 $ink
$details = New-Action '▤' '打开完整管理工具' 188 25 $ink
$close = New-Action '×' '关闭小窗' 215 24 $ink
$snapshot = New-Badge '尚无快照' 8 39 188 22
$clock = New-Badge '' 198 39 40 22
$clock.TextAlign = 'MiddleRight'
$clock.ForeColor = $muted
$progress = [Windows.Forms.Panel]::new()
$progress.BackColor = $rule
$progress.SetBounds(8, 65, 230, 2)
$progress.Visible = $false
$surface.Controls.Add($progress)
$pulse = [Windows.Forms.Panel]::new()
$pulse.BackColor = $accent
$progress.Controls.Add($pulse)

$drag = @{ active = $false }
foreach ($control in $surface, $dot, $tunnel, $snapshot, $clock) {
  $control.Add_MouseDown({
    param($sender, $eventArgs)
    if ($eventArgs.Button -ne 'Left') { return }
    $drag.active = $true
    $drag.cursor = [Windows.Forms.Cursor]::Position
    $drag.window = $form.Location
    $sender.Capture = $true
  })
  $control.Add_MouseMove({
    if (-not $drag.active) { return }
    $point = [Windows.Forms.Cursor]::Position
    $form.Location = [Drawing.Point]::new(($drag.window.X + $point.X - $drag.cursor.X), ($drag.window.Y + $point.Y - $drag.cursor.Y))
  })
  $control.Add_MouseUp({ param($sender) $drag.active = $false; $sender.Capture = $false })
  $control.Add_MouseCaptureChanged({ param($sender) if (-not $sender.Capture) { $drag.active = $false } })
}

$handler = [Net.Http.HttpClientHandler]::new()
$handler.UseProxy = $false
$handler.AllowAutoRedirect = $false
$client = [Net.Http.HttpClient]::new($handler)
$client.Timeout = [TimeSpan]::FromSeconds(9)
$client.DefaultRequestHeaders.Add('Origin', $origin)
$view = @{
  ready = $false; services = $null; snapshot = $null; job = $null; awaitingJob = $false; awaitingStart = $false
  statusDue = [DateTime]::MinValue; servicesDue = [DateTime]::MinValue
  notice = ''; noticeUntil = [DateTime]::MinValue; noticeError = $false
}
$requests = @{}

function Note($text, [switch]$ErrorTone) {
  $view.notice = $text
  $view.noticeError = $ErrorTone.IsPresent
  $view.noticeUntil = [DateTime]::UtcNow.AddSeconds(5)
}
function ServiceHint {
  $gpt = $view.services.gpt
  $gemini = $view.services.gemini
  $gptHint = switch ($gpt.state) {
    'healthy' { '正常'; break }
    'stopped' { '未运行'; break }
    default {
      if ($gpt.controlPlane.state -eq 'backoff') { '控制面退避' }
      elseif ($gpt.proxy -eq 'unhealthy') { '代理异常' }
      else { '连接待确认' }
    }
  }
  $geminiHint = switch ($gemini.state) {
    'healthy' { '正常'; break }
    'stopped' { '未运行'; break }
    default {
      if ($gemini.ssh -in @('stopped', 'connecting')) { 'SSH 重连中' }
      elseif ($gemini.http -ne 'healthy') { '本机 HTTP 待就绪' }
      else { '连接待确认' }
    }
  }
  "GPT：$gptHint    Gemini：$geminiHint"
}
function CompactBranch([string]$name, [string]$suffix) {
  $available = $snapshot.Width - [Windows.Forms.TextRenderer]::MeasureText($suffix, $snapshot.Font).Width
  if ([Windows.Forms.TextRenderer]::MeasureText($name, $snapshot.Font).Width -le $available) { return $name }
  $length = $name.Length
  while ($length -gt 0) {
    $length--
    $candidate = $name.Substring(0, $length) + '…'
    if ([Windows.Forms.TextRenderer]::MeasureText($candidate, $snapshot.Font).Width -le $available) { return $candidate }
  }
  return '…'
}
function Render {
  $now = [DateTime]::UtcNow
  $combined = $view.services.combined
  $starting = $requests.ContainsKey('start') -or $view.awaitingStart -or $combined -eq 'starting'
  $exporting = $requests.ContainsKey('export') -or $view.awaitingJob -or $view.job.status -eq 'running'
  $run.Visible = $view.ready -and $combined -eq 'stopped' -and -not $starting
  $tunnel.Visible = -not $run.Visible
  $dot.Visible = $tunnel.Visible
  $tunnel.Text = if ($starting) { '启动中…' }
    elseif (-not $view.ready -or -not $combined) { '检测中…' }
    elseif ($combined -eq 'healthy') { '运行中' }
    else { '连接中' }
  $dot.BackColor = if ($view.ready -and $combined -eq 'healthy') { $good } else { $warning }
  $statusHint = ServiceHint
  foreach ($control in $dot, $tunnel, $run) {
    if ($tips.GetToolTip($control) -ne $statusHint) { $tips.SetToolTip($control, $statusHint) }
  }

  $update.Enabled = $view.ready -and -not $exporting
  $refresh.Enabled = $view.ready -and -not ($requests.ContainsKey('status') -or $requests.ContainsKey('services'))
  $details.Enabled = $view.ready
  $progress.Visible = $exporting
  if ($exporting) {
    $width = [int]($progress.Width / 4)
    $pulse.SetBounds(([int]($now.TimeOfDay.TotalMilliseconds / 100) % 9 * ($progress.Width - $width) / 8), 0, $width, $progress.Height)
  }
  $feedback = if ($exporting) {
    $branch = $view.job.branch
    if ($view.job.status -eq 'running' -and $branch) { "导出 $branch 中…" } else { '正在准备导出…' }
  } elseif ($starting) { '正在启动本机服务…' }
  elseif ($now -lt $view.noticeUntil) { $view.notice }
  else { '' }
  $snapshot.ForeColor = if ($feedback -and -not ($starting -or $exporting) -and $view.noticeError) { $failure } else { $ink }
  $clock.Visible = -not $feedback
  $snapshot.Width = if ($feedback) { $clock.Right - $snapshot.Left } else { $clock.Left - $snapshot.Left - 2 }
  $timeText = ''
  $meta = ''
  if ($view.snapshot) {
    $stamp = [DateTimeOffset]::Parse($view.snapshot.createdAt).ToLocalTime()
    $hashText = $view.snapshot.revision
    $count = ([int]$view.snapshot.fileCount).ToString('N0')
    $branchName = if ($view.snapshot.branch) { $view.snapshot.branch } else { '未知分支' }
    $dirty = if ($view.snapshot.isDirty -eq $true) { '工作区有改动' }
      elseif ($view.snapshot.isDirty -eq $false) { '工作区干净' } else { '工作区状态未知' }
    $meta = "$branchName · $hashText" + [Environment]::NewLine + "$count 个文件 · $dirty" + [Environment]::NewLine + $stamp.ToString('yyyy-MM-dd HH:mm:ss zzz')
    if (-not $feedback) {
      $marker = if ($view.snapshot.isDirty -eq $true) { '*' } else { '' }
      $suffix = $marker + ' · ' + $hashText.Substring(0, [Math]::Min(7, $hashText.Length)) + " · $count"
      $feedback = (CompactBranch $branchName $suffix) + $suffix
      $timeText = $stamp.ToString('HH:mm')
    }
  }
  $snapshot.Text = if ($feedback) { $feedback } else { '尚无快照' }
  $clock.Text = $timeText
  foreach ($control in $snapshot, $clock) {
    if ($tips.GetToolTip($control) -ne $meta) { $tips.SetToolTip($control, $meta) }
  }
}

function Post($name, $route, $json) {
  $view.noticeUntil = [DateTime]::MinValue
  $body = [Net.Http.StringContent]::new($json, [Text.Encoding]::UTF8, 'application/json')
  $requests[$name] = $client.PostAsync($origin + $route, $body)
  Render
}
$update.Add_Click({ Post 'export' '/api/export' '{"current":true}' })
$run.Add_Click({ Post 'start' '/api/services/start' '{}' })
$refresh.Add_Click({ $view.statusDue = $view.servicesDue = [DateTime]::MinValue })
$details.Add_Click({
  try { Start-Process -FilePath ($origin + '/') }
  catch { Note '无法打开管理页。' -ErrorTone }
})
$close.Add_Click({ $form.Close() })

function Read-ActionResponse($action, $response) {
  try {
    $code = [int]$response.StatusCode
    if ($action -eq 'export') {
      $alreadyExporting = $false
      if ($code -eq 409) {
        $responseBody = ConvertFrom-Json -InputObject ($response.Content.ReadAsStringAsync().GetAwaiter().GetResult())
        $alreadyExporting = $responseBody.error -eq '正在导出快照。'
      }
      if ($code -eq 202 -or $alreadyExporting) {
        $view.awaitingJob = $true
        $requests.Remove('status')
      }
      else { Note '未能发起快照更新。' -ErrorTone }
      $view.statusDue = [DateTime]::MinValue
      return
    }
    if ($code -eq 202) {
      $view.awaitingStart = $true
      $requests.Remove('services')
    }
    elseif (-not $response.IsSuccessStatusCode) {
      $data = ConvertFrom-Json -InputObject ($response.Content.ReadAsStringAsync().GetAwaiter().GetResult())
      Note $data.error -ErrorTone
    }
    $view.servicesDue = [DateTime]::MinValue
  } finally { $response.Dispose() }
}

$timer = [Windows.Forms.Timer]::new()
$timer.Interval = 280
$timer.Add_Tick({
  $now = [DateTime]::UtcNow
  foreach ($name in @($requests.Keys)) {
    $task = $requests[$name]
    if (-not $task.IsCompleted) { continue }
    $requests.Remove($name)
    try {
      $result = $task.GetAwaiter().GetResult()
      switch ($name) {
        'status' {
          $info = ConvertFrom-Json -InputObject $result
          if ($info.app -ne 'bowerbird-mcp-console' -or $info.instance -ne $instance) { throw 'Unexpected console instance' }
          if ($info.apiVersion -ne 2) { Note '请退出旧版后台控制台。' -ErrorTone; throw 'Old console version' }
          $view.ready = $true
          $view.snapshot = $info.snapshot
          if (($view.awaitingJob -or $view.job.status -eq 'running') -and $info.job.status -in @('done', 'failed')) {
            if ($info.job.status -eq 'done') {
              $count = ([int]$info.job.exportedFiles).ToString('N0')
              Note "已更新 $($info.job.branch) · $count 文件"
            } elseif ($info.job.coverageStatus -eq 'incomplete') { Note '覆盖检查失败 · 保留原快照' -ErrorTone }
            else { Note '更新失败 · 保留原快照' -ErrorTone }
          }
          $view.awaitingJob = $false
          $view.job = $info.job
          $view.statusDue = $now.AddMilliseconds($(if ($view.job.status -eq 'running') { 450 } else { 2500 }))
        }
        'services' {
          $info = ConvertFrom-Json -InputObject $result
          if ($info.startup.status -eq 'failed' -and ($view.awaitingStart -or $view.services.startup.status -eq 'starting')) {
            Note $info.startup.error -ErrorTone
          }
          $view.awaitingStart = $false
          $view.services = $info
        }
        default { Read-ActionResponse $name $result }
      }
    } catch {
      switch ($name) {
        'status' { $view.ready = $false; $view.statusDue = $now.AddSeconds(2) }
        'services' { $view.services = $null; $view.awaitingStart = $false }
        'export' { Note '未能发起快照更新。' -ErrorTone }
        'start' { Note '未能发起服务启动。' -ErrorTone }
      }
    }
  }
  if (-not $requests.ContainsKey('status') -and $now -ge $view.statusDue) {
    $requests.status = $client.GetStringAsync($origin + '/api/status')
  }
  if ($view.ready -and -not $requests.ContainsKey('services') -and $now -ge $view.servicesDue) {
    $requests.services = $client.GetStringAsync($origin + '/api/services')
    $view.servicesDue = $now.AddSeconds($(if ($view.awaitingStart -or $view.services.combined -eq 'starting') { 1 } else { 5 }))
  }
  Render
})

$form.Add_Shown({
  try {
    $node = (Get-Command node -CommandType Application | Select-Object -First 1).Source
    $script = Join-Path $PSScriptRoot 'branch-console.mjs'
    Start-Process -FilePath $node -WorkingDirectory $root -WindowStyle Hidden -ArgumentList @(('"' + $script + '"'), '--serve-only')
  } catch { Note '无法启动本机管理工具。' -ErrorTone }
  # Show again after Windows consumes the launcher's hidden startup state.
  $form.Hide()
  $area = [Windows.Forms.Screen]::FromPoint([Windows.Forms.Cursor]::Position).WorkingArea
  $form.Location = [Drawing.Point]::new(($area.Right - $form.Width - 12), ($area.Bottom - $form.Height - 12))
  $form.Show()
  $form.Activate()
  $timer.Start()
})
$form.Add_FormClosed({ $timer.Stop(); $timer.Dispose(); $tips.Dispose(); $client.Dispose() })
[Windows.Forms.Application]::Run($form)
