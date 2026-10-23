# 定位 ZCode.exe：成功时把完整路径打到 stdout，失败 exit 1
$ErrorActionPreference = 'SilentlyContinue'

if ($env:ZCODE_EXE -and (Test-Path $env:ZCODE_EXE)) { Write-Output $env:ZCODE_EXE; exit 0 }

$p = Get-Process ZCode -ErrorAction SilentlyContinue | Where-Object { $_.Path } | Select-Object -First 1
if ($p -and $p.Path -and (Test-Path $p.Path)) { Write-Output $p.Path; exit 0 }

$cands = @(
  (Join-Path $env:LOCALAPPDATA 'Programs\ZCode\ZCode.exe'),
  (Join-Path $env:ProgramFiles 'ZCode\ZCode.exe'),
  (Join-Path ${env:ProgramFiles(x86)} 'ZCode\ZCode.exe'),
  'C:\zcode\ZCode.exe',
  'D:\zcode\ZCode.exe'
)
foreach ($c in $cands) { if ($c -and (Test-Path $c)) { Write-Output $c; exit 0 } }

$roots = @(
  'HKCU:\Software\Microsoft\Windows\CurrentVersion\Uninstall\*',
  'HKLM:\Software\Microsoft\Windows\CurrentVersion\Uninstall\*',
  'HKLM:\Software\WOW6432Node\Microsoft\Windows\CurrentVersion\Uninstall\*'
)
foreach ($root in $roots) {
  Get-ItemProperty $root -ErrorAction SilentlyContinue |
    Where-Object { $_.DisplayName -like '*ZCode*' -and $_.InstallLocation } |
    ForEach-Object {
      $exe = Join-Path $_.InstallLocation 'ZCode.exe'
      if (Test-Path $exe) { Write-Output $exe; exit 0 }
    }
}
exit 1
