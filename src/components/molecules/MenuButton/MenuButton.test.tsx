// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Additional terms: see LICENSE-ADDITIONAL-TERMS.md

import { describe, expect, it, vi } from 'vitest';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

// the SVGR plugin is not part of the test config
vi.mock('../../atoms/icons/16/Spinner.svg?react', () => ({ default: () => null }));

const { default: MenuButton } = await import('./MenuButton');

function render(props: React.ComponentProps<typeof MenuButton>) {
  return renderToStaticMarkup(<MenuButton {...props} />);
}

describe('MenuButton badge', () => {
  it('shows the count when it is > 0', () => {
    const html = render({ notificationCount: 3 });
    expect(html).toContain('notification-count');
    expect(html).toContain('>3<');
  });

  it('a count of 0 shows no badge and keeps the dot', () => {
    const html = render({ notificationCount: 0, showDot: true });
    expect(html).not.toContain('notification-count');
    expect(html).toContain('menu-button-dot-icon');
  });

  it('a stray numeric string "0" is 0, not truthy', () => {
    const html = render({ notificationCount: '0' as unknown as number, showDot: true });
    expect(html).not.toContain('notification-count');
    expect(html).toContain('menu-button-dot-icon');
  });

  it('count and dot together: only the count', () => {
    const html = render({ notificationCount: 12, showDot: true });
    expect(html).toContain('9+');
    expect(html).not.toContain('menu-button-dot-icon');
  });
});
