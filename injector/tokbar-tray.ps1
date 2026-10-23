# Token Bar 托盘开关
# 依赖：注入器在跑（injector.mjs，控制接口默认 9334）
Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing

$CTL = 9334
$PORT = 9333
$here = Split-Path -Parent $MyInvocation.MyCommand.Path
$ZCODE = ""
try {
  $p = Get-Process ZCode -ErrorAction SilentlyContinue | Where-Object { $_.Path } | Select-Object -First 1
  if ($p -and $p.Path -and (Test-Path $p.Path)) { $ZCODE = $p.Path }
  if (-not $ZCODE) {
    foreach ($c in @(
      (Join-Path $env:LOCALAPPDATA 'Programs\ZCode\ZCode.exe'),
      (Join-Path $env:ProgramFiles 'ZCode\ZCode.exe'),
      (Join-Path ${env:ProgramFiles(x86)} 'ZCode\ZCode.exe'),
      'C:\zcode\ZCode.exe',
      'D:\zcode\ZCode.exe'
    )) { if ($c -and (Test-Path $c)) { $ZCODE = $c; break } }
  }
} catch { }
$injector = Join-Path $here "injector.mjs"
$node = "node"

function Get-Status {
  try { return Invoke-RestMethod -Uri "http://127.0.0.1:$CTL/status" -TimeoutSec 2 } catch { return $null }
}

function Set-Visible([bool]$v) {
  try {
    Invoke-RestMethod -Uri "http://127.0.0.1:$CTL/visible" -Method Post -ContentType 'application/json' -Body (@{ visible = $v } | ConvertTo-Json) -TimeoutSec 3 | Out-Null
    return $true
  } catch { return $false }
}

function Ensure-Injector {
  $s = Get-Status
  if ($s) { return $true }
  if (-not (Test-Path $injector)) { [System.Windows.Forms.MessageBox]::Show("找不到 injector.mjs`n$injector"); return $false }
  Start-Process -FilePath $node -ArgumentList @("`"$injector`"", "--port", "$PORT", "--ctl-port", "$CTL") -WindowStyle Hidden | Out-Null
  Start-Sleep -Seconds 1
  return [bool](Get-Status)
}

$ni = New-Object System.Windows.Forms.NotifyIcon
$ni.Icon = [System.Drawing.SystemIcons]::Information
$ni.Text = "Token Bar"
$ni.Visible = $true

$menu = New-Object System.Windows.Forms.ContextMenuStrip
$itemStatus = New-Object System.Windows.Forms.ToolStripMenuItem
$itemStatus.Text = "状态：检测中…"
$itemStatus.Enabled = $false
[void]$menu.Items.Add($itemStatus)

$itemToggle = New-Object System.Windows.Forms.ToolStripMenuItem
$itemToggle.Text = "显示 / 隐藏速率条"
[void]$menu.Items.Add($itemToggle)

$itemStartInjector = New-Object System.Windows.Forms.ToolStripMenuItem
$itemStartInjector.Text = "启动注入器"
[void]$menu.Items.Add($itemStartInjector)

$itemLaunch = New-Object System.Windows.Forms.ToolStripMenuItem
$itemLaunch.Text = "启动 ZCode（带调试端口）"
[void]$menu.Items.Add($itemLaunch)

[void]$menu.Items.Add((New-Object System.Windows.Forms.ToolStripSeparator))

$itemExit = New-Object System.Windows.Forms.ToolStripMenuItem
$itemExit.Text = "退出"
[void]$menu.Items.Add($itemExit)

$itemToggle.add_Click({
  $s = Get-Status
  if (-not $s) {
    if (-not (Ensure-Injector)) {
      [System.Windows.Forms.MessageBox]::Show("注入器未运行。请先关闭 ZCode，再运行 start-zcode-tokbar.bat（或先点「启动 ZCode（带调试端口）」）。")
      return
    }
  }
  $cur = Get-Status
  $next = -not ($cur -and $cur.visible)
  if (-not (Set-Visible $next)) {
    [System.Windows.Forms.MessageBox]::Show("无法连接到注入器控制接口（9334）。")
  }
})

$itemStartInjector.add_Click({
  if (Ensure-Injector) { [System.Windows.Forms.MessageBox]::Show("注入器已在运行。") }
  else { [System.Windows.Forms.MessageBox]::Show("注入器启动失败或等不到 9333 调试端口。`n请确认 ZCode 是用 --remote-debugging-port 启动的。") }
})

$itemLaunch.add_Click({
  if (Get-Process ZCode -ErrorAction SilentlyContinue) {
    [System.Windows.Forms.MessageBox]::Show("ZCode 正在运行。`n请先完全退出 ZCode，再点这个菜单项。")
    return
  }
  if (-not (Test-Path $ZCODE)) { [System.Windows.Forms.MessageBox]::Show("找不到 ZCode.exe：$ZCODE") ; return }
  Start-Process -FilePath $ZCODE -ArgumentList "--remote-debugging-port=$PORT"
  Start-Sleep -Seconds 3
  Ensure-Injector | Out-Null
})

$itemExit.add_Click({
  $ni.Visible = $false
  $ni.Dispose()
  [System.Windows.Forms.Application]::Exit()
})

$ni.ContextMenuStrip = $menu

$timer = New-Object System.Windows.Forms.Timer
$timer.Interval = 2000
$timer.add_Tick({
  $s = Get-Status
  if (-not $s) {
    $itemStatus.Text = "状态：注入器未运行"
    $ni.Text = "Token Bar — 未运行"
  } elseif (-not $s.connected) {
    $itemStatus.Text = "状态：已连接控制口，等待调试端口"
    $ni.Text = "Token Bar — 等待 ZCode 调试端口"
  } elseif ($s.visible) {
    $itemStatus.Text = "状态：已连接 · 速率条已显示"
    $ni.Text = "Token Bar — 已显示"
    $itemToggle.Text = "隐藏速率条"
  } else {
    $itemStatus.Text = "状态：已连接 · 速率条已隐藏"
    $ni.Text = "Token Bar — 已隐藏"
    $itemToggle.Text = "显示速率条"
  }
})
$timer.Start()

[System.Windows.Forms.Application]::Run()
