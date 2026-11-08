// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Additional terms: see LICENSE-ADDITIONAL-TERMS.md

/**
 * LUKSO sign-in on a gateway (srv/api/luksoUniversalProfile.ts,
 * docs/auth-identity §12): a profile linked to an account signs in as on any
 * instance; one without an account is refused before its profile is looked
 * up — the gateway prepares no sign-up. On every instance the signed text
 * must be a sign-in message made for this instance (srv/util/luksoSignIn.ts).
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
const ADDRESS = '0x' + '11'.repeat(20);

/** a sign-in message as the web app builds it (src/util/siwe.ts) */
function signInMessage({
  domain = 'app.cg',
  uri = 'https://app.cg',
  address = ADDRESS,
  chainId = '42',
  nonce = SECRET,
  issuedAt = new Date().toISOString(),
}: Partial<Record<'domain' | 'uri' | 'address' | 'chainId' | 'nonce' | 'issuedAt', string>> = {}) {
  return [
    `${domain} wants you to sign in with your Ethereum account:`,
    address,
    '',
    'Sign this to log into Common Ground.',
    '',
    `URI: ${uri}`,
    'Version: 1',
    `Chain ID: ${chainId}`,
    `Nonce: ${nonce}`,
    `Issued At: ${issuedAt}`,
  ].join('\n');
}
const data = { address: ADDRESS, signature: '0x00', message: signInMessage() };

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
    linked.mockReset();
    linked.mockResolvedValue(false);
  });

  it('refuses a profile without an account before looking it up', async () => {
    process.env.CG_GATEWAY = 'true';
    linked.mockResolvedValueOnce(false);
    await expect(prepare({ session: { signSecret: SECRET } }, {}, data)).rejects.toThrow('ACCOUNT_DOES_NOT_EXIST');
    expect(onchain.luksoGetUniversalProfileData).not.toHaveBeenCalled();
  });

  it('prepares the sign-in of a linked profile and uses up the nonce', async () => {
    process.env.CG_GATEWAY = 'true';
    linked.mockResolvedValueOnce(true);
    const session: any = { signSecret: SECRET };
    await expect(prepare({ session }, {}, data)).resolves.toMatchObject({ readyForLogin: true, readyForCreation: false });
    expect(session.lukso?.existsAlready).toBe(true);
    expect(typeof session.lukso?.preparedAt).toBe('number');
    expect(session.signSecret).toBeUndefined();
    // the same message a second time: no nonce left
    linked.mockResolvedValueOnce(true);
    await expect(prepare({ session }, {}, data)).rejects.toThrow('LUKSO_LOGIN_FAILED');
  });

  describe('refuses a message that is not a sign-in message for this instance', () => {
    const refused: Array<[string, string, string?]> = [
      ['another domain', signInMessage({ domain: 'evil.example', uri: 'https://evil.example' })],
      ['another URI', signInMessage({ uri: 'https://evil.example' })],
      ['another domain with this URI', signInMessage({ domain: 'evil.example' })],
      ['no domain line', signInMessage().split('\n').slice(1).join('\n')],
      ['only a nonce', `sign in\nNonce: ${SECRET}`],
      ['a nonce inside a foreign text', `Verify ownership for the airdrop\n\n${signInMessage({ domain: 'evil.example', uri: 'https://evil.example' })}`],
      ['another nonce', signInMessage({ nonce: 'zyxwvutsrq9876543210' })],
      ['another profile', signInMessage({ address: '0x' + '22'.repeat(20) })],
      ['another chain', signInMessage({ chainId: '1' })],
      ['an old message', signInMessage({ issuedAt: new Date(Date.now() - 20 * 60_000).toISOString() })],
      ['a message from the far future', signInMessage({ issuedAt: new Date(Date.now() + 20 * 60_000).toISOString() })],
    ];
    it.each(refused)('%s', async (_name, message) => {
      linked.mockResolvedValue(true);
      const session: any = { signSecret: SECRET };
      await expect(prepare({ session }, {}, { ...data, message })).rejects.toThrow(/^(INVALID_SIGNATURE|LUKSO_LOGIN_FAILED)$/);
      expect(onchain.luksoIsValidSignature).not.toHaveBeenCalled();
      expect(session.lukso).toBeUndefined();
      expect(session.signSecret).toBe(SECRET);
    });
  });

  it('accepts a client clock that is some minutes off, either way', async () => {
    for (const minutes of [-10, 10]) {
      linked.mockResolvedValueOnce(true);
      const message = signInMessage({ issuedAt: new Date(Date.now() + minutes * 60_000).toISOString() });
      await expect(prepare({ session: { signSecret: SECRET } }, {}, { ...data, message })).resolves.toMatchObject({ readyForLogin: true });
    }
  });

  it('refuses without a nonce in the session', async () => {
    await expect(prepare({ session: {} }, {}, data)).rejects.toThrow('LUKSO_LOGIN_FAILED');
    expect(onchain.luksoIsValidSignature).not.toHaveBeenCalled();
  });

  it('accepts a checksummed profile address in the message', async () => {
    linked.mockResolvedValueOnce(true);
    const address = '0x52908400098527886E0F7030069857D2E4169EE7';
    await expect(prepare({ session: { signSecret: SECRET } }, {}, { ...data, address: address.toLowerCase(), message: signInMessage({ address }) }))
      .resolves.toMatchObject({ readyForLogin: true });
  });

  it('the main instance still prepares a sign-up for a new profile', async () => {
    linked.mockResolvedValueOnce(false);
    await expect(prepare({ session: { signSecret: SECRET } }, {}, data)).resolves.toMatchObject({ readyForCreation: true });
  });
});
