import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const project = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const windowsTest = process.platform === 'win32' ? test : test.skip;
const ps = (value: string) => `'${value.replaceAll("'", "''")}'`;
const readJson = (path: string) => JSON.parse(readFileSync(path, 'utf8').replace(/^\uFEFF/, ''));

function fixture() {
  const base = join(project, 'work', 'desktop-startup-fixtures');
  mkdirSync(base, { recursive: true });
  const root = mkdtempSync(join(base, 'fixture-'));
  mkdirSync(join(root, 'scripts'));
  for (const name of ['Common.ps1', 'Desktop-Startup.Common.ps1', 'Start-Desktop.ps1']) copyFileSync(join(project, 'scripts', name), join(root, 'scripts', name));
  return root;
}

function run(root: string, body: string) {
  const runner = join(root, 'runner.ps1');
  writeFileSync(runner, `$ErrorActionPreference='Stop'\n. ${ps(join(root, 'scripts', 'Desktop-Startup.Common.ps1'))}\n${body}\n`);
  return new Promise<{ code: number | null; output: string }>((resolveResult, reject) => {
    const child = spawn('powershell.exe', ['-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', runner], { cwd: root, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    let output = '';
    child.stdout.on('data', value => output += String(value)); child.stderr.on('data', value => output += String(value));
    const timeout = setTimeout(() => { child.kill(); reject(new Error('Isolated desktop startup timeout.')); }, 15000);
    child.once('error', error => { clearTimeout(timeout); reject(error); });
    child.once('close', code => { clearTimeout(timeout); resolveResult({ code, output }); });
  });
}

const clock = `
$script:clock = 0
function Get-StageDesktopUtcNow { return ([DateTime]::Parse('2030-01-01T00:00:00Z').ToUniversalTime()).AddSeconds($script:clock) }
function Wait-StageDesktopRetry([int]$Seconds) { $script:clock += $Seconds }
function Get-StageDockerCliPath { return 'fixture-docker' }
function Invoke-StageDesktopLocalStart { Add-Content -LiteralPath (Join-Path $StageRoot 'app-started.txt') -Value 'start' }
function Start-StageDockerDesktop { Add-Content -LiteralPath (Join-Path $StageRoot 'docker-started.txt') -Value 'start' }
`;

windowsTest('desktop startup reuses a ready Linux engine and invokes the existing no-browser local launcher once', async () => {
  const root = fixture();
  const result = await run(root, clock + `
function Get-StageDockerServerOs { return 'linux' }
function Test-StageDockerDesktopRunning { throw 'Ready engine must not launch or inspect the desktop app.' }
Invoke-StageDesktopStartup -DockerTimeoutSeconds 2 -PollSeconds 1
`);
  assert.equal(result.code, 0, result.output);
  assert.equal(readFileSync(join(root, 'app-started.txt'), 'utf8').trim(), 'start');
  assert.equal(existsSync(join(root, 'docker-started.txt')), false);
  assert.equal(readJson(join(root, 'logs', 'desktop-startup.json')).status, 'ready');
  assert.doesNotMatch(readFileSync(join(root, 'logs', 'desktop-startup.log'), 'utf8'), /token|secret|password/i);
});

windowsTest('desktop startup launches Docker once, waits for Linux readiness, and then starts the app', async () => {
  const root = fixture();
  const result = await run(root, clock + `
$script:probes = 0
function Get-StageDockerServerOs { $script:probes++; if ($script:probes -gt 2) { return 'linux' }; return $null }
function Test-StageDockerDesktopRunning { return $false }
Invoke-StageDesktopStartup -DockerTimeoutSeconds 5 -PollSeconds 1
`);
  assert.equal(result.code, 0, result.output);
  assert.equal(readFileSync(join(root, 'docker-started.txt'), 'utf8').trim(), 'start');
  assert.equal(readFileSync(join(root, 'app-started.txt'), 'utf8').trim(), 'start');
  assert.equal(readJson(join(root, 'logs', 'desktop-startup.json')).status, 'ready');
});

windowsTest('desktop startup times out without launching the app and preserves a retryable failure record', async () => {
  const root = fixture();
  const result = await run(root, clock + `
function Get-StageDockerServerOs { return $null }
function Test-StageDockerDesktopRunning { return $false }
Invoke-StageDesktopStartup -DockerTimeoutSeconds 2 -PollSeconds 1
`);
  assert.notEqual(result.code, 0, result.output);
  assert.match(result.output, /startup deadline/);
  assert.equal(existsSync(join(root, 'app-started.txt')), false);
  assert.equal(readFileSync(join(root, 'docker-started.txt'), 'utf8').trim(), 'start');
  assert.equal(readJson(join(root, 'logs', 'desktop-startup.json')).status, 'failed');
  // A failed attempt must release its file lock for the next scheduled retry.
  const retried = await run(root, clock + `function Get-StageDockerServerOs { return 'linux' }; Invoke-StageDesktopStartup -DockerTimeoutSeconds 2 -PollSeconds 1`);
  assert.equal(retried.code, 0, retried.output);
  assert.equal(readJson(join(root, 'logs', 'desktop-startup.json')).status, 'ready');
});

windowsTest('desktop startup does not relaunch a booting desktop and refuses the Windows container engine', async () => {
  for (const serverOs of ['linux', 'windows']) {
    const root = fixture();
    const result = await run(root, clock + `
$script:probes = 0
function Get-StageDockerServerOs { $script:probes++; if ($script:probes -gt 1) { return '${serverOs}' }; return $null }
function Test-StageDockerDesktopRunning { return $true }
Invoke-StageDesktopStartup -DockerTimeoutSeconds 3 -PollSeconds 1
`);
    assert.equal(result.code, serverOs === 'linux' ? 0 : 1, result.output);
    assert.equal(existsSync(join(root, 'docker-started.txt')), false);
    assert.equal(existsSync(join(root, 'app-started.txt')), serverOs === 'linux');
    if (serverOs === 'windows') assert.match(result.output, /Windows containers/);
  }
});

windowsTest('desktop startup ignores an overlapping owned launch but rejects an unusable lock path', async () => {
  for (const locked of [true, false]) {
    const root = fixture();
    const result = await run(root, clock + `
New-Item -ItemType Directory -Path (Join-Path $StageRoot 'logs') -Force | Out-Null
$path = Join-Path $StageRoot 'logs/desktop-startup.lock'
${locked ? "$held = [IO.File]::Open($path,[IO.FileMode]::OpenOrCreate,[IO.FileAccess]::ReadWrite,[IO.FileShare]::None)" : 'New-Item -ItemType Directory -Path $path | Out-Null'}
try { Invoke-StageDesktopStartup -DockerTimeoutSeconds 1 -PollSeconds 1 }
finally { ${locked ? '$held.Dispose()' : ''} }
`);
    assert.equal(result.code, locked ? 0 : 1, result.output);
    assert.match(result.output, locked ? /already running/ : /lock could not be acquired/);
    assert.equal(existsSync(join(root, 'app-started.txt')), false);
    assert.equal(existsSync(join(root, 'docker-started.txt')), false);
  }
});

windowsTest('desktop startup rotates controlled status logs before the byte bound is exceeded', async () => {
  const root = fixture();
  mkdirSync(join(root, 'logs'));
  writeFileSync(join(root, 'logs', 'desktop-startup.log'), 'x'.repeat(262130));
  writeFileSync(join(root, 'logs', 'desktop-startup.log.1'), 'previous rotation');
  const result = await run(root, clock + `function Get-StageDockerServerOs { return 'linux' }; Invoke-StageDesktopStartup -DockerTimeoutSeconds 1 -PollSeconds 1`);
  assert.equal(result.code, 0, result.output);
  assert.equal(readFileSync(join(root, 'logs', 'desktop-startup.log.2'), 'utf8'), 'previous rotation');
  assert.equal(readFileSync(join(root, 'logs', 'desktop-startup.log.1'), 'utf8').length, 262130);
  assert.ok(readFileSync(join(root, 'logs', 'desktop-startup.log')).byteLength <= 262144);
});

const identity = `function Get-StageDesktopIdentity { return @{ Sid='S-1-5-21-100-200-300-1001'; Name='Fixture\\member' } }`;
const taskMocks = `
function Get-ScheduledTask { param($TaskPath,$ErrorAction); return @() }
function New-ScheduledTaskAction { param($Execute,$Argument,$WorkingDirectory); return @{ Execute=$Execute; Arguments=$Argument; WorkingDirectory=$WorkingDirectory } }
function New-ScheduledTaskTrigger { param([switch]$AtLogOn,$User); return @{ AtLogOn=[bool]$AtLogOn; UserId=$User } }
function New-ScheduledTaskPrincipal { param($UserId,$LogonType,$RunLevel); return @{ UserId=$UserId; LogonType=$LogonType; RunLevel=$RunLevel } }
function New-ScheduledTaskSettingsSet { param([switch]$Hidden,[switch]$StartWhenAvailable,$MultipleInstances,$RestartCount,$RestartInterval,$ExecutionTimeLimit,[switch]$AllowStartIfOnBatteries,[switch]$DontStopIfGoingOnBatteries); return @{ Hidden=[bool]$Hidden; MultipleInstances=$MultipleInstances; RestartCount=$RestartCount; RestartIntervalSeconds=$RestartInterval.TotalSeconds; ExecutionTimeLimitSeconds=$ExecutionTimeLimit.TotalSeconds } }
function New-ScheduledTask { param($Action,$Trigger,$Principal,$Settings,$Description); return @{ Actions=@($Action); Triggers=@($Trigger); Principal=$Principal; Settings=$Settings; Description=$Description } }
function Register-ScheduledTask { param($TaskName,$TaskPath,$InputObject,[switch]$Force,$ErrorAction); @{ Name=$TaskName; Path=$TaskPath; Definition=$InputObject } | ConvertTo-Json -Depth 10 | Set-Content -LiteralPath (Join-Path $StageRoot 'registered.json') }
`;

windowsTest('desktop health checks tolerate a cold port and recognize IPv4 and localhost health in Windows PowerShell', async () => {
  const root = fixture();
  const live = createServer((_request, response) => { response.writeHead(200, { 'content-type': 'application/json' }); response.end(JSON.stringify({ service: 'private-stage', fixture: true })); });
  const closed = createServer();
  await new Promise<void>((ready, reject) => { live.once('error', reject); live.listen(0, '127.0.0.1', ready); });
  await new Promise<void>((ready, reject) => { closed.once('error', reject); closed.listen(0, '127.0.0.1', ready); });
  const liveAddress = live.address(), closedAddress = closed.address();
  assert.ok(liveAddress && typeof liveAddress !== 'string');
  assert.ok(closedAddress && typeof closedAddress !== 'string');
  await new Promise<void>((ready, reject) => closed.close(error => error ? reject(error) : ready()));
  try {
    const result = await run(root, `
$live = Get-StageHealth 'http://127.0.0.1:${liveAddress.port}'
if ($live.service -ne 'private-stage') { throw 'The fixture health response must be recognized.' }
$local = Get-StageHealth 'http://localhost:${liveAddress.port}'
if ($local.service -ne 'private-stage') { throw 'The localhost health response must be recognized without waiting past the health timeout.' }
$cold = Get-StageHealth 'http://127.0.0.1:${closedAddress.port}'
if ($null -ne $cold) { throw 'A cold endpoint must return null.' }
Write-Output 'Live and cold health probes passed.'
`);
    assert.equal(result.code, 0, result.output);
    assert.match(result.output, /Live and cold health probes passed/);
  } finally { await new Promise<void>((ready, reject) => live.close(error => error ? reject(error) : ready())); }
});

windowsTest('Windows maintenance refuses an active desktop startup handle but permits its inactive lock file', async () => {
  const probe = createServer();
  await new Promise<void>((ready, reject) => { probe.once('error', reject); probe.listen(0, '127.0.0.1', ready); });
  const address = probe.address(); assert.ok(address && typeof address !== 'string');
  await new Promise<void>((ready, reject) => probe.close(error => error ? reject(error) : ready()));
  for (const active of [true, false]) {
    const root = fixture();
    mkdirSync(join(root, 'logs')); mkdirSync(join(root, 'data'));
    writeFileSync(join(root, '.env'), `PORT=${address.port}\nAPP_URL=http://127.0.0.1:${address.port}\nDATA_DIR=./data\n`);
    writeFileSync(join(root, 'logs', 'desktop-startup.lock'), '');
    const result = await run(root, `
${active ? "$held = [IO.File]::Open((Join-Path $StageRoot 'logs/desktop-startup.lock'),[IO.FileMode]::Open,[IO.FileAccess]::ReadWrite,[IO.FileShare]::None)" : ''}
try { Assert-StageStopped; Write-Output 'Maintenance guards passed.' }
finally { ${active ? '$held.Dispose()' : ''} }
`);
    if (active) {
      assert.notEqual(result.code, 0, result.output);
      assert.match(result.output, /Desktop startup is active or its lock cannot be verified/);
    } else {
      assert.equal(result.code, 0, result.output);
      assert.match(result.output, /Maintenance guards passed/);
    }
  }
});

windowsTest('desktop registration is current-user interactive and limited, with hidden stable PowerShell launch and bounded retries', async () => {
  const root = fixture();
  const result = await run(root, identity + taskMocks + '\nRegister-StageDesktopStartup -Confirm:$false');
  assert.equal(result.code, 0, result.output);
  const registration = readJson(join(root, 'registered.json'));
  assert.match(registration.Name, /^PrivateStage-Desktop-[0-9a-f]{16}$/);
  const definition = registration.Definition;
  assert.equal(definition.Principal.RunLevel, 'Limited');
  assert.equal(definition.Principal.LogonType, 'Interactive');
  assert.equal(definition.Triggers[0].UserId, definition.Principal.UserId);
  assert.equal(definition.Settings.MultipleInstances, 'IgnoreNew');
  assert.equal(definition.Settings.Hidden, true);
  assert.equal(definition.Settings.RestartCount, 3);
  assert.equal(definition.Settings.ExecutionTimeLimitSeconds, 600);
  assert.match(definition.Actions[0].Execute, /WindowsPowerShell\\v1\.0\\powershell\.exe$/);
  assert.match(definition.Actions[0].Arguments, /-WindowStyle Hidden -ExecutionPolicy RemoteSigned -File "/);
  assert.equal(definition.Actions[0].WorkingDirectory, root);
  assert.doesNotMatch(JSON.stringify(registration), /password|credential|highest/i);
});

windowsTest('desktop registration preserves a qualified account when the scheduler principal constructor shortens SID inputs', async () => {
  const root = fixture();
  const result = await run(root, identity + taskMocks + `
function New-ScheduledTaskPrincipal {
  param($UserId,$LogonType,$RunLevel)
  # The installed Windows cmdlet normalizes an SID input to an unqualified local
  # account; qualified name input retains its machine/domain qualification.
  $normalized = if ($UserId -match '^S-') { 'member' } else { $UserId }
  return @{ UserId=$normalized; LogonType=$LogonType; RunLevel=$RunLevel }
}
function Register-ScheduledTask {
  param($TaskName,$TaskPath,$InputObject,[switch]$Force,$ErrorAction)
  $account = (Get-StageDesktopIdentity).Name
  if ($InputObject.Principal.UserId -ne $account -or $InputObject.Triggers[0].UserId -ne $account) { throw 'Unqualified UserId cannot be used for this desktop registration.' }
  @{ Name=$TaskName; Definition=$InputObject } | ConvertTo-Json -Depth 10 | Set-Content -LiteralPath (Join-Path $StageRoot 'registered.json')
}
Register-StageDesktopStartup -Confirm:$false
`);
  assert.equal(result.code, 0, result.output);
  const definition = readJson(join(root, 'registered.json')).Definition;
  assert.equal(definition.Principal.UserId, definition.Triggers[0].UserId);
  assert.equal(definition.Principal.RunLevel, 'Limited');
});

windowsTest('desktop ownership resolves stored account aliases by SID and reports the actual logon trigger binding', async () => {
  for (const variant of ['same-account', 'same-account-default-runlevel', 'foreign-principal', 'foreign-trigger']) {
    const root = fixture();
    const result = await run(root, identity + `
$script:spec = Get-StageDesktopTaskSpec
function Resolve-StageDesktopAccountSid([string]$Account) {
  if ($Account -match '^S-') { return $Account }
  if ($Account -in @('member','Fixture\\member')) { return 'S-1-5-21-100-200-300-1001' }
  return 'S-1-5-21-100-200-300-9999'
}
$script:storedTask = [pscustomobject]@{
  TaskName=$script:spec.Name; Description=$script:spec.Description; State='Ready'
  Principal=@{ UserId='${variant === 'foreign-principal' ? 'other-account' : 'member'}'; RunLevel=0; LogonType=3 }
  Triggers=@(@{ UserId='${variant === 'foreign-trigger' ? 'other-account' : 'member'}' })
  Actions=@(@{ Execute=$script:spec.Execute; Arguments=$script:spec.Arguments; WorkingDirectory=$script:spec.WorkingDirectory })
}
function Get-ScheduledTask { param($TaskPath,$ErrorAction); return $script:storedTask }
function Get-ScheduledTaskInfo { param($TaskName,$TaskPath,$ErrorAction); return @{ LastTaskResult=0; LastRunTime=([DateTime]::Parse('2030-01-01T00:00:00Z')) } }
function Export-ScheduledTask {
  param($TaskName,$TaskPath,$ErrorAction)
  $principal = '${variant === 'foreign-principal' ? 'S-1-5-21-100-200-300-9999' : 'S-1-5-21-100-200-300-1001'}'
  $trigger = '${variant === 'foreign-trigger' ? 'Other\\member' : 'Fixture\\member'}'
  $command = [Security.SecurityElement]::Escape($script:spec.Execute)
  $arguments = [Security.SecurityElement]::Escape($script:spec.Arguments)
  $directory = [Security.SecurityElement]::Escape($script:spec.WorkingDirectory)
  return "<Task xmlns='http://schemas.microsoft.com/windows/2004/02/mit/task'><Principals><Principal id='Author'><UserId>$principal</UserId><LogonType>InteractiveToken</LogonType>${variant === 'same-account-default-runlevel' ? '' : '<RunLevel>LeastPrivilege</RunLevel>'}</Principal></Principals><Triggers><LogonTrigger><UserId>$trigger</UserId></LogonTrigger></Triggers><Actions Context='Author'><Exec><Command>$command</Command><Arguments>$arguments</Arguments><WorkingDirectory>$directory</WorkingDirectory></Exec></Actions></Task>"
}
Get-StageDesktopStartupStatus | ConvertTo-Json -Depth 6 | Set-Content -LiteralPath (Join-Path $StageRoot 'status.json')
`);
    if (variant.startsWith('foreign-')) {
      assert.notEqual(result.code, 0, result.output);
      assert.match(result.output, /does not belong to this project and user/);
    } else {
      assert.equal(result.code, 0, result.output);
      const status = readJson(join(root, 'status.json'));
      assert.equal(status.runLevel, 'Limited');
      assert.equal(status.logonType, 'Interactive');
      assert.equal(status.currentUserOnly, true);
    }
  }
});

windowsTest('desktop registration and removal refuse an unrelated matching task before making scheduler changes', async () => {
  for (const operation of ['Register-StageDesktopStartup', 'Unregister-StageDesktopStartup']) {
    const root = fixture();
    const result = await run(root, identity + `
function Get-ScheduledTask { param($TaskPath,$ErrorAction); return [pscustomobject]@{ TaskName=(Get-StageDesktopTaskSpec).Name; Description='unrelated'; Principal=@{ UserId='other-user' }; Actions=@(@{ Execute='unrelated.exe' }) } }
function Register-ScheduledTask { throw 'Must not change the scheduler.' }
function Unregister-ScheduledTask { throw 'Must not change the scheduler.' }
${operation} -Confirm:$false
`);
    assert.notEqual(result.code, 0, result.output);
    assert.match(result.output, /does not belong to this project and user/);
    assert.doesNotMatch(result.output, /Must not change the scheduler/);
  }
});

windowsTest('desktop registration supports a read-only WhatIf rehearsal', async () => {
  const root = fixture();
  const result = await run(root, identity + taskMocks + '\nRegister-StageDesktopStartup -WhatIf');
  assert.equal(result.code, 0, result.output);
  assert.match(result.output, /What if:/i);
  assert.equal(existsSync(join(root, 'registered.json')), false);
});
