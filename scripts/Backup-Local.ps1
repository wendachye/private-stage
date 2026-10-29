. "$PSScriptRoot\Common.ps1"
. "$PSScriptRoot\Private-Storage.ps1"
Assert-StageStopped
$backupPath = Join-Path $StageRoot ('backups\' + (Get-Date -Format 'yyyyMMdd-HHmmss-fff'))
New-Item -ItemType Directory -Path (Split-Path -Parent $backupPath) -Force | Out-Null
New-Item -ItemType Directory -Path $backupPath | Out-Null
Protect-StagePrivateDirectory -Path $backupPath
$dataBackup = Join-Path $backupPath 'data'
New-Item -ItemType Directory -Path $dataBackup | Out-Null
Get-ChildItem -LiteralPath (Get-StageDataPath) -Force | Where-Object { $_.Name -notin @('app.pid','app.lock','app.lock.recover','supervisor.lock','supervisor.lock.recover','supervisor.json','supervisor.stop') } | ForEach-Object { Copy-Item -LiteralPath $_.FullName -Destination $dataBackup -Recurse -Force }
foreach ($item in @('.env','deploy\livekit.local.yaml')) {
    $source = Join-Path $StageRoot $item
    if (Test-Path -LiteralPath $source) {
        $destination = Join-Path $backupPath $item
        $parent = Split-Path -Parent $destination
        New-Item -ItemType Directory -Path $parent -Force | Out-Null
        Copy-Item -LiteralPath $source -Destination $destination -Recurse -Force
    }
}
Write-Output "Backup saved: $backupPath"
Write-Output 'This backup contains local secrets. Keep it private and outside source control.'
