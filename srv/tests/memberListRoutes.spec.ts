// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Additional terms: see LICENSE-ADDITIONAL-TERMS.md

/**
 * `/Community/getMemberList` and `/Community/getChannelMemberList` proxy the
 * memberlist service. A service that answers without a list (an empty body,
 * as it did for a community or channel created less than a second ago) must
 * become an empty member list, not an error from the binary-id conversion.
 * The handlers are captured from `registerPostRoute`; everything else is mocked.
 */

const handlers: Record<string, (request: any, response: any, data: any) => Promise<any>> = {};
const axiosPost = jest.fn();
// `/getChannelMemberList` checks channel access before asking memberlist;
// these cases always pass it (channelMemberListAccess.spec.ts covers the check)
const messageHelper = { isChannelInActiveCommunity: jest.fn() };
const permissionHelper = { hasPermissions: jest.fn() };

jest.mock('../api/util', () => ({
  registerPostRoute: (_router: unknown, path: string, _validator: unknown, handler: any) => {
    handlers[path] = handler;
  },
  convertEventPermissionToCallPermission: jest.fn(),
}));
jest.mock('../util/axios', () => ({
  __esModule: true,
  default: { post: (...args: any[]) => axiosPost(...args) },
}));
jest.mock('../validators', () => {
  // any validators.X.Y.Z lookup resolves; the captured handlers skip validation
  const anything: any = new Proxy(() => undefined, { get: () => anything });
  return { __esModule: true, default: anything };
});
jest.mock('../redis', () => ({ __esModule: true, default: { get: jest.fn(), getClient: jest.fn(() => ({})) } }));
jest.mock('../api/emails', () => ({ __esModule: true, default: {}, emailEnabled: () => false }));
for (const repository of [
  'communities', 'articles', 'communityEvents', 'event', 'onchain', 'calls',
  'files', 'newsletter', 'users',
]) {
  jest.doMock(`../repositories/${repository}`, () => ({ __esModule: true, default: {} }));
}
jest.doMock('../repositories/messages', () => ({ __esModule: true, default: messageHelper }));
jest.doMock('../repositories/permissions', () => ({ __esModule: true, default: permissionHelper }));

import { emptyChannelMemberList, emptyMemberList } from '../common/memberLists';
import { convertUuidToBinary } from '../util/memberListHelpers';

const COMMUNITY = '00000000-0000-4000-8000-0000000000c1';
const CHANNEL = '00000000-0000-4000-8000-0000000000c2';
const USER = '00000000-0000-4000-8000-0000000000a1';
const ROLE = '00000000-0000-4000-8000-0000000000b1';

beforeAll(() => {
  // loaded after the doMock calls above
  require('../api/community');
});

beforeEach(() => {
  axiosPost.mockReset();
  messageHelper.isChannelInActiveCommunity.mockReset().mockResolvedValue(true);
  permissionHelper.hasPermissions.mockReset().mockResolvedValue(true);
});

describe('/getMemberList', () => {
  const data = { communityId: COMMUNITY, offset: 0, limit: 10 };

  it('answers an empty member list when the service answers without one', async () => {
    for (const body of ['', null, undefined]) {
      axiosPost.mockResolvedValueOnce({ status: 200, data: body });
      await expect(handlers['/getMemberList']({ session: {} }, {}, data)).resolves.toEqual(emptyMemberList());
    }
  });

  it('converts a real list to uuids', async () => {
    axiosPost.mockResolvedValueOnce({
      status: 200,
      data: { ...emptyMemberList(), totalCount: 1, resultCount: 1, roles: [[convertUuidToBinary(ROLE), 1]], online: [[convertUuidToBinary(USER), [convertUuidToBinary(ROLE)]]] },
    });
    await expect(handlers['/getMemberList']({ session: {} }, {}, data)).resolves.toEqual({
      ...emptyMemberList(), totalCount: 1, resultCount: 1, roles: [[ROLE, 1]], online: [[USER, [ROLE]]],
    });
  });
});

describe('/getChannelMemberList', () => {
  const data = { communityId: COMMUNITY, channelId: CHANNEL, offset: 0, limit: 10 };

  it('answers an empty channel member list when the service answers without one', async () => {
    for (const body of ['', null, undefined]) {
      axiosPost.mockResolvedValueOnce({ status: 200, data: body });
      await expect(handlers['/getChannelMemberList']({ session: {} }, {}, data)).resolves.toEqual(emptyChannelMemberList());
    }
  });

  it('converts a real list to uuids', async () => {
    axiosPost.mockResolvedValueOnce({
      status: 200,
      data: { ...emptyChannelMemberList(), count: 1, adminCount: 1, admin: [[convertUuidToBinary(USER), [convertUuidToBinary(ROLE)]]] },
    });
    await expect(handlers['/getChannelMemberList']({ session: {} }, {}, data)).resolves.toEqual({
      ...emptyChannelMemberList(), count: 1, adminCount: 1, admin: [[USER, [ROLE]]],
    });
  });
});
