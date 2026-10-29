. "$PSScriptRoot\Common.ps1"

function Get-StageDesktopIdentity {
    $identity = [Security.Principal.WindowsIdentity]::GetCurrent()
    return @{ Sid = $identity.User.Value; Name = $identity.Name }
}

function Get-StageDesktopTaskSpec {
    $identity = Get-StageDesktopIdentity
    $sha = [Security.Cryptography.SHA256]::Create()
    try { $digest = $sha.ComputeHash([Text.Encoding]::UTF8.GetBytes($StageRoot.ToLowerInvariant() + '|' + $identity.Sid)) }
    finally { $sha.Dispose() }
    $suffix = [BitConverter]::ToString($digest).Replace('-', '').ToLowerInvariant().Substring(0, 16)
    $entry = Join-Path $StageRoot 'scripts\Start-Desktop.ps1'
    if (-not (Test-Path -LiteralPath $entry -PathType Leaf)) { throw 'The desktop startup entry is missing.' }
    $powerShell = Join-Path $env:WINDIR 'System32\WindowsPowerShell\v1.0\powershell.exe'
    if (-not (Test-Path -LiteralPath $powerShell -PathType Leaf)) { throw 'Windows PowerShell is not installed at the expected system path.' }
    return [pscustomobject]@{
        Name = 'PrivateStage-Desktop-' + $suffix
        Path = '\'
        Description = 'Private Stage current-user desktop recovery: ' + $StageRoot
        Execute = $powerShell
        Arguments = '-NoLogo -NoProfile -NonInteractive -WindowStyle Hidden -ExecutionPolicy RemoteSigned -File "' + $entry + '"'
        WorkingDirectory = $StageRoot
        UserId = $identity.Sid
        UserName = $identity.Name
    }
}

function Get-StageDesktopRegisteredTask($Spec) {
    $tasks = @(Get-ScheduledTask -TaskPath $Spec.Path -ErrorAction Stop | Where-Object { $_.TaskName -eq $Spec.Name })
    if ($tasks.Count -gt 1) { throw 'More than one desktop startup task matched; no task was changed.' }
    if ($tasks.Count) { return $tasks[0] }
    return $null
}

function Resolve-StageDesktopAccountSid([string]$Account) {
    if ([string]::IsNullOrWhiteSpace($Account)) { return $null }
    try {
        if ($Account.StartsWith('S-', [StringComparison]::OrdinalIgnoreCase)) { return ([Security.Principal.SecurityIdentifier]$Account).Value }
        return ([Security.Principal.NTAccount]$Account).Translate([Security.Principal.SecurityIdentifier]).Value
    } catch { return $null }
}

function Get-StageDesktopRegisteredBinding($Spec) {
    try {
        # CIM can expose the principal as an ambiguous bare local name. The
        # registered XML retains its SID and is authoritative for this check.
        $raw = Export-ScheduledTask -TaskName $Spec.Name -TaskPath $Spec.Path -ErrorAction Stop
        $document = New-Object Xml.XmlDocument
        $document.XmlResolver = $null
        $document.LoadXml([string]$raw)
        $namespaces = New-Object Xml.XmlNamespaceManager($document.NameTable)
        $namespaces.AddNamespace('t', 'http://schemas.microsoft.com/windows/2004/02/mit/task')
        $principals = @($document.SelectNodes('/t:Task/t:Principals/t:Principal', $namespaces))
        $triggers = @($document.SelectNodes('/t:Task/t:Triggers/*', $namespaces))
        $logonTriggers = @($document.SelectNodes('/t:Task/t:Triggers/t:LogonTrigger', $namespaces))
        $actions = @($document.SelectNodes('/t:Task/t:Actions/*', $namespaces))
        $exec = @($document.SelectNodes('/t:Task/t:Actions/t:Exec', $namespaces))
        if ($principals.Count -ne 1 -or $triggers.Count -ne 1 -or $logonTriggers.Count -ne 1 -or $actions.Count -ne 1 -or $exec.Count -ne 1) { throw 'Ambiguous task binding.' }
        $principal = $principals[0]
        if ($principal.SelectSingleNode('t:GroupId', $namespaces)) { throw 'A group principal is not a current-user startup task.' }
        $principalSid = Resolve-StageDesktopAccountSid $principal.SelectSingleNode('t:UserId', $namespaces).InnerText
        $triggerSid = Resolve-StageDesktopAccountSid $logonTriggers[0].SelectSingleNode('t:UserId', $namespaces).InnerText
        if (-not $principalSid -or -not $triggerSid) { throw 'Unresolved task identity.' }
        return [pscustomobject]@{
            PrincipalSid = $principalSid
            TriggerSid = $triggerSid
            Execute = $exec[0].SelectSingleNode('t:Command', $namespaces).InnerText
            Arguments = $exec[0].SelectSingleNode('t:Arguments', $namespaces).InnerText
            WorkingDirectory = $exec[0].SelectSingleNode('t:WorkingDirectory', $namespaces).InnerText
            RunLevel = $principal.SelectSingleNode('t:RunLevel', $namespaces).InnerText
            LogonType = $principal.SelectSingleNode('t:LogonType', $namespaces).InnerText
        }
    } catch { throw 'The registered desktop task identity could not be verified. No scheduled task was changed.' }
}

function Assert-StageDesktopTaskOwned($Task, $Spec) {
    $actions = @($Task.Actions)
    if ($Task.Description -ne $Spec.Description -or $actions.Count -ne 1 -or
        $actions[0].Execute -ne $Spec.Execute -or $actions[0].Arguments -ne $Spec.Arguments -or
        $actions[0].WorkingDirectory -ne $Spec.WorkingDirectory) {
        throw 'The matching task does not belong to this project and user. No scheduled task was changed.'
    }
    $binding = Get-StageDesktopRegisteredBinding $Spec
    if ($binding.PrincipalSid -ne $Spec.UserId -or $binding.TriggerSid -ne $Spec.UserId -or
        $binding.Execute -ne $Spec.Execute -or $binding.Arguments -ne $Spec.Arguments -or
        $binding.WorkingDirectory -ne $Spec.WorkingDirectory) {
        throw 'The matching task does not belong to this project and user. No scheduled task was changed.'
    }
    return $binding
}

function Register-StageDesktopStartup {
    [CmdletBinding(SupportsShouldProcess = $true)]
    param()
    $spec = Get-StageDesktopTaskSpec
    $existing = Get-StageDesktopRegisteredTask $spec
    if ($existing) { $null = Assert-StageDesktopTaskOwned $existing $spec }
    if ($PSCmdlet.ShouldProcess($spec.Name, 'Register limited-rights startup for the current user at logon')) {
        $action = New-ScheduledTaskAction -Execute $spec.Execute -Argument $spec.Arguments -WorkingDirectory $spec.WorkingDirectory
        # The Windows constructor can shorten SID inputs to an unqualified local
        # principal. Keep the resolvable machine/domain-qualified account name in
        # both definitions; the stable task identity still uses its account SID.
        $trigger = New-ScheduledTaskTrigger -AtLogOn -User $spec.UserName
        $principal = New-ScheduledTaskPrincipal -UserId $spec.UserName -LogonType Interactive -RunLevel Limited
        $settings = New-ScheduledTaskSettingsSet -Hidden -StartWhenAvailable -MultipleInstances IgnoreNew -RestartCount 3 -RestartInterval (New-TimeSpan -Minutes 1) -ExecutionTimeLimit (New-TimeSpan -Minutes 10) -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries
        $definition = New-ScheduledTask -Action $action -Trigger $trigger -Principal $principal -Settings $settings -Description $spec.Description
        Register-ScheduledTask -TaskName $spec.Name -TaskPath $spec.Path -InputObject $definition -Force -ErrorAction Stop | Out-Null
        Write-Output ('Registered current-user desktop startup: ' + $spec.Name)
        Write-Output 'The task runs after this user signs in. It does not reboot Windows or automatically open a session.'
    }
}

function Unregister-StageDesktopStartup {
    [CmdletBinding(SupportsShouldProcess = $true)]
    param()
    $spec = Get-StageDesktopTaskSpec
    $existing = Get-StageDesktopRegisteredTask $spec
    if (-not $existing) { Write-Output 'No desktop startup task is registered for this project and user.'; return }
    $null = Assert-StageDesktopTaskOwned $existing $spec
    if ($PSCmdlet.ShouldProcess($spec.Name, 'Remove this project current-user logon task')) {
        Unregister-ScheduledTask -TaskName $spec.Name -TaskPath $spec.Path -Confirm:$false -ErrorAction Stop
        Write-Output ('Removed current-user desktop startup: ' + $spec.Name)
    }
}

function Get-StageDesktopUtcNow { return [DateTime]::UtcNow }
function Wait-StageDesktopRetry([int]$Seconds) { Start-Sleep -Seconds $Seconds }

function Get-StageDockerCliPath {
    $command = Get-Command docker.exe -ErrorAction SilentlyContinue
    if ($command) { return $command.Source }
    $standard = Join-Path $env:ProgramFiles 'Docker\Docker\resources\bin\docker.exe'
    if (Test-Path -LiteralPath $standard -PathType Leaf) { return $standard }
    throw 'Docker CLI was not found. Install Docker Desktop before enabling startup.'
}

function Get-StageDockerServerOs([string]$DockerPath) {
    $info = New-Object Diagnostics.ProcessStartInfo
    $info.FileName = $DockerPath
    $info.Arguments = 'info --format "{{.OSType}}"'
    $info.UseShellExecute = $false
    $info.CreateNoWindow = $true
    $info.RedirectStandardOutput = $true
    $info.RedirectStandardError = $true
    $process = New-Object Diagnostics.Process
    $process.StartInfo = $info
    try {
        if (-not $process.Start()) { return $null }
        $stdout = $process.StandardOutput.ReadToEndAsync()
        $stderr = $process.StandardError.ReadToEndAsync()
        if (-not $process.WaitForExit(5000)) {
            try { $process.Kill(); $process.WaitForExit() } catch {}
            return $null
        }
        $output = $stdout.GetAwaiter().GetResult().Trim()
        $null = $stderr.GetAwaiter().GetResult()
        if ($process.ExitCode -eq 0) { return $output }
        return $null
    } finally { $process.Dispose() }
}

function Test-StageDockerDesktopRunning {
    return [bool](Get-Process -Name 'Docker Desktop' -ErrorAction SilentlyContinue)
}

function Start-StageDockerDesktop {
    $candidates = @((Join-Path $env:ProgramFiles 'Docker\Docker\Docker Desktop.exe'))
    if ($env:LOCALAPPDATA) { $candidates += Join-Path $env:LOCALAPPDATA 'Programs\DockerDesktop\Docker Desktop.exe' }
    $executable = $candidates | Where-Object { Test-Path -LiteralPath $_ -PathType Leaf } | Select-Object -First 1
    if (-not $executable) { throw 'Docker Desktop was not found at a supported installation path.' }
    Start-Process -FilePath $executable -WindowStyle Hidden | Out-Null
}

function Invoke-StageDesktopLocalStart {
    & (Join-Path $StageRoot 'scripts\Start-Local.ps1') -NoBrowser | Out-Null
}

function Write-StageDesktopStatus([string]$Status, [string]$Step, [string]$Message, [DateTime]$StartedAt) {
    $logs = Join-Path $StageRoot 'logs'
    $now = Get-StageDesktopUtcNow
    $record = [ordered]@{ status = $Status; step = $Step; message = $Message; pid = $PID; startedAtUTC = $StartedAt.ToString('o'); updatedAtUTC = $now.ToString('o') }
    $statusPath = Join-Path $logs 'desktop-startup.json'
    $temporary = $statusPath + '.new'
    $record | ConvertTo-Json | Set-Content -LiteralPath $temporary -Encoding UTF8
    Move-Item -LiteralPath $temporary -Destination $statusPath -Force
    $logPath = Join-Path $logs 'desktop-startup.log'
    $line = $now.ToString('o') + ' ' + $Status + ' ' + $Step + ': ' + $Message
    $lineBytes = [Text.Encoding]::UTF8.GetByteCount($line + [Environment]::NewLine) + 3
    if ((Test-Path -LiteralPath $logPath) -and ((Get-Item -LiteralPath $logPath).Length + $lineBytes) -gt 262144) {
        if (Test-Path -LiteralPath ($logPath + '.1')) { Move-Item -LiteralPath ($logPath + '.1') -Destination ($logPath + '.2') -Force }
        Move-Item -LiteralPath $logPath -Destination ($logPath + '.1') -Force
    }
    Add-Content -LiteralPath $logPath -Value $line -Encoding UTF8
}

function Invoke-StageDesktopStartup {
    [CmdletBinding()]
    param([ValidateRange(1,600)][int]$DockerTimeoutSeconds = 180, [ValidateRange(1,30)][int]$PollSeconds = 3)
    $logs = Join-Path $StageRoot 'logs'
    New-Item -ItemType Directory -Path $logs -Force | Out-Null
    $lockPath = Join-Path $logs 'desktop-startup.lock'
    $lock = $null
    try { $lock = [IO.File]::Open($lockPath, [IO.FileMode]::OpenOrCreate, [IO.FileAccess]::ReadWrite, [IO.FileShare]::None) }
    catch {
        $cause = $_.Exception.GetBaseException()
        if ($cause -is [IO.IOException] -and (($cause.HResult -band 65535) -in @(32,33))) { Write-Output 'Desktop startup is already running for this project.'; return }
        throw 'The desktop startup lock could not be acquired. No service was started.'
    }
    $started = Get-StageDesktopUtcNow
    $step = 'docker'
    try {
        Write-StageDesktopStatus 'starting' $step 'Checking the local Linux Docker engine.' $started
        $docker = Get-StageDockerCliPath
        $deadline = $started.AddSeconds($DockerTimeoutSeconds)
        $desktopChecked = $false
        while ($true) {
            $serverOs = Get-StageDockerServerOs $docker
            if ($serverOs -eq 'linux') { break }
            if ($serverOs) { throw 'Docker is using Windows containers. Select the Linux engine before starting Private Stage.' }
            if (-not $desktopChecked) {
                $desktopChecked = $true
                if (-not (Test-StageDockerDesktopRunning)) {
                    Write-StageDesktopStatus 'starting' $step 'Starting Docker Desktop for the current user.' $started
                    Start-StageDockerDesktop
                }
            }
            $remaining = ($deadline - (Get-StageDesktopUtcNow)).TotalSeconds
            if ($remaining -le 0) { throw 'The Linux Docker engine did not become ready before the startup deadline.' }
            Wait-StageDesktopRetry ([int][Math]::Min($PollSeconds, [Math]::Ceiling($remaining)))
        }
        $step = 'app'
        Write-StageDesktopStatus 'starting' $step 'Starting or reusing the existing local supervisor.' $started
        Invoke-StageDesktopLocalStart
        Write-StageDesktopStatus 'ready' 'complete' 'Local app startup completed; room admission remains under the existing application policy.' $started
        Write-Output 'Desktop recovery startup completed. No session was opened automatically.'
    } catch {
        # Only controlled status text is written; provider responses and configuration stay private.
        Write-StageDesktopStatus 'failed' $step 'Startup failed. Retry after checking Docker and the local application logs.' $started
        throw
    } finally { if ($lock) { $lock.Dispose() } }
}

function Get-StageDesktopStartupStatus {
    $spec = Get-StageDesktopTaskSpec
    $task = Get-StageDesktopRegisteredTask $spec
    $result = [ordered]@{ taskName = $spec.Name; registered = [bool]$task }
    if ($task) {
        $binding = Assert-StageDesktopTaskOwned $task $spec
        $info = Get-ScheduledTaskInfo -TaskName $spec.Name -TaskPath $spec.Path -ErrorAction Stop
        $result.taskState = [string]$task.State
        $runLevel = $binding.RunLevel
        if ([string]::IsNullOrWhiteSpace($runLevel)) { $runLevel = [string]$task.Principal.RunLevel }
        $result.runLevel = if ($runLevel -in @('0','Limited','LeastPrivilege')) { 'Limited' } elseif ($runLevel -in @('1','Highest','HighestAvailable')) { 'Highest' } else { 'Unknown' }
        $result.logonType = if ($binding.LogonType -eq 'InteractiveToken') { 'Interactive' } else { $binding.LogonType }
        $result.currentUserOnly = $binding.PrincipalSid -eq $spec.UserId -and $binding.TriggerSid -eq $spec.UserId
        $result.lastTaskResult = $info.LastTaskResult
        $result.lastRunTimeUTC = if ($info.LastTaskResult -eq 267011) { $null } else { $info.LastRunTime.ToUniversalTime().ToString('o') }
    }
    $statusPath = Join-Path $StageRoot 'logs\desktop-startup.json'
    if (Test-Path -LiteralPath $statusPath) { $result.lastAttempt = Get-Content -LiteralPath $statusPath -Raw | ConvertFrom-Json }
    return [pscustomobject]$result
}
