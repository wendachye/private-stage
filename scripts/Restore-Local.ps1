[CmdletBinding(SupportsShouldProcess=$true, ConfirmImpact='High')]
param([Parameter(Mandatory=$true)][string]$BackupPath)
. "$PSScriptRoot\Common.ps1"
Assert-StageStopped
$resolvedBackup = (Resolve-Path -LiteralPath $BackupPath).Path
if (-not (Test-Path -LiteralPath (Join-Path $resolvedBackup 'data') -PathType Container)) { throw 'The selected backup does not contain a data directory.' }
$currentDataPath = Get-StageDataPath
$backupFullPath = [System.IO.Path]::GetFullPath($resolvedBackup).TrimEnd('\')
if ($backupFullPath.Equals($currentDataPath, [StringComparison]::OrdinalIgnoreCase) -or $backupFullPath.StartsWith($currentDataPath + '\', [StringComparison]::OrdinalIgnoreCase) -or $currentDataPath.StartsWith($backupFullPath + '\', [StringComparison]::OrdinalIgnoreCase)) { throw 'Backup source and current DATA_DIR overlap. Restore was refused before moving any directory.' }
$backupEnvPath = Join-Path $resolvedBackup '.env'
if (Test-Path -LiteralPath $backupEnvPath) {
    $backupDataSetting = @(Get-Content -LiteralPath $backupEnvPath | Where-Object { $_ -match '^DATA_DIR=' })
    $currentSettings = Get-StageSettings
    if ($backupDataSetting.Count -gt 1) { throw 'The backup contains duplicate DATA_DIR settings. Review it before restoring.' }
    $backupConfigured = if ($backupDataSetting.Count -eq 1) { $backupDataSetting[0].Substring('DATA_DIR='.Length).Trim() } else { './data' }
    $backupEffectiveData = [System.IO.Path]::GetFullPath((Join-Path $StageRoot $backupConfigured))
    if (-not $backupEffectiveData.Equals($currentDataPath, [StringComparison]::OrdinalIgnoreCase)) { throw 'The backup uses a different DATA_DIR. Review the storage mapping before restoring; no files were changed.' }
}
if ($PSCmdlet.ShouldProcess($StageRoot,'Replace Private Stage database/configuration from the selected backup')) {
    & "$PSScriptRoot\Backup-Local.ps1"
    $dataPath = Get-StageDataPath
    $rollbackRoot = [System.IO.Path]::GetFullPath((Join-Path $StageRoot ('backups\pre-restore-' + (Get-Date -Format 'yyyyMMdd-HHmmss-fff'))))
    $rollbackData = Join-Path $rollbackRoot 'data'
    $safePrefix = $StageRoot.TrimEnd('\') + '\'
    if (-not $dataPath.StartsWith($safePrefix, [StringComparison]::OrdinalIgnoreCase) -or -not $rollbackRoot.StartsWith($safePrefix, [StringComparison]::OrdinalIgnoreCase)) { throw 'Restore target is outside the project; no directory was moved.' }
    New-Item -ItemType Directory -Path $rollbackRoot | Out-Null
    if (Test-Path -LiteralPath $dataPath) { Move-Item -LiteralPath $dataPath -Destination $rollbackData }
    New-Item -ItemType Directory -Path $dataPath -Force | Out-Null
    foreach ($item in @('data','.env','deploy\livekit.local.yaml')) {
        $source = Join-Path $resolvedBackup $item
        if (Test-Path -LiteralPath $source) {
            $destination = if ($item -eq 'data') { $dataPath } else { Join-Path $StageRoot $item }
            New-Item -ItemType Directory -Path (Split-Path -Parent $destination) -Force | Out-Null
            if ($item -eq 'data') {
                New-Item -ItemType Directory -Path $destination -Force | Out-Null
                Get-ChildItem -LiteralPath $source -Force | Where-Object { $_.Name -notin @('app.pid','app.lock','app.lock.recover','supervisor.lock','supervisor.lock.recover','supervisor.json','supervisor.stop') } | ForEach-Object { Copy-Item -LiteralPath $_.FullName -Destination $destination -Recurse -Force }
            } else { Copy-Item -LiteralPath $source -Destination $destination -Force }
        }
    }
    Write-Output 'Restore completed. Start-Local.ps1 will reconcile prior media/session state before admission.'
}
