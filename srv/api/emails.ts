// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Additional terms: see LICENSE-ADDITIONAL-TERMS.md

import sgMail, { ResponseError } from '@sendgrid/mail';
import { EmailPost } from '../repositories/emails';
import { generateEventICSFile, getUrl } from '../common/util';
import urlConfig from '../util/urls';
import communityHelper from '../repositories/communities';
import serverconfig from '../serverconfig';
import errors from '../common/errors';

// email delivery is optional (self-hosted instances may run without a
// SendGrid key); callers can check this to skip email work entirely
export function emailEnabled(): boolean {
    return !!serverconfig.SENDGRID_API_KEY && serverconfig.SENDGRID_API_KEY !== 'placeholder';
}

export type EventEmailOptions = {
    type: 'attending' | 'starting' | 'changed' | 'cancelled';
    community: string;
    communityId: string;
    communityUrl: string;
    event: Models.Community.Event;
    communityImage?: string;
}

class EmailUtils {
    //send an email using sendgrid
    public async sendEmail(to: string, subject: string, text: string, html: string, attachments?: sgMail.MailDataRequired['attachments'], from?: string) {
        const msg: sgMail.MailDataRequired = {
            to,
            from: from || process.env.EMAIL_FROM || 'no-reply@app.cg',
            subject,
            text,
            html,
            attachments
        };
        if (!emailEnabled()) {
            console.warn(`Email delivery is not configured, dropping email to ${to} ("${subject}")`);
            throw new Error(errors.server.EMAIL_DISABLED);
        }
        try {
            await sgMail.send(msg);
        } catch (error: any) {
            console.error('Error sending email to: ', to);
            console.error('Error: ', error);
            console.error('Response: ', (error as ResponseError)?.response?.body);
            throw new Error('Error sending email');
        }
    }

    public sendEmailBulk(to: string[], subject: string, text: string, html: string) {
        for (const email of to) {
            this.sendEmail(email, subject, text, html);
        }
    }

    public async sendVerificationEmail(to: string, verificationToken: string, hostname: string) {
        const emailLink = `https://${process.env.DEPLOYMENT === 'dev' ? hostname + ':3000' : hostname}/verify-email?email=${encodeURI(to)}&token=${encodeURI(verificationToken)}`;
        const subject = 'Verify your Common Ground email account';
        const html = `
        <tr>
            <td style="background-color:#f8f8f8;padding:20px;text-align:center;">
                <h2> Click <a href="${emailLink}">here</a> to verify your email address </h2>
            </td>
        </tr>`;
        const htmlTemplate = this.getHTMLTemplate(html, false)
        const text = `Click the following link to verify your email address: ${emailLink}`;
        await this.sendEmail(to, subject, text, htmlTemplate);
    }

    public async sendOneTimePasswordEmail(to: string, verificationToken: string) {
        const subject = "Here's your Common Ground one time password";
        const html = `
        <tr>
            <td style="background-color:#f8f8f8;padding:20px;text-align:center;">
                <h2> Use the following password to log in: ${verificationToken} </h2>
            </td>
        </tr>`;
        const htmlTemplate = this.getHTMLTemplate(html, false)
        const text = `Use the following password to log in: ${verificationToken}`;
        await this.sendEmail(to, subject, text, htmlTemplate);
    }

    public async sendKycResultEmail(to: string, result: boolean, kycLevel:string, kycRejectReason?: string) {
        let subject: string;
        let text: string;
        if (result) {
            subject = 'KYC Verification Success';
            text = `Your KYC verification was successful.`
        } else {
            subject = 'KYC Verification Failed';
            text = `Your KYC verification was unsuccessful. Reason: ${kycRejectReason}`
        }
        const html = `
        <tr>
            <td style="background-color:#f8f8f8;padding:20px;text-align:center;">
                <span>${text} </span>
            </td>
        </tr>`;
        const htmlTemplate = this.getHTMLTemplate(html, false)
        await this.sendEmail(to, subject, text, htmlTemplate);
    }

    public async sendNewsletter(to: string, posts: EmailPost[], generalPosts: EmailPost[]) {
        if (posts.length === 0 && generalPosts.length === 0) {
            console.log('No posts to send to user: ', to);
            return;
        }

        const header = `<tr class="w-full" style="width:100%;">
            <td colspan="4" style="text-align: center;">
                <img src="${urlConfig.APP_URL}/icons/email_logo.png" alt="CG Logo" style="width:40px;height:40px;margin-right: 10px;vertical-align: middle;"/>
                <h1 style="display:inline-block;font-size:37px;font-weight:bold;vertical-align: middle;">Common Ground Digest</h1>
            </td>
        </tr>
        `;
        
        const followingPostHtml = posts.length > 0 ? `
        <tr class="w-full" style="width:100%;">
            <td colspan="4" style="text-align: center;">
                <h2 style="display:inline-block;font-size:20px;vertical-align: middle;font-weight: normal;">This week from <span style="font-weight:bold;">your</span> communities</h1>
            </td>
        </tr>
        <tr style="height: 16px;">
            <td colspan="4" class="divider" style="border-top:1px solid #ccc;margin:20px 0;"></td>
        </tr>
        ${this.getHTMLforPosts(posts, true)}
        <tr>
            <td colspan="4" style="background-color:#f8f8f8;padding:20px;text-align:center;border-radius:8px;">
                <a href="https://app.cg" style="color: #717171; font-size: 15px; font-weight: 580; text-decoration: none;">Read more on Common Ground</a>
            </td>
        </tr>
        <tr>
            <td colspan="4" style="height: 64px;"></td>
        </tr>
        ` : '';
        
        const generalPostsHtml = generalPosts.length > 0 ? `
        <tr class="w-full" style="width:100%;">
            <td colspan="4" style="text-align: center;">
                <h2 style="display:inline-block;font-size:20px;vertical-align: middle;font-weight: normal;">This week from <span style="font-weight:bold;">all</span> communities</h1>
            </td>
        </tr>
        <tr style="height: 16px;">
            <td colspan="4" class="divider" style="border-top:1px solid #ccc;margin:20px 0;"></td>
        </tr>
        ${this.getHTMLforPosts(generalPosts, true)}
        <tr>
            <td colspan="4" style="background-color:#f8f8f8;padding:20px;text-align:center;border-radius:8px;">
                <a href="https://app.cg" style="color: #717171; font-size: 15px; font-weight: 580; text-decoration: none;">Read more on Common Ground</a>
            </td>
        </tr>
        <tr>
            <td colspan="4" style="height: 64px;"></td>
        </tr>
        ` : '';
        
        const html = this.getHTMLTemplate(header + followingPostHtml + generalPostsHtml, false, true);
        await this.sendEmail(to, 'Common Ground Newsletter', 'text', html);
    }

    public async sendArticleAsEmail(to: string, post: EmailPost) {
        const content = `
        <tr><td colspan="4">
            <h1 style="text-align: center;">New post in your community</h1>
        </td></tr>
        ${this.getHTMLforPosts([post])}
        `;
        const html = this.getHTMLTemplate(content, true, true);
        await this.sendEmail(to, 'New post in your community', 'text', html);
    }

    public async sendEventEmail(to: string, event: EventEmailOptions) {
        const emailTitle = this.getEventEmailString(event.type, event.event.title);
        const eventUrl = getUrl({
            type: 'event', community: {
                url: event.communityUrl
            },
            event: event.event
        });

        const content = `
            <tr>
                <td colspan="4">
                    <h2 style="text-align: center;">${emailTitle}</h2>
                </td>
            </tr>
            <tr>
                <td colspan="4" style="text-align: center;">
                    <span>
                        <img style="width: 20px; height: 20px; border-radius: 4px; vertical-align: bottom;" src="${event.communityImage}" alt="Community Image">
                        <span style="color: #717171;">${event.community}</span>
                    </span>
                </td>
            </tr>

            <tr>
                <td colspan="4" style="text-align: center; padding: 16px;">
                    <a
                        style="display: block; margin: auto; cursor: pointer; background-color: #181818; border-radius: 12px; color: #f1f1f1; font-size: 15px; font-weight: 580; width: 320px; padding: 16px; text-align: center; text-decoration: none;"
                        href="${urlConfig.APP_URL}${eventUrl}"
                        target="_blank"
                    >
                        View Event
                    </a>
                </td>
            </tr>
        `;

        let attachments: sgMail.MailDataRequired['attachments'] = undefined;
        if (event.type === 'attending') {
            const [community] = await communityHelper.getCommunitiesById({ids: [event.communityId]});
            if (community) {
                const ics = generateEventICSFile(urlConfig.APP_URL, community, event.event);
                attachments = [{
                    filename: 'invite.ics',
                    content: Buffer.from(ics).toString('base64'),
                    disposition: 'attachment',
                    type: 'text/calendar; method=REQUEST',
                    contentId: event.event.id
                }];
            }
        }

        const html = this.getHTMLTemplate(content, false);
        await this.sendEmail(to, emailTitle, 'text', html, attachments);
    }

    public async sendTokenSaleEmail({
        email,
        subject,
        baseUrl,
        startsIn,
    }: {
        email: string;
        subject: string;
        baseUrl: string;
        startsIn: string;
    }) {
        const tokenSaleLink = `${baseUrl}/token/`;
        const caption = '🚀 Announcing the Common Ground Token Sale 🚀';
        const paragraph1 = `We are thrilled to announce that the highly-anticipated token sale for the Common Ground project will start in <b>${startsIn}</b>! 🌟 This is your exclusive opportunity to be part of a groundbreaking project that's set to revolutionize the industry. The countdown has begun, and soon you'll have a chance to secure your stake in the future.`
        const paragraph2 = `More than 3.000 users get millions of tokens as an airdrop -`
        const html = `
        <tr>
            <td style="background-color:#f8f8f8;padding:20px;text-align:center;">
                <h2> ${caption} </h2>
            </td>
        </tr>
        <tr>
            <td style="background-color:#fefefe;padding:20px;text-align:center;">
                <p> ${paragraph1} </p>
            </td>
        </tr>
        <tr>
            <td style="background-color:#fefefe;padding:20px;text-align:center;">
                <p> ${paragraph2} <a href="${tokenSaleLink}">check out if you are eligible</a>! </p>
            </td>
        </tr>
        `;
        const htmlTemplate = this.getHTMLTemplate(html, false)
        const text = `${caption}\n${paragraph1}\n${paragraph2} check out if you are eligible here:\n${tokenSaleLink}`;
        await this.sendEmail(email, subject, text, htmlTemplate, undefined, 'mail@app.cg');
    }

    public async sendTokenSaleImmediateEmail({
        email,
        subject,
        baseUrl,
    }: {
        email: string;
        subject: string;
        baseUrl: string;
    }) {
        const tokenSaleLink = `${baseUrl}/token/`;
        const caption = '🏁 The Common Ground Token Sale goes LIVE in less than an hour! 🏁';
        const paragraph1 = `We’re thrilled to announce that the Common Ground Token Sale goes live in less than an hour! 🚀`;
        const linkText = `👉 Join the sale here:`;
        const paragraph2 = `As a thank-you to our amazing community, we’ve increased our airdrop for all users who signed up before September 2023. 🎉 Why? Because you’re awesome, and we wanted to show some love! 💚`;
        const paragraph3 = `We’ve had a few questions about whether this is legit, and the answer is a resounding YES!`;
        const paragraph4 = `This is your chance to be part of something groundbreaking. Join thousands of early supporters and help make Common Ground a resounding success. 🌟`;
        const paragraph5 = `Thanks for being part of this journey. You’re not just early—you’re essential.`;
        const paragraph6 = `Let’s build the future, together.\n— The Common Ground Team`;
        const html = `
        <tr>
            <td style="background-color:#f8f8f8;padding:20px;text-align:center;">
                <h2> 🏁 The Common Ground Token Sale goes LIVE in less than an hour! 🏁 </h2>
            </td>
        </tr>
        <tr>
            <td style="background-color:#fefefe;padding:20px;text-align:center;">
                <p> We’re thrilled to announce that the <b>Common Ground Token Sale</b> goes live in less than an hour! 🚀} </p>
                <p> 👉 <a href="${tokenSaleLink}">Join the sale here</a> </p>
                <p> As a thank-you to our amazing community, we’ve increased our airdrop for all users who signed up before September 2023. 🎉 Why? Because you’re awesome, and we wanted to show some love! 💚 </p>
                <p> We’ve had a few questions about whether this is legit, and the answer is a resounding YES!<br/>
Check it out for yourself:<br/>
•  Follow us on <a href="https://x.com/CommonGround_cg">X / Twitter</a><br/>
•  Visit our <a href="https://commonground.cg">Homepage</a><br/>
•  Or dive straight into the <a href="${tokenSaleLink}">Common Ground App</a> to see it all happening! </p>
                <p> This is your chance to <b>be part of something groundbreaking</b>. Join thousands of early supporters and help make Common Ground a resounding success. 🌟 </p>
                <p> Thanks for being part of this journey. You’re not just early—you’re essential. </p>
                <p> Let’s build the future, together.<br/>— The Common Ground Team </p>
            </td>
        </tr>
        `;
        const htmlTemplate = this.getHTMLTemplate(html, false)
        const text = `${caption}\n${paragraph1}\n${linkText} ${tokenSaleLink}\n${paragraph2}\n${paragraph3}\n${paragraph4}\n${paragraph5}\n${paragraph6}`;
        await this.sendEmail(email, subject, text, htmlTemplate, undefined, 'mail@app.cg');
    }

    private getEventEmailString(type: EventEmailOptions['type'], eventName: string) {
        switch (type) {
            case 'attending': return `You’re attending “${eventName}”`;
            case 'starting': return `Event “${eventName}” is starting soon`;
            case 'changed': return `Event “${eventName}” was changed`;
            case 'cancelled': return `Event “${eventName}” was cancelled`;
        }
    }

    private getHTMLforPosts(posts: EmailPost[], withDividers?: true) {
        let html = '';
        for (const post of posts) {
            html += `
            <tr>
                <td style="width: 160px; height: 90px; padding-bottom: 16px">
                    <a style="display: block; text-decoration: none; color: unset;" href="${post.url}">
                        <img
                            src="${post.image}"
                            alt="Post Image"
                            style="width: 160px; height: 90px; object-fit: cover;border-radius: 12px;"
                        ></img>
                    </a>
                </td>
                <td style="vertical-align: top;">
                    <a style="display: block; text-decoration: none; color: unset; padding-left: 16px;" href="${post.url}">
                        <h3 style="margin-top: 0; margin-bottom: 8px;">${post.title}</h3>
                        <span>
                            <img style="width: 20px; height: 20px;border-radius: 4px; vertical-align: bottom;" src="${post.communityImage}" alt="Community Image">
                            <span style="color: #717171;">${post.community}</span>
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

    private getHTMLTemplate(content: string, readMore: boolean, hideCGHeader?: boolean) {
        return `
            <!DOCTYPE html><html><head>
            <title>Email Template</title>

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
                            <a href="https://app.cg" style="color: #717171; font-size: 15px; font-weight: 580; text-decoration: none;">Read more on Common Ground</a>
                        </td>
                    </tr>
                    <tr>` : ''}
                        <td class="footer" colspan="4" style="padding:20px;text-align:center;">
                            <a href="https://app.cg?user-settings=notifications" style="color: #717171; font-size: 15px; font-weight: 580; text-decoration: none;">Change email settings</a>
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