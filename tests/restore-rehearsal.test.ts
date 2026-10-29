import test from 'node:test';
import assert from 'node:assert/strict';
import { copyFileSync, cpSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, writeFileSync, symlinkSync, existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { createServer } from 'node:net';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { StageService } from '../backend/src/domain/stage-service.ts';
import { AuthService } from '../backend/src/auth/auth-service.ts';
import { verifyLocalRestore } from '../scripts/verify-local-restore.mjs';

const project = resolve(import.meta.dirname, '..');
const owner = { userId: '111111111111111111', displayName: 'Synthetic restore owner', deviceId: 'fixture-device', isOwner: true, isAdmin: true };
const tokenKey = 'a'.repeat(64);
async function fixture() {
  const base = join(project, 'work/restore-rehearsal-tests'); mkdirSync(base, { recursive: true });
  const root = mkdtempSync(join(base, 'fixture-'));
  const data = join(root, 'data'); mkdirSync(data);
  mkdirSync(join(root, 'deploy')); mkdirSync(join(root, 'scripts'));
  const listener = createServer(); await new Promise<void>(done => listener.listen(0, '127.0.0.1', done));
  const address = listener.address(); assert.ok(address && typeof address !== 'string');
  await new Promise<void>((done, reject) => listener.close(error => error ? reject(error) : done()));
  writeFileSync(join(root, '.env'), `DATA_DIR=./data\nPORT=${address.port}\nAPP_URL=http://127.0.0.1:${address.port}\nDISCORD_OWNER_ID=${owner.userId}\nDISCORD_ADMIN_ROLE_IDS=\nTOKEN_ENCRYPTION_KEY=${tokenKey}\nSESSION_KEY=${'b'.repeat(64)}\n`);
  writeFileSync(join(root, 'deploy/livekit.local.yaml'), 'fixture: synthetic-only\n');
  const stage = new StageService({ databasePath: join(data, 'stage.sqlite'), ownerUserId: owner.userId });
  try {
    const scheduled = await stage.execute(owner, { type: 'schedule.save', title: 'Durable synthetic reservation', mode: 'qa', startsAt: '2030-01-01T10:00:00Z', endsAt: '2030-01-01T11:00:00Z' });
    await stage.execute(owner, { type: 'session.open', scheduleId: scheduled.snapshot.schedules[0]!.id });
    const state = stage.store.read<Record<string, unknown>>()!;
    state.bans = { 'synthetic-banned-member': 'fixture' };
    state.adminConfiguration = { ownerUserId: owner.userId, adminRoleIds: ['fixture-role'], explicitAdminUserIds: ['fixture-admin'] };
    state.adminRolesConfigured = true;
    stage.store.save(state);
  } finally { stage.close(); }
  const auth = new AuthService({ databasePath: join(data, 'auth.sqlite'), encryptionKey: tokenKey, guildId: 'fixture-guild', clientId: 'fixture-client', clientSecret: 'fixture-only', preview: false, cacheSeconds: 60, maxStaleSeconds: 300,
    adminConfiguration: () => ({ ownerUserId: owner.userId, adminRoleIds: [], explicitAdminUserIds: [] }),
    fetch: async input => String(input).endsWith('/users/@me') ? Response.json({ id: owner.userId, username: 'Synthetic restore owner' }) : Response.json({ roles: [] }),
  });
  try { await auth.completeDiscord({ access_token: 'synthetic-access-not-a-real-token', expires_in: 3600 }, 'fixture-device'); }
  finally { auth.close(); }
  const backup = join(root, 'backups/selected'); mkdirSync(backup, { recursive: true });
  cpSync(data, join(backup, 'data'), { recursive: true });
  copyFileSync(join(root, '.env'), join(backup, '.env')); cpSync(join(root, 'deploy'), join(backup, 'deploy'), { recursive: true });
  const target = join(project, 'work/restore-drills', randomUUID().replaceAll('-', ''), 'project'); mkdirSync(target, { recursive: true });
  cpSync(backup, target, { recursive: true });
  return { root, backup, target };
}

test('restore verification checks copied private data and queues closed-room reconciliation without changing its backup', async () => {
  const f = await fixture();
  const sourceStage = readFileSync(join(f.backup, 'data/stage.sqlite'));
  const result = await verifyLocalRestore({ backupPath: f.backup, targetRoot: f.target });
  assert.equal(result.ok, true); assert.equal(result.tokenRecordsChecked, 1);
  assert.equal(result.tokenKeyVerifiedAgainstRecords, true);
  assert.equal(result.restoredFilesByteIdenticalBeforeOpen, true);
  assert.equal(result.restartRoomClosed, true); assert.equal(result.priorRoomCleanupQueuedIfNeeded, true);
  assert.equal(result.schedulesRetained, true); assert.equal(result.adminConfigurationRetained, true); assert.equal(result.bansRetained, true);
  assert.equal(result.providerRequestsMade, 0); assert.equal(result.mediaRequestsMade, 0);
  assert.deepEqual(readFileSync(join(f.backup, 'data/stage.sqlite')), sourceStage);
  assert.equal(JSON.stringify(result).includes('synthetic-access-not-a-real-token'), false);
  assert.equal(JSON.stringify(result).includes(owner.userId), false);
});

test('restore verification refuses a changed copied artifact before normalizing its database', async () => {
  const f = await fixture(); const stageBefore = readFileSync(join(f.target, 'data/stage.sqlite'));
  writeFileSync(join(f.target, '.env'), readFileSync(join(f.target, '.env'), 'utf8') + 'EXTRA=copy-was-modified\n');
  await assert.rejects(verifyLocalRestore({ backupPath: f.backup, targetRoot: f.target }), /does not match/);
  assert.deepEqual(readFileSync(join(f.target, 'data/stage.sqlite')), stageBefore);
});

test('restore verification refuses matching copied files when their encryption key cannot decrypt the restored account', async () => {
  const f = await fixture();
  for (const root of [f.backup, f.target]) writeFileSync(join(root, '.env'), readFileSync(join(root, '.env'), 'utf8').replace(tokenKey, 'c'.repeat(64)));
  await assert.rejects(verifyLocalRestore({ backupPath: f.backup, targetRoot: f.target }), /Matching-key token decryption failed/);
});

test('the low-level verifier refuses an ordinary project target before opening or changing its database', async () => {
  const f = await fixture(); const before = readFileSync(join(f.root, 'data/stage.sqlite'));
  await assert.rejects(verifyLocalRestore({ backupPath: f.backup, targetRoot: f.root }), /only accepts a fresh isolated/);
  assert.deepEqual(readFileSync(join(f.root, 'data/stage.sqlite')), before);
});

const ps = (value: string) => `'${value.replaceAll("'", "''")}'`;
function command(root: string, source: string) {
  return new Promise<{ code: number | null; output: string }>((done, reject) => {
    const child = spawn('powershell.exe', ['-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', `$ErrorActionPreference='Stop'; Import-Module (Join-Path $PSHOME 'Modules\\Microsoft.PowerShell.Security\\Microsoft.PowerShell.Security.psd1'); ${source}`], { cwd: root, windowsHide: true });
    let output = ''; child.stdout.on('data', data => output += data); child.stderr.on('data', data => output += data);
    const timer = setTimeout(() => { child.kill(); reject(new Error('Isolated restore rehearsal timed out.')); }, 25000);
    child.once('error', error => { clearTimeout(timer); reject(error); }); child.once('close', code => { clearTimeout(timer); done({ code, output }); });
  });
}
test('Windows rehearsal uses the real restore script only inside a private scratch project and new backups get private ACLs', { skip: process.platform !== 'win32' }, async () => {
  const f = await fixture();
  for (const name of ['Common.ps1', 'Private-Storage.ps1', 'Backup-Local.ps1', 'Restore-Local.ps1', 'Verify-LocalRestore.ps1', 'verify-local-restore.mjs']) copyFileSync(join(project, 'scripts', name), join(f.root, 'scripts', name));
  for (const name of ['backend/src/domain/stage-service.ts', 'backend/src/storage/stage-store.ts', 'shared/types.ts']) { mkdirSync(resolve(f.root, name, '..'), { recursive: true }); copyFileSync(join(project, name), join(f.root, name)); }
  writeFileSync(join(f.root, 'package.json'), '{"type":"module"}');
  symlinkSync(join(project, 'node_modules'), join(f.root, 'node_modules'), 'junction');
  const sourceBefore = readFileSync(join(f.root, 'data/stage.sqlite'));
  const backup = await command(f.root, `& ${ps(join(f.root, 'scripts/Backup-Local.ps1'))}`);
  assert.equal(backup.code, 0, backup.output);
  const selected = backup.output.match(/Backup saved: ([^\r\n]+)/)?.[1]; assert.ok(selected);
  const acl = await command(f.root, `$a=Get-Acl -LiteralPath ${ps(selected)}; $allowed=@([Security.Principal.WindowsIdentity]::GetCurrent().User.Value,'S-1-5-18','S-1-5-32-544'); @{Private=$a.AreAccessRulesProtected;Unexpected=@($a.Access|Where-Object {$_.IdentityReference.Translate([Security.Principal.SecurityIdentifier]).Value -notin $allowed}).Count}|ConvertTo-Json -Compress`);
  assert.equal(acl.code, 0, acl.output); assert.deepEqual(JSON.parse(acl.output.trim()), { Private: true, Unexpected: 0 });
  writeFileSync(join(selected, 'data/supervisor.stop'), 'legacy-record-must-be-excluded');
  const report = join(f.root, 'docs/evidence/rehearsal.json');
  const verified = await command(f.root, `& ${ps(join(f.root, 'scripts/Verify-LocalRestore.ps1'))} -BackupPath ${ps(selected)} -ReportPath ${ps(report)}`);
  assert.equal(verified.code, 0, verified.output);
  const result = JSON.parse(readFileSync(report, 'utf8').replace(/^\uFEFF/, ''));
  assert.equal(result.ok, true); assert.equal(result.privateRehearsalAcl, true); assert.equal(result.originalProjectRestored, false); assert.equal(result.processRecordsExcluded, true);
  assert.deepEqual(readFileSync(join(f.root, 'data/stage.sqlite')), sourceBefore);
  assert.equal(existsSync(join(f.root, 'data/supervisor.stop')), false);
  assert.equal(readdirSync(join(f.root, 'work/restore-drills')).length, 1);
});
