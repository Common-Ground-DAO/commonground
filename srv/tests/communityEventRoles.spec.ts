// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Additional terms: see LICENSE-ADDITIONAL-TERMS.md

/**
 * `/Community/createCommunityEvent` and `/Community/updateCommunityEvent`
 * check the event's full role permission list against the live roles of the
 * community before they write anything: a refused list creates no call and
 * changes neither the event nor its call. The route handlers are captured
 * from `registerPostRoute` and called directly, with the repositories mocked.
 */

const handlers: Record<string, (request: any, response: any, data: any) => Promise<any>> = {};

const permissionHelper = {
  hasPermissions: jest.fn(),
  hasPermissionsOrThrow: jest.fn(),
};
const communityEventHelper = {
  checkEventRolePermissions: jest.fn(),
  createCommunityEvent: jest.fn(),
  updateCommunityEvent: jest.fn(),
  getCommunityEvent: jest.fn(),
  isEventOngoingOrInPast: jest.fn(),
  prepareEventToSendEmail: jest.fn(),
  getUserEmailsToNotify: jest.fn(),
};
const callHelper = {
  createCall: jest.fn(),
  updateCall: jest.fn(),
  getCallSlots: jest.fn(() => ({ overallCallSlots: 10, stageSlots: 5 })),
};
const communityHelper = { getCommunityPremiumTier: jest.fn(async () => 'FREE'), isCommunityWhitelisted: jest.fn(async () => true) };
const articleHelper = { registerCommunityArticleForEmails: jest.fn() };
const requireNewsletterDelivery = jest.fn();

jest.mock('../api/util', () => ({
  registerPostRoute: (_router: unknown, path: string, _validator: unknown, handler: any) => {
    handlers[path] = handler;
  },
  convertEventPermissionToCallPermission: jest.fn((rp: any[]) => rp),
}));
jest.mock('../validators', () => ({
  __esModule: true,
  default: { API: { Community: new Proxy({}, { get: () => undefined }) } },
}));
jest.mock('../repositories/permissions', () => ({ __esModule: true, default: permissionHelper }));
jest.mock('../repositories/messages', () => ({ __esModule: true, default: {} }));
jest.mock('../util/axios', () => ({ __esModule: true, default: {} }));
jest.mock('../repositories/communities', () => ({ __esModule: true, default: communityHelper }));
jest.mock('../repositories/articles', () => ({ __esModule: true, default: articleHelper }));
jest.mock('../repositories/communityEvents', () => ({ __esModule: true, default: communityEventHelper }));
jest.mock('../repositories/event', () => ({ __esModule: true, default: { emit: jest.fn() } }));
jest.mock('../repositories/onchain', () => ({ __esModule: true, default: {} }));
jest.mock('../repositories/calls', () => ({ __esModule: true, default: callHelper }));
jest.mock('../repositories/files', () => ({ __esModule: true, default: {} }));
jest.mock('../repositories/newsletter', () => ({ __esModule: true, default: {} }));
jest.mock('../repositories/users', () => ({ __esModule: true, default: {} }));
jest.mock('../api/emails', () => ({ __esModule: true, default: {}, requireNewsletterDelivery }));
jest.mock('../util/eventMailBudget', () => ({ reserveEventMailRound: jest.fn(async () => true) }));

import '../api/community';

const ME = '00000000-0000-4000-8000-000000000001';
const COMMUNITY = '00000000-0000-4000-8000-0000000000c1';
const EVENT = '00000000-0000-4000-8000-0000000000e1';
const CALL = '00000000-0000-4000-8000-0000000000f1';
const FOREIGN_ROLE = '00000000-0000-4000-8000-0000000000a9';

const asUser = () => ({ session: { user: { id: ME } } });
const inAnHour = () => new Date(Date.now() + 3600_000).toISOString();
// a role that may only preview the event: it never reaches the call's permissions
const rolePermissions = [{ roleId: FOREIGN_ROLE, permissions: ['EVENT_PREVIEW'] }];
const eventRequest = (extra: Record<string, unknown> = {}) => ({
  communityId: COMMUNITY,
  title: 'event',
  description: null,
  type: 'call',
  scheduleDate: inAnHour(),
  duration: 60,
  rolePermissions,
  callData: { slots: 10, stageSlots: 5, audioOnly: false, hd: false },
  ...extra,
});

beforeEach(() => {
  jest.clearAllMocks();
  permissionHelper.hasPermissionsOrThrow.mockResolvedValue(undefined);
  communityEventHelper.checkEventRolePermissions.mockRejectedValue(new Error('NOT_ALLOWED'));
});

describe('/createCommunityEvent', () => {
  it('checks the full role list first: a refused list creates neither call nor event', async () => {
    await expect(handlers['/createCommunityEvent'](asUser(), {}, eventRequest())).rejects.toThrow('NOT_ALLOWED');
    expect(communityEventHelper.checkEventRolePermissions).toHaveBeenCalledWith(COMMUNITY, rolePermissions);
    expect(callHelper.createCall).not.toHaveBeenCalled();
    expect(communityEventHelper.createCommunityEvent).not.toHaveBeenCalled();
  });

  it('creates the call and the event once the list passes', async () => {
    communityEventHelper.checkEventRolePermissions.mockResolvedValue(undefined);
    callHelper.createCall.mockResolvedValue({ id: CALL });
    communityEventHelper.createCommunityEvent.mockResolvedValue({ id: EVENT });
    await handlers['/createCommunityEvent'](asUser(), {}, eventRequest());
    expect(communityEventHelper.checkEventRolePermissions.mock.invocationCallOrder[0])
      .toBeLessThan(callHelper.createCall.mock.invocationCallOrder[0]);
    expect(communityEventHelper.createCommunityEvent).toHaveBeenCalled();
  });
});

describe('/updateCommunityEvent', () => {
  it('checks the full role list against the event\'s community before the event or its call change', async () => {
    communityEventHelper.isEventOngoingOrInPast.mockResolvedValue(false);
    communityEventHelper.getCommunityEvent.mockResolvedValue({ id: EVENT, communityId: COMMUNITY, callId: CALL });
    await expect(handlers['/updateCommunityEvent'](asUser(), {}, eventRequest({ id: EVENT }))).rejects.toThrow('NOT_ALLOWED');
    expect(communityEventHelper.checkEventRolePermissions).toHaveBeenCalledWith(COMMUNITY, rolePermissions);
    expect(communityEventHelper.updateCommunityEvent).not.toHaveBeenCalled();
    expect(callHelper.updateCall).not.toHaveBeenCalled();
    expect(callHelper.createCall).not.toHaveBeenCalled();
  });
});


describe('/sendArticleAsEmail while newsletters are paused', () => {
  it('does not queue the article or change the pending newsletter', async () => {
    requireNewsletterDelivery.mockImplementationOnce(() => { throw new Error('NEWSLETTER_DISABLED'); });
    await expect(handlers['/sendArticleAsEmail'](asUser(), {}, {
      communityId: COMMUNITY, articleId: 'article',
    })).rejects.toThrow('NEWSLETTER_DISABLED');
    expect(articleHelper.registerCommunityArticleForEmails).not.toHaveBeenCalled();
  });
  it('still queues an article when delivery is enabled', async () => {
    await handlers['/sendArticleAsEmail'](asUser(), {}, { communityId: COMMUNITY, articleId: 'article' });
    expect(articleHelper.registerCommunityArticleForEmails).toHaveBeenCalledWith('article', COMMUNITY);
  });
});
