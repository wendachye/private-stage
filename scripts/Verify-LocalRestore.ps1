[CmdletBinding()]
param([Parameter(Mandatory=$true)][string]$BackupPath, [string]$ReportPath)
. "$PSScriptRoot\Common.ps1"
. "$PSScriptRoot\Private-Storage.ps1"

# This command never restores over the running project's data. The only restore
# invocation below is a copy of Restore-Local.ps1 inside a fresh private project.
Assert-StageStopped
$source = (Resolve-Path -LiteralPath $BackupPath).Path.TrimEnd('\')
$backupRoot = [IO.Path]::GetFullPath((Join-Path $StageRoot 'backups')).TrimEnd('\')
if (-not $source.StartsWith($backupRoot + '\', [StringComparison]::OrdinalIgnoreCase)) { throw 'Select a stopped-service backup inside this project backup directory.' }
foreach ($required in @('.env','data\stage.sqlite','data\auth.sqlite')) {
    if (-not (Test-Path -LiteralPath (Join-Path $source $required) -PathType Leaf)) { throw 'The selected backup is incomplete.' }
}
function Assert-OrdinaryTree([string]$Directory) {
    $current = Get-Item -LiteralPath $Directory -Force
    if ($current.Attributes -band [IO.FileAttributes]::ReparsePoint) { throw 'Reparse points are not supported in a restore rehearsal.' }
    foreach ($child in Get-ChildItem -LiteralPath $Directory -Force) {
        if ($child.Attributes -band [IO.FileAttributes]::ReparsePoint) { throw 'Reparse points are not supported in a restore rehearsal.' }
        if ($child.PSIsContainer) { Assert-OrdinaryTree $child.FullName }
    }
}
Assert-OrdinaryTree $source
$runsRoot = [IO.Path]::GetFullPath((Join-Path $StageRoot 'work\restore-drills'))
New-Item -ItemType Directory -Path $runsRoot -Force | Out-Null
Assert-OrdinaryTree $runsRoot
$runRoot = [IO.Path]::GetFullPath((Join-Path $runsRoot ([Guid]::NewGuid().ToString('N'))))
if (-not $runRoot.StartsWith($runsRoot.TrimEnd('\') + '\', [StringComparison]::OrdinalIgnoreCase)) { throw 'Restore rehearsal containment validation failed.' }
New-Item -ItemType Directory -Path $runRoot | Out-Null
Protect-StagePrivateDirectory $runRoot
$target = Join-Path $runRoot 'project'
$targetScripts = Join-Path $target 'scripts'
New-Item -ItemType Directory -Path $targetScripts -Force | Out-Null
foreach ($name in @('Common.ps1','Private-Storage.ps1','Backup-Local.ps1','Restore-Local.ps1')) { Copy-Item -LiteralPath (Join-Path $PSScriptRoot $name) -Destination $targetScripts }
Copy-Item -LiteralPath (Join-Path $source '.env') -Destination (Join-Path $target '.env')
$dataLines = @(Get-Content -LiteralPath (Join-Path $source '.env') | Where-Object { $_ -match '^DATA_DIR=' })
if ($dataLines.Count -gt 1) { throw 'Duplicate DATA_DIR values are not supported in a restore rehearsal.' }
$configured = if ($dataLines.Count) { $dataLines[0].Substring(9).Trim() } else { './data' }
if ([IO.Path]::IsPathRooted($configured)) { throw 'Restore rehearsal requires a project-relative DATA_DIR.' }
$targetData = [IO.Path]::GetFullPath((Join-Path $target $configured))
if (-not $targetData.StartsWith($target.TrimEnd('\') + '\', [StringComparison]::OrdinalIgnoreCase)) { throw 'The rehearsal DATA_DIR is outside its fresh project.' }
foreach ($reserved in @('scripts','deploy','backups')) {
    $reservedPath = Join-Path $target $reserved
    if ($targetData.Equals($reservedPath, [StringComparison]::OrdinalIgnoreCase) -or $targetData.StartsWith($reservedPath + '\', [StringComparison]::OrdinalIgnoreCase) -or $reservedPath.StartsWith($targetData + '\', [StringComparison]::OrdinalIgnoreCase)) { throw 'The rehearsal DATA_DIR overlaps a reserved directory.' }
}
New-Item -ItemType Directory -Path $targetData -Force | Out-Null
try { $restoreOutput = & (Join-Path $targetScripts 'Restore-Local.ps1') -BackupPath $source -Confirm:$false }
catch { throw 'The isolated restore failed; the original project was not restored or moved.' }
$node = (Get-Command node.exe -ErrorAction Stop).Source
$verifier = Join-Path $PSScriptRoot 'verify-local-restore.mjs'
$loader = Join-Path $StageRoot 'node_modules\tsx\dist\loader.mjs'
$loaderUri = ([Uri]$loader).AbsoluteUri
$verificationOutput = & $node --import $loaderUri $verifier $source $target
if ($LASTEXITCODE -ne 0) { throw 'Restore verification failed; private details were not printed.' }
$summary = $verificationOutput | ConvertFrom-Json
$privateAcl = Get-Acl -LiteralPath $runRoot
$allowed = @([Security.Principal.WindowsIdentity]::GetCurrent().User.Value,'S-1-5-18','S-1-5-32-544')
$unexpected = @($privateAcl.Access | Where-Object { $_.IdentityReference.Translate([Security.Principal.SecurityIdentifier]).Value -notin $allowed })
if (-not $privateAcl.AreAccessRulesProtected -or $unexpected.Count) { throw 'The rehearsal storage ACL is not private.' }
$summary | Add-Member -NotePropertyName privateRehearsalAcl -NotePropertyValue $true
$summary | Add-Member -NotePropertyName privateRehearsalRetained -NotePropertyValue $true
$summary | Add-Member -NotePropertyName originalProjectRestored -NotePropertyValue $false
$json = $summary | ConvertTo-Json -Depth 8
$json | Set-Content -LiteralPath (Join-Path $runRoot 'verification.json') -Encoding UTF8
if ($ReportPath) {
    $report = [IO.Path]::GetFullPath($ReportPath)
    $valid = $false
    foreach ($relative in @('docs\evidence','work')) { if ($report.StartsWith((Join-Path $StageRoot $relative).TrimEnd('\') + '\', [StringComparison]::OrdinalIgnoreCase)) { $valid = $true } }
    if (-not $valid) { throw 'The public report must be inside this project work or evidence directory.' }
    New-Item -ItemType Directory -Path (Split-Path -Parent $report) -Force | Out-Null
    $json | Set-Content -LiteralPath $report -Encoding UTF8
}
Write-Output $json
