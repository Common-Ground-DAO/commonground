// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Additional terms: see LICENSE-ADDITIONAL-TERMS.md

import { isMainThread } from 'worker_threads';
import emailUtils, { emailEnabled } from '../api/emails';
import emailHelper from '../repositories/emails';
import newsletterHelper from '../repositories/newsletter';

if (isMainThread) {
    throw new Error("newsletterDelivery can only be run as a worker job");
}

function generateNewsletterId(): number {
    const today = new Date();
    const day = String(today.getDate()).padStart(2, '0');
    const month = String(today.getMonth() + 1).padStart(2, '0');
    const year = today.getFullYear();
    const formattedDate = `${year}${month}${day}`;
    const sendId = Number(formattedDate);
    return sendId;
}

async function sendEmails(users: { userId: string, email: string }[], newsletterId: number) {
    console.log(`Sending weekly newsletter to ${users.length} users`);
    const errors: { user: { userId: string, email: string }, error: any }[] = [];
    const generalCommunityPosts = await emailHelper.getGeneralCommunityPosts();
    console.log(`Found ${generalCommunityPosts.length} general emails`);
    const emailPromises = users.map(async (user) => {
        const posts = await emailHelper.getPostsFromFollowedCommunities(user.userId);
        console.log(`Found ${posts.length} posts for user ${user.userId}`);
        try {
            await emailUtils.sendNewsletter(user.email, posts, generalCommunityPosts);
            await newsletterHelper.updateSentAtNewsletterStatus(newsletterId, user.userId);
        } catch (error) {
            console.error(`Error sending email to user ${user.userId}`, error);
            errors.push({ user, error });
        }
    }
    );
    await Promise.all(emailPromises);
    return errors;
}

(async () => {
    if (!emailEnabled()) {
        console.log('Email delivery is not configured, skipping newsletter delivery');
        process.exit(0);
    }
    const newsletterId = generateNewsletterId();
    const users = await newsletterHelper.createNewsletterEntries(newsletterId);
    if (users.length === 0) {
        console.log('No users to send newsletter to');
        process.exit(0);
    }
    const errors = await sendEmails(users, newsletterId);
    if (errors.length > 0) {
        console.error('Errors sending emails: ', errors);
        const retryErrors = await sendEmails(errors.map((error) => error.user), newsletterId);
        if (retryErrors.length > 0) {
            console.error('Errors retyring sending emails: ', retryErrors);
            process.exit(1);
        }
    }
    process.exit(0);
})();