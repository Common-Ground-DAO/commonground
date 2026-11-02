// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Additional terms: see LICENSE-ADDITIONAL-TERMS.md

/**
 * Notification read state and unread count: `markAsRead` / `markAllAsRead`
 * write and emit only on a real change, every count is a number and travels
 * with its database time, `getUnreadCount` keeps answering old clients (no
 * body) with the plain count.
 *
 * The route handlers are captured from `registerPostRoute`; the repository
 * is the real one on a mocked pool, `eventHelper.emit` is mocked.
 */

const handlers: Record<string, { validator: any; handler: (request: any, response: any, data: any) => Promise<any> }> = {};
const poolQuery = jest.fn();
const emit = jest.fn();

jest.mock('../api/util', () => ({
  registerPostRoute: (_router: unknown, path: string, validator: unknown, handler: any) => {
    handlers[path] = { validator, handler };
  },
}));
jest.mock('../util/postgres', () => ({
  __esModule: true,
  default: { query: (...args: any[]) => poolQuery(...args) },
}));
jest.mock('../repositories/event', () => ({ __esModule: true, default: { emit: (...args: any[]) => emit(...args) } }));

import '../api/notifications';
import notificationHelper from '../repositories/notifications';

const ME = '00000000-0000-4000-8000-000000000001';
const NOTIFICATION = '00000000-0000-4000-8000-0000000000f1';
const COUNT_AT = new Date('2026-11-02T12:00:00.123Z');
const UPDATED_AT = new Date('2026-11-02T11:59:59.000Z');

const asUser = (id: string) => ({ session: { user: { id } } });
const normalize = (sql: string) => sql.replace(/\s+/g, ' ').trim();

/** answers the count query with a numeric string, as pg does for int8 */
function answer(write: (sql: string) => any) {
  poolQuery.mockImplementation(async (sql: string) => {
    if (normalize(sql).startsWith('SELECT COUNT(*)::int AS "unreadCount", now() AS "unreadCountAt"')) {
      return { rows: [{ unreadCount: '3', unreadCountAt: COUNT_AT }] };
    }
    return write(normalize(sql));
  });
}

async function call(path: string, body: unknown, request: any = asUser(ME)) {
  const { validator, handler } = handlers[path];
  // registerPostRoute hands a missing body over as `{}`
  const data = validator ? await validator.validateAsync(body ?? {}) : undefined;
  return handler(request, {}, data);
}

beforeEach(() => {
  poolQuery.mockReset();
  emit.mockReset();
});

describe('Notification/markAsRead', () => {
  it('writes only an unread notification', async () => {
    answer(() => ({ rows: [{ updatedAt: UPDATED_AT, found: true }] }));
    await call('/markAsRead', { notificationId: NOTIFICATION });
    const [sql, params] = poolQuery.mock.calls[0];
    expect(normalize(sql)).toContain('WHERE "userId" = $1 AND "id" = $2 AND "read" = FALSE');
    expect(params).toEqual([ME, NOTIFICATION]);
  });

  it('emits the update with the unread count as a number', async () => {
    answer(() => ({ rows: [{ updatedAt: UPDATED_AT, found: true }] }));
    await expect(call('/markAsRead', { notificationId: NOTIFICATION })).resolves.toBeUndefined();
    expect(emit).toHaveBeenCalledTimes(1);
    expect(emit).toHaveBeenCalledWith({
      type: 'cliNotificationEvent',
      action: 'update',
      data: { id: NOTIFICATION, updatedAt: UPDATED_AT.toISOString(), read: true },
      unreadCount: 3,
      unreadCountAt: COUNT_AT.toISOString(),
    }, { userIds: [ME] });
  });

  it('emits nothing for a notification that is already read', async () => {
    answer(() => ({ rows: [{ updatedAt: null, found: true }] }));
    await expect(call('/markAsRead', { notificationId: NOTIFICATION })).resolves.toBeUndefined();
    expect(emit).not.toHaveBeenCalled();
    // and does not read the count either
    expect(poolQuery).toHaveBeenCalledTimes(1);
  });

  it('refuses an unknown notification', async () => {
    answer(() => ({ rows: [{ updatedAt: null, found: false }] }));
    await expect(call('/markAsRead', { notificationId: NOTIFICATION })).rejects.toThrow('NOT_FOUND');
    expect(emit).not.toHaveBeenCalled();
  });

  it('still emits (without a count) when the count cannot be read', async () => {
    const error = jest.spyOn(console, 'error').mockImplementation(() => undefined);
    poolQuery.mockImplementation(async (sql: string) => {
      if (normalize(sql).startsWith('SELECT COUNT(*)::int')) {
        throw new Error('connection lost');
      }
      return { rows: [{ updatedAt: UPDATED_AT, found: true }] };
    });
    await call('/markAsRead', { notificationId: NOTIFICATION });
    expect(emit).toHaveBeenCalledWith({
      type: 'cliNotificationEvent',
      action: 'update',
      data: { id: NOTIFICATION, updatedAt: UPDATED_AT.toISOString(), read: true },
    }, { userIds: [ME] });
    error.mockRestore();
  });

  it('requires a login', async () => {
    await expect(call('/markAsRead', { notificationId: NOTIFICATION }, { session: {} })).rejects.toThrow('LOGIN_REQUIRED');
  });
});

describe('Notification/markAllAsRead', () => {
  it('writes only unread rows and emits allread with the count', async () => {
    answer(() => ({ rows: [{ changed: '2', updatedAt: UPDATED_AT }] }));
    await expect(call('/markAllAsRead', undefined)).resolves.toBeUndefined();
    const [sql, params] = poolQuery.mock.calls[0];
    expect(normalize(sql)).toContain('WHERE "userId" = $1 AND "read" = FALSE');
    expect(params).toEqual([ME]);
    expect(emit).toHaveBeenCalledWith({
      type: 'cliNotificationEvent',
      action: 'allread',
      data: { updatedAt: UPDATED_AT.toISOString() },
      unreadCount: 3,
      unreadCountAt: COUNT_AT.toISOString(),
    }, { userIds: [ME] });
  });

  it('emits nothing when nothing was unread', async () => {
    answer(() => ({ rows: [{ changed: 0, updatedAt: null }] }));
    await expect(call('/markAllAsRead', undefined)).resolves.toBeUndefined();
    expect(emit).not.toHaveBeenCalled();
  });
});

describe('Notification/getUnreadCount', () => {
  it('answers a call without a body (older clients) with the plain count as a number', async () => {
    answer(() => { throw new Error('unexpected query'); });
    await expect(call('/getUnreadCount', undefined)).resolves.toBe(3);
    await expect(call('/getUnreadCount', {})).resolves.toBe(3);
  });

  it('answers withTime with the count and its database time', async () => {
    answer(() => { throw new Error('unexpected query'); });
    await expect(call('/getUnreadCount', { withTime: true })).resolves.toEqual({
      unreadCount: 3,
      unreadCountAt: COUNT_AT.toISOString(),
    });
    const [sql, params] = poolQuery.mock.calls[0];
    expect(normalize(sql)).toContain('WHERE "userId" = $1 AND "read" = FALSE');
    expect(params).toEqual([ME]);
  });

  it('rejects unknown keys', async () => {
    await expect(call('/getUnreadCount', { other: 1 })).rejects.toThrow();
  });

  it('requires a login', async () => {
    await expect(call('/getUnreadCount', undefined, { session: {} })).rejects.toThrow('LOGIN_REQUIRED');
  });
});

describe('notificationHelper.getUnreadCount', () => {
  it('returns a number (the login response field)', async () => {
    answer(() => { throw new Error('unexpected query'); });
    const count = await notificationHelper.getUnreadCount(ME);
    expect(count).toBe(3);
    expect(typeof count).toBe('number');
  });
});

describe('new notification events', () => {
  const notification: Models.Notification.ApiNotification = {
    id: NOTIFICATION,
    type: 'Follower',
    text: 'is now following you',
    read: false,
    createdAt: UPDATED_AT.toISOString(),
    updatedAt: UPDATED_AT.toISOString(),
    subjectItemId: null,
    subjectCommunityId: null,
    subjectUserId: null,
    subjectArticleId: null,
    extraData: null,
  } as any;

  it('carry the unread count', async () => {
    // the device lookup for web push finds no subscription
    answer(() => ({ rows: [] }));
    await notificationHelper.sendWsOrWebPushNotificationEvent({
      userId: ME,
      event: { type: 'cliNotificationEvent', action: 'new', data: notification },
    });
    expect(emit).toHaveBeenCalledWith({
      type: 'cliNotificationEvent',
      action: 'new',
      data: notification,
      unreadCount: 3,
      unreadCountAt: COUNT_AT.toISOString(),
    }, { userIds: [ME] });
  });

  it('are not emitted (and not counted) for DMs', async () => {
    answer(() => ({ rows: [] }));
    await notificationHelper.sendWsOrWebPushNotificationEvent({
      userId: ME,
      event: { type: 'cliNotificationEvent', action: 'new', data: { ...notification, type: 'DM' } as any },
    });
    expect(emit).not.toHaveBeenCalled();
    expect(poolQuery.mock.calls.some(([sql]) => normalize(sql).startsWith('SELECT COUNT(*)::int'))).toBe(false);
  });
});
