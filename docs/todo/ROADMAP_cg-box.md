# Roadmap: cg.box — move the hosted instance to a single self-host server

> Umbrella roadmap for moving the hosted Common Ground instance from `app.cg`
> (Docker Swarm, `production` branch) to **`cg.box`** (one server, self-host
> profile, `develop` branch), plus the infrastructure and security work that has
> to land first. Living document; supersedes the 2026-10-22 platform-ops
> planning, whose decisions are carried over below. Delete this file when the move is done and `app.cg` is shut down; the
> post-move items (P7) graduate into their own roadmaps or TODO.md.
>
> **No deadline, no blockers wanted:** "as soon as possible" means the move must
> not wait on anything that isn't on this list — not that the list gets cut.

## Target picture

```
            ┌──────────────────── one server ─────────────────────────┐
cg.box ─────┤ Caddy ─► main instance (develop: api, wsapi, jobs, …)   │
            │   │                         │                           │
app.cg ─────┤   └────► gateway instance ──┴── same Postgres / Valkey / │
id.app.cg ──┤          (develop, gateway mode)   SeaweedFS             │
            └─────────────────────────────────────────────────────────┘
```

- **cg.box** is a fresh instance on `develop`, restored from a backup of the
  current production data (Postgres + S3) and migrated forward.
- For a transition period **app.cg and id.app.cg point at the same server**.
  There a minimal **"login & migrate" gateway** runs: users log in exactly as
  before — device key (silent), passkey (rpID `id.app.cg`), wallet, email,
  password — and get a **one-time link** that logs them in on cg.box. cg.box then
  requires them to set up a login method that works there (and an email) before
  they get in.
- After the transition period app.cg is shut down. Users who did not move by then
  lose access; the active user base is expected to have moved.
- The `production` branch and the Azure/Swarm pipeline are **not touched**: the
  old stack is switched off after the final backup.

## Decisions

2026-10-22 (from the platform-ops planning):

1. Container runtime on targets: **Docker Compose** (self-host profile). Target
   OS: Ubuntu LTS / Debian 13.
2. **nginx is replaced by Caddy** in the self-host profile **and** the dev stack,
   so routing lives in one place.
3. **7-day minimum release age for every ecosystem** (npm, Docker images, apt,
   pip/Galaxy, CI). Exceptions only with explicit maintainer approval, recorded
   with date, package/version and reason.
4. **Redis → Valkey.**
5. Images are built on the server. Prebuilt images (GitHub Actions + GHCR) and the
   Ansible management suite (Ansible in a pinned container, `cg.sh`/`cg.ps1`) come
   after the move — except backup/restore, which is needed before it.

2026-10-28:

6. Merge to `develop` without PRs where the maintainer says so; housekeeping via
   git.
7. The **seven deferred major updates are part of this work** (Express 5,
   react-router 7, Tailwind 4, Vite 8, TypeORM 1.x, joi 18, TypeScript 6).

2026-10-31:

8. **Gateway instead of a read-only mode** on the old stack (target picture above).
   No Bot API forwarding is needed — the production release has no Bot API.
9. **Passkeys for cg.box are registered on the main origin** (rpID `cg.box`), with
   no popup or redirect to an `id.` subdomain. There is no `id.cg.box`. The
   account-creation UI gets reworked in the same go.
10. **Email: the app speaks SMTP only** (nodemailer, replacing SendGrid; Mailchimp
    goes). The stack ships an **optional send-only mail container** (compose
    profile, switchable off) and the operator can point the app at any SMTP
    server instead. (Revises the 2026-08-02 "no MTA in the stack" decision.)
11. A **dress rehearsal with real production data** happens well before move day,
    on the test VM; the final dump is taken on move day.
12. app.cg is kept only for the transition period.

2026-11-01:

13. **Node 26** (LTS since 2026-10, support until ~2029) for the new deployment;
    Node 24 is the fallback only if mediasoup or a native module blocks.
14. **Renovate runs as the Mend GitHub app** (free for public repos, no own
    infrastructure, opens PRs only — nothing auto-merges).

## Phases

Order: P0 → P1 → (P2 ∥ P3) → P4 → P5 → P6. Work inside a phase runs in parallel
branches. Each item follows the usual cycle (branch from `develop` → implement →
independent review → maintainer go → merge → delete branch).

### Lanes (how the work is parallelized)

Claude coordinates: work packages go to implementing agents, each result gets an
independent review, then a test-VM acceptance where it touches the stack, then
the maintainer's go for merge + push (ready branches are presented in batches).
Lanes are cut by **file ownership**, so parallel branches rarely conflict:

| Lane | Owns | Sequence |
|---|---|---|
| **A Infra** | `docker/`, Dockerfiles, compose files, Caddy, shell scripts | F1+F2 → F3 ∥ F4 → F5 → F7 → F8 |
| **B Dependencies** | `package.json` / `yarn.lock` of all workspaces | after F1+F2 are merged (age gate, Node 26): F6 → M1 → M2 → M3 → M4 |
| **C Move features** | backend auth/APIs, login and account UI | starts now: G8 → G4 → G2+G3 → G1 → G5, G6, G7, G9 |
| **D Security** | the private findings list (not in this repo) | starts now: S1 triage; fixes are slotted into A/B/C |
| **Maintainer** | outside the repo | Renovate app, server order, DNS, legal (S6), production dump |

Serialization points (one at a time, coordinated by Claude):

- **Dev stack**: every checkout on the dev VM shares the compose project `docker`
  (volumes, ports), so only one lane runs the stack; agents in worktrees build
  and test in throwaway containers with their own project names.
- **Builds**: a frontend build peaks at ~4 GB; the dev VM (16 GB, 4 cores) takes
  about two concurrent heavy builds.
- **Test VM**: one acceptance run at a time.
- **Lockfile**: lane C's new packages (e.g. nodemailer, WebAuthn) land as small
  separate commits that are merged first, so lane B rebases on them.
- **Merges to `develop`**: one at a time; open branches rebase afterwards.

Start set: A (F1+F2), C (G8), D (S1) — two to three implementing agents at once,
plus reviews. Lane B starts when F1+F2 are merged.

### P0 — Housekeeping

- [x] This roadmap committed; `ROADMAP_dependency-updates.md`,
  `ROADMAP_REFERENCE_CLIENT.md` and `ROADMAP_IMAGE_FILTER.md` dissolved into
  docs/ and TODO.md; hosted-Swarm-only TODO items marked superseded.
- [x] Issue #53 follow-up merged (`a5633d5be`); merged remote branches deleted
  (12 on 2026-10-28).
- [x] Delete the six remaining remote branches (squash-merged into develop,
  verified 2026-10-31 by a trial merge that leaves develop's tree unchanged).
- [x] `docker/.env` untracked: template `docker/.env.example` + first-run
  generator `docker/ensureEnv.sh` (merged 2026-10-31, `3925a78`).
- [x] Dev VM access to GitHub via per-repo deploy keys; `main`/`develop`
  protected against force pushes and deletion (ruleset).
- [ ] Reply to issue #87 (external contributor, call reliability) — draft by
  Claude, posted by the maintainer. Mention the ICE-TCP and startup-order fixes
  merged 2026-10-28.

### P1 — Foundation

- [ ] **F1 Update policy.** Policy document in docs/infrastructure (7-day rule,
  exception log, mechanisms: Yarn `npmMinimalAgeGate`/`npmPreapprovedPackages`,
  Renovate `minimumReleaseAge`). Renovate config for the Mend GitHub app
  (decision 14; the maintainer installs the app). `yarn --immutable` in every Dockerfile; lockfile for
  `docker/hardhat/node`; narrow `approvedGitRepositories`. Checksums for binary
  downloads where feasible (mediasoup worker, Chrome for Testing for puppeteer,
  bcrypt prebuilds).
- [ ] **F2 Base images and tooling.** Pin every image by version + digest. Node 26
  (decision 13) — verify mediasoup and the native modules (bcrypt, sharp,
  onnxruntime) build and run. Debian base `bookworm` → `trixie`
  (TODO(verify): bookworm's regular security support status). apt via dated
  snapshot or exact versions. SeaweedFS and Caddy current. Yarn 4.17.1 → current
  4.x (update the `packageManager` field incl. its hash) — all under the 7-day
  rule; binary checksums as in F1.
- [ ] **F3 PostgreSQL 14 → 18.** Time-sensitive: PostgreSQL 14 reaches end of life
  in November 2026, and both the dev stack and the self-host profile run
  `postgres:14-alpine` today. New image + tuned `postgresql.conf` for 18. On
  cg.box this is a restore into a fresh cluster, no in-place upgrade. Check the
  dev stack's upgrade path (dump/restore of the dev volume, documented).
- [ ] **F4 Redis 6.2 → Valkey.** Sessions, socket.io adapter, cached data; verify
  node-redis / connect-redis / `@socket.io/redis-adapter` against Valkey.
- [ ] **F5 Caddy replaces nginx** (self-host + dev). Custom Caddy image carrying
  the frontend dist and the instance-config injection. Reproduce every nginx rule
  in order: `/files/` S3-presign rewrite (exact `Host <host>:8333`), `/api/v2/`
  allowlist strip-prefix, `/api/bot/v1/` → `/BotV1/`, `/api/ws/`, share/OG
  routes, the `/community/<url>` redirect, static
  assets with long-lived `immutable` caching for the content-hashed files under
  `static/` (nginx caps them at `max-age=86400, must-revalidate` today), SPA fallback with `no-cache`
  shell, COOP/COEP pages, CSP + security headers, the CG-ID-origin CORS headers
  (needed by the gateway's `id.app.cg`), `request_body max_size 16MB`,
  trusted-proxy / `X-Forwarded-For` handling (the rate limiter keys on it). Add HSTS
  (no preload at first). Let's Encrypt in production, `tls internal` for local
  instances. Dev stack: Caddy `tls internal` instead of nginx + self-signed certs;
  `run.sh` commands keep working; the Vite dev server on :3000 is unchanged.
  Update `tools/checkHtmlRewriteCompat.mjs`, the
  conformance compose file, build scripts and docs. Acceptance: conformance suite
  green + browser pass on the test VM. The CG ID vhost is no longer needed on
  cg.box (decision 9) but **is** needed for the gateway's `id.app.cg` (see G1;
  the TODO.md item on pruning the CG ID vhost's cross-origin allowances applies
  here). The hosted Swarm nginx configs are deleted together with the Swarm
  pipeline after the move (P7).
- [ ] **F6 npm security + in-major refresh** of all workspaces under the age gate
  (`yarn npm audit` clean or every remaining advisory documented). Includes the
  Hardhat 2.29 bump from TODO.md ("Optional").
- [ ] **F7 Self-host leftovers.** Build ID no longer written into the tracked
  `src/common/random_build_id.ts`; a real healthcheck (`startHealthcheck` in
  `srv/healthcheck.ts` has no callers, every process uses `fakeHealthcheck()` —
  wire the real one up or delete it, and move `fakeHealthcheck` into its own
  module so `memberlist` stops opening Redis connections it never uses); Docker
  log rotation; IPv6 address detection; drop the `docker-compose` v1 fallback in
  `selfhost.sh` (v1 ignores `COMPOSE_PROFILES`, so `calls`/`blockchain` would
  silently not start).
- [ ] **F8 Backup / restore.** `selfhost.sh backup|restore` (or scripts):
  Postgres custom-format dump, SeaweedFS data, encrypted secrets bundle
  (`.env.selfhost`, `vapid_keys.json`, `s3_config/`, certs), retention,
  systemd timer, **off-server copy** (e.g. restic to a storage box). Done only
  after a restore onto a fresh test VM was rehearsed.

### P2 — Major-version waves (after F6)

One branch per wave, each verified with typecheck, lint, tests, conformance suite
and a browser pass on the test VM:

- [ ] **M1** TypeScript 6, joi 18
- [ ] **M2** Express 5, TypeORM 1.x (runtime-critical; full backend pass)
- [ ] **M3** react-router 7, Vite 8
- [ ] **M4** Tailwind 4 (visual regressions — screenshot comparison of key views)

### P3 — Move features (parallel to P2)

- [ ] **G1 Gateway mode.** The `develop` backend + frontend started a second time
  with `BASE_URL=https://app.cg`, `CGID_URL=https://id.app.cg` and a gateway flag,
  on the same database/Valkey/S3. Server-side **endpoint allowlist** (login
  methods incl. CGID passkey assertion, session, transfer-link creation; nothing
  else) — enforced in the backend, not just hidden in the UI. Frontend: after
  login only the "Common Ground moved to cg.box" screen. Deep links: after the
  transfer, `app.cg/<path>` lands on `cg.box/<path>`. Session cookie scoped to
  `.app.cg`. Because the gateway needs the CGID passkey flow for rpID `id.app.cg`,
  the CGID app can only be removed from the code base **after** the gateway is
  gone (P7).
- [ ] **G2 Transfer link.** One-time token: random, stored hashed with user id,
  ~10 min expiry, single use; carried in the URL fragment
  (`https://cg.box/transfer#<token>`) so it never reaches logs or `Referer`;
  redeemed by a POST from the cg.box frontend. Rate-limited.
- [ ] **G3 Account-security step on cg.box.** A user arriving via transfer link
  (and any user without a working login method on cg.box) must add one before
  using the app: passkey on cg.box, password, or an already-linked wallet; plus a
  verified email. A server-side password policy comes with it. Decide here whether stricter requirements against bots apply to
  new sign-ups too (email verification is cheap once mail runs on our side).
- [ ] **G4 Passkeys on the main origin + new account-creation UI.** rpID =
  cg.box host, ceremonies run in the main app (conditional UI / passkey autofill
  on the login form; step-up re-authentication for destructive actions such as
  deleting a community becomes a simple in-page prompt). New account-creation /
  login UI. Old `id.app.cg` passkeys stay valid on the gateway only. Take the
  TODO.md item "Passkey ceremony foot-guns in the CGID flow" into account when
  the ceremonies move.
- [ ] **G5 Import routine.** Restore the production dump into Postgres 18, run the
  develop migrations, then a post-import step (sessions live in Redis/Valkey,
  not in the dump, so they start empty anyway): keep `devices` and
  old passkeys (the gateway needs them) but mark old passkeys as gateway-only,
  rewrite absolute `app.cg` URLs in stored content
  (TODO(verify): where absolute URLs are stored), copy S3 objects into SeaweedFS
  (TODO(verify): which storage production uses and the data volume). Idempotent
  and scripted; part of the backup/restore tooling.
- [ ] **G6 Service worker on app.cg.** The new server serves, at the old service
  worker URL, a worker that replaces the old PWA: clears the old caches, takes
  control and loads the gateway. Must be tested with a browser that has the old
  app installed (P5).
- [ ] **G7 Farewell push.** One-off script that sends "Common Ground moved" to
  every stored push subscription, in the payload format of the **old** service
  worker, signed with the **old VAPID key pair** (must come with the production
  secrets); removes expired subscriptions. Old subscriptions are not usable for
  cg.box — users re-subscribe there (part of G3).
- [ ] **G8 Mail.** SMTP via nodemailer instead of SendGrid (the swap point is
  `EmailUtils.sendEmail` in `srv/api/emails.ts` + init in `srv/serverconfig.ts`),
  Mailchimp removed. Optional send-only MTA container (compose profile `mail`,
  e.g. Postfix or Maddy): persistent queue with retries (greylisting), DKIM
  signing with the key kept out of the app containers, one egress point for
  port 25. `CG_ENABLE_MAIL=false` + `SMTP_*` settings for an external server.
  Docs for SPF, DKIM, DMARC, PTR/rDNS, outbound port 25 at the hoster, and
  one-click unsubscribe for notification mails.
- [ ] **G9 Domain-specific leftovers.** `og:site_name` hardcoded to `app.cg` in
  `index.html` (every self-hosted instance ships it in social previews — drop the
  tag or rewrite it in the instance-config injection like the other social meta);
  external service settings for cg.box: Twitter callback URL,
  WalletConnect origin allowlist, email sender domain.

### P4 — Security gate (before the rehearsal is signed off)

- [ ] **S1 Findings triage.** The private findings list is triaged against the
  new stack; whatever applies and blocks the move is fixed (tracked privately).
- [ ] **S2 Review of the new code** (gateway, transfer link, account-security
  step, passkeys on the main origin, mail) — independent security review.
- [ ] **S3 Server hardening.** SSH key-only login, firewall (only 22, 80,
  443 tcp+udp (HTTP/3), 4443, 40000–40099 udp+tcp; note that Docker-published ports bypass ufw — publish
  nothing else), unattended security upgrades, log rotation.
- [ ] **S4 Monitoring.** External uptime check; alerts for disk space, certificate
  expiry, container health; where alerts go.
- [ ] **S5 DNS.** CAA record (Let's Encrypt only); lowered TTL on app.cg ahead of
  the move; HSTS without preload first.
- [ ] **S6 Operator duties** (maintainer, not code): legal notice and privacy
  policy for cg.box (new hoster → data processing agreement; own mail sending
  changes data flows), DSA notice-and-action contact and reporting process.

### P5 — Dress rehearsal (test VM)

- [ ] Production dump (DB + S3) from the maintainer — a few weeks old is fine;
  deleted from the test VM afterwards.
- [ ] Full run on the test VM with `cg.test` as the new domain and `app.test` /
  `id.app.test` as stand-ins for the old ones (Caddy `tls internal`, hosts file):
  import (G5), gateway, transfer link, account-security step, farewell push
  against a test subscription, service-worker replacement with a browser that has
  the old production app installed (served under `app.test` before the switch).
- [ ] Backup → restore onto a freshly reset test VM (F8).
- [ ] One real Let's Encrypt run on a publicly reachable server (the test VM only
  exercises `tls internal`), so the ACME path is proven before move day.
- [ ] Time the import, so move-day downtime can be announced.
- [ ] Repeat until clean; write the move-day runbook from it.

### P6 — Move

- [ ] Server ordered and sized (from the rehearsal numbers); base setup per S3.
- [ ] Soft launch: cg.box running for the team for a few days (fresh data).
- [ ] Announcement with the downtime window.
- [ ] Move day per runbook: stop the old stack → final dump → import → DNS for
  app.cg / id.app.cg / cg.box → checks → farewell push.
- [ ] Transition period (length to decide), then P7.

### P7 — After the move

- [ ] app.cg / id.app.cg shut down as instances; both domains **stay registered**
  and only serve a plain redirect to cg.box (whoever registered a lapsed domain
  could serve installed PWAs and the old passkey origin). Gateway mode, CGID app,
  old passkeys and old push subscriptions removed from code and data.
- [ ] Azure pipelines, Swarm stack files and hosted nginx configs deleted. Before
  that, the reference-client pipeline (`pipelines/reference-client-conformance.yml`:
  OpenAPI drift check + conformance suite) moves to GitHub Actions, or both stop
  running — see TODO.md.
- [ ] Ansible management suite (`cg setup`, backup/restore, update/status/logs/
  config), GHCR images, VM-based development environment for contributors
  (`cg dev-setup`) — own roadmaps.

## Open questions

- Length of the transition period (P6).
- Stricter sign-up requirements against bots — which, and for whom (G3).
- Production storage backend and data volume; who produces the dump and how (G5,
  P5).

## Test infrastructure

| VM | Purpose | Lifecycle |
|---|---|---|
| **dev VM** | daily development: checkout, dev stack, Claude Code, VS Code Remote-SSH (4 cores, 16 GB RAM) | long-lived |
| **test VM** | self-host acceptance, rehearsal, backup/restore | disposable: snapshot of a fresh Ubuntu Server 26.04, reverted before each from-scratch run |

Test VM sizing: ≥ 4 cores, 8 GB RAM, 40 GB disk; SSH key login for a sudo user;
UDP 40000–40099 and TCP 4443 reachable from the maintainer's browser for call
tests.

The test VM is reached from the maintainer's workstation via hosts-file names
(`cg.test`, `app.test`, `id.app.test`) and a persistent local root CA kept on the
dev VM, seeded into Caddy after each reset (procedure in `docker/SELFHOST.md`,
"Local test instance"). Code reaches it as a `git archive` of the branch under
test — no push needed.
