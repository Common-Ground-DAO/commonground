/**
 * Own profile + user lookups + search.
 *
 * Contract: srv/api/user.ts (updateOwnData, setOwnStatus, getUserData,
 * getUserProfileDetails, availability probes, setPassword,
 * updateUserAccount) and srv/api/search.ts (searchUsers, searchArticles).
 */

import type { HttpTransport } from "../transport/http.js";
import type { OnlineStatus, ProfileItemType, UserData } from "../auth/types.js";

export interface UpdateOwnDataPatch {
  communityOrder?: string[];
  finishedTutorials?: string[];
  newsletter?: boolean;
  weeklyNewsletter?: boolean;
  email?: string;
  displayAccount?: ProfileItemType;
  dmNotifications?: boolean;
  tags?: string[] | null;
}

export interface UserSearchHit {
  id: string;
  matchPriority?: number;
  matchedAccountTypes?: ProfileItemType[];
}

export class ProfileApi {
  constructor(private readonly transport: HttpTransport) {}

  /** POST /User/updateOwnData — partial settings/profile update. */
  async updateOwnData(patch: UpdateOwnDataPatch): Promise<void> {
    await this.transport.call("User/updateOwnData", patch);
  }

  async setOwnStatus(status: OnlineStatus): Promise<void> {
    await this.transport.call("User/setOwnStatus", { status });
  }

  /** Public profile cards for user ids. */
  async getUserData(userIds: string[]): Promise<UserData[]> {
    return this.transport.call("User/getUserData", { userIds });
  }

  async getUserProfileDetails(userId: string): Promise<{
    detailledProfiles: unknown[];
    wallets: unknown[];
  }> {
    return this.transport.call("User/getUserProfileDetails", { userId });
  }

  /** Update the cg account (displayName/description/links/homepage —
   * imageId is set via File/uploadImage, not here). */
  async updateCgAccount(changes: {
    displayName?: string;
    description?: string;
    homepage?: string;
    links?: { url: string; text: string }[];
  }): Promise<void> {
    await this.transport.call("User/updateUserAccount", { type: "cg", ...changes });
  }

  async isCgProfileNameAvailable(displayName: string): Promise<boolean> {
    return this.transport.call("User/isCgProfileNameAvailable", { displayName });
  }

  async isEmailAvailable(email: string): Promise<boolean> {
    return this.transport.call("User/isEmailAvailable", { email });
  }

  async setPassword(password: string): Promise<void> {
    await this.transport.call("User/setPassword", { password });
  }

  /** POST /Search/searchUsers — id + match metadata; hydrate via getUserData. */
  async searchUsers(options: {
    query: string | null;
    limit?: number;
    offset?: number;
    tags?: string[];
  }): Promise<UserSearchHit[]> {
    return this.transport.call("Search/searchUsers", options);
  }

  async searchArticles(options: {
    type: "community" | "user" | "all";
    query: string | null;
    limit?: number;
    offset?: number;
    tags?: string[];
  }): Promise<unknown[]> {
    return this.transport.call("Search/searchArticles", options);
  }
}
