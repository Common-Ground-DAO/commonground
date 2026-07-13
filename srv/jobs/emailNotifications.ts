// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Additional terms: see LICENSE-ADDITIONAL-TERMS.md

import { isMainThread } from 'worker_threads';
import emailUtils, { emailEnabled } from '../api/emails';
import emailHelper from '../repositories/emails';
import articleHelper from '../repositories/articles';
import newsletterHelper from '../repositories/newsletter';
import communityEventHelper from '../repositories/communityEvents';

if (isMainThread) {
    throw new Error("articleAsEmailDelivery can only be run as a worker job");
}

const articleNotifications = async () => {
    try {
        const communityArticles = await articleHelper.getCommunityArticleForEmailsList();
        console.log('Articles ready to be sent: %o', communityArticles);
        if (communityArticles.length === 0) {
            console.log('No articles to send');
            return;
        }
        for (const article of communityArticles) {
            console.log('preparing to sent article: ', article.articleId, ' to community: ', article.communityId);
            const preparedArticle = await emailHelper.prepareArticleToSendViaEmail(article.articleId, article.communityId);
            console.log('prepared article: ', preparedArticle.emailPost?.title);
            console.log('recipients: ', preparedArticle.recipients.length);

            const emailPostToSend = preparedArticle.emailPost;
            if (!!emailPostToSend) {
                await Promise.all(preparedArticle.recipients.map(user => emailUtils.sendArticleAsEmail(user, emailPostToSend)));
            }
            await newsletterHelper.updateSentAtCommunityNewsletterStatus(article.articleId, article.communityId);
        }
    } catch (error) {
        console.error(`error preparing articles to be sent as emails: `, error);
        process.exit(1);
    }
}

const eventNotifications = async () => {
    try {
        const communityEvents: {eventId: string, userEmails: string[], userParticipantIds: string[]}[] = await communityEventHelper.getUpcomingEventsToNotify();
        console.log('Events ready to be sent: %o', communityEvents);
        if (communityEvents.length === 0) {
            console.log('No events to send');
            return;
        }
        for (const event of communityEvents) {
            console.log('preparing to notify starting event: ', event.eventId);
            if (!event.userEmails || event.userEmails.length === 0) {
                console.log('No participants with valid emails to notify');
                continue;
            }
            if (!event.userParticipantIds || event.userParticipantIds.length === 0) {
                console.log('No participant IDs to notify for event: ', event.eventId);
                continue;
            }
            const preparedEvent = await communityEventHelper.prepareEventToSendEmail(event.eventId, event.userParticipantIds[0], "starting");
            console.log('prepared event: ', preparedEvent.event.title);
            console.log('recipients: ', event.userEmails.length);

            await Promise.all(event.userEmails.map(user => emailUtils.sendEventEmail(user, preparedEvent)));
            await communityEventHelper.markEventAsNotified(event.eventId);
        }
    } catch (error) {
        console.error(`error preparing events to be notified via emails: `, error);
        process.exit(1);
    }
}

(async () => {
    if (!emailEnabled()) {
        console.log('Email delivery is not configured, skipping email notifications');
        process.exit(0);
    }
    await articleNotifications();
    await eventNotifications();
    process.exit(0);
})();