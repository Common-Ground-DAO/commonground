// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Additional terms: see LICENSE-ADDITIONAL-TERMS.md

/**
 * LUKSO sign-in on a gateway (srv/api/luksoUniversalProfile.ts,
 * docs/auth-identity §12): a profile linked to an account signs in as on any
 * instance; one without an account is refused before its profile is looked
 * up — the gateway prepares no sign-up.
 */

process.env.BASE_URL = 'https://app.cg';
process.env.DEPLOYMENT = 'prod';

type Handler = (request: any, response: any, data: any) => Promise<any>;
const routes: Record<string, Handler> = {};
jest.doMock('../api/util', () => ({
  registerPostRoute: (_router: unknown, path: string, _validator: unknown, handler: Handler) => {
    routes[path] = handler;
  },
}));
jest.doMock('../api/user', () => ({ SIGNABLE_SECRET_LENGTH: 20 }));
jest.doMock('../util/rateLimit', () => ({ __esModule: true, default: () => jest.fn(async () => undefined) }));
const onchain = {
  luksoIsValidSignature: jest.fn(async () => true),
  luksoGetUniversalProfileData: jest.fn(async () => ({ username: 'someone', profileImageUrl: 'https://example.org/p.png', description: '' })),
};
jest.doMock('../repositories/onchain', () => ({ __esModule: true, default: onchain }));
const linked = jest.fn(async () => false);
jest.doMock('../repositories/users', () => ({ __esModule: true, default: { isUniversalProfileAlreadyLinked: (...args: unknown[]) => linked(...(args as [])) } }));

const SECRET = 'abcdefghij0123456789';
const data = { address: '0x' + '11'.repeat(20), signature: '0x00', message: `sign in\nNonce: ${SECRET}` };

describe('Lukso/PrepareLuksoAction on a gateway', () => {
  let prepare: Handler;
  beforeAll(() => {
    jest.isolateModules(() => {
      require('../api/luksoUniversalProfile');
    });
    prepare = routes['/PrepareLuksoAction'];
  });
  afterEach(() => {
    delete process.env.CG_GATEWAY;
    jest.clearAllMocks();
  });

  it('refuses a profile without an account before looking it up', async () => {
    process.env.CG_GATEWAY = 'true';
    linked.mockResolvedValueOnce(false);
    await expect(prepare({ session: { signSecret: SECRET } }, {}, data)).rejects.toThrow('ACCOUNT_DOES_NOT_EXIST');
    expect(onchain.luksoGetUniversalProfileData).not.toHaveBeenCalled();
  });

  it('prepares the sign-in of a linked profile', async () => {
    process.env.CG_GATEWAY = 'true';
    linked.mockResolvedValueOnce(true);
    const session: any = { signSecret: SECRET };
    await expect(prepare({ session }, {}, data)).resolves.toMatchObject({ readyForLogin: true, readyForCreation: false });
    expect(session.lukso?.existsAlready).toBe(true);
  });

  it('the main instance still prepares a sign-up for a new profile', async () => {
    linked.mockResolvedValueOnce(false);
    await expect(prepare({ session: { signSecret: SECRET } }, {}, data)).resolves.toMatchObject({ readyForCreation: true });
  });
});
