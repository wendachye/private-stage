import { createHash, createDecipheriv } from 'node:crypto';
import { readFile, readdir, lstat } from 'node:fs/promises';
import { isDeepStrictEqual, parseEnv } from 'node:util';
import { resolve, join, relative, isAbsolute, dirname, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import { StageService } from '../backend/src/domain/stage-service.ts';

const processRecords = new Set(['app.pid','app.lock','app.lock.recover','supervisor.lock','supervisor.lock.recover','supervisor.json','supervisor.stop']);
const hash = value => createHash('sha256').update(value).digest('hex');
const check = (condition, message) => { if (!condition) throw new Error(message); };
async function inventory(directory, prefix = '') {
  const entries = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const full = join(directory, entry.name), name = prefix ? `${prefix}/${entry.name}` : entry.name;
    check(!(await lstat(full)).isSymbolicLink(), 'Restore verification refuses linked files.');
    if (entry.isDirectory()) entries.push(...await inventory(full, name));
    else { check(entry.isFile(), 'Unsupported backup artifact.'); entries.push([name, hash(await readFile(full))]); }
  }
  return entries.sort(([a], [b]) => a.localeCompare(b));
}
function readState(databasePath) {
  const db = new DatabaseSync(databasePath, { readOnly: true });
  try {
    check(db.prepare('PRAGMA integrity_check').get().integrity_check === 'ok', 'SQLite integrity check failed.');
    check(db.prepare('PRAGMA foreign_key_check').all().length === 0, 'SQLite foreign-key check failed.');
    const row = db.prepare('SELECT value FROM stage_state WHERE id=1').get();
    check(row, 'Restored stage state is missing.');
    return JSON.parse(row.value);
  } finally { db.close(); }
}
function inspectAuth(databasePath, keyHex) {
  check(/^[a-f0-9]{64}$/i.test(keyHex ?? ''), 'The restored token-encryption key is invalid.');
  const db = new DatabaseSync(databasePath, { readOnly: true });
  try {
    check(db.prepare('PRAGMA integrity_check').get().integrity_check === 'ok', 'Auth SQLite integrity check failed.');
    check(db.prepare('PRAGMA foreign_key_check').all().length === 0, 'Auth SQLite foreign-key check failed.');
    const encrypted = db.prepare('SELECT tokens FROM auth_accounts WHERE tokens IS NOT NULL').all();
    for (const row of encrypted) {
      try {
        const blob = Buffer.from(row.tokens, 'base64');
        check(blob.length >= 28, 'Encrypted token record is incomplete.');
        const decipher = createDecipheriv('aes-256-gcm', Buffer.from(keyHex, 'hex'), blob.subarray(0, 12));
        decipher.setAuthTag(blob.subarray(12, 28));
        const plaintext = Buffer.concat([decipher.update(blob.subarray(28)), decipher.final()]);
        try {
          const tokens = JSON.parse(plaintext.toString('utf8'));
          check(typeof tokens.access === 'string' && tokens.access.length > 0 && Number.isFinite(tokens.expiresAt), 'Decrypted token record is invalid.');
        } finally { plaintext.fill(0); }
      } catch { throw new Error('Matching-key token decryption failed.'); }
    }
    return { tokenRecordsChecked: encrypted.length, tokenKeyVerifiedAgainstRecords: encrypted.length > 0, authIntegrity: true, authForeignKeys: true };
  } finally { db.close(); }
}
export async function verifyLocalRestore({ backupPath, targetRoot }) {
  backupPath = resolve(backupPath); targetRoot = resolve(targetRoot);
  const drillsRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../work/restore-drills');
  const rehearsalRelative = relative(drillsRoot, targetRoot), segments = rehearsalRelative.split(sep);
  check(!isAbsolute(rehearsalRelative) && segments.length === 2 && /^[a-f0-9]{32}$/i.test(segments[0]) && segments[1] === 'project', 'The verifier only accepts a fresh isolated restore-drill project.');
  for (const directory of [drillsRoot, join(drillsRoot, segments[0]), targetRoot]) {
    const entry = await lstat(directory);
    check(entry.isDirectory() && !entry.isSymbolicLink(), 'Restore verification refuses linked project directories.');
  }
  const sourceRelative = relative(backupPath, targetRoot), targetRelative = relative(targetRoot, backupPath);
  check(sourceRelative && (sourceRelative.startsWith('..') || isAbsolute(sourceRelative)) && targetRelative && (targetRelative.startsWith('..') || isAbsolute(targetRelative)), 'Restore source and rehearsal target must not overlap.');
  const before = await inventory(backupPath);
  const settings = parseEnv(await readFile(join(targetRoot, '.env'), 'utf8'));
  const data = resolve(targetRoot, settings.DATA_DIR ?? './data');
  const dataRelative = relative(targetRoot, data);
  check(dataRelative && !dataRelative.startsWith('..') && !isAbsolute(dataRelative), 'The restore verifier requires isolated project data.');
  let comparedFiles = 0;
  for (const [name, digest] of before) {
    let destination;
    if (name.startsWith('data/')) {
      const path = name.slice(5);
      if (processRecords.has(path.split('/')[0])) continue;
      destination = join(data, path);
    } else if (name === '.env' || name === 'deploy/livekit.local.yaml') destination = join(targetRoot, name);
    else continue;
    check(hash(await readFile(destination)) === digest, 'A restored artifact does not match the stopped-service backup.');
    comparedFiles++;
  }
  const restoredInventory = await inventory(data);
  check(restoredInventory.every(([name]) => !processRecords.has(name.split('/')[0])), 'Process ownership records must not be restored.');
  const stateBefore = readState(join(data, 'stage.sqlite'));
  const auth = inspectAuth(join(data, 'auth.sqlite'), settings.TOKEN_ENCRYPTION_KEY);
  check(/^[a-f0-9]{64}$/i.test(settings.SESSION_KEY ?? ''), 'The restored session key is invalid.');
  const expectedSchedules = structuredClone(stateBefore.schedules);
  for (const schedule of expectedSchedules) {
    if (!['stage', 'open', 'qa'].includes(schedule.mode)) schedule.mode = 'open';
    if (schedule.sessionId && schedule.sessionId === stateBefore.live?.id) schedule.status = 'completed';
  }
  const expectedAdmin = structuredClone(stateBefore.adminConfiguration);
  if (settings.DISCORD_OWNER_ID) expectedAdmin.ownerUserId = settings.DISCORD_OWNER_ID;
  if (!stateBefore.adminRolesConfigured && settings.DISCORD_ADMIN_ROLE_IDS !== undefined) expectedAdmin.adminRoleIds = [...new Set(settings.DISCORD_ADMIN_ROLE_IDS.split(',').map(value => value.trim()).filter(Boolean))];
  const service = new StageService({ databasePath: join(data, 'stage.sqlite'), ownerUserId: settings.DISCORD_OWNER_ID ?? '', adminRoleIds: settings.DISCORD_ADMIN_ROLE_IDS?.split(',').map(value => value.trim()).filter(Boolean) ?? [] });
  let stateAfter;
  try { stateAfter = service.store.read(); } finally { service.close(); }
  check(stateAfter.live === null, 'A restored process must start with its room closed.');
  check(isDeepStrictEqual(stateAfter.schedules, expectedSchedules), 'Restored schedules were not retained across startup reconciliation.');
  check(isDeepStrictEqual(stateAfter.adminConfiguration, expectedAdmin), 'Restored admin configuration changed unexpectedly.');
  check(isDeepStrictEqual(stateAfter.bans, stateBefore.bans), 'Restored bans changed unexpectedly.');
  check(stateAfter.admissions.every(admission => admission.revoked || admission.sessionId !== stateBefore.live?.id), 'Prior room admissions were not revoked.');
  check(!stateBefore.live || stateAfter.cleanupRooms.includes(stateBefore.live.roomName) && stateAfter.mediaSyncPending, 'Prior media cleanup was not queued before new admission.');
  check(isDeepStrictEqual(await inventory(backupPath), before), 'The source backup changed during its rehearsal.');
  return { ok: true, restoredFilesByteIdenticalBeforeOpen: true, comparedFiles, processRecordsExcluded: true, stageIntegrity: true, stageForeignKeys: true, ...auth, sessionKeyPresent: true, restartRoomClosed: true, priorRoomCleanupQueuedIfNeeded: true, schedulesRetained: true, adminConfigurationRetained: true, bansRetained: true, sourceBackupUnchanged: true, providerRequestsMade: 0, mediaRequestsMade: 0 };
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    check(process.argv.length === 4, 'Specify a backup and isolated target.');
    process.stdout.write(JSON.stringify(await verifyLocalRestore({ backupPath: process.argv[2], targetRoot: process.argv[3] })) + '\n');
  } catch {
    process.stderr.write('Restore verification failed. Private database and credential details were not printed.\n');
    process.exitCode = 1;
  }
}
