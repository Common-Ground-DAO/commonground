# Packaging decisions (maintainer call)

The reference client is feature-complete against the current contract. These
are the open publication questions — the recommendation is stated, but each is
the maintainer's to decide.

## 1. npm publication

**Question:** publish `@commonground/client` to npm, or keep it in-repo only?

**Recommendation: publish.** The whole point of the reference client is to be
the artifact native teams and bot developers build against. An unpublished
package means every consumer vendors a git submodule — friction that defeats
"official SDK." The conformance suite (`@commonground/conformance`) stays
private (it needs a live instance; it is a test harness, not a library).

Concretely:
- Scope `@commonground/client` under a Common Ground npm org.
- The package is already ESM-only, node ≥ 24, zero browser APIs, and ships
  `dist/` with type declarations — publishable as-is.
- Keep `@commonground/conformance` `"private": true` (already set).

## 2. License

**Question:** the repo is AGPL-3.0 + additional terms. Does the SDK inherit
that, or ship under a more permissive license?

**The tension:** AGPL on a *client library* is unusual and discourages
adoption — a bot author or a native app linking `@commonground/client` would,
under AGPL, face copyleft obligations on their own code. That is the opposite
of what an "official SDK meant to be embedded everywhere" wants. But the SDK is
derived from this AGPL codebase (it mirrors `src/common` types and encodes the
server's protocol), so relicensing is not automatic — it needs the
copyright holders' decision.

**Recommendation (maintainer to confirm):** dual-license the SDK package
itself under a permissive license (MIT or Apache-2.0) so downstream clients can
embed it freely, while the server and conformance suite stay AGPL. This is the
common pattern (server copyleft, client permissive). It requires:
- Confirming all contributors to `sdk/client/` agree, or that the CLA/copyright
  assignment already covers it.
- A `sdk/client/LICENSE` stating the SDK's license explicitly (right now
  `package.json` points at the repo root license — that must change if the
  decision is to relicense).

**Do not publish until this is resolved** — the license in the first published
version is the one consumers rely on; changing it later is disruptive.

## 3. Bot-developer library positioning

**Question:** market `@commonground/client` as the official bot SDK too?

**Finding:** it already speaks the entire bot surface — bearer auth
(`BotClient`), `whoami`, `scopes/list`, message send, and the realtime
handshake all work and are covered by R6 conformance. A bot author needs
nothing the human client doesn't already provide; a bot is a user.

**Recommendation: yes, with one caveat.** Document the bot entry points
(`BotClient`, `CommonGroundClient.bots`) prominently. The caveat is F-11
(`sdk/conformance/FINDINGS.md`): a freshly-created community bot can't post
until the membership gap is fixed server-side. Resolve F-11 before promoting
the bot-SDK story, or the first thing a bot developer tries fails.

## Checklist before `npm publish`

- [ ] License decision made and `sdk/client/LICENSE` written to match.
- [ ] npm org/scope created; `publishConfig.access` set.
- [ ] F-11 (bot community install) resolved, or bot posting documented as
      pending.
- [ ] `prepublishOnly` runs `yarn workspace @commonground/client build`.
- [ ] A published-package smoke test (install the tarball, import, hit a live
      instance's `Instance/config`).
- [ ] Version strategy agreed (the SDK version tracks its own semver, decoupled
      from the server's `/api/v2`; see docs/api/VERSIONING.md).
