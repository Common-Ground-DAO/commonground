# Plugin System Documentation

> Status: verified against commit 523fceccd, 2026-07-25

This document describes the Common Ground plugin system: architecture, data model, APIs, frontend integration, communication protocol, configuration, and known example plugins. It is written for AI agents and developers working on the codebase.

---

## 1. Plugin Architecture Overview

Plugins in Common Ground are external web applications embedded inside the platform via **sandboxed iframes**. The system enables communities to extend their functionality by linking any compatible web app, which then communicates bidirectionally with the host platform through a structured message-passing protocol.

### Key architectural properties

- **Iframe isolation**: Plugins render inside an `<iframe>` with sandbox attributes `allow-scripts allow-same-origin allow-forms allow-pointer-lock allow-downloads`. Additional permissions (microphone, camera) are gated by the `allow` attribute based on user-accepted permissions.
- **Cryptographic request signing**: Every data request from a plugin to the platform backend is signed with RSA-2048 key pairs (SHA-256). The server verifies signatures before responding, and signs its responses for the plugin to verify.
- **Two tiers of communication**: "Safe requests" are handled entirely on the frontend (init, navigate, requestPermission). "Signed requests" pass through the backend with cryptographic verification (userInfo, communityInfo, userFriends, giveRole).
- **Isolation mode**: Plugins that need advanced browser features (SharedArrayBuffer, WebAssembly threading, high-precision timers) can require "isolation mode," which changes the browsing context group isolation for the entire app. This requires the user to switch modes and reload.
- **Portal-based rendering**: The iframe is rendered via `ReactDOM.createPortal` into `document.body`, positioned absolutely to overlay either a docked area (when the user is viewing the plugin page) or a floating draggable window (when navigating away).

### Libraries

- **`@common-ground-dao/cg-plugin-lib-host`**: The host-side library used by the frontend. It provides TypeScript types for the message protocol: `PluginRequest`, `PluginResponse`, `PluginRequestInner`, `PluginResponseInner`, `SafeRequestInner`, `GiveRoleActionPayload`.
- **CGPluginLib** (external, at `https://github.com/Common-Ground-DAO/CGPluginLib`): The plugin-side library that plugin developers use. It handles signing requests with the private key and deserializing/verifying responses.
- **CGSamplePlugin** (external, at `https://github.com/Common-Ground-DAO/CGSamplePlugin`): A boilerplate plugin demonstrating integration.

---

## 2. Backend Plugin System

### 2.1 Data Model (Entities)

There are three database entities (TypeORM, PostgreSQL):

#### `plugins` table (`srv/entities/plugins.ts` -- entity class `Plugin`)

The canonical definition of a plugin. Each plugin has exactly one owner community.

| Column                 | Type                  | Description |
|------------------------|-----------------------|-------------|
| `id`                   | UUID (PK)             | Unique plugin identifier. |
| `ownerCommunityId`     | UUID (FK -> communities) | The community that created/owns this plugin. |
| `url`                  | VARCHAR(255)          | The URL loaded in the iframe. |
| `tags`                 | TEXT[] (nullable)     | Searchable tags for the appstore. |
| `privateKey`           | TEXT                  | RSA-2048 private key (PKCS#8 PEM). Used server-side to sign responses. |
| `publicKey`            | TEXT                  | RSA-2048 public key (SPKI PEM). Used server-side to verify incoming requests. |
| `permissions`          | JSONB (nullable)      | `{ mandatory: PluginPermission[], optional: PluginPermission[] }` |
| `description`          | TEXT (nullable)       | Human-readable description. |
| `imageId`              | VARCHAR(64) (nullable)| Reference to an uploaded plugin logo/image. |
| `clonable`             | BOOLEAN (default false) | Whether other communities can clone (install) this plugin. |
| `appstoreEnabled`      | BOOLEAN (default false) | Whether the plugin is featured/verified in the appstore. |
| `warnAbusive`          | BOOLEAN (default false) | Admin flag for potentially abusive plugins. |
| `requiresIsolationMode`| BOOLEAN (default false) | Whether the plugin needs cross-origin isolation headers. |
| `createdAt`            | TIMESTAMPTZ           | Auto-set on creation. |
| `updatedAt`            | TIMESTAMPTZ           | Auto-set on update. |
| `deletedAt`            | TIMESTAMPTZ (nullable)| Soft delete timestamp. |

#### `communities_plugins` table (`srv/entities/communities-plugins.ts` -- entity class `CommunityPlugin`)

The join table linking plugins to communities. A single plugin (from the `plugins` table) can be installed in multiple communities. Each installation gets its own row with community-specific configuration.

| Column        | Type                  | Description |
|---------------|-----------------------|-------------|
| `id`          | UUID (PK)             | Unique community-plugin installation identifier. This is the `pluginId` used in frontend routes and the `id` field in `Models.Plugin.Plugin`. |
| `communityId` | UUID (FK -> communities) | The community where this plugin is installed. |
| `pluginId`    | UUID (FK -> plugins)  | The underlying plugin definition. |
| `name`        | VARCHAR(255)          | Display name (can differ from the plugin's original name). |
| `config`      | JSONB (default `{}`)  | Community-specific config: `{ canGiveRole?: boolean, giveableRoleIds?: string[] }`. |
| `createdAt`   | TIMESTAMPTZ           | |
| `updatedAt`   | TIMESTAMPTZ           | |
| `deletedAt`   | TIMESTAMPTZ (nullable)| Soft delete. |

**Important distinction**: `Models.Plugin.Plugin` (the frontend model) is a *merged* view that combines fields from both `plugins` and `communities_plugins`. The `id` field is the `communities_plugins.id`, while `pluginId` is the `plugins.id`.

#### `user_plugin_state` table (`srv/entities/user-plugin-state.ts` -- entity class `UserPluginState`)

Tracks per-user permission acceptance for each plugin.

| Column               | Type                  | Description |
|----------------------|-----------------------|-------------|
| `userId`             | UUID (PK, FK -> users) | |
| `pluginId`           | UUID (PK, FK -> plugins) | References `plugins.id`. |
| `acceptedPermissions`| JSONB (nullable)      | Array of accepted `PluginPermission` strings. |
| `createdAt`          | TIMESTAMPTZ           | |
| `updatedAt`          | TIMESTAMPTZ           | |

Composite primary key: `(userId, pluginId)`.

### 2.2 API Endpoints (`srv/api/plugins.ts`)

All endpoints are POST routes under the `/Plugins` prefix. All require authentication (session-based) except the public appstore/discovery endpoints `getAppstorePlugin`, `getAppstorePlugins`, and `getPluginCommunities`.

#### `POST /Plugins/createPlugin`
- **Auth**: Admin role in the target community.
- **Request**: `{ name, url, description, imageId, communityId, config, permissions, clonable, requiresIsolationMode, tags }`
- **Behavior**: Generates an RSA-2048 key pair. Creates both a `plugins` row and a `communities_plugins` row. Enforces a per-community plugin limit (`config.PREMIUM.COMMUNITY_FREE.PLUGIN_LIMIT`).
- **Response**: `{ id, publicKey, privateKey }` -- the keys are shown to the admin once and should be saved to the plugin's `.env` file as `VITE_PLUGIN_PUBLIC_KEY` and `PLUGIN_PRIVATE_KEY`.
- **Events**: Emits `cliPluginEvent` with action `"new"`. Config is filtered out for non-admin recipients.

#### `POST /Plugins/clonePlugin`
- **Auth**: Admin role in the target community.
- **Request**: `{ pluginId, copiedFromCommunityId, targetCommunityId }`
- **Behavior**: Creates a new `communities_plugins` row pointing to the same `plugins` entry. The target community gets its own config but shares the plugin URL and permissions. Cloning is subject to the per-community plugin limit. In the appstore UI, only plugins whose owner has enabled `clonable` (or `appstoreEnabled`) are offered for installation.
- **Response**: `{ ok: true }`

#### `POST /Plugins/updatePlugin`
- **Auth**: Admin role in the community.
- **Request**: `{ id, communityId, name, config, pluginData }` where `pluginData` (nullable) contains `{ pluginId, url, description, imageId, permissions, clonable, requiresIsolationMode, tags }`.
- **Behavior**: Updates community-specific fields (name, config) always. Updates plugin-global fields (url, permissions, etc.) only if the community is the owner. If the URL changes, all users' accepted permissions for this plugin are reset (they must re-accept).
- **Events**: Emits `cliPluginEvent` action `"update"` to the community, and action `"dataUpdate"` to all communities using this plugin if `pluginData` was changed.

#### `POST /Plugins/deletePlugin`
- **Auth**: Admin role in the community.
- **Request**: `{ id }` (the `communities_plugins.id`)
- **Behavior**: If the deleting community owns the plugin, it is deleted for all communities that cloned it. Otherwise, only the local installation is removed.
- **Events**: Emits `"dataDelete"` (owner delete, affects all communities) or `"delete"` (local uninstall).

#### `POST /Plugins/pluginRequest`
- **Auth**: Logged-in user.
- **Request**: `{ request: string, signature: string }` where `request` is JSON-stringified `RequestInner`.
- **Behavior**: This is the core plugin communication endpoint. It:
  1. Parses the inner request JSON.
  2. Validates the request schema.
  3. Checks the request is at most 10 minutes old (timestamp extracted from `requestId`).
  4. Checks request uniqueness via Redis (prevents replay attacks, 15-minute TTL).
  5. Verifies the RSA signature against the plugin's public key.
  6. Dispatches based on request type (see Section 4).
  7. Signs the response with the plugin's private key.
- **Response**: `{ response: string, signature: string }`

#### `POST /Plugins/acceptPluginPermissions`
- **Auth**: Logged-in user.
- **Request**: `{ pluginId, permissions }` where `pluginId` is `communities_plugins.id`.
- **Behavior**: Stores the user's accepted permissions. Always includes `USER_ACCEPTED` as a baseline marker. Emits a community update event so the frontend reflects the change.

#### `POST /Plugins/getAppstorePlugin`
- **Auth**: None required.
- **Request**: `{ pluginId }` (the `plugins.id`)
- **Response**: Plugin details for the appstore detail view.

#### `POST /Plugins/getAppstorePlugins`
- **Auth**: None required.
- **Request**: `{ query?, tags?, limit, offset }`
- **Response**: `{ plugins: [...] }` -- paginated list of clonable/appstore plugins.

#### `POST /Plugins/getPluginCommunities`
- **Auth**: None required.
- **Request**: `{ pluginId, limit, offset }`
- **Response**: `{ communityIds: string[] }` -- communities that have installed this plugin.

### 2.3 Event System

Plugin mutations emit WebSocket events of type `cliPluginEvent` with these actions:

| Action         | When                                    | Payload includes |
|----------------|-----------------------------------------|------------------|
| `"new"`        | Plugin created or cloned                | Full plugin data  |
| `"update"`     | Community-level fields updated          | `id, communityId, name, config` |
| `"dataUpdate"` | Plugin-global fields updated by owner   | `pluginId, url, description, imageId, permissions, clonable` |
| `"delete"`     | Local uninstall (non-owner)             | `id, communityId` |
| `"dataDelete"` | Owner deletes plugin (affects all)      | `pluginId` |

Config data is filtered out for non-admin recipients to prevent leaking role configuration to regular users.

---

## 3. Frontend Plugin Integration

### 3.1 Key Files and Components

| File | Purpose |
|------|---------|
| `src/context/PluginIframeProvider.tsx` | Global React context managing the single iframe instance. Provides `loadIframe`, `unloadIframe`, `iframeRef`, `iframeUrl`, dock state. |
| `src/views/PluginView/useIframePlugin.tsx` | Hook that sets up `postMessage` listener, dispatches safe/signed requests, enforces rate limits. |
| `src/views/PluginView/PluginView.tsx` | The page component rendered when a user navigates to a plugin. Handles permission acceptance flow, missing account prompts, and isolation mode switching. |
| `src/views/PluginView/PluginViewSettings.tsx` | Settings panel for managing optional permissions and reporting plugins. |
| `src/components/organisms/IframePluginPortal/IframePluginPortal.tsx` | The actual `<iframe>` element, rendered via `createPortal` to `document.body`. Handles docked vs. floating (draggable) modes. |
| `src/views/PluginSettingsView/PluginSettingsView.tsx` | Thin wrapper that renders `PluginsManagement` inside the community settings area. |
| `src/components/templates/CommunityLobby/PluginsManagement/PluginsManagement.tsx` | Admin UI for creating, editing, and deleting plugins. Shows RSA keys in a modal after creation. |
| `src/components/templates/CommunityLobby/PluginsManagement/PluginEditor.tsx` | Form for editing plugin properties: name, URL, description, tags, clonability, permissions, role-giving config, isolation mode. |
| `src/components/templates/CommunityLobby/PluginsManagement/PluginEditorPermissionsSetter.tsx` | UI for setting each permission as mandatory, optional, or disabled. |
| `src/components/organisms/PluginAppstore/PluginAppstore.tsx` | The appstore browse page. Loads paginated plugins, separates them into "Verified Apps" (appstoreEnabled) and "Community Apps". |
| `src/components/molecules/PluginInstallField/PluginInstallField.tsx` | "Install to community" UI. Lets admins clone a plugin from the appstore into one of their communities. |
| `src/data/api/plugins.ts` | Frontend API connector class (`PluginsApiConnector`) wrapping all plugin API calls. |

### 3.2 Plugin Loading Flow

1. User navigates to a plugin page within a community.
2. `PluginView` checks whether the user has accepted the plugin URL and all mandatory permissions (`USER_ACCEPTED` marker in `acceptedPermissions`).
3. If not accepted, a consent screen is shown displaying the plugin URL, mandatory permissions, and optional permissions (checkboxes).
4. On acceptance, `pluginsApi.acceptPluginPermissions()` is called.
5. If accepted, `PluginView` also checks:
   - Whether the user has linked the required accounts (Twitter, Lukso, Farcaster, email).
   - Whether isolation mode matches the plugin's requirement.
6. Once all checks pass, `loadIframe(communityId, plugin)` is called on the `PluginIframeContext`.
7. `useIframePlugin` constructs the iframe URL by appending query parameters: `iframeUid` (random 10-char string), `cg_theme` (dark/light), `cg_bg_color`.
8. `IframePluginPortal` renders the iframe via portal, positioned over the `dockRef` div.

### 3.3 Docked vs. Floating Mode

- **Docked**: When the user is on the plugin page, `isDocked = true`. The iframe fills the dock area.
- **Floating**: When the user navigates away, the iframe persists as a small 200x200px draggable window in the bottom-right corner. Users can drag it, expand back to full view, or close it.

### 3.4 Rate Limiting (Client-Side)

Enforced in `useIframePlugin.tsx`, per iframe instance:
- **General requests**: Max 100 per minute (`MAX_REQUESTS_PER_MINUTE`). Tracked in a rolling 60-second timestamp window.
- **Navigate requests**: Max 1 per 5 seconds (`MAX_NAVIGATES_PER_5_SECS`), tracked in a rolling 5-second window.
- **requestPermission requests**: Share the same navigate bucket (max 1 per 5 seconds).

Exceeding a limit causes the host to return an error response (`MAX_REQUESTS_PER_MINUTE` / `MAX_NAVIGATES_PER_5_SECS`) to the iframe instead of dispatching the request.

---

## 4. Plugin Communication Protocol

Communication happens via `window.postMessage`. The host listens for messages from the iframe and responds on the same channel.

### 4.1 Message Flow

```
Plugin (iframe)                          Host (parent window)
     |                                          |
     |-- postMessage(PluginRequest) ----------->|
     |                                          |-- Parse request
     |                                          |-- Route: safe or signed?
     |                                          |
     |                     [Safe: handle locally]|
     |                     [Signed: POST to /Plugins/pluginRequest]
     |                                          |
     |<-- postMessage({ type: requestId, -------|
     |        payload: PluginResponse })         |
```

### 4.2 Safe Requests (Frontend-Only)

These do not require cryptographic signing and are handled entirely in the browser:

#### `init`
- **Purpose**: Plugin initialization. Returns the plugin's ID, the current user's ID, and assignable role IDs.
- **Response data**: `{ pluginId, assignableRoleIds, userId }`

#### `navigate`
- **Purpose**: Request the host app to navigate to a URL.
- **Payload**: `{ type: 'navigate', to: string }`
- **Behavior**: If the URL is internal (same origin), navigates via React Router. If external, shows a confirmation modal.
- **Rate limited**: 1 per 5 seconds.

#### `requestPermission`
- **Purpose**: Plugin asks the user to grant a specific permission it doesn't yet have.
- **Payload**: `{ type: 'requestPermission', permission: 'email' | 'twitter' | 'lukso' | 'farcaster' | 'friends' }`
- **Behavior**: If the permission is in the plugin's optional or mandatory list but the user hasn't granted it or doesn't have the required account, shows a modal prompting the user.

### 4.3 Signed Requests (Backend-Verified)

These are forwarded to `POST /Plugins/pluginRequest` with RSA signature verification:

#### `request` type: `userInfo`
- **Purpose**: Get information about the currently logged-in user.
- **Response data**: `{ id, name, imageUrl, roles, premium, twitter?, lukso?, farcaster?, email? }`
- **Permission gating**: Social account fields are only included if the plugin has the corresponding permission AND the user has accepted it (e.g., `READ_TWITTER` for Twitter data).

#### `request` type: `communityInfo`
- **Purpose**: Get information about the community the plugin is installed in.
- **Response data**: `{ id, title, url, smallLogoUrl, largeLogoUrl, headerImageUrl, official, premium, roles[] }`

#### `request` type: `userFriends`
- **Purpose**: Get the current user's friend list.
- **Payload**: `{ type: 'userFriends', limit, offset }`
- **Response data**: `{ friends: [{ id, name, imageUrl }] }`
- **Permission gating**: Requires `READ_FRIENDS` permission accepted by the user.

#### `action` type: `giveRole`
- **Purpose**: Assign a community role to a user.
- **Payload**: `{ type: 'giveRole', roleId, userId }`
- **Permission gating**: Requires `canGiveRole` enabled in plugin config AND the role ID must be in `giveableRoleIds`. Cannot assign predefined roles. The role must belong to the same community.
- **Response data**: `{ success: true }`
- **Side effect**: On success, the host shows a "role claimed" modal to the user.

### 4.4 Request/Response Signing

1. The plugin signs its request JSON with its **private key** using RSA SHA-256.
2. The server verifies using the stored **public key**.
3. The server signs its response JSON with the stored **private key**.
4. The plugin verifies using its **public key** (stored as `VITE_PLUGIN_PUBLIC_KEY`).

Request IDs contain a timestamp component (format: `{random}-{timestamp}`) and must be less than 10 minutes old. Redis enforces uniqueness with a 15-minute TTL to prevent replay attacks.

### 4.5 Iframe URL Parameters

When loading a plugin, the host appends these query parameters to the plugin URL:

| Parameter     | Description |
|---------------|-------------|
| `iframeUid`   | A random 10-character string identifying this iframe instance. Must be included in all requests back to the host. |
| `cg_theme`    | `"dark"` or `"light"` -- the current platform theme. |
| `cg_bg_color` | Hex background color (e.g., `#161820` for dark, `#F1F1F1` for light). |

### 4.6 Iframe Sandbox and Permissions

The iframe element uses:
- `sandbox="allow-scripts allow-same-origin allow-forms allow-pointer-lock allow-downloads"`
- `allow` attribute dynamically constructed:
  - Always: `cross-origin-isolated; web-share; clipboard-read; clipboard-write`
  - Microphone: Granted to the iframe origin only if `ALLOW_MICROPHONE` is in the user's accepted permissions; otherwise `none`.
  - Camera: Granted to the iframe origin only if `ALLOW_CAMERA` is in accepted permissions; otherwise `none`.

---

## 5. Plugin Configuration

### 5.1 Admin Setup (Community Settings > Plugins)

Admins manage plugins through the Plugin Settings view (`PluginSettingsView` -> `PluginsManagement`).

**Creating a plugin:**
1. Click "Create" in the plugins list.
2. Fill in: name, URL, description, tags.
3. Set permission requirements (each permission can be: Mandatory, Optional, or No need).
4. Optionally enable clonability (shows in appstore) and isolation mode.
5. Configure role-giving: enable `canGiveRole` and select which community roles the plugin can assign.
6. Save. A modal displays the RSA key pair. The admin must copy these into their plugin's environment:
   - `VITE_PLUGIN_PUBLIC_KEY="-----BEGIN PUBLIC KEY-----\n..."`
   - `PLUGIN_PRIVATE_KEY="-----BEGIN PRIVATE KEY-----\n..."`

**Updating a plugin:**
- Community-specific fields (name, config) can always be edited.
- Plugin-global fields (URL, permissions, description, tags, clonability) can only be edited by the **owner community**.
- Changing the URL resets all users' accepted permissions.

**Cloning a plugin from the appstore:**
1. Browse the Plugin Appstore.
2. Select a plugin and choose "Install."
3. Pick a target community (must be admin).
4. The clone creates a `communities_plugins` row with separate config but shared plugin URL/permissions.

### 5.2 Plugin Permissions

Permissions are categorized as **mandatory** (user must accept to use the plugin) or **optional** (user can toggle):

| Permission         | What it grants |
|--------------------|----------------|
| `USER_ACCEPTED`    | Internal marker that the user has accepted the plugin URL. Always added automatically. |
| `READ_TWITTER`     | Plugin can read the user's linked Twitter username. |
| `READ_LUKSO`       | Plugin can read the user's linked LUKSO username and UP address. |
| `READ_FARCASTER`   | Plugin can read the user's linked Farcaster display name, username, and FID. |
| `READ_EMAIL`       | Plugin can read the user's verified email address. |
| `READ_FRIENDS`     | Plugin can read the user's friend list. |
| `ALLOW_MICROPHONE` | The iframe is granted microphone access. |
| `ALLOW_CAMERA`     | The iframe is granted camera access. |

### 5.3 Plugin Config (Per-Community)

Stored in `communities_plugins.config` as JSONB:

```typescript
type PluginConfig = {
    canGiveRole?: boolean;       // Whether the plugin can assign roles
    giveableRoleIds?: string[];  // Which role IDs the plugin is allowed to assign
}
```

Only custom, non-predefined roles with free assignment rules can be added to `giveableRoleIds`.

### 5.4 Plugin Limits

Communities on the free tier have a plugin limit defined by `config.PREMIUM.COMMUNITY_FREE.PLUGIN_LIMIT` (currently 50 across all tiers). Attempting to create or clone beyond this limit returns a `PLUGIN_LIMIT_EXCEEDED` error.

### 5.5 Plugin Reporting and Abuse Flagging

Plugins can be reported by users via the `PluginViewSettings` panel (report type: `PLUGIN`). The appstore query in `srv/repositories/plugins.ts` filters out non-verified plugins that have accumulated `MINIMUM_REPORTS_TO_FLAG_PLUGIN` (currently 3) or more unresolved reports. The `warnAbusive` boolean on the `plugins` table is an admin-level flag for marking potentially abusive plugins, though its enforcement is at the query level in the appstore listing.

### 5.6 Dynamic Permission Requests at Runtime

Plugins can request additional permissions at runtime using the `requestPermission` safe request (see Section 4.2). When a plugin sends this request, the host checks whether the permission is in the plugin's declared optional or mandatory list. If the user hasn't yet granted it or doesn't have the required linked account, an `AddPermissionModal` is shown. On acceptance, the permission is added to the user's accepted set via `acceptPluginPermissions`. This flow is managed in `PluginIframeProvider.tsx`.

---

## 6. Example Plugins

The following open-source plugins are referenced in the project README and demonstrate the capabilities of the plugin system:

### Luanti (Minetest)
A WebAssembly version of the open-source voxel game engine. Features in-browser peer-to-peer hosting and save persistence. This is a prime example of a plugin requiring **isolation mode** (for SharedArrayBuffer / WebAssembly threading support).

### Sauerbraten
A WebAssembly port of the Quake-like arcade shooter. Another example of a game plugin that likely requires isolation mode for its WASM-based engine.

### Utilities
A collection of utility plugins:
- **Forums**: Community discussion plugin.
- **Airdrop/Vesting tools**: Crypto token distribution tools.
- **cg-base-plugin**: A boilerplate starter template for building new plugins.

### Developer Resources
- **Plugin helper library**: `https://github.com/Common-Ground-DAO/CGPluginLib`
- **Sample plugin**: `https://github.com/Common-Ground-DAO/CGSamplePlugin`

These URLs are referenced directly in the `PluginsManagement.tsx` component as guidance for community admins building plugins.

---

## 7. Key Source Files Reference

| Path | Description |
|------|-------------|
| `srv/entities/plugins.ts` | Plugin entity (TypeORM) |
| `srv/entities/communities-plugins.ts` | Community-Plugin join entity |
| `srv/entities/user-plugin-state.ts` | User permission acceptance state entity |
| `srv/api/plugins.ts` | All plugin API route handlers |
| `srv/repositories/plugins.ts` | Plugin repository (database queries) |
| `srv/common/types/models/plugin.d.ts` | Plugin model type definitions |
| `srv/common/types/api/plugins.d.ts` | Plugin API request/response type definitions |
| `srv/common/enums.ts` | `PluginPermission` enum (line 193) |
| `src/context/PluginIframeProvider.tsx` | Iframe lifecycle management context |
| `src/views/PluginView/useIframePlugin.tsx` | postMessage handler and iframe URL construction |
| `src/views/PluginView/PluginView.tsx` | Plugin page with permission consent flow |
| `src/views/PluginView/PluginViewSettings.tsx` | Plugin settings panel (user-facing) |
| `src/components/organisms/IframePluginPortal/IframePluginPortal.tsx` | Iframe portal rendering (docked/floating) |
| `src/views/PluginSettingsView/PluginSettingsView.tsx` | Plugin admin settings page wrapper |
| `src/components/templates/CommunityLobby/PluginsManagement/PluginsManagement.tsx` | Plugin CRUD management UI |
| `src/components/templates/CommunityLobby/PluginsManagement/PluginEditor.tsx` | Plugin editor form |
| `src/components/templates/CommunityLobby/PluginsManagement/PluginEditorPermissionsSetter.tsx` | Permission configuration UI |
| `src/components/organisms/PluginAppstore/PluginAppstore.tsx` | Appstore browse page |
| `src/components/organisms/PluginAppstore/PluginCard.tsx` | Appstore plugin card with share/details buttons |
| `src/components/organisms/PluginAppstore/PluginCardDetails.tsx` | Appstore plugin detail modal with install, launch, share, and community list |
| `src/components/molecules/PluginInstallField/PluginInstallField.tsx` | Clone/install plugin to community UI |
| `src/components/organisms/AddPermissionModal/AddPermissionModal.tsx` | Modal shown when a plugin dynamically requests a permission at runtime |
| `src/components/templates/CommunityLobby/PluginsManagement/PluginManagementList.tsx` | List of plugins in the admin management view |
| `src/data/api/plugins.ts` | Frontend API connector |
