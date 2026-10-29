[CmdletBinding()]
param()
. "$PSScriptRoot\Desktop-Startup.Common.ps1"
Get-StageDesktopStartupStatus | ConvertTo-Json -Depth 6
