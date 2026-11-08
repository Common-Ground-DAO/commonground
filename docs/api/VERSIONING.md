# API versioning & deprecation policy

The API is the contract multiple independent clients depend on (web, the
headless reference client, future native iOS/Android, bots). This policy makes
breaking that contract a deliberate, observable act rather than an accident.

## Two version surfaces

1. **REST path version** — every RPC route lives under `/api/v2/`. The `v2`
   segment is the coarse, rarely-incremented version: it changes only for a
   wholesale, non-negotiable break. Additive changes never bump it.
2. **Socket protocol version** — the realtime handshake negotiates
   `protocolVersion` (`BOT_PROTOCOL_VERSION`, currently `"1"`). A client
   presenting an unsupported version is rejected at connect
   (`unsupported_bot_protocol`). This is the fine-grained lever for realtime
   changes that can't be expressed additively.

## What counts as breaking (requires a version bump)

- Removing a route, an event, or a protoo method.
- Removing or renaming a field a client reads, or a request field the server
  requires.
- Narrowing a type (tightening a validator so previously-valid requests fail;
  changing a field's type or an enum's members).
- Changing the meaning of an existing field or error code.

## What is additive (no bump; ship freely)

- New routes, new events, new optional request fields.
- New response fields (clients must ignore unknown fields — the SDK does).
- New enum members **only** where clients are documented to tolerate unknowns
  (e.g. error codes: `ApiErrorCode` includes `(string & {})`; event names:
  the router ignores non-`cli*` and unknown `cli*` names).

## Deprecation flow

1. Mark the field/route deprecated in the OpenAPI (`deprecated: true`) and in
   the socket/protoo catalogs, with the replacement and a removal date.
2. Keep it working for **at least one minor cycle** (≥ 30 days) after the
   deprecation ships to the reference instance.
3. Remove only in a version bump (REST `v3`, or a new socket
   `protocolVersion`), never silently.

## Enforcement

- **Drift check (CI):** `sdk/tools/generate-openapi.sh --check` regenerates
  `docs/api/openapi.json` from the live Joi validators; any diff fails the
  build. A validator change that isn't reflected in the committed spec — i.e.
  an *undocumented* contract change — cannot merge.
- **Conformance suite (CI):** every documented behavior is pinned by a test
  that cites its contract section. A breaking change turns a green test red in
  the same PR that caused it.
- **FINDINGS log:** contract defects surfaced by the reference client
  (`sdk/conformance/FINDINGS.md`) are the backlog of things to fix *before*
  they calcify into a version we must support forever.

## Practical guidance for server changes

- Adding a response field: just do it.
- Adding a request field: make it optional, or you've broken every existing
  client — that's a bump.
- Removing anything: deprecate first, remove at the next bump.
- Changing a validator: run the drift check locally
  (`sdk/tools/generate-openapi.sh`) and commit the regenerated spec in the
  same PR, so the diff shows the contract change explicitly to reviewers.
