$ErrorActionPreference = 'Stop'
$script:StageRoot = [System.IO.Path]::GetFullPath((Split-Path -Parent $PSScriptRoot))
function Get-StageSettings {
    $settings = @{}
    $envPath = Join-Path $script:StageRoot '.env'
    if (Test-Path -LiteralPath $envPath) {
        foreach ($line in Get-Content -LiteralPath $envPath) {
            if ($line -match '^([A-Z_]+)=(.*)$') { $settings[$matches[1]] = $matches[2].Trim() }
        }
    }
    return $settings
}
function Get-StageDataPath {
    $settings = Get-StageSettings
    $configured = if ($settings.DATA_DIR) { $settings.DATA_DIR } else { './data' }
    $resolved = [System.IO.Path]::GetFullPath((Join-Path $script:StageRoot $configured))
    $prefix = $script:StageRoot.TrimEnd('\') + '\'
    if (-not $resolved.StartsWith($prefix, [StringComparison]::OrdinalIgnoreCase)) { throw 'Local scripts require DATA_DIR within this project folder. Use your deployment supervisor for external data volumes.' }
    $backupRoot = [System.IO.Path]::GetFullPath((Join-Path $script:StageRoot 'backups'))
    if ($resolved.Equals($backupRoot, [StringComparison]::OrdinalIgnoreCase) -or $resolved.StartsWith($backupRoot + '\', [StringComparison]::OrdinalIgnoreCase)) { throw 'DATA_DIR must not be inside the backup directory.' }
    return $resolved
}
function Assert-StageStopped {
    $desktopStartupLock = Join-Path $script:StageRoot 'logs\desktop-startup.lock'
    if (Test-Path -LiteralPath $desktopStartupLock) {
        $desktopStartupProbe = $null
        try { $desktopStartupProbe = [IO.File]::Open($desktopStartupLock, [IO.FileMode]::Open, [IO.FileAccess]::ReadWrite, [IO.FileShare]::None) }
        catch { throw 'Desktop startup is active or its lock cannot be verified. Pause desktop startup and wait for it to finish before backup or restore.' }
        finally { if ($desktopStartupProbe) { $desktopStartupProbe.Dispose() } }
    }
    $settings = Get-StageSettings
    $supervisorLock = Join-Path (Get-StageDataPath) 'supervisor.lock'
    if (Test-Path -LiteralPath $supervisorLock) {
        try { $supervisor = Get-Content -LiteralPath $supervisorLock -Raw | ConvertFrom-Json; $supervisorProcessId = [int]$supervisor.pid }
        catch { throw 'The supervisor lock is unreadable; cannot verify the database is stopped.' }
        if ($supervisorProcessId -le 0) { throw 'The supervisor lock has an invalid process ID.' }
        if (Get-Process -Id $supervisorProcessId -ErrorAction SilentlyContinue) { throw 'The local supervisor is still running, possibly between app restarts. Stop it before backup or restore.' }
    }
    $lockPath = Join-Path (Get-StageDataPath) 'app.lock'
    if (Test-Path -LiteralPath $lockPath) {
        try { $lock = Get-Content -LiteralPath $lockPath -Raw | ConvertFrom-Json; $lockPid = [int]$lock.pid }
        catch { throw 'The app lock is unreadable; cannot verify the database is stopped.' }
        if ($lockPid -le 0) { throw 'The app lock has an invalid process ID.' }
        if (Get-Process -Id $lockPid -ErrorAction SilentlyContinue) { throw 'The app lock belongs to a running process. Stop it before backup or restore.' }
    }
    $pidPath = Join-Path (Get-StageDataPath) 'app.pid'
    if (Test-Path -LiteralPath $pidPath) {
        $recordedId = 0
        if ([int]::TryParse((Get-Content -LiteralPath $pidPath -Raw).Trim(), [ref]$recordedId)) {
            if (Get-Process -Id $recordedId -ErrorAction SilentlyContinue) { throw 'The recorded app process is still running. Stop it before backup or restore.' }
        }
    }
    $port = if ($settings.PORT) { [int]$settings.PORT } else { 3210 }
    try { $listeners = [System.Net.NetworkInformation.IPGlobalProperties]::GetIPGlobalProperties().GetActiveTcpListeners() }
    catch { throw 'Cannot verify whether the app is stopped. Backup/restore was refused.' }
    if ($listeners | Where-Object Port -eq $port) { throw "Port $port is still listening. Verify the app is stopped before backup or restore." }
    $baseUrl = if ($settings.APP_URL) { $settings.APP_URL } else { 'http://localhost:3210' }
    try { $response = Invoke-RestMethod -Uri "$baseUrl/healthz" -TimeoutSec 2 }
    catch { return }
    if ($response.service -eq 'private-stage') { throw 'Stop Private Stage before backing up or restoring its database.' }
}
function Get-StageHealth([string]$BaseUrl) {
    # Preserve curl's localhost/dual-stack behavior. WinPS can turn a native
    # stderr redirect into a terminating error, while its HTTP client can spend
    # the entire health timeout waiting on IPv6 before trying the IPv4 listener.
    # Capture the owned probe's streams directly and treat a cold port as normal.
    $process = $null
    try {
        $target = [Uri]($BaseUrl.TrimEnd('/') + '/healthz')
        if (-not $target.IsAbsoluteUri -or $target.Scheme -notin @('http','https')) { return $null }
        $curl = Get-Command curl.exe -ErrorAction Stop
        $info = New-Object Diagnostics.ProcessStartInfo
        $info.FileName = $curl.Source
        $info.Arguments = '-sS --max-time 2 -- "' + $target.AbsoluteUri + '"'
        $info.UseShellExecute = $false
        $info.CreateNoWindow = $true
        $info.RedirectStandardOutput = $true
        $info.RedirectStandardError = $true
        $process = New-Object Diagnostics.Process
        $process.StartInfo = $info
        if (-not $process.Start()) { return $null }
        $stdout = $process.StandardOutput.ReadToEndAsync()
        $stderr = $process.StandardError.ReadToEndAsync()
        if (-not $process.WaitForExit(3000)) {
            try { $process.Kill(); $null = $process.WaitForExit(500) } catch {}
            return $null
        }
        $raw = $stdout.GetAwaiter().GetResult()
        $null = $stderr.GetAwaiter().GetResult()
        if ($process.ExitCode -ne 0) { return $null }
        return $raw | ConvertFrom-Json
    } catch { return $null }
    finally { if ($process) { $process.Dispose() } }
}
