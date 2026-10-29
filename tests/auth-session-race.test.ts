import test from 'node:test';
import assert from 'node:assert/strict';
import { AuthService, AuthError } from '../backend/src/auth/auth-service.ts';

for (const endedBy of ['logout', 'expiry', 'active'] as const) {
  test(endedBy === 'active' ? 'a delayed membership response still authenticates an active session' : `a delayed membership response cannot authenticate a session ended by ${endedBy}`, async () => {
    let now = Date.now(), delayed = false;
    let release!: (response: Response) => void;
    let entered!: () => void;
    const checking = new Promise<void>(resolve => { entered = resolve; });
    const response = new Promise<Response>(resolve => { release = resolve; });
    const accountId = '111111111111111111';
    const auth = new AuthService({
      databasePath: ':memory:', encryptionKey: 'b'.repeat(64), guildId: 'fixture-guild', clientId: 'fixture-client', clientSecret: 'fixture-only',
      preview: false, cacheSeconds: 30, maxStaleSeconds: 300, now: () => now,
      adminConfiguration: () => ({ ownerUserId: accountId, adminRoleIds: [], explicitAdminUserIds: [] }),
      fetch: async input => {
        if (String(input).endsWith('/users/@me')) return Response.json({ id: accountId, username: 'Fixture owner' });
        assert.ok(String(input).endsWith('/member'), 'This fixture does not refresh tokens or call any real provider.');
        if (!delayed) return Response.json({ roles: [] });
        entered();
        return response;
      },
    });
    try {
      const sid = await auth.completeDiscord({ access_token: 'fixture-access', expires_in: 48 * 60 * 60 }, 'device');
      now += 31_000; delayed = true;
      const principal = auth.principal(sid, 'device', { fresh: true, allowStale: false });
      await checking;
      if (endedBy === 'logout') auth.logout(sid);
      else if (endedBy === 'expiry') now += 8 * 60 * 60 * 1000;
      release(Response.json({ roles: [] }));
      if (endedBy === 'active') {
        assert.equal((await principal).userId, accountId);
        assert.equal(auth.activeSessions().length, 1);
      } else {
        await assert.rejects(principal, error => error instanceof AuthError && error.code === 'signed-out', `A session ended by ${endedBy} must remain ended when verification finishes.`);
        assert.equal(auth.activeSessions().length, 0);
      }
    } finally {
      release(Response.json({ roles: [] }));
      auth.close();
    }
  });
}
