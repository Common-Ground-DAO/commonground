// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Additional terms: see LICENSE-ADDITIONAL-TERMS.md

import { createTransport, type Attachment, type SendMailOptions, type Transporter } from 'nodemailer';
import { isMainThread } from 'worker_threads';
import { EmailPost } from '../repositories/emails';
import { generateEventICSFile, getUrl } from '../common/util';
import urlConfig from '../util/urls';
import communityHelper from '../repositories/communities';
import errors from '../common/errors';
import { dockerSecret } from '../util';
import { describeMailConfig, parseMailConfig, plaintextSmtpWarning } from '../util/mailConfig';
import { createUnsubscribeToken, deriveUnsubscribeKey, type UnsubscribeTarget } from '../util/unsubscribeToken';

// SMTP is configured through the environment (srv/util/mailConfig.ts). Email
// delivery is optional: without SMTP_HOST the backend runs with email
// disabled, and callers check emailEnabled() to skip email work entirely. The
// instance config's `features.email` uses the same rule, so the UI and the
// backend agree on whether email works.
const mailConfig = parseMailConfig(process.env, urlConfig.APP_HOSTNAME);
// once per process at startup — the job workers (worker threads) import this
// module on every run and log their own "skipping" line instead
if (isMainThread) {
    console.log(describeMailConfig(mailConfig));
    const plaintextWarning = plaintextSmtpWarning(mailConfig);
    if (plaintextWarning) {
        console.error(plaintextWarning);
    }
}

export function emailEnabled(): boolean {
    return mailConfig.enabled;
}

let transporter: Transporter | undefined;
function getTransporter(): Transporter {
    if (!mailConfig.enabled) {
        throw new Error(errors.server.EMAIL_DISABLED);
    }
    if (!transporter) {
        const { host, port, security, auth } = mailConfig.config;
        transporter = createTransport({
            host,
            port,
            secure: security === 'tls',
            requireTLS: security === 'starttls',
            ignoreTLS: security === 'none',
            auth,
            // the jobs send to many recipients at once: queue the messages
            // over a few reused connections instead of one connection each
            pool: true,
            maxConnections: 5,
            maxMessages: 100,
            connectionTimeout: 30_000,
            greetingTimeout: 30_000,
            socketTimeout: 60_000,
        });
    }
    return transporter;
}

let unsubscribeKey: Buffer | null | undefined;
function getUnsubscribeKey(): Buffer | null {
    if (unsubscribeKey === undefined) {
        const secret = dockerSecret('redis_secret') || process.env.REDIS_SECRET;
        unsubscribeKey = secret ? deriveUnsubscribeKey(secret) : null;
        if (!unsubscribeKey) {
            console.warn('REDIS_SECRET is not set: notification mails are sent without one-click unsubscribe links');
        }
    }
    return unsubscribeKey;
}

/** Key the unsubscribe endpoint verifies tokens with (null: none configured). */
export function unsubscribeTokenKey(): Buffer | null {
    return getUnsubscribeKey();
}

/** One-click unsubscribe link (RFC 8058) for a notification mail, if available. */
function unsubscribeUrl(target: UnsubscribeTarget): string | null {
    const key = getUnsubscribeKey();
    if (!key) {
        return null;
    }
    return `${urlConfig.API_URL}/User/emailUnsubscribe?token=${createUnsubscribeToken(key, target)}`;
}

const escapeHtml = (str: string | null | undefined) => (str || '').replace(/[&<>"']/g, m => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' } as Record<string, string>)[m]);

const settingsUrl = () => `${urlConfig.APP_URL}/?user-settings=notifications`;

export type EventEmailOptions = {
    type: 'attending' | 'starting' | 'changed' | 'cancelled';
    community: string;
    communityId: string;
    communityUrl: string;
    event: Models.Community.Event;
    communityImage?: string;
}

export type EmailRecipient = {
    email: string;
    userId: string;
};

type OutgoingEmail = {
    to: string;
    subject: string;
    text: string;
    html: string;
    attachments?: Attachment[];
    /**
     * Notification/newsletter mails name the preference a one-click
     * unsubscribe turns off; transactional mails (login codes, verification,
     * event mails for an event the user joined) leave it out.
     */
    unsubscribe?: UnsubscribeTarget;
};

class EmailUtils {
    // the single place mail leaves the backend
    private async sendEmail(mail: OutgoingEmail) {
        if (!mailConfig.enabled) {
            console.warn(`Email delivery is not configured, dropping email to ${mail.to} ("${mail.subject}")`);
            throw new Error(errors.server.EMAIL_DISABLED);
        }
        const message: SendMailOptions = {
            from: { name: mailConfig.config.from.name, address: mailConfig.config.from.address },
            to: mail.to,
            subject: mail.subject,
            text: mail.text,
            html: mail.html,
            attachments: mail.attachments,
        };
        if (mail.unsubscribe) {
            const url = unsubscribeUrl(mail.unsubscribe);
            if (url) {
                message.headers = {
                    'List-Unsubscribe': `<${url}>`,
                    'List-Unsubscribe-Post': 'List-Unsubscribe=One-Click',
                };
            }
        }
        try {
            await getTransporter().sendMail(message);
        } catch (error: any) {
            console.error('Error sending email to: ', mail.to);
            console.error('Error: ', error?.message || error, error?.response ? `(SMTP response: ${error.response})` : '');
            throw new Error('Error sending email');
        }
    }

    /**
     * Confirms an address for an existing account: the 8-digit code, plus a
     * link that confirms it when opened while signed in to that account.
     */
    public async sendVerificationEmail(to: string, code: string) {
        // every mail link comes from the configured BASE_URL, never from the
        // request (Host / X-Forwarded-Host are client-controlled)
        const emailLink = `${urlConfig.APP_URL}/verify-email?email=${encodeURIComponent(to)}&token=${encodeURIComponent(code)}`;
        const subject = 'Confirm your email address for Common Ground';
        const html = `
        <tr>
            <td colspan="4" style="background-color:#f8f8f8;padding:20px;text-align:center;">
                <h2> Your confirmation code: ${escapeHtml(code)} </h2>
                <p> Enter it where you asked for it, or <a href="${escapeHtml(emailLink)}">open this link</a> in the browser where you are signed in. It is valid for 24 hours. If you did not ask for this, you can ignore this mail. </p>
            </td>
        </tr>`;
        const htmlTemplate = this.getHTMLTemplate(html, false);
        const text = `Your confirmation code: ${code}\n\nEnter it where you asked for it, or open this link in the browser where you are signed in:\n\n${emailLink}\n\nIt is valid for 24 hours. If you did not ask for this, you can ignore this mail.\n`;
        await this.sendEmail({ to, subject, text, html: htmlTemplate });
    }

    /** Email login: the 8-digit one-time code. */
    public async sendOneTimePasswordEmail(to: string, code: string) {
        const subject = 'Your Common Ground login code';
        const html = `
        <tr>
            <td colspan="4" style="background-color:#f8f8f8;padding:20px;text-align:center;">
                <h2> Your login code: ${escapeHtml(code)} </h2>
                <p> It is valid for 15 minutes. If you did not try to log in, you can ignore this mail. </p>
            </td>
        </tr>`;
        const htmlTemplate = this.getHTMLTemplate(html, false);
        const text = `Your login code: ${code}\n\nIt is valid for 15 minutes. If you did not try to log in, you can ignore this mail.\n`;
        await this.sendEmail({ to, subject, text, html: htmlTemplate });
    }

    /** Someone asked to confirm an address that already belongs to another account (no code is sent). */
    public async sendAddressInUseEmail(to: string) {
        const subject = 'Email address confirmation on Common Ground';
        const html = `
        <tr>
            <td colspan="4" style="background-color:#f8f8f8;padding:20px;text-align:center;">
                <h2> Someone tried to add this address to a Common Ground account. </h2>
                <p> This address already belongs to an account, so nothing was changed. If this was not you, you can ignore this mail. </p>
            </td>
        </tr>`;
        const htmlTemplate = this.getHTMLTemplate(html, false);
        const text = `Someone tried to add this address to a Common Ground account. This address already belongs to an account, so nothing was changed. If this was not you, you can ignore this mail.\n`;
        await this.sendEmail({ to, subject, text, html: htmlTemplate });
    }

    /** The account's address was changed: told to the previous address. */
    public async sendEmailChangedEmail(to: string) {
        const subject = 'The email address of your Common Ground account was changed';
        const html = `
        <tr>
            <td colspan="4" style="background-color:#f8f8f8;padding:20px;text-align:center;">
                <h2> The email address of your account was changed. </h2>
                <p> Mails for your account now go to the new address. If this was not you, sign in and review your account settings right away. </p>
            </td>
        </tr>`;
        const htmlTemplate = this.getHTMLTemplate(html, false);
        const text = `The email address of your account was changed. Mails for your account now go to the new address. If this was not you, sign in and review your account settings right away.\n`;
        await this.sendEmail({ to, subject, text, html: htmlTemplate });
    }

    /** The account's password was set or changed. */
    public async sendPasswordChangedEmail(to: string) {
        const subject = 'The password of your Common Ground account was changed';
        const html = `
        <tr>
            <td colspan="4" style="background-color:#f8f8f8;padding:20px;text-align:center;">
                <h2> The password of your account was set or changed. </h2>
                <p> If this was you, there is nothing to do. If not, sign in and review the sign-in methods in your account settings right away. </p>
            </td>
        </tr>`;
        const htmlTemplate = this.getHTMLTemplate(html, false);
        const text = `The password of your account was set or changed. If this was you, there is nothing to do. If not, sign in and review the sign-in methods in your account settings right away.\n`;
        await this.sendEmail({ to, subject, text, html: htmlTemplate });
    }

    /** Sign-up: the 8-digit code that proves the address before the account exists. */
    public async sendSignupCodeEmail(to: string, code: string) {
        const subject = 'Your Common Ground sign-up code';
        const html = `
        <tr>
            <td colspan="4" style="background-color:#f8f8f8;padding:20px;text-align:center;">
                <h2> Your sign-up code: ${escapeHtml(code)} </h2>
                <p> It is valid for 15 minutes. If you did not try to create an account, you can ignore this mail. </p>
            </td>
        </tr>`;
        const htmlTemplate = this.getHTMLTemplate(html, false);
        const text = `Your sign-up code: ${code}\n\nIt is valid for 15 minutes. If you did not try to create an account, you can ignore this mail.\n`;
        await this.sendEmail({ to, subject, text, html: htmlTemplate });
    }

    /** Sign-up attempted with an address that already has an account (no code is sent). */
    public async sendSignupAddressTakenEmail(to: string) {
        const subject = 'Sign-up attempt on Common Ground';
        const loginLink = `${urlConfig.APP_URL}/`;
        const html = `
        <tr>
            <td colspan="4" style="background-color:#f8f8f8;padding:20px;text-align:center;">
                <h2> Someone tried to create a new account with this address. </h2>
                <p> This address already belongs to an account. <a href="${escapeHtml(loginLink)}">Log in</a> instead. If this was not you, you can ignore this mail. </p>
            </td>
        </tr>`;
        const htmlTemplate = this.getHTMLTemplate(html, false);
        const text = `Someone tried to create a new account with this address. This address already belongs to an account — log in instead: ${loginLink}\nIf this was not you, you can ignore this mail.\n`;
        await this.sendEmail({ to, subject, text, html: htmlTemplate });
    }

    /** A sign-in method was added to the account. */
    public async sendNewSignInMethodEmail(to: string, method: string) {
        const subject = 'A new sign-in method was added to your Common Ground account';
        const html = `
        <tr>
            <td colspan="4" style="background-color:#f8f8f8;padding:20px;text-align:center;">
                <h2> A new sign-in method was added to your account: ${escapeHtml(method)} </h2>
                <p> If this was you, there is nothing to do. If not, review the sign-in methods in your account settings right away. </p>
            </td>
        </tr>`;
        const htmlTemplate = this.getHTMLTemplate(html, false);
        const text = `A new sign-in method was added to your account: ${method}\n\nIf this was you, there is nothing to do. If not, review the sign-in methods in your account settings right away.\n`;
        await this.sendEmail({ to, subject, text, html: htmlTemplate });
    }

    public async sendNewsletter(recipient: EmailRecipient, posts: EmailPost[], generalPosts: EmailPost[]) {
        if (posts.length === 0 && generalPosts.length === 0) {
            console.log('No posts to send to user: ', recipient.userId);
            return;
        }

        const header = `<tr class="w-full" style="width:100%;">
            <td colspan="4" style="text-align: center;">
                <img src="${urlConfig.APP_URL}/icons/email_logo.png" alt="CG Logo" style="width:40px;height:40px;margin-right: 10px;vertical-align: middle;"/>
                <h1 style="display:inline-block;font-size:37px;font-weight:bold;vertical-align: middle;">Common Ground Digest</h1>
            </td>
        </tr>
        `;

        const section = (whose: 'your' | 'all', sectionPosts: EmailPost[]) => sectionPosts.length > 0 ? `
        <tr class="w-full" style="width:100%;">
            <td colspan="4" style="text-align: center;">
                <h2 style="display:inline-block;font-size:20px;vertical-align: middle;font-weight: normal;">This week from <span style="font-weight:bold;">${whose}</span> communities</h2>
            </td>
        </tr>
        <tr style="height: 16px;">
            <td colspan="4" class="divider" style="border-top:1px solid #ccc;margin:20px 0;"></td>
        </tr>
        ${this.getHTMLforPosts(sectionPosts, true)}
        <tr>
            <td colspan="4" style="background-color:#f8f8f8;padding:20px;text-align:center;border-radius:8px;">
                <a href="${urlConfig.APP_URL}" style="color: #717171; font-size: 15px; font-weight: 580; text-decoration: none;">Read more on Common Ground</a>
            </td>
        </tr>
        <tr>
            <td colspan="4" style="height: 64px;"></td>
        </tr>
        ` : '';

        const unsubscribe: UnsubscribeTarget = { userId: recipient.userId, topic: { kind: 'digest' } };
        const html = this.getHTMLTemplate(header + section('your', posts) + section('all', generalPosts), false, true, unsubscribe);
        const text = [
            'Common Ground Digest',
            posts.length > 0 ? `\nThis week from your communities:\n\n${this.getTextForPosts(posts)}` : '',
            generalPosts.length > 0 ? `\nThis week from all communities:\n\n${this.getTextForPosts(generalPosts)}` : '',
            `\nRead more on Common Ground: ${urlConfig.APP_URL}`,
            this.getTextFooter(unsubscribe),
        ].join('\n');
        await this.sendEmail({ to: recipient.email, subject: 'Common Ground Newsletter', text, html, unsubscribe });
    }

    public async sendArticleAsEmail(recipient: EmailRecipient, post: EmailPost, communityId: string) {
        const content = `
        <tr><td colspan="4">
            <h1 style="text-align: center;">New post in your community</h1>
        </td></tr>
        ${this.getHTMLforPosts([post])}
        `;
        const unsubscribe: UnsubscribeTarget = { userId: recipient.userId, topic: { kind: 'community', communityId } };
        const html = this.getHTMLTemplate(content, true, true, unsubscribe);
        const text = [
            `New post in your community ${post.community}:`,
            '',
            this.getTextForPosts([post]),
            this.getTextFooter(unsubscribe),
        ].join('\n');
        await this.sendEmail({ to: recipient.email, subject: 'New post in your community', text, html, unsubscribe });
    }

    public async sendEventEmail(to: string, event: EventEmailOptions) {
        const emailTitle = this.getEventEmailString(event.type, event.event.title);
        const eventUrl = `${urlConfig.APP_URL}${getUrl({
            type: 'event', community: {
                url: event.communityUrl
            },
            event: event.event
        })}`;

        const content = `
            <tr>
                <td colspan="4">
                    <h2 style="text-align: center;">${escapeHtml(emailTitle)}</h2>
                </td>
            </tr>
            <tr>
                <td colspan="4" style="text-align: center;">
                    <span>
                        ${event.communityImage ? `<img style="width: 20px; height: 20px; border-radius: 4px; vertical-align: bottom;" src="${escapeHtml(event.communityImage)}" alt="Community Image">` : ''}
                        <span style="color: #717171;">${escapeHtml(event.community)}</span>
                    </span>
                </td>
            </tr>

            <tr>
                <td colspan="4" style="text-align: center; padding: 16px;">
                    <a
                        style="display: block; margin: auto; cursor: pointer; background-color: #181818; border-radius: 12px; color: #f1f1f1; font-size: 15px; font-weight: 580; width: 320px; padding: 16px; text-align: center; text-decoration: none;"
                        href="${escapeHtml(eventUrl)}"
                        target="_blank"
                    >
                        View Event
                    </a>
                </td>
            </tr>
        `;

        let attachments: Attachment[] | undefined = undefined;
        if (event.type === 'attending') {
            const [community] = await communityHelper.getCommunitiesById({ids: [event.communityId]});
            if (community) {
                const ics = generateEventICSFile(urlConfig.APP_URL, community, event.event);
                attachments = [{
                    filename: 'invite.ics',
                    content: ics,
                    contentType: 'text/calendar; method=PUBLISH',
                    contentDisposition: 'attachment',
                }];
            }
        }

        const html = this.getHTMLTemplate(content, false);
        const text = [
            emailTitle,
            `Community: ${event.community}`,
            '',
            `View event: ${eventUrl}`,
            this.getTextFooter(),
        ].join('\n');
        await this.sendEmail({ to, subject: emailTitle, text, html, attachments });
    }

    private getEventEmailString(type: EventEmailOptions['type'], eventName: string) {
        switch (type) {
            case 'attending': return `You’re attending “${eventName}”`;
            case 'starting': return `Event “${eventName}” is starting soon`;
            case 'changed': return `Event “${eventName}” was changed`;
            case 'cancelled': return `Event “${eventName}” was cancelled`;
        }
    }

    private getTextForPosts(posts: EmailPost[]) {
        return posts.map(post => `- ${post.title} (${post.community})\n  ${post.url}`).join('\n');
    }

    private getTextFooter(unsubscribe?: UnsubscribeTarget) {
        const lines = ['', '--', `Change email settings: ${settingsUrl()}`];
        const url = unsubscribe ? unsubscribeUrl(unsubscribe) : null;
        if (url) {
            lines.push(`Unsubscribe from these emails: ${url}`);
        }
        return lines.join('\n');
    }

    private getHTMLforPosts(posts: EmailPost[], withDividers?: true) {
        let html = '';
        for (const post of posts) {
            html += `
            <tr>
                <td style="width: 160px; height: 90px; padding-bottom: 16px">
                    <a style="display: block; text-decoration: none; color: unset;" href="${escapeHtml(post.url)}">
                        <img
                            src="${escapeHtml(post.image)}"
                            alt="Post Image"
                            style="width: 160px; height: 90px; object-fit: cover;border-radius: 12px;"
                        />
                    </a>
                </td>
                <td style="vertical-align: top;">
                    <a style="display: block; text-decoration: none; color: unset; padding-left: 16px;" href="${escapeHtml(post.url)}">
                        <h3 style="margin-top: 0; margin-bottom: 8px;">${escapeHtml(post.title)}</h3>
                        <span>
                            ${post.communityImage ? `<img style="width: 20px; height: 20px;border-radius: 4px; vertical-align: bottom;" src="${escapeHtml(post.communityImage)}" alt="Community Image">` : ''}
                            <span style="color: #717171;">${escapeHtml(post.community)}</span>
                        </span>
                    </a>
                </td>
            </tr>
            ${withDividers ? `<tr style="height: 16px;">
                <td style="width: 10%;"></td>
                <td class="divider" colspan="2" style="border-top:1px solid #ccc;margin:16px 0;"></td>
                <td style="width: 10%;"></td>
            </tr>` : ''}
            `;
        }
        return html;
    }

    private getHTMLTemplate(content: string, readMore: boolean, hideCGHeader?: boolean, unsubscribe?: UnsubscribeTarget) {
        const unsubscribeLink = unsubscribe ? unsubscribeUrl(unsubscribe) : null;
        return `<!DOCTYPE html>
<html>
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Common Ground</title>
</head>
<body style="margin:0;padding:0;font-family:arial,sans-serif;">
            <table style="width: 100%; border-spacing: 0;">
                <tbody>
                    <tr class="w-full" style="width:100%;">
                        <td colspan="4" class="blue-stripe" style="background-color:#4072be;height:16px;"></td>
                    </tr>
                    ${!hideCGHeader ? `<tr class="w-full" style="width:100%;">
                        <td colspan="4" style="text-align: center;">
                            <img src="${urlConfig.APP_URL}/icons/email_logo.png" alt="CG Logo" style="width:40px;height:40px;margin-right: 10px;vertical-align: middle;"/>
                            <h1 class="name" style="display:inline-block;font-size:24px;font-weight:bold;vertical-align: middle;">Common Ground</h1>
                        </td>
                    </tr>` : ''}
                    ${content}
                    <tr style="height: 20px;">
                        <td colspan="4" class="divider" style="border-top:1px solid #ccc;margin:20px 0;"></td>
                    </tr>
                    ${readMore ? `<tr>
                        <td colspan="4" style="background-color:#f8f8f8;padding:20px;text-align:center;border-radius:8px;">
                            <a href="${urlConfig.APP_URL}" style="color: #717171; font-size: 15px; font-weight: 580; text-decoration: none;">Read more on Common Ground</a>
                        </td>
                    </tr>` : ''}
                    <tr>
                        <td class="footer" colspan="4" style="padding:20px;text-align:center;">
                            <a href="${settingsUrl()}" style="color: #717171; font-size: 15px; font-weight: 580; text-decoration: none;">Change email settings</a>
                            ${unsubscribeLink ? `<span style="color: #717171;"> · </span>
                            <a href="${escapeHtml(unsubscribeLink)}" style="color: #717171; font-size: 15px; font-weight: 580; text-decoration: none;">Unsubscribe from these emails</a>` : ''}
                        </td>
                    </tr>
                </tbody>
            </table>
</body>
</html>
`;
    }
}

const emailUtils = new EmailUtils();
export default emailUtils;
