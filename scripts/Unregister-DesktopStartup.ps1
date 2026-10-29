[CmdletBinding(SupportsShouldProcess = $true)]
param()
. "$PSScriptRoot\Desktop-Startup.Common.ps1"
Unregister-StageDesktopStartup @PSBoundParameters
