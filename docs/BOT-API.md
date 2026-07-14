# Bot API v1

A human session creates and manages a bot through the web app or management
API. The bot then uses its own bearer token for the deliberately small,
versioned messaging and Socket.IO contract.

The stable public bot surface lives under `/api/bot/v1`. The web application
continues to use `/api/v2`; those routes are not the bot protocol version.
Bot API v1 changes are additive: existing fields and behavior will not be
removed or renamed without a new protocol version. Unknown response and event
fields must be ignored by clients.

Examples below assume:

```sh
CG_URL=https://chat.example.org
COOKIE_JAR=./cg-cookie.txt
COMMUNITY_ID=00000000-0000-4000-8000-000000000001
CHANNEL_ID=00000000-0000-4000-8000-000000000002
ROLE_ID=00000000-0000-4000-8000-000000000003
```

API responses use `{"status":"OK","data":...}` or
`{"status":"ERROR","error":"..."}`. Validation and domain errors are
usually encoded in that response envelope. Bearer authentication failures use
HTTP 401, non-allowlisted routes use HTTP 403, and a request containing both a
bot bearer token and a human session cookie uses HTTP 400.

## Ownership and management

Management calls require the normal human session cookie. Never attach a bot
token to them. Obtain the cookie by signing in through the web app, then export
it to a curl-compatible cookie jar or use the same endpoints from an
authenticated browser/CLI integration.

There are three ownership models:

- `user`: `ownerId` must be the current human user's UUID. A community manager
  must opt in to user-owned bots, and the owner must remain a community member.
- `community`: `ownerId` is a community UUID and the caller must have
  `COMMUNITY_MANAGE_ROLES` there. The bot is installed into that community when
  it is created and cannot be installed elsewhere.
- `platform`: `ownerId` must be `null`, and the caller's user UUID must be in
  the instance's `PLATFORM_OPERATOR_USER_IDS`. Presence is either `all` or a
  `selected` list of communities.

All management routes are `POST /api/v2/Bot/...` with JSON bodies:

| Route | Body | Result |
|---|---|---|
| `/list` | `{ownerType, ownerId}` | bots for that owner |
| `/listCommunityBots` | `{communityId}` | active bots installed in a managed community, including custom role IDs |
| `/create` | `{ownerType, ownerId, displayName, imageId, description, platformPresence?}` | new bot |
| `/update` | `{botUserId, displayName?, imageId?, description?, platformPresence?}` | updated bot |
| `/disable` | `{botUserId}` | permanently disables the bot |
| `/install` | `{botUserId, communityId, roleIds}` | installs and assigns roles |
| `/remove` | `{botUserId, communityId}` | removes the installation |
| `/setRoles` | `{botUserId, communityId, roleIds}` | replaces assigned custom roles |
| `/setAllowUserBots` | `{communityId, allowUserBots}` | community opt-in/out for user bots |
| `/tokens/issue` | `{botUserId, name}` | new raw token and token metadata |
| `/tokens/list` | `{botUserId}` | token metadata, never raw tokens |
| `/tokens/revoke` | `{botUserId, tokenId}` | revokes one token |

`imageId`, `description`, and token `name` may be `null`. Descriptions are at
most 2,000 characters and token names at most 100. `roleIds` contains custom
role UUIDs from the target community; the predefined member role is managed
automatically. A user-owned bot cannot be granted channel permissions its owner
does not have.

Create a user-owned bot:

```sh
curl --fail-with-body -sS \
  --cookie "$COOKIE_JAR" \
  -H 'Content-Type: application/json' \
  -d '{
    "ownerType":"user",
    "ownerId":"YOUR-HUMAN-USER-UUID",
    "displayName":"Release Bot",
    "imageId":null,
    "description":"Posts release notifications."
  }' \
  "$CG_URL/api/v2/Bot/create"
```

Install it and assign a role:

```sh
curl --fail-with-body -sS \
  --cookie "$COOKIE_JAR" \
  -H 'Content-Type: application/json' \
  -d "{\"botUserId\":\"$BOT_USER_ID\",\"communityId\":\"$COMMUNITY_ID\",\"roleIds\":[\"$ROLE_ID\"]}" \
  "$CG_URL/api/v2/Bot/install"
```

Community managers must first enable user bots when applicable:

```sh
curl --fail-with-body -sS \
  --cookie "$COOKIE_JAR" \
  -H 'Content-Type: application/json' \
  -d "{\"communityId\":\"$COMMUNITY_ID\",\"allowUserBots\":true}" \
  "$CG_URL/api/v2/Bot/setAllowUserBots"
```

## Tokens and rotation

Issue a token with a human session:

```sh
curl --fail-with-body -sS \
  --cookie "$COOKIE_JAR" \
  -H 'Content-Type: application/json' \
  -d "{\"botUserId\":\"$BOT_USER_ID\",\"name\":\"production\"}" \
  "$CG_URL/api/v2/Bot/tokens/issue"
```

The `data.token` value starts with `cgb_` and is returned only once. Store it
in a secret manager, never in source control, URLs, query strings, logs, or
browser storage. Only a SHA-256 hash is stored server-side.

Use rotation rather than sharing a token: issue a new named token, update the
consumer, verify `/whoami`, then revoke the old token by its metadata `id`.
Revocation immediately disconnects sockets using that token. Disabling a bot
revokes every token, removes active memberships, and preserves its user/profile
row so historical messages still render with the bot's identity.

Verify a bearer token (no cookie):

```sh
curl --fail-with-body -sS \
  -H "Authorization: Bearer $BOT_TOKEN" \
  -H 'Content-Type: application/json' \
  -d '{}' \
  "$CG_URL/api/bot/v1/whoami"
```

The response includes `protocolVersion: "1"` in addition to the bot, device,
and token IDs.

## Bearer messaging API

Every request must use `Authorization: Bearer $BOT_TOKEN`, must not include a
session cookie, and must identify exactly one community/channel with:

```json
{"access":{"communityId":"COMMUNITY_UUID","channelId":"CHANNEL_UUID"}}
```

The bot, token, owner policy, installation, roles, and channel permissions are
rechecked for every request. v1 allows only these six `POST` routes:

| Route | Additional body fields |
|---|---|
| `/api/bot/v1/messages/loadMessages` | `order?`, `createdBefore?`, `createdAfter?` |
| `/api/bot/v1/messages/messagesById` | `messageIds` |
| `/api/bot/v1/messages/loadUpdates` | `createdStart`, `createdEnd`, `updatedAfter` |
| `/api/bot/v1/messages/createMessage` | `id`, `body`, `parentMessageId`, `attachments` |
| `/api/bot/v1/messages/setReaction` | `messageId`, `reaction` |
| `/api/bot/v1/messages/unsetReaction` | `messageId` |

Create a text message. The client must supply a fresh UUID as `id`:

```sh
MESSAGE_ID="$(uuidgen | tr '[:upper:]' '[:lower:]')"
curl --fail-with-body -sS \
  -H "Authorization: Bearer $BOT_TOKEN" \
  -H 'Content-Type: application/json' \
  -d "{
    \"id\":\"$MESSAGE_ID\",
    \"access\":{\"communityId\":\"$COMMUNITY_ID\",\"channelId\":\"$CHANNEL_ID\"},
    \"body\":{\"version\":\"1\",\"content\":[{\"type\":\"text\",\"value\":\"Build completed\"}]},
    \"parentMessageId\":null,
    \"attachments\":[]
  }" \
  "$CG_URL/api/bot/v1/messages/createMessage"
```

Load recent messages:

```sh
curl --fail-with-body -sS \
  -H "Authorization: Bearer $BOT_TOKEN" \
  -H 'Content-Type: application/json' \
  -d "{\"access\":{\"communityId\":\"$COMMUNITY_ID\",\"channelId\":\"$CHANNEL_ID\"},\"order\":\"DESC\"}" \
  "$CG_URL/api/bot/v1/messages/loadMessages"
```

## Rate limits

Limits use fixed one-minute windows and are tracked per token:

- all allowed bearer REST calls: 120 requests/minute by default;
- `createMessage`: also 30 created messages/minute by default.

A created message consumes one unit from both limits. Exceeding a limit returns
an error envelope with `RATE_LIMIT_EXCEEDED`. Instance operators can tune
`BOT_API_RATE_LIMIT_PER_MINUTE` and
`BOT_MESSAGE_RATE_LIMIT_PER_MINUTE`.

## Socket.IO events

Use Socket.IO 4.x and put the token only in the handshake `auth` object:

```js
import { io } from "socket.io-client";

const socket = io(process.env.CG_URL, {
  path: "/api/ws/",
  auth: { token: process.env.BOT_TOKEN, protocolVersion: "1" },
});

socket.on("cliMessageEvent", (event) => {
  switch (event.action) {
    case "new":
      console.log("new message", event.data);
      break;
    case "update":
      console.log("updated fields", event.data);
      break;
    case "delete":
      console.log("deleted message IDs", event.data.channelId, event.data.deletedIds);
      break;
  }
});

socket.on("connect_error", (error) => console.error(error.message));
```

`new` carries a complete API message plus `creatorIsBot`. A selected `@mention`
is a body element with `{type: "mention", userId, alias}`; compare `userId`
with the ID from `/whoami`, never with the editable alias. Replies carry
`parentMessageId`; use `messagesById` to load the parent and compare its
`creatorId` with the bot's ID. Ignore `creatorIsBot: true` by default to prevent
multi-bot mention or reply loops.

`update` carries `id`, `channelId`,
`updatedAt`, and the changed message fields. `delete` carries `channelId` and
`deletedIds`. Only `cliMessageEvent` is the supported public v1 event contract.
The handshake requires `protocolVersion: "1"`. A missing or unsupported version
is rejected with `unsupported_bot_protocol`.

The server joins a bot only to rooms allowed by its current policy,
installation, roles, and channel permissions. Removing a role, installation,
owner access, community gate, or selected platform presence removes live room
access. Token revocation or bot disable disconnects the socket immediately;
automatic reconnect then fails with `connect_error`. Bots do not affect human
online-presence counts.

## Explicit v1 exclusions

Bot bearer tokens cannot use human profile/follow APIs, DMs or chats, calls,
articles, files/uploads, moderation APIs, community management APIs, plugin
APIs, notifications, or any message route not listed above. They cannot edit
or delete messages in v1. A bot's assigned roles never expand the HTTP
allowlist. Do not treat hidden frontend controls as authorization—the backend
allowlist and permission checks are authoritative.

## Instance operator configuration

Self-hosted deployments configure these in `docker/.env.selfhost`, then run
`./selfhost/selfhost.sh up` from `docker/` so Compose recreates services whose
configuration changed:

| Variable | Default | Meaning |
|---|---:|---|
| `PLATFORM_OPERATOR_USER_IDS` | empty | comma-separated human user UUIDs allowed to manage platform bots |
| `BOT_USER_OWNER_LIMIT` | 5 | active bots per user owner |
| `BOT_COMMUNITY_OWNER_LIMIT` | 10 | active bots per community owner |
| `BOT_PLATFORM_OWNER_LIMIT` | 10 | active platform bots |
| `BOT_ACTIVE_TOKEN_LIMIT` | 10 | active tokens per bot |
| `BOT_API_RATE_LIMIT_PER_MINUTE` | 120 | allowed REST calls per token/minute |
| `BOT_MESSAGE_RATE_LIMIT_PER_MINUTE` | 30 | message creates per token/minute |

Existing `.env.selfhost` files are intentionally never overwritten by the
initializer, so add these values manually when upgrading an existing instance.
