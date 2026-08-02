# TODO — open one-off tasks

> Standalone open tasks that are too small for a workstream of their own. When an entry
> grows into real, multi-step work, it graduates into its own `ROADMAP_<topic>.md` and
> leaves this list. Working state, not documentation of record.

## Operational (time-critical)

- [ ] **Cut the hosted Swarm stack over to the single `redis` service** — the stack files
  in the separate infrastructure repository still publish
  `redis-sessions`/`redis-socketio`/`redis-data`, which images built after the core-slimming
  Phase-5 merge (2026-08-02) no longer look for. Either merge the three services into one
  named `redis` or set `REDIS_URL` on `api`, `wsapi`, `job-runner` and `onchain`,
  **before or together with** the next staging/prod image rollout. Details:
  [docs/deployment](../deployment/README.md) §6. Nothing in this repo can perform or verify
  the change.
- [ ] **Pin the SeaweedFS image in the hosted Swarm stack** — the compose files in this
  repo pin `chrislusf/seaweedfs:4.40` (2026-08-02; security floor 4.34), but the Swarm
  stack files in the separate infrastructure repository pin independently and may still
  ride `:latest`. Same coordination as the Redis item above; see
  [docs/todo/ROADMAP_SEAWEEDFS_CONSOLIDATION.md](ROADMAP_SEAWEEDFS_CONSOLIDATION.md).

## Maintainer decisions needed

- [ ] **Premium purchases on self-hosted instances** — the Spark purchase flow (`PaySpark`)
  sends to Common Ground's own beneficiary addresses hardcoded in
  `src/common/premiumConfig.ts`, and purchases are only credited by the onchain listener.
  Every self-hosted instance therefore takes payments for CG wallets, regardless of the
  `CG_ENABLE_BLOCKCHAIN` toggle. Decide: hide the premium purchase flow on non-official
  instances entirely, make the beneficiaries configurable, or leave as is.

## Cleanup candidates (small, self-contained)

- [ ] **`srv/healthcheck.ts`: wire up or delete the dead real healthcheck.**
  `startHealthcheck` (sole consumer of `checkRedis`) has zero callers — every process uses
  `fakeHealthcheck()`. Either wire the real one up or delete the dead path; in the same
  move, split `fakeHealthcheck` into its own module (precedent:
  `srv/mediasoup/mediasoupHealthcheck.ts`) so `memberlist` stops opening Redis connections
  it never uses.
- [ ] **Drop the `docker-compose` v1 fallback in `docker/selfhost/selfhost.sh`** — v1 is
  EOL and ignores `COMPOSE_PROFILES`, so on v1 the `calls`/`blockchain` profiles would
  silently start neither service.
- [ ] **`contracts/contracts/TokenSale.sol` + its deploy script** — kept in Phase 2 as the
  record of the sale that ran; decide whether git history is record enough.
- [ ] **`role_gated_files` + `GET /gated-videos/:filename` / `GET /gated-files/:filename`**
  — their only content producers were the wizard data-room elements removed in Phase 2;
  the table has no create path in code. Removal candidate.

## Optional / nice-to-have

- [ ] **Dev-stack service toggles** — the `calls`/`blockchain` compose profiles exist only
  in the selfhost profile; the dev stack starts `mediasoup` and `onchain` unconditionally.
  If wanted, `run.sh` needs the same `COMPOSE_PROFILES` derivation `selfhost.sh` has.

## Deferred (decided against for now)

- **`wsapi`-in-`api` collapse** — explicitly deferred during core slimming (2026-08-01):
  real refactor, low payoff.
- **Bundled mail server in the stack** — decided against (2026-08-02): extra maintenance,
  and operators who want one can run their own. The email direction is
  bring-your-own-SMTP; see the planned email workstream below.

## Upcoming workstreams (roadmap to be written)

- **Build-stack migration CRA/craco → Vite** — runs after the core slimming (ordering
  decided 2026-08-01); nothing removed during slimming has to be migrated.
- **Email: provider-agnostic SMTP** — replace the hard-wired SendGrid client with a
  generic SMTP transport (swap surface is `EmailUtils.sendEmail` in `srv/api/emails.ts`
  plus init in `srv/serverconfig.ts`, see [docs/email-notifications](../email-notifications/README.md));
  drop the Mailchimp audience sync (local subscription flag already exists). No bundled
  MTA (see above).
