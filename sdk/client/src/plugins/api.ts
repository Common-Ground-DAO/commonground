/**
 * Plugins — appstore discovery, install/configure, and the signed
 * plugin-runtime RPC (`pluginRequest`).
 *
 * Contract: srv/api/plugins.ts. Management routes (create/update/delete/clone)
 * require the community's Admin role. `createPlugin` returns an RSA keypair
 * ONCE — the private key signs later `pluginRequest` calls (RSA-SHA256 over
 * the JSON request string), which the server verifies against the stored
 * public key. Requests carry a `requestId` "<n>-<epochMillis>" that must be
 * ≤10 min old and single-use (Redis replay lock).
 */

import { createSign, createVerify } from "node:crypto";
import type { HttpTransport } from "../transport/http.js";

export type PluginPermission =
  | "USER_ACCEPTED" | "READ_TWITTER" | "READ_LUKSO" | "READ_FARCASTER"
  | "READ_EMAIL" | "READ_FRIENDS" | "ALLOW_MICROPHONE" | "ALLOW_CAMERA";

export interface PluginPermissions {
  mandatory: PluginPermission[];
  optional: PluginPermission[];
}

export interface PluginConfig {
  canGiveRole?: boolean;
  giveableRoleIds?: string[];
}

export interface CreatePluginOptions {
  name: string;
  url: string;
  description: string | null;
  imageId: string | null;
  communityId: string;
  config: PluginConfig;
  permissions: PluginPermissions;
  clonable: boolean;
  requiresIsolationMode: boolean;
  tags: string[] | null;
}

export interface CreatePluginResult {
  id: string;
  /** SPKI PEM */
  publicKey: string;
  /** PKCS8 PEM — returned ONCE, store it to sign pluginRequests */
  privateKey: string;
}

export interface AppstorePlugin {
  pluginId: string;
  ownerCommunityId: string;
  url: string;
  description: string | null;
  permissions: PluginPermissions;
  imageId: string | null;
  name: string;
  communityCount: number;
  appstoreEnabled: boolean;
  tags: string[] | null;
}

/** The inner request signed and sent inside a pluginRequest. */
export type PluginRequestData =
  | { type: "userInfo" }
  | { type: "communityInfo" }
  | { type: "userFriends"; limit: number; offset: number }
  | { type: "giveRole"; userId: string; roleId: string };

export class PluginApi {
  constructor(private readonly transport: HttpTransport) {}

  /** POST /Plugins/createPlugin (Admin role). Persist the returned private
   * key — it is the only copy and signs future pluginRequests. */
  async create(options: CreatePluginOptions): Promise<CreatePluginResult> {
    return this.transport.call("Plugins/createPlugin", {
      name: options.name,
      url: options.url,
      description: options.description,
      imageId: options.imageId,
      communityId: options.communityId,
      config: options.config,
      permissions: options.permissions,
      clonable: options.clonable,
      requiresIsolationMode: options.requiresIsolationMode,
      tags: options.tags,
    });
  }

  async clone(pluginId: string, copiedFromCommunityId: string, targetCommunityId: string): Promise<{ ok: true }> {
    return this.transport.call("Plugins/clonePlugin", { pluginId, copiedFromCommunityId, targetCommunityId });
  }

  async update(patch: {
    id: string;
    communityId: string;
    name: string;
    config: PluginConfig;
    pluginData?: {
      pluginId: string;
      url: string;
      description: string | null;
      imageId: string | null;
      permissions: PluginPermissions;
      clonable: boolean;
      requiresIsolationMode: boolean;
      tags: string[] | null;
    } | null;
  }): Promise<{ ok: true }> {
    return this.transport.call("Plugins/updatePlugin", { pluginData: null, ...patch });
  }

  /** POST /Plugins/deletePlugin — soft-delete an install (or the whole plugin
   * if the caller's community owns it). */
  async delete(id: string): Promise<{ ok: true }> {
    return this.transport.call("Plugins/deletePlugin", { id });
  }

  /** POST /Plugins/acceptPluginPermissions — per-user consent; the server
   * always adds USER_ACCEPTED. */
  async acceptPermissions(pluginId: string, permissions: PluginPermission[]): Promise<{ ok: true }> {
    return this.transport.call("Plugins/acceptPluginPermissions", { pluginId, permissions });
  }

  // ---- Appstore (public, no auth) ----

  async getAppstorePlugin(pluginId: string): Promise<AppstorePlugin> {
    return this.transport.call("Plugins/getAppstorePlugin", { pluginId });
  }

  async getAppstorePlugins(
    options: { query?: string; tags?: string[]; limit: number; offset: number },
  ): Promise<{ plugins: AppstorePlugin[] }> {
    return this.transport.call("Plugins/getAppstorePlugins", options);
  }

  async getPluginCommunities(pluginId: string, limit: number, offset: number): Promise<{ communityIds: string[] }> {
    return this.transport.call("Plugins/getPluginCommunities", { pluginId, limit, offset });
  }

  /**
   * POST /Plugins/pluginRequest — the signed plugin-runtime RPC. Signs the
   * request with the plugin's private key (from create()), sends it, and
   * verifies the server's response signature with the plugin public key.
   *
   * @param installId  the communities_plugins install id (createPlugin's id)
   * @param privateKeyPem  PKCS8 PEM from create()
   * @param publicKeyPem   SPKI PEM from create() (to verify the response)
   * @param counter  a monotonic number for the requestId (caller-owned)
   */
  async pluginRequest(
    installId: string,
    privateKeyPem: string,
    publicKeyPem: string,
    data: PluginRequestData,
    kind: "request" | "action",
    counter: number,
    epochMillis: number,
    iframeUid = "reference-client",
  ): Promise<unknown> {
    const inner = {
      pluginId: installId,
      requestId: `${counter}-${epochMillis}`,
      iframeUid,
      type: kind,
      data,
    };
    const requestString = JSON.stringify(inner);
    const signer = createSign("RSA-SHA256");
    signer.update(requestString);
    const signature = signer.sign(privateKeyPem, "base64");

    const envelope = (await this.transport.call("Plugins/pluginRequest", {
      request: requestString,
      signature,
    })) as { response: string; signature: string };

    // Verify the server signed the response with the plugin private key.
    const verifier = createVerify("RSA-SHA256");
    verifier.update(envelope.response);
    if (!verifier.verify(publicKeyPem, envelope.signature, "base64")) {
      throw new Error("pluginRequest: response signature verification failed");
    }
    return JSON.parse(envelope.response);
  }
}
