import type { BackendEvent } from "../shared/events";

/**
 * In-process fan-out for SSE clients.
 *
 * One process, one bus. That is a real limitation and it is stated in the README: a second
 * backend instance would not see the first one's events. Supabase Realtime is the upgrade path;
 * the event shape would not change.
 */

type Listener = (event: BackendEvent) => void;

export class EventBus {
  private readonly listeners = new Set<Listener>();

  add(listener: Listener): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  publish(event: BackendEvent): void {
    for (const listener of this.listeners) {
      try {
        listener(event);
      } catch {
        /* one broken socket must not stop the others */
      }
    }
  }

  get size(): number {
    return this.listeners.size;
  }
}
