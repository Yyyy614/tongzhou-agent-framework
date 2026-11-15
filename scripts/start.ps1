param([switch]$SkipBuild)
$ErrorActionPreference = 'Stop'
$projectPath = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
$previousPath = Get-Location
try {
    Set-Location -LiteralPath $projectPath
    $nodePath = (Get-Command node -ErrorAction Stop).Source
    $pidFile = Join-Path $projectPath '.local/server.pid'
    $cliPath = Join-Path $projectPath 'dist/cli.js'
    if (Test-Path -LiteralPath $pidFile) {
        $recordedPid = [int](Get-Content -LiteralPath $pidFile -Raw).Trim()
        $existing = Get-CimInstance Win32_Process -Filter "ProcessId=$recordedPid"
        if ($existing -and $existing.CommandLine.Contains($cliPath, [StringComparison]::OrdinalIgnoreCase)) {
            Write-Output "Framework is already running (PID $recordedPid)."
            exit 0
        }
        if ($existing) { throw 'The recorded PID belongs to an unverified process; inspect it before starting.' }
    }
    & $nodePath scripts/local-postgres.mjs
    $databaseExit = $LASTEXITCODE
    if ($databaseExit -ne 0) { throw "Database setup failed (exit $databaseExit)." }
    if (-not $SkipBuild) {
        & $nodePath scripts/build.mjs
        $buildExit = $LASTEXITCODE
        if ($buildExit -ne 0) { throw "Build failed (exit $buildExit)." }
    }
    $envFile = Join-Path $projectPath '.env'
    if (-not (Test-Path -LiteralPath $envFile)) { throw 'Create .env from .env.example before starting.' }
    $child = Start-Process -FilePath $nodePath -ArgumentList @("--env-file=`"$envFile`"", "`"$cliPath`"", 'serve') -WorkingDirectory $projectPath -WindowStyle Hidden -RedirectStandardOutput (Join-Path $projectPath '.local/server.stdout.log') -RedirectStandardError (Join-Path $projectPath '.local/server.stderr.log') -PassThru
    $child.Id | Set-Content -LiteralPath $pidFile
    for ($attempt = 0; $attempt -lt 40; $attempt++) {
        Start-Sleep -Milliseconds 250
        $child.Refresh()
        if ($child.HasExited) { throw 'Host exited during startup. Inspect .local/server.stderr.log.' }
        try {
            $result = Invoke-RestMethod -Uri 'http://127.0.0.1:4317/health' -TimeoutSec 1
            if ($result.status -eq 'ok') { Write-Output "Framework ready at http://127.0.0.1:4317 (PID $($child.Id))."; exit 0 }
        } catch { }
    }
    throw 'Host has not become ready. Inspect .local/server.stdout.log and server.stderr.log.'
} finally { Set-Location $previousPath }
