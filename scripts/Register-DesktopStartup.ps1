[CmdletBinding(SupportsShouldProcess = $true)]
param()
. "$PSScriptRoot\Desktop-Startup.Common.ps1"
Register-StageDesktopStartup @PSBoundParameters
