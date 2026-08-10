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
 *   - bodyPreview: the media-stripped body, bounded two independent ways — a
 *     ~600-char TEXT budget (governs readable content) AND a structural bound on
 *     node/child count (governs response size, so a valid post of e.g. 100k
 *     zero-cost newline nodes can't inflate the feed). Consecutive newlines are
 *     collapsed to at most two and leading/trailing runs dropped. isTruncated is
 *     set whenever text is cut OR structural content is omitted/collapsed — the
 *     signal for the client to fetch full detail on "Read more". Media extraction
 *     never sets it. */

const MAX_PREVIEW_CHARS = 600;     // readable-text budget
const MAX_PREVIEW_NODES = 40;      // structural bound: retained body nodes
const MAX_HEADER_CHILDREN = 12;    // retained children within one header
const MAX_CONSECUTIVE_NEWLINES = 2; // collapse blank-line runs to at most this

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
      if (keptChildren.length >= MAX_HEADER_CHILDREN) break; // structural cap
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

// Bound a header's child count independently of the text budget — a header can
// hold thousands of zero-length children that never trip the char budget.
function sanitizeHeader(node: ContentNode): { node: ContentNode; capped: boolean } {
  if (node.type !== 'header' || !Array.isArray(node.value) || node.value.length <= MAX_HEADER_CHILDREN) {
    return { node, capped: false };
  }
  return { node: { ...node, value: node.value.slice(0, MAX_HEADER_CHILDREN) }, capped: true };
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
  let hadContent = false;
  let newlineRun = 0; // consecutive newlines buffered at the tail

  // Emit buffered newlines between content, collapsed to the run limit. Leading
  // runs (before any content) are dropped; a run longer than the limit counts as
  // omitted structural content.
  const flushNewlines = () => {
    if (hadContent) {
      const emit = Math.min(newlineRun, MAX_CONSECUTIVE_NEWLINES);
      for (let i = 0; i < emit && kept.length < MAX_PREVIEW_NODES; i++) kept.push({ type: 'newline' });
      if (newlineRun > emit) truncated = true;
    } else if (newlineRun > MAX_CONSECUTIVE_NEWLINES) {
      truncated = true; // a large leading/all-blank run bounded away
    }
    newlineRun = 0;
  };

  for (const node of bodyNodes) {
    if (node.type === 'newline') {
      newlineRun++;
      continue;
    }

    const len = nodeTextLength(node);
    if (used + len > MAX_PREVIEW_CHARS) {
      flushNewlines();
      const shortened = truncateNode(node, MAX_PREVIEW_CHARS - used);
      if (shortened && kept.length < MAX_PREVIEW_NODES) kept.push(shortened);
      truncated = true;
      break;
    }

    flushNewlines();
    if (kept.length >= MAX_PREVIEW_NODES) {
      truncated = true; // structural bound: this node (and any after) omitted
      break;
    }

    const { node: sanitized, capped } = sanitizeHeader(node);
    if (capped) truncated = true;
    kept.push(sanitized);
    used += len;
    hadContent = true;
  }
  // A trailing newline run is dropped (cosmetic); but an all-newline body still
  // needs to signal that its (blank) content was bounded away.
  if (!hadContent && newlineRun > MAX_CONSECUTIVE_NEWLINES) truncated = true;

  return { bodyPreview: { version: '2', content: kept }, isTruncated: truncated, media };
}
