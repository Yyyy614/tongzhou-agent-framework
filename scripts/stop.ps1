$ErrorActionPreference = 'Stop'
$projectPath = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
$pidFile = Join-Path $projectPath '.local/server.pid'
if (-not (Test-Path -LiteralPath $pidFile)) { Write-Output 'No recorded framework process.'; exit 0 }
$recordedPid = [int](Get-Content -LiteralPath $pidFile -Raw).Trim()
$existing = Get-CimInstance Win32_Process -Filter "ProcessId=$recordedPid"
if (-not $existing) { Write-Output 'Framework process already stopped.'; exit 0 }
$cliPath = Join-Path $projectPath 'dist/cli.js'
if ($existing.Name -ne 'node.exe' -or -not $existing.CommandLine.Contains($cliPath, [StringComparison]::OrdinalIgnoreCase)) { throw 'PID identity does not match this project; refusing to stop it.' }
# This is an explicit process-tree stop, not a rollback of work already sent outside.
& taskkill.exe /PID $recordedPid /T /F
$stopExit = $LASTEXITCODE
if ($stopExit -ne 0) { throw "Process stop failed (exit $stopExit)." }
Write-Output 'Stopped this framework and its child workers. Interrupted runs will require reconciliation on restart.'
