// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Additional terms: see LICENSE-ADDITIONAL-TERMS.md

/* Feed post normalization.
 *
 * Articles store body + media interleaved as structured content; the post feed
 * presents body text and ordered media separately (images render below the
 * text). normalizePost() splits an article's content into:
 *   - media[]: every inline articleImage (in document order), preceded by the
 *     legacy cover image if present. Media is ALWAYS complete regardless of body
 *     truncation, so a truncated card still shows all the post's images.
 *   - bodyPreview: the media-stripped body, truncated at a node boundary once it
 *     exceeds the character budget (an oversized leading text node is truncated
 *     in place). isTruncated is true only when body TEXT was cut — the signal
 *     for the client to fetch full detail on "Read more". Media extraction never
 *     sets it. */

const MAX_PREVIEW_CHARS = 600;

type Content = Models.BaseArticle.Content;
type ContentNode = Models.BaseArticle.ContentElementV2;
type PostMedia = Models.Feed.PostMedia;

function coverMedia(headerImageId: string | null, thumbnailImageId: string | null): PostMedia[] {
  const cover = headerImageId ?? thumbnailImageId;
  if (!cover) return [];
  return [{
    type: 'image',
    objectId: cover,
    largeObjectId: null,
    caption: null,
    size: null,
    width: null,
    height: null,
  }];
}

function imageNodeToMedia(node: Common.Content.ArticleImage): PostMedia {
  return {
    type: 'image',
    objectId: node.imageId,
    largeObjectId: node.largeImageId ?? null,
    caption: node.caption ?? null,
    size: node.size ?? null,
    width: null,
    height: null,
  };
}

// Approximate rendered text length of a body node, for the truncation budget.
// The budget is about TEXT, so zero-cost structural nodes (newline) don't
// consume it — leading/interspersed newlines must not forfeit the text budget.
function nodeTextLength(node: ContentNode): number {
  switch (node.type) {
    case 'text':
    case 'link':
    case 'richTextLink':
      return node.value?.length ?? 0;
    case 'header':
      return Array.isArray(node.value)
        ? node.value.reduce((sum, t) => sum + (t.value?.length ?? 0), 0)
        : 0;
    case 'newline':
      return 0;
    case 'articleEmbed':
      return 24; // a nominal weight so an embed-only body still terminates
    default:
      return 0;
  }
}

function truncateString(value: string, budget: number): string {
  if (value.length <= budget) return value;
  let cut = value.slice(0, budget);
  const lastSpace = cut.lastIndexOf(' ');
  if (lastSpace > budget * 0.6) cut = cut.slice(0, lastSpace);
  return cut.trimEnd();
}

// Shorten a single body node to `budget` characters, preserving a valid
// structured node. Returns null when the node carries no truncatable text (a
// newline/embed, or a text node that shrinks to empty) so the caller drops it.
function truncateNode(node: ContentNode, budget: number): ContentNode | null {
  if (budget <= 0) return null;
  if (node.type === 'text' || node.type === 'link' || node.type === 'richTextLink') {
    const value = truncateString(node.value ?? '', budget);
    return value ? { ...node, value } : null;
  }
  if (node.type === 'header') {
    const children = Array.isArray(node.value) ? node.value : [];
    const keptChildren: Common.Content.Text[] = [];
    let used = 0;
    for (const child of children) {
      const clen = child.value?.length ?? 0;
      if (used + clen <= budget) {
        keptChildren.push(child);
        used += clen;
        continue;
      }
      const value = truncateString(child.value ?? '', budget - used);
      if (value) keptChildren.push({ ...child, value });
      break;
    }
    return keptChildren.length ? { ...node, value: keptChildren } : null;
  }
  return null;
}

export type NormalizedPost = {
  bodyPreview: Content;
  isTruncated: boolean;
  media: PostMedia[];
};

export function normalizePost(
  content: Content | null,
  headerImageId: string | null,
  thumbnailImageId: string | null,
): NormalizedPost {
  const media = coverMedia(headerImageId, thumbnailImageId);

  if (!content) {
    return { bodyPreview: { version: '2', content: [] }, isTruncated: false, media };
  }

  if (content.version === '1') {
    const text = content.text ?? '';
    if (text.length <= MAX_PREVIEW_CHARS) {
      return { bodyPreview: content, isTruncated: false, media };
    }
    return {
      bodyPreview: { version: '1', text: truncateString(text, MAX_PREVIEW_CHARS) },
      isTruncated: true,
      media,
    };
  }

  // v2: split media out of the body first so media is always complete, then
  // truncate the remaining body nodes at a node boundary.
  const nodes = Array.isArray(content.content) ? content.content : [];
  const bodyNodes: ContentNode[] = [];
  for (const node of nodes) {
    if (node.type === 'articleImage') {
      media.push(imageNodeToMedia(node));
    } else {
      bodyNodes.push(node);
    }
  }

  const kept: ContentNode[] = [];
  let used = 0;
  let truncated = false;
  for (const node of bodyNodes) {
    const len = nodeTextLength(node);
    if (used + len <= MAX_PREVIEW_CHARS) {
      kept.push(node);
      used += len;
      continue;
    }
    // This node overflows the remaining budget. Truncate it in place when it
    // carries text (any text-bearing node, headers included); otherwise drop
    // it. Either way there is more body than we kept, so mark truncated.
    const shortened = truncateNode(node, MAX_PREVIEW_CHARS - used);
    if (shortened) kept.push(shortened);
    truncated = true;
    break;
  }

  return { bodyPreview: { version: '2', content: kept }, isTruncated: truncated, media };
}
