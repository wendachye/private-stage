param([switch]$NoBrowser)
. "$PSScriptRoot\Common.ps1"
Push-Location -LiteralPath $StageRoot
try {
    if (-not (Test-Path -LiteralPath (Join-Path $StageRoot 'node_modules'))) {
        & npm.cmd ci
        if ($LASTEXITCODE -ne 0) { throw 'npm ci failed.' }
    }
    & npm.cmd run setup
    if ($LASTEXITCODE -ne 0) { throw 'Local setup failed.' }
    & docker compose -f (Join-Path $StageRoot 'deploy\compose.local.yml') up -d livekit
    if ($LASTEXITCODE -ne 0) { throw 'Start Docker Desktop, then retry this script.' }
    $settings = Get-StageSettings
    $baseUrl = if ($settings.APP_URL) { $settings.APP_URL } else { 'http://localhost:3210' }
    $running = $false
    $health = Get-StageHealth $baseUrl
    $running = $health.service -eq 'private-stage'
    if (-not $running) {
        $port = if ($settings.PORT) { [int]$settings.PORT } else { 3210 }
        $listeners = [System.Net.NetworkInformation.IPGlobalProperties]::GetIPGlobalProperties().GetActiveTcpListeners()
        if ($listeners | Where-Object Port -eq $port) { throw "Port $port is already in use. No second app process was started." }
        $nodePath = (Get-Command node.exe).Source
        $supervisorLock = Join-Path (Get-StageDataPath) 'supervisor.lock'
        if (Test-Path -LiteralPath $supervisorLock) {
            try { $owner = Get-Content -LiteralPath $supervisorLock -Raw | ConvertFrom-Json }
            catch { throw 'The supervisor lock is unreadable. Inspect it before starting another process.' }
            if (Get-Process -Id ([int]$owner.pid) -ErrorAction SilentlyContinue) { throw 'A local supervisor is already running or restarting the app. Inspect logs\app.error.log before retrying.' }
        }
        $entryPath = Join-Path $StageRoot 'scripts\Run-Local.mjs'
        $process = Start-Process -FilePath $nodePath -ArgumentList @('"' + $entryPath + '"') -WorkingDirectory $StageRoot -WindowStyle Hidden -RedirectStandardError (Join-Path $StageRoot 'logs\supervisor-startup.error.log') -PassThru
        $ready = $false
        for ($attempt=0; $attempt -lt 30; $attempt++) {
            Start-Sleep -Seconds 1
            if ($process.HasExited) { throw 'The app supervisor stopped during startup. Check logs\app.error.log and logs\supervisor-startup.error.log.' }
            $health = Get-StageHealth $baseUrl
            if ($health.service -eq 'private-stage') { $ready=$true; break }
        }
        if (-not $ready) { throw 'Startup is taking longer than expected. Check the newest logs before retrying.' }
    }
    Write-Output "Private Stage is running at $baseUrl"
    Write-Output 'Supervised launches keep bounded logs in logs\app.log and logs\app.error.log; a crash restart always returns to a closed room.'
    Write-Output 'Local preview uses fictional users. Public access and real Discord membership are configured separately.'
    if (-not $NoBrowser) { Start-Process $baseUrl }
} finally { Pop-Location }
