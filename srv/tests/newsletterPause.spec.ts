// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Additional terms: see LICENSE-ADDITIONAL-TERMS.md

const mockSendMail = jest.fn(async () => ({}));
jest.mock('nodemailer', () => ({ createTransport: () => ({ sendMail: mockSendMail }) }));
jest.mock('../repositories/communities', () => ({ __esModule: true, default: {} }));
jest.mock('../common/util', () => ({ getUrl: () => '/event/test', generateEventICSFile: jest.fn() }));
jest.mock('../util/urls', () => ({ __esModule: true, default: { APP_URL: 'https://cg.test', APP_HOSTNAME: 'cg.test' } }));
jest.mock('../util/sessionSecret', () => ({ configuredSessionSecret: () => 'test-session-secret' }));

const savedEnv = { ...process.env };
let mail: typeof import('../api/emails');
const recipient = { userId: '00000000-0000-4000-8000-000000000001', email: 'test@example.org' };
const post: any = { title: 'Example', community: 'Test', url: '/article/example' };

beforeAll(() => {
  process.env.SMTP_HOST = 'mailpit';
  process.env.SMTP_PORT = '1025';
  process.env.SMTP_SECURITY = 'none';
  delete process.env.SMTP_USER;
  delete process.env.SMTP_PASSWORD;
  process.env.EMAIL_FROM = 'no-reply@cg.test';
  mail = require('../api/emails');
});
beforeEach(() => {
  mockSendMail.mockClear();
  process.env.CG_ENABLE_NEWSLETTERS = 'false';
});
afterAll(() => { process.env = savedEnv; });

it('refuses both newsletter senders before SMTP, without reporting success', async () => {
  expect(mail.emailEnabled()).toBe(true);
  expect(mail.newslettersEnabled()).toBe(false);
  expect(() => mail.requireNewsletterDelivery()).toThrow('NEWSLETTER_DISABLED');
  await expect(mail.default.sendNewsletter(recipient, [post], [])).rejects.toThrow('NEWSLETTER_DISABLED');
  await expect(mail.default.sendArticleAsEmail(recipient, post, 'community')).rejects.toThrow('NEWSLETTER_DISABLED');
  expect(mockSendMail).not.toHaveBeenCalled();
});

it('still sends login, verification, security and event mails while newsletters are paused', async () => {
  await mail.default.sendOneTimePasswordEmail(recipient.email, '12345678');
  await mail.default.sendVerificationEmail(recipient.email, '87654321');
  await mail.default.sendAddressInUseEmail(recipient.email);
  await mail.default.sendEventEmail(recipient.email, {
    type: 'starting', community: 'Test', communityId: 'community', communityUrl: 'test',
    event: { title: 'Test event' },
  } as any);
  expect(mockSendMail).toHaveBeenCalledTimes(4);
});

it.each([undefined, 'true'])('keeps newsletter sending available with CG_ENABLE_NEWSLETTERS=%s', async value => {
  if (value === undefined) delete process.env.CG_ENABLE_NEWSLETTERS;
  else process.env.CG_ENABLE_NEWSLETTERS = value;
  expect(mail.newslettersEnabled()).toBe(true);
  await mail.default.sendNewsletter(recipient, [post], []);
  await mail.default.sendArticleAsEmail(recipient, post, 'community');
  expect(mockSendMail).toHaveBeenCalledTimes(2);
});
