// SPDX-License-Identifier: AGPL-3.0-or-later
// Additional terms: see LICENSE-ADDITIONAL-TERMS.md

export const LOCAL_DATA_TIMEOUT_MS = 30_000;
export class LocalDataError extends Error {
  constructor(options?: ErrorOptions) {
    super('Local data could not be loaded. Please reload the app.', options);
    this.name = 'LocalDataError';
  }
}

/** A timeout ends the UI wait, not the underlying IndexedDB operation.
 * Keep tracking real work so an update cannot interrupt it or start a second
 * writer. Recovery reloads the page; it never deletes browser data or keys.
 */
class LocalData {
  private pending = new Set<Promise<unknown>>();
  private listeners = new Set<() => void>();
  private failure: LocalDataError | null = null;
  get error() { return this.failure; }
  get busy() { return this.pending.size > 0; }
  subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  };
  assertHealthy() {
    if (this.failure) throw this.failure;
  }
  private fail(cause: unknown) {
    if (!this.failure) {
      this.failure = new LocalDataError({ cause });
      for (const listener of this.listeners) listener();
    }
    return this.failure;
  }
  async whenIdle(): Promise<void> {
    while (this.pending.size) await Promise.allSettled([...this.pending]);
  }
  async run<T>(work: () => Promise<T>): Promise<T> {
    this.assertHealthy();
    const operation = Promise.resolve().then(work);
    this.pending.add(operation);
    let timer: ReturnType<typeof setTimeout> | undefined;
    // Both handlers consume settlement even if the caller already timed out.
    void operation.then(() => this.pending.delete(operation), () => this.pending.delete(operation));
    try {
      return await Promise.race([
        operation,
        new Promise<never>((_, reject) => {
          timer = setTimeout(() => reject(new Error('Local data operation timed out')), LOCAL_DATA_TIMEOUT_MS);
        }),
      ]);
    } catch (cause) {
      throw this.fail(cause);
    } finally {
      clearTimeout(timer);
    }
  }
}
export default new LocalData();
