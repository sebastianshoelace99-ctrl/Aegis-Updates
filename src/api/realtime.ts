import { getSelfId } from "../state/identity";
import { postTyping, subscribeEvents, type BackendStatus } from "./backend";
import { isDmChannelId } from "./dms";
import type { Message } from "./messages";
import type { Presence } from "./workspace";

/**
 * The live transport.
 *
 * The handlers are the contract the rest of the app already used for the old mock socket
 * (`message`, `typing`, `presence`), so the React layer did not have to learn a new shape when
 * the backend arrived. The events themselves now come from `GET /api/events`; there is no timer
 * inventing traffic, and a quiet server looks quiet.
 */

export type RealtimeHandlers = {
  onMessage: (message: Message) => void;
  onReaction: (message: Message) => void;
  onTyping: (channelId: string, memberId: string) => void;
  onPresence: (memberId: string, presence: Presence) => void;
  onStatus?: (status: BackendStatus) => void;
};

export type StopRealtime = () => void;

export function startRealtime(handlers: RealtimeHandlers): StopRealtime {
  if (typeof window === "undefined") return () => {};

  return subscribeEvents((event) => {
    if (event.type === "message") {
      handlers.onMessage(event.message);
      return;
    }

    if (event.type === "reaction") {
      handlers.onReaction(event.message);
      return;
    }

    if (event.type === "typing") {
      // The server echoes every typing signal, including this window's own.
      if (event.memberId !== getSelfId()) handlers.onTyping(event.channelId, event.memberId);
      return;
    }

    // The signed-in member's dot comes from the saved status choice, not from the wire.
    if (event.memberId !== getSelfId()) handlers.onPresence(event.memberId, event.presence);
  }, handlers.onStatus);
}

/**
 * Typing is fire-and-forget: a dropped keystroke notice is not worth surfacing an error for.
 * The caller throttles; the server fans out.
 *
 * A DM id is a conversation the client named, not a channel the backend has a row for, and
 * `POST /api/typing` answers 404 for an unregistered channel. Signalling there would burn a
 * failed request every few seconds to tell nobody: the other side of a DM is addressed by its
 * own mirrored id (`dm:<their id>` vs `dm:<mine>`), which the server would have to map. Until
 * the backend models DMs, the honest thing is to stay quiet.
 */
export function signalTyping(channelId: string): void {
  if (typeof window === "undefined") return;
  if (isDmChannelId(channelId)) return;
  void postTyping(channelId).catch(() => {
    /* offline is a normal state; the next keystroke retries */
  });
}
