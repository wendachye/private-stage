import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { StageService, DomainError } from '../backend/src/domain/stage-service.ts';
import { StageStore } from '../backend/src/storage/stage-store.ts';
import type { Principal, RoomMode } from '../shared/types.ts';

const owner: Principal = { userId: 'owner', displayName: 'Owner', deviceId: 'owner-browser', isOwner: true, isAdmin: true };
const member: Principal = { userId: 'member', displayName: 'Member', deviceId: 'member-browser', isOwner: false, isAdmin: false };
const reservation = { title: 'Scheduled conversation', description: 'Initial speaking mode check', startsAt: '2030-01-01T10:00:00Z', endsAt: '2030-01-01T11:00:00Z' };
const denied = (code: string) => (error: unknown): boolean => error instanceof DomainError && error.code === code;

test('scheduled speaking choices are inherited in Waiting and retained in Live without automatically opening microphones', async () => {
  for (const mode of ['open', 'stage', 'qa'] as const) {
    const service = new StageService({ databasePath: ':memory:', ownerUserId: owner.userId });
    try {
      const saved = await service.execute(owner, { type: 'schedule.save', ...reservation, mode });
      const schedule = saved.snapshot.schedules[0]!;
      assert.equal(schedule.mode, mode);
      const opened = await service.execute(owner, { type: 'session.open', scheduleId: schedule.id });
      assert.equal(opened.snapshot.session?.state, 'waiting');
      assert.equal(opened.snapshot.session?.mode, mode);
      assert.equal(opened.snapshot.self.microphoneOwned, false);
      const admission = await service.admit(member);
      for (const phase of ['waiting', 'live'] as const) {
        assert.equal(service.snapshot(member).session?.state, phase);
        assert.equal(service.snapshot(member).session?.mode, mode);
        assert.equal(service.snapshot(member).self.canSpeak, mode === 'open');
        assert.equal(service.snapshot(member).self.microphoneOwned, false);
        assert.equal(service.mediaPolicy(admission.identity)?.allowedSources.includes('microphone'), false);
        if (phase === 'waiting') await service.execute(owner, { type: 'session.start' });
      }
    } finally { service.close(); }
  }
});

test('new schedules default to Everyone while edits preserve omitted speaking mode and accept an explicit replacement', async () => {
  const service = new StageService({ databasePath: ':memory:', ownerUserId: owner.userId });
  try {
    const saved = await service.execute(owner, { type: 'schedule.save', ...reservation });
    const id = saved.snapshot.schedules[0]!.id;
    assert.equal(saved.snapshot.schedules[0]?.mode, 'open');
    await service.execute(owner, { type: 'schedule.save', ...reservation, id, mode: 'qa' });
    const titleEdit = await service.execute(owner, { type: 'schedule.save', ...reservation, id, title: 'Revised title only' });
    assert.equal(titleEdit.snapshot.schedules[0]?.mode, 'qa');
    assert.equal(titleEdit.snapshot.schedules[0]?.title, 'Revised title only');
    const modeEdit = await service.execute(owner, { type: 'schedule.save', ...reservation, id, mode: 'open' });
    assert.equal(modeEdit.snapshot.schedules[0]?.mode, 'open');
    const opened = await service.execute(owner, { type: 'session.open', scheduleId: id });
    assert.equal(opened.snapshot.session?.mode, 'open');
    await service.execute(owner, { type: 'schedule.save', ...reservation, id, mode: 'stage' });
    assert.equal(service.snapshot(owner).session?.mode, 'open', 'Editing a schedule must not silently change an already-open room.');
  } finally { service.close(); }
});

test('an explicit room-opening choice overrides a saved schedule without rewriting it', async () => {
  const service = new StageService({ databasePath: ':memory:', ownerUserId: owner.userId });
  try {
    const saved = await service.execute(owner, { type: 'schedule.save', ...reservation, mode: 'stage' });
    const id = saved.snapshot.schedules[0]!.id;
    const opened = await service.execute(owner, { type: 'session.open', scheduleId: id, mode: 'open' });
    assert.equal(opened.snapshot.session?.mode, 'open');
    assert.equal(opened.snapshot.schedules[0]?.mode, 'stage');
    await service.execute(owner, { type: 'session.start' });
    assert.equal(service.snapshot(owner).session?.mode, 'open');
  } finally { service.close(); }
});

test('invalid or unauthorized schedule mode changes reject before changing schedules or consuming reservations', async () => {
  const service = new StageService({ databasePath: ':memory:', ownerUserId: owner.userId });
  try {
    await assert.rejects(service.execute(owner, { type: 'schedule.save', ...reservation, mode: 'invalid' }), denied('invalid_mode'));
    assert.equal(service.snapshot(owner).schedules.length, 0);
    const saved = await service.execute(owner, { type: 'schedule.save', ...reservation, mode: 'qa' });
    const before = saved.snapshot.schedules;
    const id = before[0]!.id;
    await assert.rejects(service.execute(owner, { type: 'schedule.save', ...reservation, id, mode: 'invalid' }), denied('invalid_mode'));
    await assert.rejects(service.execute(member, { type: 'schedule.save', ...reservation, id, mode: 'open' }), denied('admin_required'));
    await assert.rejects(service.execute(owner, { type: 'session.open', scheduleId: id, mode: 'invalid' }), denied('invalid_mode'));
    assert.deepEqual(service.snapshot(owner).schedules, before);
    assert.equal(service.snapshot(owner).session, null);
    const opened = await service.execute(owner, { type: 'session.open', scheduleId: id });
    assert.equal(opened.snapshot.session?.mode, 'qa');
  } finally { service.close(); }
});

test('schedule modes survive database reopen and legacy schedules gain Everyone without losing reservation metadata', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'private-stage-schedule-speaking-'));
  const databasePath = join(directory, 'state.sqlite');
  let service: StageService | undefined;
  try {
    service = new StageService({ databasePath, ownerUserId: owner.userId });
    const saved = await service.execute(owner, { type: 'schedule.save', ...reservation, mode: 'qa' });
    const original = saved.snapshot.schedules[0]!;
    service.close(); service = undefined;
    service = new StageService({ databasePath, ownerUserId: owner.userId });
    assert.deepEqual(service.snapshot(owner).schedules[0], original);
    service.close(); service = undefined;

    const store = new StageStore(databasePath);
    try {
      const legacy = store.read<{ schedules: Array<{ mode?: RoomMode }>; [key: string]: unknown }>()!;
      delete legacy.schedules[0]!.mode;
      store.save(legacy);
    } finally { store.close(); }

    service = new StageService({ databasePath, ownerUserId: owner.userId });
    assert.deepEqual(service.snapshot(owner).schedules[0], { ...original, mode: 'open' });
    service.close(); service = undefined;
    service = new StageService({ databasePath, ownerUserId: owner.userId });
    assert.equal(service.snapshot(owner).schedules[0]?.mode, 'open', 'Legacy normalization must itself be durable.');
    const opened = await service.execute(owner, { type: 'session.open', scheduleId: original.id });
    assert.equal(opened.snapshot.session?.mode, 'open');
    assert.equal(opened.snapshot.session?.title, original.title);
  } finally {
    service?.close();
    rmSync(directory, { recursive: true, force: true });
  }
});
