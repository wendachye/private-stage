. "$PSScriptRoot\Common.ps1"
$shutdownFailed = $false
$supervisorPath = Join-Path (Get-StageDataPath) 'supervisor.json'
$supervisorLockPath = Join-Path (Get-StageDataPath) 'supervisor.lock'
if (Test-Path -LiteralPath $supervisorLockPath) {
    try { $activeSupervisorLock = Get-Content -LiteralPath $supervisorLockPath -Raw | ConvertFrom-Json; $lockProcessId = [int]$activeSupervisorLock.pid }
    catch { throw 'The supervisor lock is unreadable. No process was stopped.' }
    if ($lockProcessId -le 0) { throw 'The supervisor lock is invalid. No process was stopped.' }
    if ((Get-Process -Id $lockProcessId -ErrorAction SilentlyContinue) -and -not (Test-Path -LiteralPath $supervisorPath)) { throw 'A supervisor is active but its ownership record is missing. No process was stopped.' }
}
if (Test-Path -LiteralPath $supervisorPath) {
    try { $supervisor = Get-Content -LiteralPath $supervisorPath -Raw | ConvertFrom-Json; $supervisorProcessId = [int]$supervisor.pid }
    catch { throw 'The supervisor record is unreadable. No processes were stopped.' }
    if ($supervisorProcessId -le 0 -or -not $supervisor.token) { throw 'The supervisor record is invalid. No processes were stopped.' }
    if ($activeSupervisorLock -and (Get-Process -Id ([int]$activeSupervisorLock.pid) -ErrorAction SilentlyContinue) -and ($activeSupervisorLock.pid -ne $supervisorProcessId -or $activeSupervisorLock.token -ne $supervisor.token)) { throw 'Active supervisor ownership does not match its record. No process was stopped.' }
    $runningSupervisor = Get-CimInstance Win32_Process -Filter "ProcessId=$supervisorProcessId" -ErrorAction Stop
    if ($runningSupervisor) {
        $supervisorEntry = Join-Path $StageRoot 'scripts\Run-Local.mjs'
        if (-not $runningSupervisor.CommandLine -or -not $runningSupervisor.CommandLine.Contains($supervisorEntry)) { throw 'The saved supervisor PID belongs to another process. No process was stopped.' }
        $lockPath = Join-Path (Get-StageDataPath) 'supervisor.lock'
        $supervisorLock = Get-Content -LiteralPath $lockPath -Raw | ConvertFrom-Json
        if ($supervisorLock.pid -ne $supervisorProcessId -or $supervisorLock.token -ne $supervisor.token) { throw 'Supervisor ownership changed. No stop request was sent.' }
        @{ token=$supervisor.token } | ConvertTo-Json | Set-Content -LiteralPath (Join-Path (Get-StageDataPath) 'supervisor.stop')
        $deadline = [DateTime]::UtcNow.AddSeconds(20)
        while ((Get-Process -Id $supervisorProcessId -ErrorAction SilentlyContinue) -and [DateTime]::UtcNow -lt $deadline) { Start-Sleep -Milliseconds 200 }
        if (Get-Process -Id $supervisorProcessId -ErrorAction SilentlyContinue) { throw 'The supervisor did not stop in time. Inspect logs before retrying; no unrelated process was killed.' }
        $finalSupervisor = Get-Content -LiteralPath $supervisorPath -Raw | ConvertFrom-Json
        $shutdownFailed = $finalSupervisor.token -eq $supervisor.token -and $finalSupervisor.status -eq 'failed'
    }
}
$pidPath = Join-Path (Get-StageDataPath) 'app.pid'
if (Test-Path -LiteralPath $pidPath) {
    $stageProcessId = [int](Get-Content -LiteralPath $pidPath -Raw).Trim()
    $runningProcess = Get-CimInstance Win32_Process -Filter "ProcessId=$stageProcessId" -ErrorAction Stop
    if ($runningProcess) {
        $entryPath = Join-Path $StageRoot 'backend\src\index.ts'
        if (-not $runningProcess.CommandLine -or -not $runningProcess.CommandLine.Contains($entryPath)) { throw 'The saved PID belongs to another process. No process was stopped.' }
        Stop-Process -Id $stageProcessId -ErrorAction Stop
    }
}
& docker compose -f (Join-Path $StageRoot 'deploy\compose.local.yml') stop livekit
if ($LASTEXITCODE -ne 0) { throw 'The local media service could not be stopped.' }
if ($shutdownFailed) { throw 'App and media are stopped, but application shutdown reported an error or timeout. Inspect logs\app.error.log before restarting.' }
Write-Output 'Local app/media stopped. The next app startup closes any prior session and reconciles media before admission.'
Write-Output 'If you started npm run dev in a terminal instead, stop that terminal process with Ctrl+C.'
