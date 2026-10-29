[CmdletBinding()]
param([ValidateRange(1,600)][int]$DockerTimeoutSeconds = 180, [ValidateRange(1,30)][int]$PollSeconds = 3)
. "$PSScriptRoot\Desktop-Startup.Common.ps1"
try { Invoke-StageDesktopStartup @PSBoundParameters }
catch { Write-Error $_; exit 1 }
