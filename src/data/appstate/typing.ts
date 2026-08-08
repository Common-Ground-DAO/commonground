// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Additional terms: see LICENSE-ADDITIONAL-TERMS.md

import connectionManager from './connection';

// Ephemeral typing presence. The server keeps no authoritative state and does
// not always send an explicit stop (a crashed/backgrounded sender just goes
// silent), so we apply a local expiry: a typing user is dropped if no refresh
// arrives within EXPIRY_MS. Senders refresh well inside this window.
const EXPIRY_MS = 7_000;

type Listener = (typingUserIds: string[]) => void;

class TypingManager {
  // channelId -> (userId -> expiry timeout handle)
  private byChannel = new Map<string, Map<string, ReturnType<typeof setTimeout>>>();
  private listeners = new Map<string, Set<Listener>>();
  private started = false;

  private ensureStarted() {
    if (this.started) {
      return;
    }
    this.started = true;
    connectionManager.registerClientEventHandler('cliTypingEvent', (event) => {
      const channelId = event.access.channelId;
      if (event.isTyping) {
        this.markTyping(channelId, event.userId);
      } else {
        this.clearTyping(channelId, event.userId);
      }
    });
  }

  private markTyping(channelId: string, userId: string) {
    let typers = this.byChannel.get(channelId);
    if (!typers) {
      typers = new Map();
      this.byChannel.set(channelId, typers);
    }
    const existing = typers.get(userId);
    if (existing) {
      clearTimeout(existing);
    }
    const isNew = !typers.has(userId);
    typers.set(userId, setTimeout(() => this.clearTyping(channelId, userId), EXPIRY_MS));
    if (isNew) {
      this.notify(channelId);
    }
  }

  private clearTyping(channelId: string, userId: string) {
    const typers = this.byChannel.get(channelId);
    if (!typers) {
      return;
    }
    const handle = typers.get(userId);
    if (handle) {
      clearTimeout(handle);
    }
    if (typers.delete(userId)) {
      if (typers.size === 0) {
        this.byChannel.delete(channelId);
      }
      this.notify(channelId);
    }
  }

  public getTypingUserIds(channelId: string): string[] {
    return Array.from(this.byChannel.get(channelId)?.keys() ?? []);
  }

  /** Subscribe to the typing-user list for a channel. Fires immediately. */
  public subscribe(channelId: string, listener: Listener): () => void {
    this.ensureStarted();
    let set = this.listeners.get(channelId);
    if (!set) {
      set = new Set();
      this.listeners.set(channelId, set);
    }
    set.add(listener);
    listener(this.getTypingUserIds(channelId));
    return () => {
      const current = this.listeners.get(channelId);
      if (current) {
        current.delete(listener);
        if (current.size === 0) {
          this.listeners.delete(channelId);
        }
      }
    };
  }

  private notify(channelId: string) {
    const set = this.listeners.get(channelId);
    if (!set) {
      return;
    }
    const ids = this.getTypingUserIds(channelId);
    set.forEach((listener) => listener(ids));
  }
}

const typingManager = new TypingManager();
export default typingManager;
