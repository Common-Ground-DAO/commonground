// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Additional terms: see LICENSE-ADDITIONAL-TERMS.md

import { describe, expect, it, vi } from 'vitest';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import SendStatusNotice, { messageExcerpt, moveFocusAfterDiscard, sendStatusActionLabels } from './SendStatusNotice';

const content: Models.Message.Body['content'] = [{ type: 'text', value: 'hello  world' }];

function render(props: Partial<React.ComponentProps<typeof SendStatusNotice>> = {}) {
  return renderToStaticMarkup(<SendStatusNotice
    messageId='m1'
    content={content}
    sendStatus='error-send'
    onRetry={() => {}}
    onDiscard={() => {}}
    {...props}
  />);
}

describe('SendStatusNotice', () => {
  it('a failed send: polite status, Retry and Discard named after the message', () => {
    const html = render();
    expect(html).toContain('role="status"');
    expect(html).not.toContain('role="alert"');
    expect(html).toContain('<span id="m1-send-status">Message not sent</span>');
    expect(html).toContain('aria-label="Retry sending “hello world”"');
    expect(html).toContain('aria-label="Discard “hello world”"');
    expect(html.match(/aria-describedby="m1-send-status"/g)).toHaveLength(2);
    expect(html).toContain('>Retry</button>');
    expect(html).toContain('>Discard</button>');
  });

  it('a failed edit: Retry and Undo edit', () => {
    const html = render({ sendStatus: 'error-update' });
    expect(html).toContain('Edit not saved');
    expect(html).toContain('aria-label="Retry saving the edit of “hello world”"');
    expect(html).toContain('aria-label="Undo edit of “hello world”"');
    expect(html).toContain('>Undo edit</button>');
  });

  it('a failed comment', () => {
    expect(render({ kind: 'comment' })).toContain('Comment not posted');
  });

  it('only the actions it is given', () => {
    const html = render({ onRetry: undefined, onDiscard: undefined });
    expect(html).toContain('Message not sent');
    expect(html).not.toContain('<button');
  });
});

describe('action labels', () => {
  it('truncates long messages and falls back without text', () => {
    expect(messageExcerpt([{ type: 'text', value: 'x'.repeat(60) }])).toBe('x'.repeat(39) + '…');
    expect(messageExcerpt([])).toBe('');
    expect(sendStatusActionLabels('error-send', '')).toEqual({
      retry: 'Retry sending message',
      discard: 'Discard message',
    });
  });
});

describe('moveFocusAfterDiscard', () => {
  function setup(options: { focused?: boolean; composer?: boolean; coarse?: boolean; scope?: boolean }) {
    const composer = { focus: vi.fn() };
    const scope = {
      hasAttribute: vi.fn(() => false),
      tabIndex: 0,
      focus: vi.fn(),
      querySelector: vi.fn(() => (options.composer ? composer : null)),
    };
    const ownerDocument = {
      activeElement: null as unknown,
      defaultView: { matchMedia: () => ({ matches: !!options.coarse }) },
    };
    const button = {
      ownerDocument,
      closest: vi.fn(() => (options.scope === false ? null : scope)),
    };
    if (options.focused !== false) ownerDocument.activeElement = button;
    moveFocusAfterDiscard(button as unknown as HTMLElement);
    return { composer, scope };
  }

  it('focuses the composer of the list', () => {
    const { composer, scope } = setup({ composer: true });
    expect(composer.focus).toHaveBeenCalledOnce();
    expect(scope.focus).not.toHaveBeenCalled();
  });

  it('without a composer: the list, made focusable', () => {
    const { scope } = setup({ composer: false });
    expect(scope.tabIndex).toBe(-1);
    expect(scope.focus).toHaveBeenCalledOnce();
  });

  it('on touch devices: the list, so the keyboard stays closed', () => {
    const { composer, scope } = setup({ composer: true, coarse: true });
    expect(composer.focus).not.toHaveBeenCalled();
    expect(scope.focus).toHaveBeenCalledOnce();
  });

  it('leaves focus alone when the button does not have it', () => {
    const { composer, scope } = setup({ composer: true, focused: false });
    expect(composer.focus).not.toHaveBeenCalled();
    expect(scope.focus).not.toHaveBeenCalled();
  });
});
