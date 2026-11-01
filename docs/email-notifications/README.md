# Email & Notifications

> Status: verified against commit a3c3f7608, 2026-08-01; SMTP sending layer,
> Mailchimp removal, one-click unsubscribe, send limits, bounce policy and ICS
> invites against commit e44dac1, 2026-10-31; send limits per IP, the limit error and the 8-digit codes against commit
> 2fad7d3, 2026-11-01; `CG_FEATURE_EMAIL` note against commit fe3937f, 2026-10-31;
> verification and login codes, the notice mails of the account-security changes against commit 9fc05a9, 2026-11-01.

This document covers every email path in Common Ground: transactional mail (verification, one-time-password login, event mails), the weekly digest and per-community article newsletters, one-click unsubscribe, send limits, bounce handling, and the user/community preference model that gates them. Web push and in-app notifications are a separate delivery channel — see [docs/realtime](../realtime/README.md) (§ Push Notifications) — and the boundary between the two is described in [Boundary to web push](#boundary-to-web-push). Running a mail server for a self-hosted instance (the `mail` relay, SPF/DKIM/DMARC/PTR) is covered in [docs/deployment §3.9](../deployment/README.md#39-email-smtp-and-the-mail-relay) and [`docker/SELFHOST.md`](../../docker/SELFHOST.md#email).

---

## Table of Contents

1. [Transport & configuration](#transport--configuration)
2. [Sending layer](#sending-layer-srvapiemailsts)
3. [Transactional mails](#transactional-mails)
4. [Weekly newsletter (digest)](#weekly-newsletter-digest)
5. [Per-community article newsletter](#per-community-article-newsletter)
6. [Event notification mails](#event-notification-mails)
7. [One-click unsubscribe](#one-click-unsubscribe)
8. [Send limits](#send-limits)
9. [Bounces](#bounces)
10. [Notification preferences](#notification-preferences)
11. [Scheduled jobs](#scheduled-jobs)
12. [Boundary to web push](#boundary-to-web-push)
13. [Data model reference](#data-model-reference)
14. [History: SendGrid and Mailchimp](#history-sendgrid-and-mailchimp)

---

## Transport & configuration

The backend speaks **SMTP only**, through [nodemailer](https://nodemailer.com). Any SMTP server works: the built-in send-only relay of the selfhost stack (`mail` service), a provider's SMTP endpoint, or a local catcher in development. There is no third-party mail API in the code.

Configuration comes from the environment and is parsed by `parseMailConfig()` in `srv/util/mailConfig.ts`:

| Variable | Default | Meaning |
|----------|---------|---------|
| `SMTP_HOST` | — | SMTP server. **Empty = email disabled.** |
| `SMTP_SECURITY` | `starttls` | `tls` — implicit TLS from the first byte; `starttls` — plain connect, then STARTTLS, which is **required** (no plaintext fallback); `none` — no TLS at all, only for a relay on a private network (the selfhost `mail` container, the dev catcher) |
| `SMTP_PORT` | `465` / `587` / `25` by `SMTP_SECURITY` | server port |
| `SMTP_USER`, `SMTP_PASSWORD` | — | SMTP AUTH; both or neither |
| `EMAIL_FROM` | `no-reply@<host of BASE_URL>` | sender address (a plain address, no display name) |
| `EMAIL_FROM_NAME` | `Common Ground` | sender display name |

The transport is created lazily as a **pool** (`pool: true`, at most 5 connections, 100 messages each), because the jobs send to many recipients at once; connection/greeting timeouts are 30 s, the socket timeout 60 s. Certificates are verified for `tls`/`starttls` (nodemailer default).

The `api` and `job-runner` services receive these variables in both compose files. The dev stack points them at its `mailpit` catcher (`SMTP_HOST=mailpit`, port 1025, `none`; web UI on `EXTERNAL_LISTEN_IP:8025`) — `docker-compose.yml` uses that as the default even when the variables are missing from an older `docker/.env`, and an explicitly empty `SMTP_HOST` turns email off. Self-hosting: see [docs/deployment §3.9](../deployment/README.md#39-email-smtp-and-the-mail-relay).

### Graceful degradation

Email delivery is **optional**. `emailEnabled()` (`srv/api/emails.ts`) is `true` only when `parseMailConfig()` accepts the configuration. A missing `SMTP_HOST` — or an invalid value (`SMTP_SECURITY` not one of the three modes, a non-numeric or out-of-range `SMTP_PORT`, only one of `SMTP_USER`/`SMTP_PASSWORD`, an `EMAIL_FROM` that isn't a plain address) — disables email instead of crashing. The `api` process logs one line at startup either way (main thread only, never the password), e.g.

```
Email delivery is disabled: SMTP_HOST is not set. Email login codes, verification and notification mails are unavailable.
Email delivery via SMTP mail:587 (none, user cg-app), from no-reply@chat.example.org
```

`SMTP_SECURITY=none` towards a host that is neither loopback nor a single-label name (a compose service such as `mail` or `mailpit`) adds an error-level line to that log — prefixed `!!!` when a login is configured, because the password then crosses the network in clear (`plaintextSmtpWarning()` in `srv/util/mailConfig.ts`; `selfhost.sh up` warns with the same rule).

When email is disabled:

- `sendEmail` logs a warning, drops the message, and throws `EMAIL_DISABLED` (`srv/common/errors`).
- The `newsletterDelivery` and `emailNotifications` jobs exit early without doing work (each run logs that it is skipping).
- `POST /user/sendOneTimePasswordForLogin` rejects with `EMAIL_DISABLED` instead of pretending a code was sent.
- The instance config ships `features.email: false` (`srv/util/instanceConfig.ts` applies the same `parseMailConfig()` rule), so the frontend hides email features. The instance config the selfhost Caddy edge serves (`/instance-config.js`, `CG_FEATURE_EMAIL`) only checks that `SMTP_HOST` is non-empty, so in the web app an otherwise invalid configuration still shows the email UI while the backend has email off — the `api` startup log names the reason.

---

## Sending layer (`srv/api/emails.ts`)

`EmailUtils` is a singleton (`export default emailUtils`).

- **`sendEmail({ to, subject, text, html, attachments?, unsubscribe? })`** — private; the only place mail leaves the backend (`transporter.sendMail`). Guards on `emailEnabled()`, sets `From: "<EMAIL_FROM_NAME>" <EMAIL_FROM>`, and — when `unsubscribe` names a preference — adds the one-click unsubscribe headers (see [One-click unsubscribe](#one-click-unsubscribe)). SMTP errors are logged with the server response and rethrown as `Error sending email`.
- Composers: `sendVerificationEmail`, `sendOneTimePasswordEmail`, `sendNewsletter`, `sendArticleAsEmail`, `sendEventEmail`.

**Templates are local.** Every mail is assembled in the backend: an HTML part and a plain-text part, both built inline (no templating engine, no provider-side templates):

- `getHTMLTemplate(content, readMore, hideCGHeader?, unsubscribe?)` — table-based shell with a blue header stripe, the CG logo, and a footer with "Change email settings" (`<APP_URL>/?user-settings=notifications`) and, for notification mails, "Unsubscribe from these emails".
- `getHTMLforPosts(posts, withDividers?)` / `getTextForPosts(posts)` — an `EmailPost[]` list (thumbnail + title + community / title, community and URL).
- `getTextFooter(unsubscribe?)` — the plain-text counterpart of the footer.
- `getEventEmailString(type, name)` — subject/heading per event type.

User-provided values (post titles, community and event names, image URLs) are HTML-escaped before they go into the HTML part. Every link points at `urlConfig.APP_URL` (derived from `BASE_URL`) — never at the host of the incoming request — so self-hosted instances link to themselves. The logo and post images are absolute URLs; article/community images are resolved to signed S3 URLs (`fileHelper.getSignedUrls`) before rendering.

---

## Transactional mails

| Mail | Composer | Triggered from | Notes |
|------|----------|----------------|-------|
| Email verification | `sendVerificationEmail` | `POST /user/requestEmailVerification` (and account creation on an instance without the sign-up code step) | An 8-digit code plus a link to `<APP_URL>/verify-email?email=…&token=<code>` (both URI-component-encoded) that works while signed in to the account that asked; a dev setup that wants the link on the Vite dev server sets `BASE_URL` accordingly. Send limits apply ([Send limits](#send-limits)). |
| Address in use | `sendAddressInUseEmail` | `POST /user/requestEmailVerification` for an address another account has verified | Notice instead of a code; the requester gets the same answer as for a free address. Send limits apply ([Send limits](#send-limits)). |
| One-time password login | `sendOneTimePasswordEmail` | `POST /user/sendOneTimePasswordForLogin` | Emails an 8-digit login code (15 minutes) only to the **verified** address of an account; nothing is sent for an unconfirmed or unknown address, the answer is the same. Requires `emailEnabled()`; send limits apply. |
| Password changed | `sendPasswordChangedEmail` | `POST /user/setPassword` | Notice to the verified address. |
| Address changed | `sendEmailChangedEmail` | `POST /user/verifyEmail` replacing a verified address | Notice to the previous address. |
| Event mails | `sendEventEmail` | See [Event notification mails](#event-notification-mails) | — |

Transactional mails carry **no** unsubscribe headers. The notification mails — [Weekly digest](#weekly-newsletter-digest) (`sendNewsletter`) and [community article mails](#per-community-article-newsletter) (`sendArticleAsEmail`) — do.

### Verification and login codes

`srv/util/emailCodes.ts` keeps two kinds of 8-digit codes (CSPRNG, leading zeros kept) for existing accounts, in
Valkey with the expiry as TTL — only a hash, bound to the account, the purpose and the address the
code was sent to:

- `verify` (24 hours): `requestEmailVerification` → `verifyEmail` (signed in to that account). The
  address becomes the account's verified address only when its code comes back; on an instance that
  sends mail, `updateOwnData` no longer sets `email` (`EMAIL_VERIFICATION_REQUIRED`).
- `login` (15 minutes, only to a verified address): `sendOneTimePasswordForLogin` → `User/login {type:'verificationCode'}`.

One code per account and purpose (a new one replaces the old one), five wrong guesses per code
(atomic counter), and a matching code is deleted in the step that accepts it, so it works once.
A verification code is never a login code. Details: [auth-identity §5.5, §8](../auth-identity/README.md#55-email-verification-code--one-time-password-type-verificationcode).

---

## Weekly newsletter (digest)

A "Common Ground Digest" summarising the last 7 days of articles, sent to users who opted in via the `weeklyNewsletter` flag.

**Job:** `srv/jobs/newsletterDelivery.ts` — cron `0 12 * * 6` (Saturdays, 12:00).

Flow:

1. Skip entirely if `!emailEnabled()`.
2. Compute a numeric `newsletterId` from the current date (`YYYYMMDD`) — this de-duplicates a given week's send.
3. `createNewsletterEntries(newsletterId)` (`srv/repositories/newsletter.ts`) inserts one `user_newsletter_status` row per eligible user (`weeklyNewsletter = true AND emailVerified = true AND deletedAt IS NULL`) that does not already have a row for this `newsletterId`, and returns the newly added users. Re-running the job the same day therefore does not re-send.
4. For each user, `getPostsFromFollowedCommunities(userId)` (their communities) plus one shared `getGeneralCommunityPosts()` (up to 10 articles from all communities, published in the last 7 days) build two `EmailPost` lists.
5. `sendNewsletter({ email, userId }, followedPosts, generalPosts)` renders two sections — "This week from **your** communities" and "This week from **all** communities" — and sends, with a one-click unsubscribe for the digest. If both lists are empty the send is skipped.
6. On success, `updateSentAtNewsletterStatus(newsletterId, userId)` stamps `sentAt`.
7. Failed sends are collected and retried once; a second failure exits the worker with code 1.

`getNewsletterStatus(userId)` (checks for a `sentAt` within the last 7 days) supports "was this user mailed recently" queries.

---

## Per-community article newsletter

Community managers can push a published article to all eligible community members as an email ("New post in your community").

**Opt-in to send (author side):**

- `POST /community/sendArticleAsEmail` (`srv/api/community.ts`) requires `COMMUNITY_MANAGE_ARTICLES` permission **and** the community to be whitelisted (`isCommunityWhitelisted`). It calls `registerCommunityArticleForEmails(articleId, communityId)`, which marks the article `markAsNewsletter = true` and un-marks any other pending article in the community (only one queued at a time).

**Delivery (job side):** `srv/jobs/emailNotifications.ts` → `articleNotifications()` (part of the every-minute job):

1. `getCommunityArticleForEmailsList()` finds articles where `markAsNewsletter = true AND sentAsNewsletter IS NULL AND published < now()`.
2. `prepareArticleToSendViaEmail(articleId, communityId)` (`srv/repositories/emails.ts`) resolves the recipient set (`{ email, userId }[]`): it walks the article's role permissions, collects roles that grant `ARTICLE_READ` (mapping the `Public` role onto `Member` where relevant, excluding `Admin`), then selects **verified** subscribers of the community newsletter for those roles.
   - Recipient query (`newsletterUsersBaseQuery`): user must have a **claimed** role granting read access, `emailVerified = true`, not deleted, and an active per-community newsletter subscription (`newsletterJoinedAt IS NOT NULL AND newsletterLeftAt IS NULL`).
3. `sendArticleAsEmail(recipient, post, communityId)` is sent to each recipient, with a one-click unsubscribe for that community's article mails. Sends run through `sendToAll()` (`srv/util/sendToAll.ts`, `Promise.allSettled`): a recipient whose send fails is logged (by user id) and skipped.
4. `updateSentAtCommunityNewsletterStatus(articleId, communityId)` stamps `sentAsNewsletter` — also when some sends failed, because a retry of the whole article would mail everyone else again.

**Subscription (recipient side):** managed in `srv/repositories/newsletter.ts`:

- `subscribeUser(userId, communityIds[])` / `unsubscribeUser(...)` toggle `user_community_state.newsletterJoinedAt` / `newsletterLeftAt` and emit a `cliCommunityEvent` update (`myNewsletterEnabled`) so the UI updates live.
- `getUserSubscriptions(userId)`, `getUsersEligibleForCommunityNewsletter(communityId)`, `getMembersCountForNewsletter(...)`, and `getNewsletterHistory(...)` support the community-settings UI.

---

## Event notification mails

Sent to event participants. `sendEventEmail` produces one of four variants via `EventEmailOptions.type`:

| Type | Subject | Trigger |
|------|---------|---------|
| `attending` | "You're attending …" | `POST /community/addEventParticipant`. Includes an `invite.ics` calendar attachment. |
| `starting` | "… is starting soon" | `emailNotifications` job → `eventNotifications()` |
| `changed` | "… was changed" | `POST /community/updateCommunityEvent` |
| `cancelled` | "… was cancelled" | `POST /community/deleteCommunityEvent` |

- The `attending` variant attaches an ICS file (`text/calendar; method=PUBLISH`, disposition `attachment`) generated by `generateEventICSFile` (`src/common/util.ts`, shared with the frontend's "add to calendar"): `METHOD:PUBLISH` (informational — there is no attendee list to reply to), `UID` `<event id>@<instance host>`, `DTSTAMP` = the time the file was generated. Titles and names are escaped per RFC 5545 (`src/common/ics.ts`: TEXT escaping, quoted parameters, 75-octet folding, CRLF), so no event or community title can add or alter calendar properties.
- The `starting` variant is driven by the every-minute job: `getUpcomingEventsToNotify()` finds events scheduled within the next 15 minutes that have not yet been notified (`eventNotified = FALSE`) and whose participants have `emailVerified = TRUE`; the mails go out through `sendToAll()` like article mails, and `markEventAsNotified` then sets `eventNotified = TRUE` regardless of individual failures.
- Recipient resolution for `changed`/`cancelled` uses `getUserEmailsToNotify({eventId})`, which returns participants with `emailVerified = TRUE`.
- In all API-triggered cases the email send is wrapped in a try/catch so a mail failure never fails the underlying event mutation.
- Event mails are treated as transactional (the user joined the event); there is no email preference for them and they carry no unsubscribe headers.

---

## One-click unsubscribe

Digest and community-article mails carry ([RFC 8058](https://www.rfc-editor.org/rfc/rfc8058)):

```
List-Unsubscribe: <https://<host>/api/v2/User/emailUnsubscribe?token=<token>>
List-Unsubscribe-Post: List-Unsubscribe=One-Click
```

Mail apps show this as an "Unsubscribe" button and POST to the URL; the same URL is the "Unsubscribe from these emails" link in the footer (HTML and text part).

**Token** (`srv/util/unsubscribeToken.ts`): `<kind>.<userId>[.<communityId>].<mac>` — kind `d` (weekly digest) or `c` (one community's article mails), MAC = base64url HMAC-SHA256 over the rest, keyed with a key derived from the session secret (`REDIS_SECRET`, label `cg-email-unsubscribe-v1`). Tokens need no database lookup to verify, do not expire (an old mail's link keeps working), and can only turn a preference **off**. Rotating `REDIS_SECRET` invalidates the links in mails already sent. Without `REDIS_SECRET` the mails are sent without unsubscribe headers/links (warning in the log).

**Endpoint** (`srv/api/emailUnsubscribe.ts`, mounted on the `User` router, so `/api/v2/User/emailUnsubscribe`; no login):

| Method | Effect |
|--------|--------|
| `GET ?token=…` | Only shows a confirmation page with an "Unsubscribe" button (a form POST to the same URL). GET never changes anything — link scanners open every URL in a mail. |
| `POST ?token=…` | Turns the preference off and shows "You are unsubscribed": `d` → `users.weeklyNewsletter = false` (via `userHelper.updateUser`, which also emits `cliUserOwnData`); `c` → `newsletterHelper.unsubscribeUser(userId, [communityId])` if the user is still subscribed (idempotent otherwise). The RFC 8058 body `List-Unsubscribe=One-Click` is accepted form-encoded; multipart bodies are not parsed — the signed token alone authorizes. |

Validation: Joi schemas `emailUnsubscribeQuery` (token pattern; other query keys such as the `utm_*` parameters link rewriters append are ignored) and `emailUnsubscribeBody` in `srv/validators/api/user.ts`; an invalid or forged token gets a 400 page. A token for an account that has been deleted since the mail was sent is answered like a successful unsubscribe. Rate limit: `ipRateLimitHandler`, 60 requests/minute per IPv4 address or IPv6 /64 (120 per /56, 240 per /48), separate buckets for GET and POST — higher than the signup/captcha limits because mail providers send one-click POSTs from a few shared server IPs. The buckets have fixed names (`bucket` option of `srv/util/rateLimit.ts`), since the URL carries the token. Responses are small HTML pages (`Cache-Control: no-store`, `X-Robots-Tag: noindex`).

RFC 8058 receivers only honour the headers when the message's DKIM signature covers them; the selfhost `mail` relay signs both (`docker/mail/maddy.conf`). With an external SMTP server, that is the provider's DKIM configuration.

---

## Send limits

Three endpoints make the server mail an address the caller chooses. They are limited in up to three dimensions (`srv/util/mailSendLimits.ts`, numbers in `srv/util/authLimits.ts`, sliding windows in Redis via `srv/util/rateLimit.ts`), checked before the mail is generated:

| Endpoint | Per client IP | Per target address | Per account |
|----------|---------------|--------------------|-------------|
| `POST /user/sendOneTimePasswordForLogin` (no login) | 30/h per IPv4 address or IPv6 /64 (90 per /56, 180 per /48) | 1/min and 10/h | — |
| `POST /user/requestSignupEmailCode` (no login) | 40/h, same prefixes | 1/min and 5/h | — |
| `POST /user/requestEmailVerification` (login required) | 30/h, same prefixes | 5/h | 5/h |

The per-address buckets are keyed by an HMAC of the lower-cased address, with a key derived from the session secret (`REDIS_SECRET`, label `cg-mail-send-limit-v1`, like the unsubscribe key), so no address is stored in Redis in clear and the keys can't be matched against a list of known addresses; they stop one inbox from being flooded from many IPs or accounts. For the login code that limit is also a lever against the address owner: anyone who knows an address can use up its budget and keep the owner from getting a code. The short cooldown (one code per minute) with a higher hourly cap (10) keeps that window short while still capping the mail volume to one inbox. The limits of a request are counted together (`enforceLimits`): a refused request counts in none of them, and the refusal names the longest wait. Over the limit the endpoint answers `RATE_LIMIT_EXCEEDED` with `retryAfterSeconds` (and a `Retry-After` header, [auth-identity §4 "Limits"](../auth-identity/README.md#limits)); the web app's "send again" buttons count down the per-address minute. Account creation with email (`POST /user/createUser`) sends at most one verification mail and is covered by the account limit (20 per network per hour, 50 per day). The selfhost relay additionally caps submissions at 50 messages/s and 10 in parallel (`limits` in `docker/mail/maddy.conf`); maddy has no limit on the queue size.

---

## Bounces

**Built-in relay.** The relay's queue (`docker/mail/maddy.conf`) turns every permanent delivery failure (a 5xx answer from the recipient's server) into a delivery status notification (RFC 3464) to the envelope sender, `EMAIL_FROM`. Instead of a mailbox, those reports go through a small queue of their own (`bounce_queue`, so they survive a `job-runner` restart) to the **bounce receiver**, a permanent worker of the `job-runner` (`srv/jobs/bounceReceiver.ts`, started when `MAIL_BOUNCE_RECEIVER=true`, which the selfhost compose file sets from `CG_ENABLE_MAIL`).

The receiver (`srv/util/bounceReceiverServer.ts`, built on [smtp-server](https://nodemailer.com/extras/smtp-server/)) listens on port 2525. The `job-runner` is on the shared `cryptogram` network as well as `mail-relay`, so the receiver checks every connection: only the addresses the relay's host name (`mail`, `MAIL_RELAY_HOST`) resolves to at that moment are let in, everything else gets `554` and a log line. It then requires the relay login (`SMTP_USER`/`SMTP_PASSWORD`, AUTH PLAIN, compared in constant time; the third failed attempt closes the connection), offers no STARTTLS, and limits messages to 1 MB, clients to 10, idle time to 60 s and each connection to 5 minutes.

`parseDsn()` (`srv/util/dsn.ts`) reads only the `message/delivery-status` part of a report (the quoted original headers are ignored). Every recipient with `Action: failed` and a `5.x.x` status is recorded in `email_bounces` (address, report Message-ID, status, the receiving server's `Diagnostic-Code` truncated to 500 characters) by `srv/repositories/emailBounces.ts`, which then applies the bounce policy (`srv/util/bouncePolicy.ts`) in the same transaction:

- **A single bounce changes nothing.** A 5xx does not prove the mailbox is gone: receivers also answer 5xx when they reject *this server* (blocklisted IP, failing SPF/DKIM/DMARC, missing PTR), and the relay reports every permanent failure as `Status: 5.0.0`, whatever the receiving server said — so the status code can't tell the two cases apart.
- **An address is marked unverified** (`users.emailVerified = false`, case-insensitive match) once it has at least two counted permanent bounces from separate messages that lie at least 24 hours apart. Since every digest, article and event mail requires a verified address, nothing more is sent there until the user verifies an address again.
- **Bursts are treated as a sending-side problem.** If more than 25 different addresses bounce within an hour, or more than 10 addresses of one recipient domain (`MAIL_BOUNCE_BURST_ADDRESSES` / `MAIL_BOUNCE_BURST_DOMAIN_ADDRESSES` on the `job-runner`), all bounces of that hour (in that domain) are flagged `senderSide` and never count, nobody (in that domain) is unverified, and the worker logs one error line per hour prefixed `!!!` with the latest diagnostic texts. Trade-off: a large send that hits many dead mailboxes at once looks like such an incident too, so those addresses are only unverified when they bounce again outside a burst.

The worker logs one line per report: status counts, rows recorded, how many addresses passed the policy and how many users were actually changed. Reports with only temporary results are ignored — maddy sends one, with `Status: 4.0.0`, when it gives up on a message after its last retry. If the database is unavailable, the receiver answers `451` and the relay retries the report later; a re-delivered report is recognized by its Message-ID and not counted twice. Bounce records older than 180 days are deleted by the weekly `newsletterDelivery` job.

**External SMTP server.** Bounces go wherever the provider sends them — usually to the envelope sender (`EMAIL_FROM`) or a bounce address in the provider's account. The app does not read them; operators who want to act on them use the provider's suppression list or dashboard, or make `EMAIL_FROM` a mailbox they read.

---

## Notification preferences

There are **three independent email opt-ins**, plus per-community push settings.

| Preference | Storage | Scope | Governs |
|------------|---------|-------|---------|
| `newsletter` | `users.newsletter` (bool, default `false`) | Global | The "CG Updates Newsletter" toggle: records the user's opt-in for a platform newsletter. No mail is sent based on it at present; it is kept for a future newsletter sent by the instance itself (it used to be mirrored into a Mailchimp list, see [History](#history-sendgrid-and-mailchimp)). |
| `weeklyNewsletter` | `users.weeklyNewsletter` (bool, default `true` since migration `1724084789644`) | Global | Weekly digest email eligibility; one-click unsubscribe `d` |
| `dmNotifications` | `users.dmNotifications` (bool, default `true`) | Global | DM notifications (push channel) |
| per-community newsletter | `user_community_state.newsletterJoinedAt` / `newsletterLeftAt` | Per community | Community article mail eligibility; one-click unsubscribe `c` |
| `notifyMentions`, `notifyReplies`, `notifyPosts`, `notifyEvents`, `notifyCalls` | `user_community_state` (bool, default `true`) | Per community | **Push / in-app** notifications (see [Boundary to web push](#boundary-to-web-push)) |

Global flags `newsletter`, `weeklyNewsletter`, and `dmNotifications` are edited through `POST /user/updateOwnData` (validated in `srv/validators/api/user.ts`). `newsletter` also has the dedicated `POST /user/subscribeNewsletter` / `POST /user/unsubscribeNewsletter` routes, which set the flag and emit `cliUserOwnData` (their `email` request field is accepted for compatibility and ignored).

`emailVerified` acts as a hard gate on **every** newsletter and event email query — unverified addresses never receive digest, article, or event mail regardless of the opt-in flags above.

---

## Scheduled jobs

Email-relevant workers are spawned from `srv/jobs.ts` (each runs in a worker thread; all guard on `isMainThread` and exit early if email is disabled):

| Job file | Schedule | Purpose |
|----------|----------|---------|
| `newsletterDelivery.ts` | `0 12 * * 6` (Sat 12:00) | Weekly digest; first deletes bounce records older than 180 days |
| `emailNotifications.ts` | `*/1 * * * *` (every minute) | Article newsletters + "event starting soon" mails |
| `bounceReceiver.ts` | permanent (selfhost relay only) | Receives the relay's bounce reports, see [Bounces](#bounces) |

The every-minute `emailNotifications` job runs `articleNotifications()` then `eventNotifications()` in sequence. Failed sends to individual recipients are logged and don't stop the run; other errors (e.g. the database) exit the worker, which is respawned on the next tick.

---

## Boundary to web push

Email and web push are **parallel, independent channels** with different plumbing and different preference flags:

| | Email | Web push / in-app |
|---|-------|-------------------|
| Transport | SMTP (nodemailer) | `web-push` (VAPID) |
| Code | `srv/api/emails.ts`, `srv/jobs/*` | `srv/repositories/notifications.ts` (`webPush.sendNotification`) |
| Preferences | `users.weeklyNewsletter`; per-community newsletter subscription | `users.dmNotifications`; `user_community_state.notify{Mentions,Replies,Posts,Events,Calls}` |
| Gated by | `emailVerified` | active push subscription + the `notify*` flags |

The per-community `notify*` booleans (`notifyMentions`, `notifyReplies`, `notifyPosts`, `notifyEvents`, `notifyCalls`) are consumed by the **push** path in `srv/repositories/notifications.ts`, not by any email query. Event *emails*, by contrast, are gated only by event participation and `emailVerified`. Full push/VAPID/service-worker detail lives in [docs/realtime](../realtime/README.md).

---

## Data model reference

| Table / column | Meaning |
|----------------|---------|
| `users.email`, `users.emailVerified` | Address and verification state (`emailVerified` is reset by the bounce policy) |
| `email_bounces` (`address`, `reportId`, `status`, `diagnostic`, `senderSide`, `createdAt`) | Permanent bounces from the selfhost relay; unique per (`reportId`, `address`); kept 180 days |
| Valkey `email-code:<purpose>:<userId>` | Pending verification / login code (hash, bound address, expiry) |
| `users.newsletter` | "CG Updates Newsletter" opt-in (kept for a future newsletter; nothing is sent based on it yet) |
| `users.weeklyNewsletter` | Weekly digest opt-in |
| `users.dmNotifications` | DM push opt-in |
| `user_newsletter_status` (`userId`, `newsletterId`, `sentAt`) | Weekly-digest send ledger (de-dup per week) |
| `user_community_state.newsletterJoinedAt` / `newsletterLeftAt` | Per-community newsletter subscription window |
| `user_community_state.notify*` | Per-community push preferences |
| `communities_articles.markAsNewsletter` / `sentAsNewsletter` | Article queued-for / already-sent-as email |

---

## History: SendGrid and Mailchimp

Until 2026-10 the backend sent through the **SendGrid** HTTP API (`@sendgrid/mail`, `SENDGRID_API_KEY`) and mirrored the `newsletter` flag into a **Mailchimp** marketing list (`@mailchimp/mailchimp_marketing`, `MAILCHIMP_API_KEY`, `MAILCHIMP_LIST_ID`, data center `us9`), tagging contacts "New Member" / "New Community created". Both are gone (decision 10 of the cg.box move): mail goes out over SMTP, and `newsletter` is a local opt-in flag.

- SendGrid was used as a plain transport — every mail's HTML and text were already built in the backend, no SendGrid dynamic templates or template IDs were referenced. Account-side SendGrid settings (e.g. click/open tracking or subscription footers) were never configured in code; TODO(verify): whether the old SendGrid account added any of these to the mails.
- The three mails that sent the literal string `text` as their plain-text part (digest, article, event) got real text parts in the move.
- Contacts that only existed in the Mailchimp list (and the tags there) are not migrated; the list is outside the code.
