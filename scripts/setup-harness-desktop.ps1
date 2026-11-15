$ErrorActionPreference = 'Stop'
$projectPath = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
$lock = Get-Content -LiteralPath (Join-Path $projectPath 'harness-desktop.lock.json') -Raw | ConvertFrom-Json
$toolsPath = Join-Path $projectPath '.tools'
$desktopPath = Join-Path $toolsPath 'harness-desktop'
$archivePath = Join-Path $toolsPath 'harness-desktop-setup.exe'
$logPath = Join-Path $projectPath '.local/extract-harness.log'
New-Item -ItemType Directory -Force -Path $toolsPath,(Join-Path $projectPath '.local') | Out-Null
function Matches-Hash($path, $expected) { return (Test-Path -LiteralPath $path) -and ((Get-FileHash -LiteralPath $path -Algorithm SHA256).Hash -eq $expected) }
if ((Matches-Hash (Join-Path $desktopPath $lock.executable) $lock.executableSHA256) -and (Matches-Hash (Join-Path $desktopPath 'resources/app.asar') $lock.asarSHA256)) { Write-Output "Pinned Harness Desktop $($lock.version) is ready."; exit 0 }
if (-not (Test-Path -LiteralPath $archivePath)) {
    & curl.exe --noproxy '*' --fail --silent --show-error --location --max-time 180 $lock.installerURL -o $archivePath
    $downloadExit = $LASTEXITCODE
    if ($downloadExit -ne 0) { throw "Desktop download failed ($downloadExit)." }
}
if (-not (Matches-Hash $archivePath $lock.installerSHA256)) { throw 'The download differs from the pinned release. Review a version update; do not install it automatically.' }
$signature = Get-AuthenticodeSignature -LiteralPath $archivePath
if ($signature.Status -ne 'Valid' -or $signature.SignerCertificate.Subject -notlike '*Hangzhou DeepSeek Artificial Intelligence Co., Ltd.*') { throw 'Official installer signature could not be verified.' }
if ((Get-Item -LiteralPath $archivePath).VersionInfo.ProductVersion -ne $lock.version) { throw 'Installer version does not match the framework baseline.' }
$sevenZip = (Get-Command 7z.exe -ErrorAction Stop).Source
$stagePath = Join-Path $toolsPath 'harness-installer'
& $sevenZip x $archivePath "-o$stagePath" -y -bd *> $logPath
$extractExit = $LASTEXITCODE
if ($extractExit -ne 0) { throw "Installer extraction failed ($extractExit); see $logPath" }
$applicationArchive = Get-ChildItem -LiteralPath $stagePath -Recurse -File -Filter 'app-64.7z' | Select-Object -First 1
if (-not $applicationArchive) { throw 'The pinned installer contains no x64 application archive.' }
& $sevenZip x $applicationArchive.FullName "-o$desktopPath" -y -bd *>> $logPath
$extractExit = $LASTEXITCODE
if ($extractExit -ne 0) { throw "Application extraction failed ($extractExit); see $logPath" }
if (-not (Matches-Hash (Join-Path $desktopPath $lock.executable) $lock.executableSHA256) -or -not (Matches-Hash (Join-Path $desktopPath 'resources/app.asar') $lock.asarSHA256)) { throw 'Extracted Desktop integrity does not match the release baseline.' }
Write-Output "Pinned Harness Desktop $($lock.version) is ready. No global installation was performed."
