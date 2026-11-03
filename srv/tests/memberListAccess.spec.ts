// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Additional terms: see LICENSE-ADDITIONAL-TERMS.md

/**
 * `/Community/getMemberList` and `/Community/getUserCommunityRoleIds` answer
 * from the memberlist service.
 *
 * - getMemberList: members of the community (a claimed role in the live
 *   community) get the full answer for any window, search and role filter.
 *   Everyone else may only ask for the first few members (offset 0,
 *   limit <= 6, no search, no role filter) and gets a preview: counts and
 *   member ids, without roles, presence split or per-role counts, from the
 *   service's preview (the first members by name, independent of presence;
 *   see memberlistService.spec.ts), in the service's order.
 * - getUserCommunityRoleIds: needs a session; the caller is the user
 *   themself or a member of the community.
 *
 * The route handlers are captured from `registerPostRoute` and called
 * directly, with every repository and the memberlist request mocked.
 */

const handlers: Record<string, (request: any, response: any, data: any) => Promise<any>> = {};

const permissionHelper = {
  hasPermissions: jest.fn(),
  hasPermissionsOrThrow: jest.fn(),
  hasTrustOrThrow: jest.fn(),
  isMemberOfActiveCommunity: jest.fn(),
};
const axios = { post: jest.fn() };

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
jest.mock('../repositories/messages', () => ({ __esModule: true, default: {} }));
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

const ME = '00000000-0000-4000-8000-000000000001';
const ONLINE = '00000000-0000-4000-8000-000000000002';
const OFFLINE = '00000000-0000-4000-8000-000000000003';
const ROLE = '00000000-0000-4000-8000-0000000000e1';
const COMMUNITY = '00000000-0000-4000-8000-0000000000c1';

const asUser = (id: string) => ({ session: { user: { id } } });
const anonymous = () => ({ session: {} });
const getMemberList = (req: any, data: any) => handlers['/getMemberList'](req, {}, { communityId: COMMUNITY, ...data });
const getUserCommunityRoleIds = (req: any, userId: string) =>
  handlers['/getUserCommunityRoleIds'](req, {}, { userId, communityId: COMMUNITY });

// what memberlist answers: ids in its binary (utf16le) encoding
const toBinary = (uuid: string) => Buffer.from(uuid.replace(/-/g, ''), 'hex').toString('utf16le');
const memberlistAnswer = () => ({
  totalCount: 2,
  resultCount: 2,
  roles: [[toBinary(ROLE), 2]],
  online: [[toBinary(ONLINE), [toBinary(ROLE)]]],
  offline: [[toBinary(OFFLINE), [toBinary(ROLE)]]],
});
// the service's preview: OFFLINE sorts first by name
const memberlistPreview = (limit: number) => ({
  totalCount: 2,
  resultCount: 2,
  roles: [],
  online: [],
  offline: [[toBinary(OFFLINE), []], [toBinary(ONLINE), []]].slice(0, limit),
});
const answerByUrl = (url: string, body: string) => ({
  data: url.endsWith('/getMemberListPreview') ? memberlistPreview(JSON.parse(body).limit) : memberlistAnswer(),
});
const calledUrls = () => axios.post.mock.calls.map(([url]: [string]) => url);
const fullAnswer = {
  totalCount: 2,
  resultCount: 2,
  roles: [[ROLE, 2]],
  online: [[ONLINE, [ROLE]]],
  offline: [[OFFLINE, [ROLE]]],
};
const previewAnswer = {
  totalCount: 2,
  resultCount: 2,
  online: [],
  offline: [[OFFLINE, []], [ONLINE, []]],
  roles: [],
};

beforeEach(() => {
  jest.clearAllMocks();
  permissionHelper.isMemberOfActiveCommunity.mockResolvedValue(false);
});

describe('/getMemberList', () => {
  beforeEach(() => {
    axios.post.mockImplementation(async (url: string, body: string) => answerByUrl(url, body));
  });

  describe('for a member of the community', () => {
    beforeEach(() => {
      permissionHelper.isMemberOfActiveCommunity.mockResolvedValue(true);
    });

    it.each([
      ['the first window', { offset: 0, limit: 80 }],
      ['a later window', { offset: 80, limit: 80 }],
      ['a search', { offset: 0, limit: 80, search: 'ali' }],
      ['a role filter', { offset: 0, limit: 80, roleId: ROLE }],
      ['the role counts (limit 1)', { offset: 0, limit: 1 }],
    ])('answers %s in full', async (_label, data) => {
      await expect(getMemberList(asUser(ME), data)).resolves.toEqual(fullAnswer);
      expect(permissionHelper.isMemberOfActiveCommunity).toHaveBeenCalledWith(ME, COMMUNITY);
      expect(calledUrls()).toEqual(['http://memberlist:4000/getMemberListWindow']);
      const body = JSON.parse(axios.post.mock.calls[0][1]);
      expect(body.offset).toBe(data.offset);
      expect(body.limit).toBe(data.limit);
    });
  });

  describe('for a signed-in non-member', () => {
    it('answers the service preview of the first six members', async () => {
      await expect(getMemberList(asUser(ME), { offset: 0, limit: 6 })).resolves.toEqual(previewAnswer);
      expect(permissionHelper.isMemberOfActiveCommunity).toHaveBeenCalledWith(ME, COMMUNITY);
      expect(calledUrls()).toEqual(['http://memberlist:4000/getMemberListPreview']);
      expect(JSON.parse(axios.post.mock.calls[0][1])).toEqual({ communityId: toBinary(COMMUNITY), limit: 6 });
    });

    it('caps the preview at the requested limit, in the service order (an offline member that sorts first comes first)', async () => {
      const result = await getMemberList(asUser(ME), { offset: 0, limit: 1 });
      expect(JSON.parse(axios.post.mock.calls[0][1]).limit).toBe(1);
      expect(result.offline).toEqual([[OFFLINE, []]]);
      expect(result.online).toEqual([]);
    });

    it('never carries more than six member ids, roles or a presence split', async () => {
      const many = Array.from({ length: 8 }, (_, i) => `00000000-0000-4000-8000-0000000001${String(i).padStart(2, '0')}`);
      axios.post.mockResolvedValue({ data: {
        totalCount: 8, resultCount: 8, roles: [[toBinary(ROLE), 8]],
        online: [[toBinary(ONLINE), [toBinary(ROLE)]]],
        offline: many.map(id => [toBinary(id), [toBinary(ROLE)]]),
      } });
      const result = await getMemberList(asUser(ME), { offset: 0, limit: 6 });
      expect(result.offline).toEqual(many.slice(0, 6).map(id => [id, []]));
      expect(result.online).toEqual([]);
      expect(result.roles).toEqual([]);
      expect(result.totalCount).toBe(8);
    });

    it.each([
      ['an offset', { offset: 6, limit: 6 }],
      ['a limit above six', { offset: 0, limit: 7 }],
      ['a search', { offset: 0, limit: 6, search: 'ali' }],
      ['a role filter', { offset: 0, limit: 6, roleId: ROLE }],
    ])('refuses %s', async (_label, data) => {
      await expect(getMemberList(asUser(ME), data)).rejects.toThrow('NOT_ALLOWED');
      expect(axios.post).not.toHaveBeenCalled();
    });
  });

  describe('for a visitor', () => {
    it('answers a preview without asking for membership', async () => {
      await expect(getMemberList(anonymous(), { offset: 0, limit: 6 })).resolves.toEqual(previewAnswer);
      expect(permissionHelper.isMemberOfActiveCommunity).not.toHaveBeenCalled();
      expect(calledUrls()).toEqual(['http://memberlist:4000/getMemberListPreview']);
    });

    it.each([
      ['an offset', { offset: 1, limit: 6 }],
      ['a limit above six', { offset: 0, limit: 100 }],
      ['a search', { offset: 0, limit: 6, search: 'ali' }],
      ['a role filter', { offset: 0, limit: 6, roleId: ROLE }],
    ])('asks to log in for %s', async (_label, data) => {
      await expect(getMemberList(anonymous(), data)).rejects.toThrow('LOGIN_REQUIRED');
      expect(axios.post).not.toHaveBeenCalled();
    });
  });
});

describe('/getUserCommunityRoleIds', () => {
  beforeEach(() => {
    axios.post.mockResolvedValue({ data: [toBinary(ROLE)] });
  });

  it('answers the user themself, member or not', async () => {
    await expect(getUserCommunityRoleIds(asUser(ME), ME)).resolves.toEqual([ROLE]);
    expect(permissionHelper.isMemberOfActiveCommunity).not.toHaveBeenCalled();
    expect(JSON.parse(axios.post.mock.calls[0][1])).toEqual({
      userId: toBinary(ME),
      communityId: toBinary(COMMUNITY),
    });
  });

  it('answers a member of the community about another user', async () => {
    permissionHelper.isMemberOfActiveCommunity.mockResolvedValue(true);
    await expect(getUserCommunityRoleIds(asUser(ME), ONLINE)).resolves.toEqual([ROLE]);
    expect(permissionHelper.isMemberOfActiveCommunity).toHaveBeenCalledWith(ME, COMMUNITY);
  });

  it('refuses a non-member asking about another user', async () => {
    await expect(getUserCommunityRoleIds(asUser(ME), ONLINE)).rejects.toThrow('NOT_ALLOWED');
    expect(permissionHelper.isMemberOfActiveCommunity).toHaveBeenCalledWith(ME, COMMUNITY);
    expect(axios.post).not.toHaveBeenCalled();
  });

  it('asks a visitor to log in', async () => {
    await expect(getUserCommunityRoleIds(anonymous(), ONLINE)).rejects.toThrow('LOGIN_REQUIRED');
    expect(permissionHelper.isMemberOfActiveCommunity).not.toHaveBeenCalled();
    expect(axios.post).not.toHaveBeenCalled();
  });
});
