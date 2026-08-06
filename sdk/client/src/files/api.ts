/**
 * File/media upload + signed downloads.
 *
 * Contract: srv/api/files.ts. `POST /File/uploadImage` is the API's only
 * multipart route: file field `uploaded` (8 MB cap, re-encoded server-side
 * to WebP and resized per type) + text field `options` (JSON, the
 * UploadType). Profile/community image types wire themselves up server-side;
 * message attachments take the returned ids. `POST /File/getSignedUrls`
 * presigns S3 GETs, rewritten to the clean `/files/<id>/<sig>/<date>/<ttl>`
 * path nginx resolves — the signature lives in the path, so downloads need
 * no auth headers.
 */

import type { HttpTransport } from "../transport/http.js";

export type UploadType =
  | "userProfileImage"
  | "userBannerImage"
  | "articleImage"
  | "articleContentImage"
  | "channelAttachmentImage"
  | "pluginAppstoreImage"
  | "communityHeaderImage"
  | "communityLogoSmall"
  | "communityLogoLarge"
  | "roleImage";

export interface UploadOptions {
  type: UploadType;
  communityId?: string;
  roleId?: string;
}

export interface UploadResult {
  imageId: string;
  /** present for the two-output types (article/channel attachment images) */
  largeImageId?: string;
}

export interface SignedUrl {
  objectId: string;
  url: string;
  validUntil: string;
}

export class FileApi {
  constructor(private readonly transport: HttpTransport) {}

  /** Upload an image. `filename`'s extension only informs mime sniffing —
   * the server re-encodes everything to WebP. */
  async uploadImage(
    data: Uint8Array,
    options: UploadOptions,
    filename = "upload.png",
    mimeType = "image/png",
  ): Promise<UploadResult> {
    const form = new FormData();
    // Uint8Array → fresh ArrayBuffer keeps the BlobPart type strict-safe.
    form.append("uploaded", new Blob([Uint8Array.from(data).buffer], { type: mimeType }), filename);
    form.append("options", JSON.stringify(options));
    return this.transport.callMultipart("File/uploadImage", form);
  }

  /** POST /File/getSignedUrls — 7-day-valid download URLs for object ids. */
  async getSignedUrls(objectIds: string[]): Promise<SignedUrl[]> {
    return this.transport.call("File/getSignedUrls", { objectIds });
  }

  /**
   * Signed URLs embed the instance's public origin; when testing through a
   * different origin (e.g. the disposable loopback instance) the path still
   * verifies — rebase it onto this client's base URL.
   */
  rebaseSignedUrl(signed: SignedUrl): string {
    const { pathname, search } = new URL(signed.url);
    return `${this.transport.baseUrl}${pathname}${search}`;
  }
}
