// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Additional terms: see LICENSE-ADDITIONAL-TERMS.md

type Preview = Pick<API.User.previewTransferLink.Response, 'identity' | 'username' | 'userId'>;
type IdentityType = NonNullable<API.User.previewTransferLink.Response['identity']>['type'];

const LABEL: Record<IdentityType, string> = {
  cg: '',
  twitter: 'X ',
  farcaster: 'Farcaster ',
  lukso: 'Universal Profile ',
};

/**
 * What tells the account of a transfer link apart from any other: its handle
 * (the cg profile name, else a linked X or Farcaster handle, else the
 * Universal Profile address). A display name and an image can be copied,
 * these can't. Without any of them, the start of the account id.
 */
export function transferIdentityText(preview: Preview): string {
  const identity = preview.identity ?? (preview.username ? { type: 'cg' as const, handle: preview.username } : null);
  if (!identity) {
    return `Account ${preview.userId.slice(0, 8)}`;
  }
  if (identity.type === 'lukso') {
    return `${LABEL.lukso}${identity.handle}`;
  }
  return `${LABEL[identity.type]}@${identity.handle}`;
}
