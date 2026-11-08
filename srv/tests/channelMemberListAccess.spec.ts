// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Additional terms: see LICENSE-ADDITIONAL-TERMS.md

/**
 * `/Community/getChannelMemberList` answers with the members of a channel
 * (user ids, presence, roles) from the memberlist service. It follows the
 * rule for reading the channel: the channel and its community exist, and
 * the caller has CHANNEL_EXISTS + CHANNEL_READ, where the Public role covers
 * visitors.
 *
 * The route handler is captured from `registerPostRoute` and called
 * directly, with every repository and the memberlist request mocked.
 */

const handlers: Record<string, (request: any, response: any, data: any) => Promise<any>> = {};

const permissionHelper = {
  hasPermissions: jest.fn(),
  hasPermissionsOrThrow: jest.fn(),
  hasTrustOrThrow: jest.fn(),
};
const axios = { post: jest.fn() };
const messageHelper = { isChannelInActiveCommunity: jest.fn() };

jest.mock('../api/util', () => ({
  registerPostRoute: (_router: unknown, path: string, _validator: unknown, handler: any) => {
    handlers[path] = handler;
  },
  convertEventPermissionToCallPermission: jest.fn(),
}));
jest.mock('../validators', () => ({
  __esModule: true,
  default: { API: { Community: new Proxy({}, { get: () => undefined }) } },
}));
jest.mock('../repositories/permissions', () => ({ __esModule: true, default: permissionHelper }));
jest.mock('../repositories/messages', () => ({ __esModule: true, default: messageHelper }));
jest.mock('../util/axios', () => ({ __esModule: true, default: axios }));
jest.mock('../repositories/communities', () => ({ __esModule: true, default: {} }));
jest.mock('../repositories/articles', () => ({ __esModule: true, default: {} }));
jest.mock('../repositories/communityEvents', () => ({ __esModule: true, default: {} }));
jest.mock('../repositories/event', () => ({ __esModule: true, default: { emit: jest.fn() } }));
jest.mock('../repositories/onchain', () => ({ __esModule: true, default: {} }));
jest.mock('../repositories/calls', () => ({ __esModule: true, default: {} }));
jest.mock('../repositories/files', () => ({ __esModule: true, default: {} }));
jest.mock('../repositories/newsletter', () => ({ __esModule: true, default: {} }));
jest.mock('../repositories/users', () => ({ __esModule: true, default: {} }));
jest.mock('../api/emails', () => ({ __esModule: true, default: {} }));

import '../api/community';
import { ChannelPermission } from '../common/enums';

const ME = '00000000-0000-4000-8000-000000000001';
const MEMBER = '00000000-0000-4000-8000-000000000002';
const ROLE = '00000000-0000-4000-8000-0000000000e1';
const COMMUNITY = '00000000-0000-4000-8000-0000000000c1';
const CHANNEL = '00000000-0000-4000-8000-0000000000a1';

const request = { communityId: COMMUNITY, channelId: CHANNEL, offset: 0, limit: 3 };
const asUser = (id: string) => ({ session: { user: { id } } });
const anonymous = () => ({ session: {} });
const getChannelMemberList = (req: any) => handlers['/getChannelMemberList'](req, {}, request);

// what memberlist answers: ids in its binary (utf16le) encoding
const toBinary = (uuid: string) => Buffer.from(uuid.replace(/-/g, ''), 'hex').toString('utf16le');
const memberlistAnswer = () => ({
  count: 1, adminCount: 0, moderatorCount: 0, writerCount: 1, readerCount: 0, offlineCount: 0,
  admin: [], moderator: [], writer: [[toBinary(MEMBER), [toBinary(ROLE)]]], reader: [], offline: [],
});

beforeEach(() => {
  jest.clearAllMocks();
  messageHelper.isChannelInActiveCommunity.mockResolvedValue(true);
  axios.post.mockResolvedValue({ data: memberlistAnswer() });
});

describe('/getChannelMemberList', () => {
  it('answers a caller who may read the channel', async () => {
    permissionHelper.hasPermissions.mockResolvedValue(true);
    const result = await getChannelMemberList(asUser(ME));
    expect(permissionHelper.hasPermissions).toHaveBeenCalledWith({
      userId: ME,
      communityId: COMMUNITY,
      channelId: CHANNEL,
      permissions: [ChannelPermission.CHANNEL_EXISTS, ChannelPermission.CHANNEL_READ],
    });
    expect(messageHelper.isChannelInActiveCommunity).toHaveBeenCalledWith(COMMUNITY, CHANNEL);
    expect(axios.post).toHaveBeenCalledTimes(1);
    expect(result.writer).toEqual([[MEMBER, [ROLE]]]);
  });

  it('answers a visitor when the channel is readable without login (Public role)', async () => {
    permissionHelper.hasPermissions.mockResolvedValue(true);
    const result = await getChannelMemberList(anonymous());
    expect(permissionHelper.hasPermissions).toHaveBeenCalledWith(expect.objectContaining({
      userId: undefined,
      communityId: COMMUNITY,
      channelId: CHANNEL,
    }));
    expect(result.count).toBe(1);
  });

  it('refuses a visitor when the channel needs a role', async () => {
    permissionHelper.hasPermissions.mockResolvedValue(false);
    await expect(getChannelMemberList(anonymous())).rejects.toThrow('LOGIN_REQUIRED');
    expect(axios.post).not.toHaveBeenCalled();
  });

  it('refuses a signed-in user without read access (non-member, or a member without the role)', async () => {
    permissionHelper.hasPermissions.mockResolvedValue(false);
    await expect(getChannelMemberList(asUser(ME))).rejects.toThrow('NOT_ALLOWED');
    expect(axios.post).not.toHaveBeenCalled();
  });

  it('refuses when the caller may only see that the channel exists', async () => {
    permissionHelper.hasPermissions.mockImplementation(async ({ permissions }: { permissions: string[] }) =>
      !permissions.includes(ChannelPermission.CHANNEL_READ));
    await expect(getChannelMemberList(asUser(ME))).rejects.toThrow('NOT_ALLOWED');
    expect(axios.post).not.toHaveBeenCalled();
  });

  it.each([
    ['a signed-in user', () => asUser(ME)],
    ['a visitor', anonymous],
  ])('refuses %s when the channel or its community is deleted or the pair does not match', async (_label, req) => {
    messageHelper.isChannelInActiveCommunity.mockResolvedValue(false);
    permissionHelper.hasPermissions.mockResolvedValue(true);
    await expect(getChannelMemberList(req())).rejects.toThrow('NOT_ALLOWED');
    expect(messageHelper.isChannelInActiveCommunity).toHaveBeenCalledWith(COMMUNITY, CHANNEL);
    expect(axios.post).not.toHaveBeenCalled();
  });
});
