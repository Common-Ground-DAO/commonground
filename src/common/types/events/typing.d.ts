// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Additional terms: see LICENSE-ADDITIONAL-TERMS.md

declare namespace Events {
  namespace Typing {
    // Ephemeral typing-presence broadcast. The server keeps no authoritative
    // typing state; receivers apply a local expiry (see the client contract),
    // so a missed `isTyping: false` self-heals. `access` echoes the validated
    // MessageAccess context so clients can route the indicator to the right
    // channel / chat / article.
    type Typing = {
      type: 'cliTypingEvent';
      data: {
        access: API.Messages.MessageAccess;
        userId: string;
        isTyping: boolean;
      };
    };

    type Event = (
      Typing
    );
  }
}
