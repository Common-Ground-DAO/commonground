// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Additional terms: see LICENSE-ADDITIONAL-TERMS.md

declare namespace Events {
  namespace Bot {
    type Scopes = {
      type: 'cliBotScopesEvent';
      action: 'refresh';
      data: Record<string, never>;
    };

    type Event = Scopes;
  }
}
