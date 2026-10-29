# Waits for ZCode to exit, then re-applies the tokbar app.asar patch and restarts ZCode.
# Uses the snippet content hash, so a patch upgrade is always picked up.
$ErrorActionPreference = 'Stop'
$here = $PSScriptRoot
$log = Join-Path $here 'auto-install.log'

function L($m) {
  Add-Content -Path $log -Value ('[{0}] {1}' -f (Get-Date -Format 'yyyy-MM-dd HH:mm:ss'), $m) -Encoding UTF8
}

L 'repatch watcher started, waiting for ZCode to exit'
while (Get-Process -Name ZCode -ErrorAction SilentlyContinue) { Start-Sleep -Seconds 2 }
Start-Sleep -Seconds 1

$node = 'D:\nodejs\node.exe'
if (-not (Test-Path $node)) { L ('REPATCH FAILED: node not found at ' + $node); exit 1 }

L 'repatching with --force'
& $node (Join-Path $here 'install-asar.mjs') --force 2>&1 | ForEach-Object { L $_ }
if ($LASTEXITCODE -ne 0) { L ('REPATCH FAILED (exit ' + $LASTEXITCODE + ')'); exit 1 }

# agent 运行时的空 thinking 净化补丁（ZCode 升级后会被覆盖，这里一并重打）
$agentFix = Join-Path (Split-Path -Parent $here) 'agent-patch\install-agent-fix.mjs'
if (Test-Path $agentFix) {
  L 'applying agent thinking fix'
  & $node $agentFix 2>&1 | ForEach-Object { L $_ }
  if ($LASTEXITCODE -ne 0) { L ('AGENT FIX FAILED (exit ' + $LASTEXITCODE + ')') }
}

L 'repatch ok, starting ZCode'
$exe = 'D:\zcode\ZCode.exe'
if (Test-Path $exe) { Start-Process -FilePath $exe }
L 'repatch done'
