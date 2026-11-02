// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Additional terms: see LICENSE-ADDITIONAL-TERMS.md

/**
 * SQL-level contract of the call-ending sweeps, of call ends and restarts and
 * of the call permission rewrite in `repositories/calls.ts`, with the pool
 * mocked. The statements themselves run against a real database in
 * `e2e/checks/call-sweep.sh` (docs/backend/README.md, `callUpdateEmitter.ts`).
 */

const poolQuery = jest.fn();
const clientQuery = jest.fn();
const clientRelease = jest.fn();

jest.mock('../util/postgres', () => ({
  __esModule: true,
  default: {
    query: (...args: any[]) => poolQuery(...args),
    connect: async () => ({
      query: (...args: any[]) => clientQuery(...args),
      release: () => clientRelease(),
    }),
  },
}));

import callHelper from '../repositories/calls';
import config from '../common/config';

const CALL = '00000000-0000-4000-8000-0000000000c1';
const COMMUNITY = '00000000-0000-4000-8000-0000000000e1';

const normalize = (sql: string) => sql.replace(/\s+/g, ' ');

beforeEach(() => {
  poolQuery.mockReset();
  clientQuery.mockReset();
  clientRelease.mockReset();
});

describe('callHelper.endCallsOfGoneCallServers', () => {
  it('ends the open calls of deleted, missing or silent call servers and returns them', async () => {
    poolQuery.mockResolvedValue({ rows: [{ id: CALL, communityId: COMMUNITY }] });
    await expect(callHelper.endCallsOfGoneCallServers()).resolves.toEqual([{ id: CALL, communityId: COMMUNITY }]);
    const sql = normalize(poolQuery.mock.calls[0][0]);
    expect(sql).toContain('cs.id IS NULL OR cs."deletedAt" IS NOT NULL');
    expect(sql).toContain(`cs."updatedAt" < now() - interval '${config.CALLSERVER_GONE_AFTER_MILLISECONDS} milliseconds'`);
    expect(sql).toContain('c."callServerId" IS NOT NULL');
    // only open calls, and never twice
    expect(sql).toContain('WHERE c."endedAt" IS NULL');
    expect(sql).toContain('WHERE c.id = gc.id AND c."endedAt" IS NULL RETURNING c.id, c."communityId"');
    // members still marked as present leave with the call, previews are cleared
    expect(sql).toMatch(/UPDATE callmembers cm SET "leftAt" = .* WHERE cm."callId" = gc.id AND cm."leftAt" IS NULL/);
    expect(sql).toContain('"previewUserIds" = ARRAY[]::UUID[]');
  });

  it('ends event calls right away, like a call server reset', async () => {
    poolQuery.mockResolvedValue({ rows: [] });
    await callHelper.endCallsOfGoneCallServers();
    const sql = normalize(poolQuery.mock.calls[0][0]);
    expect(sql).not.toContain('scheduleDate');
    expect(sql).not.toContain('communities_events');
  });

  it('does not wait for the stale period of a live call server', () => {
    // a call server that missed a few heartbeats is not gone yet
    expect(config.CALLSERVER_GONE_AFTER_MILLISECONDS).toBeGreaterThan(config.CALLSERVER_STALE_AFTER_MILLISECONDS);
  });
});

describe('callHelper.endEmptyCalls', () => {
  it('ends non-scheduled calls that never had a member, or whose members all left a while ago', async () => {
    poolQuery.mockResolvedValue({ rows: [] });
    await callHelper.endEmptyCalls();
    const sql = normalize(poolQuery.mock.calls[0][0]);
    expect(sql).toContain('HAVING COUNT(cm.id) = 0 OR ( COUNT(cm.id) = COUNT(cm."leftAt")');
    expect(sql).toContain(`MAX(cm."leftAt") < now() - interval '${config.END_CALL_AFTER_ALL_LEFT_PERIOD} milliseconds'`);
    expect(sql).toContain('AND "endedAt" IS NULL RETURNING id, "communityId"');
  });

  it('ends event calls by their scheduled end in minutes, scheduled calls without an event row when empty', async () => {
    poolQuery.mockResolvedValue({ rows: [] });
    await callHelper.endEmptyCalls();
    const sql = normalize(poolQuery.mock.calls[0][0]);
    expect(sql).toContain(`ce."duration" * interval '1 minute' AS "duration"`);
    expect(sql).toContain('WHERE (ce.id IS NOT NULL OR cl."scheduleDate" IS NOT NULL)');
    // without an event row ce."scheduleDate" is NULL: ended
    expect(sql).toContain('WHERE "scheduleDate" IS NULL OR "scheduleDate" + "duration" < now()');
  });
});

describe('ending a call from its room', () => {
  it.each([
    ['softEndCall', () => callHelper.softEndCall(CALL)],
    ['endCallForEveryone', () => callHelper.endCallForEveryone(CALL)],
  ])('%s only ends a call that is still open', async (_name, end) => {
    poolQuery.mockResolvedValue({ rows: [], rowCount: 0 });
    await expect(end()).resolves.toBeNull();
    const update = normalize(poolQuery.mock.calls[1][0]);
    expect(update).toMatch(/UPDATE calls SET "endedAt" = NOW\(\).* AND "endedAt" IS NULL RETURNING id/);
  });
});

describe('callHelper.startScheduledCall', () => {
  it('restarts an ended event call and closes the memberships it left open', async () => {
    poolQuery.mockImplementation(async (sql: string) => normalize(sql).includes('FROM callservers')
      ? { rows: [{ id: 'server', url: 'cs.example' }] }
      : { rows: [{ id: CALL, communityTitle: 'c', communityUrl: 'c', rolePermissions: [] }] });
    await callHelper.startScheduledCall({ communityEventId: 'event', callStarter: 'user' });
    const sql = normalize(poolQuery.mock.calls[1][0]);
    expect(sql).toContain('"endedAt" = NULL');
    expect(sql).toMatch(/UPDATE callmembers SET "leftAt" = COALESCE\("leftAt", NOW\(\)\) WHERE "callId" = \(SELECT id FROM get_call\) AND "leftAt" IS NULL AND EXISTS \( SELECT 1 FROM calls WHERE id = \(SELECT id FROM get_call\) AND "endedAt" IS NOT NULL \)/);
  });
});

describe('callHelper.updateCallPermissions', () => {
  it('builds a complete VALUES row for the member role when no permissions are given', async () => {
    clientQuery.mockResolvedValue({ rows: [] });
    await callHelper.updateCallPermissions(CALL, COMMUNITY, undefined);
    const statements = clientQuery.mock.calls.map(c => normalize(c[0]).trim());
    // delete and insert in one transaction
    expect(statements[0]).toBe('BEGIN');
    expect(statements[1]).toContain('DELETE FROM callpermissions');
    expect(statements[2]).toContain(`, ( '${CALL}'::UUID, (SELECT id FROM member_role), ARRAY[`);
    expect(statements[3]).toBe('COMMIT');
    expect(clientRelease).toHaveBeenCalled();
  });

  it('rolls back when the insert fails, keeping the old permissions', async () => {
    clientQuery.mockImplementation(async (sql: string) => {
      if (sql.includes('INSERT INTO callpermissions')) {
        throw new Error('insert failed');
      }
      return { rows: [] };
    });
    await expect(callHelper.updateCallPermissions(CALL, COMMUNITY, undefined)).rejects.toThrow('insert failed');
    const statements = clientQuery.mock.calls.map(c => normalize(c[0]).trim());
    expect(statements[statements.length - 1]).toBe('ROLLBACK');
    expect(statements).not.toContain('COMMIT');
    expect(clientRelease).toHaveBeenCalled();
  });

  it('builds one row per given role', async () => {
    const ROLE = '00000000-0000-4000-8000-0000000000f1';
    const ADMIN = '00000000-0000-4000-8000-0000000000f2';
    poolQuery.mockResolvedValue({ rows: [{ id: ADMIN }] });
    clientQuery.mockResolvedValue({ rows: [] });
    await callHelper.updateCallPermissions(CALL, COMMUNITY, [
      { roleId: ROLE, permissions: ['CALL_EXISTS' as any] },
      { roleId: ADMIN, permissions: ['CALL_EXISTS' as any] },
    ]);
    const insert = normalize(clientQuery.mock.calls[2][0]);
    expect(insert).toContain(`,( '${CALL}'::UUID, '${ROLE}'::uuid, ARRAY['CALL_EXISTS']`);
    // the admin role gets moderator permissions in its own row, not twice
    expect(insert).not.toContain(`'${ADMIN}'::uuid`);
  });
});
