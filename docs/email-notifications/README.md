# Email & Notifications

> Status: verified against commit a3c3f7608, 2026-08-01.

This document covers every email path in Common Ground: transactional mail (verification, one-time-password login, event and article notifications), the weekly digest and per-community article newsletters, the Mailchimp marketing integration, and the user/community preference model that gates them. Web push and in-app notifications are a separate delivery channel — see [docs/realtime](../realtime/README.md) (§ Push Notifications) — and the boundary between the two is described in [Boundary to web push](#boundary-to-web-push).

---

## Table of Contents

1. [Providers & configuration](#providers--configuration)
2. [Sending layer](#sending-layer-srvapiemailsts)
3. [Transactional mails](#transactional-mails)
4. [Weekly newsletter (digest)](#weekly-newsletter-digest)
5. [Per-community article newsletter](#per-community-article-newsletter)
6. [Event notification mails](#event-notification-mails)
7. [Mailchimp marketing integration](#mailchimp-marketing-integration)
8. [Notification preferences](#notification-preferences)
9. [Scheduled jobs](#scheduled-jobs)
10. [Boundary to web push](#boundary-to-web-push)
11. [Data model reference](#data-model-reference)

---

## Providers & configuration

Common Ground uses **two distinct third-party services** for two distinct purposes:

| Provider | Purpose | Client library | Config key |
|----------|---------|----------------|------------|
| **SendGrid** | All transactional & newsletter email delivery | `@sendgrid/mail` | `SENDGRID_API_KEY` |
| **Mailchimp** | Marketing-list subscription (the general "newsletter" opt-in) | `@mailchimp/mailchimp_marketing` | `MAILCHIMP_API_KEY`, `MAILCHIMP_SERVER`, `MAILCHIMP_DEFAULT_LIST_ID` |

Both are initialised once in `srv/serverconfig.ts`. Keys resolve in order: Docker secret → environment variable → the literal string `'placeholder'`. `MAILCHIMP_SERVER` is hard-wired to `us9`.

**SendGrid is the single, hard-wired mail provider.** There is no SMTP or provider abstraction: `srv/api/emails.ts` imports `@sendgrid/mail` directly and every send goes through `sgMail.send`. A future provider-agnostic layer (e.g. SMTP) would replace the body of `EmailUtils.sendEmail` and the initialisation in `serverconfig.ts` — the rest of the codebase only depends on the `emailUtils` methods.

### Graceful degradation (self-hosting)

Email delivery is **optional**. `emailEnabled()` (`srv/api/emails.ts:15`) returns `true` only when `SENDGRID_API_KEY` is set and is not the `'placeholder'` value. When it returns `false`:

- `sendEmail` logs a warning, drops the message, and throws `EMAIL_DISABLED` (`srv/common/errors`).
- The `newsletterDelivery` and `emailNotifications` jobs exit early without doing work.
- `POST /user/sendOneTimePasswordForLogin` rejects with `EMAIL_DISABLED` instead of pretending a code was sent.

Similarly, Mailchimp calls are skipped when `MAILCHIMP_API_KEY === 'placeholder'`; the user's local subscription flag is still updated so self-hosted instances keep newsletter state locally.

### From-addresses

| Source | From address |
|--------|--------------|
| All mails | `process.env.EMAIL_FROM` ‖ `no-reply@app.cg` |

---

## Sending layer (`srv/api/emails.ts`)

`EmailUtils` is a singleton (`export default emailUtils`) exposing one low-level primitive and several high-level composers.

- **`sendEmail(to, subject, text, html, attachments?, from?)`** — the only method that calls SendGrid. Guards on `emailEnabled()`, catches/normalises SendGrid `ResponseError`s.
- **`sendEmailBulk(to[], …)`** — fan-out loop over `sendEmail` (fire-and-forget; no per-recipient error aggregation).
- Composers: `sendVerificationEmail`, `sendOneTimePasswordEmail`, `sendNewsletter`, `sendArticleAsEmail`, `sendEventEmail`.

All HTML is assembled inline (no templating engine) via private helpers:

- `getHTMLTemplate(content, readMore, hideCGHeader?)` — wraps content in a table-based responsive shell with a blue header stripe, the CG logo, and a footer linking to `https://app.cg?user-settings=notifications` ("Change email settings").
- `getHTMLforPosts(posts, withDividers?)` — renders an `EmailPost[]` list (thumbnail + title + community).
- `getEventEmailString(type, name)` — subject/heading per event type.

The logo and post images are referenced as absolute URLs under `urlConfig.APP_URL`; article/community images are resolved to signed S3 URLs (`fileHelper.getSignedUrls`) before rendering.

---

## Transactional mails

| Mail | Composer | Triggered from | Notes |
|------|----------|----------------|-------|
| Email verification | `sendVerificationEmail` | Account creation (`srv/api/user.ts:694`) and resend (`:1464`) | Link to `/verify-email?email=…&token=…`; in dev the link targets `hostname:3000`. |
| One-time password login | `sendOneTimePasswordEmail` | `POST /user/sendOneTimePasswordForLogin` (`:1514`) | Emails a login code to an existing account (see [Notification preferences](#notification-preferences)). Requires `emailEnabled()`. |
| Event notifications | `sendEventEmail` | See [Event notification mails](#event-notification-mails) | — |
| Article notification | `sendArticleAsEmail` | `emailNotifications` job | See [Per-community article newsletter](#per-community-article-newsletter). |
| Weekly digest | `sendNewsletter` | `newsletterDelivery` job | See [Weekly newsletter](#weekly-newsletter-digest). |

### Verification token lifecycle

Verification / OTP tokens are managed in `srv/repositories/emails.ts`:

- `generateVerificationEmailToken(userId)` returns the user's current unexpired code if one exists, otherwise stores a freshly generated code with an expiry and returns it.
- `verifyEmail(email, token)` validates the code, checks expiry, and on success sets `emailVerified = true`, clearing the code and its expiration.
- The same generator backs both email verification and the OTP-login flow.

---

## Weekly newsletter (digest)

A "Common Ground Digest" summarising the last 7 days of articles, sent to users who opted in via the `weeklyNewsletter` flag.

**Job:** `srv/jobs/newsletterDelivery.ts` — cron `0 12 * * 6` (Saturdays, 12:00).

Flow:

1. Skip entirely if `!emailEnabled()`.
2. Compute a numeric `newsletterId` from the current date (`YYYYMMDD`) — this de-duplicates a given week's send.
3. `createNewsletterEntries(newsletterId)` (`srv/repositories/newsletter.ts`) inserts one `user_newsletter_status` row per eligible user (`weeklyNewsletter = true AND emailVerified = true AND deletedAt IS NULL`) that does not already have a row for this `newsletterId`, and returns the newly added users. Re-running the job the same day therefore does not re-send.
4. For each user, `getPostsFromFollowedCommunities(userId)` (their communities) plus one shared `getGeneralCommunityPosts()` (up to 10 articles from all communities, published in the last 7 days) build two `EmailPost` lists.
5. `sendNewsletter(email, followedPosts, generalPosts)` renders two sections — "This week from **your** communities" and "This week from **all** communities" — and sends. If both lists are empty the send is skipped.
6. On success, `updateSentAtNewsletterStatus(newsletterId, userId)` stamps `sentAt`.
7. Failed sends are collected and retried once; a second failure exits the worker with code 1.

`getNewsletterStatus(userId)` (checks for a `sentAt` within the last 7 days) supports "was this user mailed recently" queries.

---

## Per-community article newsletter

Community managers can push a published article to all eligible community members as an email ("New post in your community").

**Opt-in to send (author side):**

- `POST /community/sendArticleAsEmail` (`srv/api/community.ts:1105`) requires `COMMUNITY_MANAGE_ARTICLES` permission **and** the community to be whitelisted (`isCommunityWhitelisted`). It calls `registerCommunityArticleForEmails(articleId, communityId)`, which marks the article `markAsNewsletter = true` and un-marks any other pending article in the community (only one queued at a time).

**Delivery (job side):** `srv/jobs/emailNotifications.ts` → `articleNotifications()` (part of the every-minute job):

1. `getCommunityArticleForEmailsList()` finds articles where `markAsNewsletter = true AND sentAsNewsletter IS NULL AND published < now()`.
2. `prepareArticleToSendViaEmail(articleId, communityId)` (`srv/repositories/emails.ts`) resolves the recipient set: it walks the article's role permissions, collects roles that grant `ARTICLE_READ` (mapping the `Public` role onto `Member` where relevant, excluding `Admin`), then selects **verified** subscribers of the community newsletter for those roles.
   - Recipient query (`newsletterUsersBaseQuery`): user must have a **claimed** role granting read access, `emailVerified = true`, not deleted, and an active per-community newsletter subscription (`newsletterJoinedAt IS NOT NULL AND newsletterLeftAt IS NULL`).
3. `sendArticleAsEmail(email, post)` is sent to each recipient.
4. `updateSentAtCommunityNewsletterStatus(articleId, communityId)` stamps `sentAsNewsletter` so the article is not sent again.

**Subscription (recipient side):** managed in `srv/repositories/newsletter.ts`:

- `subscribeUser(userId, communityIds[])` / `unsubscribeUser(...)` toggle `user_community_state.newsletterJoinedAt` / `newsletterLeftAt` and emit a `cliCommunityEvent` update (`myNewsletterEnabled`) so the UI updates live.
- `getUserSubscriptions(userId)`, `getUsersEligibleForCommunityNewsletter(communityId)`, `getMembersCountForNewsletter(...)`, and `getNewsletterHistory(...)` support the community-settings UI.

---

## Event notification mails

Sent to event participants. `sendEventEmail` produces one of four variants via `EventEmailOptions.type`:

| Type | Subject | Trigger |
|------|---------|---------|
| `attending` | "You're attending …" | `POST /community/addEventParticipant` (`srv/api/community.ts:1655`). Includes an `invite.ics` calendar attachment. |
| `starting` | "… is starting soon" | `emailNotifications` job → `eventNotifications()` |
| `changed` | "… was changed" | Event update route (`:1577`) |
| `cancelled` | "… was cancelled" | `POST /community/deleteCommunityEvent` (`:1617`) |

- The `attending` variant attaches an ICS invite generated by `generateEventICSFile`.
- The `starting` variant is driven by the every-minute job: `getUpcomingEventsToNotify()` finds events scheduled within the next 15 minutes that have not yet been notified (`eventNotified = FALSE`) and whose participants have `emailVerified = TRUE`; after sending, `markEventAsNotified` sets `eventNotified = TRUE`.
- Recipient resolution for `changed`/`cancelled` uses `getUserEmailsToNotify({eventId})`, which returns participants with `emailVerified = TRUE`.
- In all API-triggered cases the email send is wrapped in a try/catch so a mail failure never fails the underlying event mutation.

---

## Mailchimp marketing integration

Separate from SendGrid, Mailchimp holds the platform-wide **marketing** list (the general "newsletter" toggle, distinct from the weekly digest). Implemented in `srv/repositories/users.ts`:

| Method | Mailchimp call | Local effect |
|--------|----------------|--------------|
| `subscribeNewsletter(userId, email)` | `lists.setListMember` → `subscribed` | sets `users.newsletter = true`, emits `cliUserOwnData` |
| `unsubscribeNewsletter(userId, email)` | `lists.updateListMember` → `unsubscribed` | sets `users.newsletter = false`, emits `cliUserOwnData` |
| `addContactEmail(userId, email, withNewCommunityCreatedTag?)` | subscribe + `lists.updateListMemberTags` (`New Member`, optionally `New Community created`) | — |

API entry points: `POST /user/subscribeNewsletter` and `POST /user/unsubscribeNewsletter` (`srv/api/user.ts:1134`, `:1150`). When the Mailchimp key is the placeholder, the remote call is skipped and only the local `users.newsletter` flag / event is updated.

---

## Notification preferences

There are **three independent opt-ins**, plus per-community push settings.

| Preference | Storage | Scope | Governs |
|------------|---------|-------|---------|
| `newsletter` | `users.newsletter` (bool, default `false`) | Global | Mailchimp marketing list membership |
| `weeklyNewsletter` | `users.weeklyNewsletter` (bool, default `true` since migration `1724084789644`) | Global | Weekly digest email eligibility |
| `dmNotifications` | `users.dmNotifications` (bool, default `true`) | Global | DM notifications (push channel) |
| per-community newsletter | `user_community_state.newsletterJoinedAt` / `newsletterLeftAt` | Per community | Community article newsletter eligibility |
| `notifyMentions`, `notifyReplies`, `notifyPosts`, `notifyEvents`, `notifyCalls` | `user_community_state` (bool, default `true`) | Per community | **Push / in-app** notifications (see [Boundary to web push](#boundary-to-web-push)) |

Global flags `newsletter`, `weeklyNewsletter`, and `dmNotifications` are edited through `POST /user/updateOwnData` (validated in `srv/validators/api/user.ts`). `newsletter` additionally round-trips to Mailchimp via the dedicated subscribe/unsubscribe routes.

`emailVerified` acts as a hard gate on **every** newsletter and event email query — unverified addresses never receive digest, article, or event mail regardless of the opt-in flags above.

---

## Scheduled jobs

Email-relevant workers are spawned from `srv/jobs.ts` (each runs in a worker thread; all guard on `isMainThread` and exit early if email is disabled):

| Job file | Schedule | Purpose |
|----------|----------|---------|
| `newsletterDelivery.ts` | `0 12 * * 6` (Sat 12:00) | Weekly digest |
| `emailNotifications.ts` | `*/1 * * * *` (every minute) | Article newsletters + "event starting soon" mails |

The every-minute `emailNotifications` job runs `articleNotifications()` then `eventNotifications()` in sequence; a thrown error in either exits the worker (it is respawned on the next tick).

---

## Boundary to web push

Email and web push are **parallel, independent channels** with different plumbing and different preference flags:

| | Email | Web push / in-app |
|---|-------|-------------------|
| Transport | SendGrid | `web-push` (VAPID) |
| Code | `srv/api/emails.ts`, `srv/jobs/*` | `srv/repositories/notifications.ts` (`webPush.sendNotification`) |
| Preferences | `users.newsletter` / `weeklyNewsletter` / `dmNotifications`; per-community newsletter subscription | `user_community_state.notify{Mentions,Replies,Posts,Events,Calls}` |
| Gated by | `emailVerified` | active push subscription + the `notify*` flags |

The per-community `notify*` booleans (`notifyMentions`, `notifyReplies`, `notifyPosts`, `notifyEvents`, `notifyCalls`) are consumed by the **push** path in `srv/repositories/notifications.ts`, not by any email query. Event *emails*, by contrast, are gated only by event participation and `emailVerified`. Full push/VAPID/service-worker detail lives in [docs/realtime](../realtime/README.md).

---

## Data model reference

| Table / column | Meaning |
|----------------|---------|
| `users.email`, `users.emailVerified` | Address and verification state |
| `users.verificationCode`, `verificationCodeExpiration` | Verification / OTP token and expiry |
| `users.newsletter` | Mailchimp marketing opt-in |
| `users.weeklyNewsletter` | Weekly digest opt-in |
| `users.dmNotifications` | DM push opt-in |
| `user_newsletter_status` (`userId`, `newsletterId`, `sentAt`) | Weekly-digest send ledger (de-dup per week) |
| `user_community_state.newsletterJoinedAt` / `newsletterLeftAt` | Per-community newsletter subscription window |
| `user_community_state.notify*` | Per-community push preferences |
| `communities_articles.markAsNewsletter` / `sentAsNewsletter` | Article queued-for / already-sent-as email |

---

## TODO(verify)

- The `EMAIL_FROM` environment variable is read directly in `sendEmail`; confirm where (if anywhere) it is documented/set for production deployments — it is not part of `serverconfig.ts`.
