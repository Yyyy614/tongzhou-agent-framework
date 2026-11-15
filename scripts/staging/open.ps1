param([ValidateSet('employee','admin')][string]$Mode = 'employee')
$ErrorActionPreference = 'Stop'
$projectRoot = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '../..'))
Set-Location -LiteralPath $projectRoot
$stageRoot = Join-Path $projectRoot '.local/staging'
$connection = Get-Content -LiteralPath (Join-Path $stageRoot 'connection.json') -Raw | ConvertFrom-Json
if ($connection.serverURL -notin @('http://127.0.0.1:14317','https://sales.hongkeweilai.com:8443')) { throw 'Unexpected test service address' }
$useTunnel = $connection.serverURL -eq 'http://127.0.0.1:14317'
$sshOptions = @('-o','IdentitiesOnly=yes','-o','BatchMode=yes','-o','ConnectTimeout=8','-o','StrictHostKeyChecking=yes','-o',('UserKnownHostsFile=' + $connection.knownHostsFile))
if ($useTunnel) {
$listener = Get-NetTCPConnection -LocalPort 14317 -State Listen -ErrorAction SilentlyContinue
if ($listener) {
    $owner = Get-CimInstance Win32_Process -Filter ('ProcessId=' + $listener[0].OwningProcess)
    if ($owner.Name -ne 'ssh.exe' -or $owner.CommandLine -notlike '*caf-stage-tunnel@115.159.158.226*' -or $owner.CommandLine -notlike '*127.0.0.1:14317:127.0.0.1:14317*') { throw 'Test port is occupied by a different process' }
} else {
    $arguments = @('-i',('"' + $connection.tunnelKeyFile + '"')) + $sshOptions + @('-o','ExitOnForwardFailure=yes','-o','ServerAliveInterval=20','-o','ServerAliveCountMax=3','-T','-N','-L','127.0.0.1:14317:127.0.0.1:14317','caf-stage-tunnel@115.159.158.226')
    $tunnel = Start-Process -FilePath 'ssh.exe' -ArgumentList $arguments -WindowStyle Hidden -PassThru -RedirectStandardOutput (Join-Path $stageRoot 'tunnel.out.log') -RedirectStandardError (Join-Path $stageRoot 'tunnel.err.log')
    $ready = $false
    for ($attempt=0; $attempt -lt 20; $attempt++) {
        Start-Sleep -Milliseconds 250
        if ($tunnel.HasExited) { throw 'Test tunnel did not start; inspect .local/staging/tunnel.err.log' }
        if (Get-NetTCPConnection -LocalPort 14317 -State Listen -ErrorAction SilentlyContinue) { $ready = $true; break }
    }
    if (-not $ready) { throw 'Test tunnel startup timed out' }
}
}
$health = Invoke-RestMethod -Uri ($connection.serverURL + '/health') -TimeoutSec 8 -NoProxy
if ($health.status -ne 'ok') { throw 'Test service is not ready' }
if ($Mode -eq 'employee') {
    $manifestName = if ($useTunnel) { 'employee-client-release.json' } else { 'employee-client-https-release.json' }
    $release = Get-Content -LiteralPath (Join-Path $stageRoot $manifestName) -Raw | ConvertFrom-Json
    if ($release.serverURL -ne $connection.serverURL) { throw 'Employee release belongs to a different service' }
    $runtime = Join-Path $release.directory 'runtime/node.exe'
    $client = Join-Path $release.directory 'client/start.mjs'
    $device = Join-Path $stageRoot $(if ($useTunnel) { 'employee-device' } else { 'https-employee-device' })
    Start-Process -FilePath $runtime -ArgumentList @(('"' + $client + '"'),'--data-dir',('"' + $device + '"')) -WindowStyle Hidden | Out-Null
    Write-Output '已打开云端测试员工入口，工作在原生 Harness 中完成。'
} else {
    & ssh.exe -i $connection.adminKeyFile @sshOptions 'ubuntu@115.159.158.226' 'sudo -n docker exec caf-staging-app node scripts/staging/issue-console.mjs'
    $sshExit = $LASTEXITCODE
    if ($sshExit -ne 0) { throw 'Could not issue a test administrator entry' }
    $entryPath = Join-Path $stageRoot 'private/console-entry.json'
    & scp.exe -i $connection.adminKeyFile @sshOptions 'ubuntu@115.159.158.226:/srv/company-agent-staging/state/console-entry.json' $entryPath
    $copyExit = $LASTEXITCODE
    if ($copyExit -ne 0) { throw 'Could not retrieve the test administrator entry' }
    $entry = Get-Content -LiteralPath $entryPath -Raw | ConvertFrom-Json
    if (-not $entry.url.StartsWith($connection.serverURL + '/#entry=')) { throw 'Invalid console entry address' }
    Start-Process -FilePath $entry.url | Out-Null
    Write-Output '已打开云端测试管理后台。'
}
