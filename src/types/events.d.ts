// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Additional terms: see LICENSE-ADDITIONAL-TERMS.md

declare namespace Events {
  type ClientEvent = (
    Events.Community.Event |
    Events.Message.Event |
    Events.Notification.Event |
    Events.User.Event |
    Events.Application.Event |
    Events.Calls.Event |
    Events.Chat.Event |
    Events.Channel.Event |
    Events.Typing.Event |
    Events.CgId.Event
  ) & {
    type: `cli${string}`;
  };
}