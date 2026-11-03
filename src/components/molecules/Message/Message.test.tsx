// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Additional terms: see LICENSE-ADDITIONAL-TERMS.md

import { beforeAll, describe, expect, it, vi } from 'vitest';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

// the SVGR plugin is not part of the test config
vi.mock('../../atoms/icons/20/Reply.svg?react', () => ({ default: () => null }));
// the providers and their data layer are out of scope: the item renders from its props
vi.mock('context/OwnDataProvider', () => ({ useOwnUser: () => ({ id: 'me' }) }));
vi.mock('context/UserDataProvider', () => ({ useMultipleUserData: () => ({}) }));
vi.mock('context/WindowSizeProvider', () => ({ useWindowSizeContext: () => ({ isMobile: false }) }));
vi.mock('context/CommunityProvider', () => ({ useSafeCommunityContext: () => ({ state: 'no-community' }) }));
vi.mock('components/organisms/UserTooltip/UserTooltip', () => ({ default: () => null }));
vi.mock('./MessageTooltip/MessageTooltip', () => ({ default: () => null }));
vi.mock('./ReplyContentRenderer/ReplyContentRenderer', () => ({ default: () => null }));
vi.mock('./MessageAttachments/MessageAttachments', () => ({ default: () => null }));
vi.mock('./ReactionsDisplay/ReactionsDisplay', () => ({ default: () => null }));
vi.mock('../MesssageBodyRenderer/MarkdownContent', () => ({
  default: (props: { source: string }) => <span>{props.source}</span>,
  toMarkdownSource: (lines: string[]) => lines.join('\n'),
}));
vi.mock('../LinkPreview/LinkPreviewLoader', () => ({ default: () => null }));
vi.mock('../LoginBanner/MiniLoginBanner', () => ({ default: () => null }));
vi.mock('components/atoms/SimpleLink/SimpleLink', () => ({ default: () => null, isLocalUrl: () => false }));
vi.mock('components/atoms/FullscreenImageModal/FullscreenImageModal', () => ({ default: () => null }));
vi.mock('components/atoms/YoutubeIframe/YoutubeIframe', () => ({ default: () => null }));
vi.mock('hooks/useSignedUrl', () => ({ useSignedUrl: () => undefined }));

let Message: typeof import('./Message').default;

beforeAll(async () => {
  // the item looks up the tooltip portal root while rendering
  vi.stubGlobal('document', { getElementById: () => null });
  Message = (await import('./Message')).default;
});

function message(sendStatus?: Models.Message.Message['sendStatus']): Models.Message.Message {
  const createdAt = new Date('2026-11-03T10:00:00.000Z');
  return {
    id: 'm1',
    creatorId: 'me',
    channelId: 'c1',
    body: { version: '1', content: [{ type: 'text', value: 'hello' }] },
    attachments: [],
    editedAt: null,
    createdAt,
    updatedAt: createdAt,
    reactions: {},
    ownReaction: null,
    parentMessageId: null,
    sendStatus,
  };
}

function render(sendStatus?: Models.Message.Message['sendStatus']) {
  const noop = () => {};
  return renderToStaticMarkup(<Message
    message={message(sendStatus)}
    repliedTo={null}
    channelId='c1'
    setReaction={noop}
    unsetReaction={noop}
    replyClick={noop}
    editClick={noop}
    retrySend={noop}
    discardPending={noop}
    canReply
  />);
}

describe('Message sendStatus', () => {
  it('a confirmed message: no data-send-status, no notice', () => {
    const html = render(undefined);
    expect(html).toContain('data-timestamp="2026-11-03T10:00:00.000Z"');
    expect(html).not.toContain('data-send-status');
    expect(html).not.toContain('message-send-status');
    expect(html).not.toMatch(/class="[^"]*\bsending\b/);
  });

  it('a pending send: faded (`sending`), data-send-status, no notice', () => {
    const html = render('sending');
    expect(html).toMatch(/class="[^"]*\bsending\b/);
    expect(html).toContain('data-send-status="sending"');
    expect(html).not.toContain('message-send-status');
  });

  it('a failed send: data-send-status, notice with Retry and Discard', () => {
    const html = render('error-send');
    expect(html).toContain('data-send-status="error-send"');
    expect(html).not.toMatch(/class="[^"]*\bsending\b/);
    expect(html).toContain('Message not sent');
    expect(html).toContain('>Retry</button>');
    expect(html).toContain('>Discard</button>');
  });

  it('a failed edit: data-send-status, notice with Retry and Undo edit', () => {
    const html = render('error-update');
    expect(html).toContain('data-send-status="error-update"');
    expect(html).toContain('Edit not saved');
    expect(html).toContain('>Retry</button>');
    expect(html).toContain('>Undo edit</button>');
  });
});
