import { infiniteQueryOptions } from "@tanstack/react-query";
import {
  MAX_MESSAGE_BODY,
  PAGE_SIZE,
  type FileAttachment,
  type Message,
} from "../../shared/messages";
import { fetchMessagesPage, postMessage, postReaction, type FetchMessagesArgs } from "./backend";

/**
 * The message tier, backed by the real API.
 *
 * Two properties matter more than the transport:
 *
 *  1. **Cursor pagination is real.** `before` is an opaque timestamp cursor and pages are
 *     returned ascending, so the feed's "load older" path is the same code a socket-backed
 *     server needs. Returning everything and slicing in the component would not be.
 *  2. **Pages never overlap.** `before` is exclusive on the server, so a page can never
 *     re-select a row it already returned.
 */

export * from "../../shared/messages";

/** Ascending page, ending just before `before`. Returned ascending so the feed never re-sorts. */
export async function fetchMessages({
  channelId,
  before = null,
  limit = PAGE_SIZE,
}: FetchMessagesArgs): Promise<Message[]> {
  return fetchMessagesPage({ channelId, before, limit });
}

/**
 * Sending, with a real round trip so the optimistic row has something to be optimistic about.
 * The author is decided by the server from the request identity, not by the caller: a client that
 * could name its own author could impersonate one.
 *
 * A message may be attachment-only; the emptiness rule therefore considers both halves.
 */
export async function sendMessage(
  channelId: string,
  body: string,
  attachments: readonly FileAttachment[] = [],
): Promise<Message> {
  const trimmed = body.trim();
  if (trimmed.length === 0 && attachments.length === 0) {
    throw new Error("Cannot send an empty message");
  }
  if (trimmed.length > MAX_MESSAGE_BODY) {
    throw new Error(`Messages are limited to ${MAX_MESSAGE_BODY} characters`);
  }

  return postMessage(channelId, trimmed, attachments);
}

/**
 * Toggle one glyph on one message.
 *
 * Answers with the server's view of the whole row rather than a boolean, because "did my toggle add
 * or remove" is the server's decision: two windows can toggle the same glyph at once, and only the
 * reply knows which way this one landed.
 */
export async function reactToMessage(
  channelId: string,
  messageId: string,
  emoji: string,
  burst = false,
): Promise<Message> {
  return postReaction(channelId, messageId, emoji, burst);
}

/** Pages arrive newest-chunk-first; the feed renders one ascending array. */
export function flattenPages(pages: readonly Message[][]): Message[] {
  return pages
    .slice()
    .reverse()
    .flatMap((page) => page);
}

export function messagesQueryKey(channelId: string): readonly ["messages", string] {
  return ["messages", channelId] as const;
}

export const messagesInfiniteQuery = (channelId: string) =>
  infiniteQueryOptions({
    queryKey: messagesQueryKey(channelId),
    queryFn: ({ pageParam }) => fetchMessages({ channelId, before: pageParam }),
    initialPageParam: null as string | null,
    getNextPageParam: (lastPage) => {
      const oldest = lastPage[0];
      // A short page is the end of history; a full page may still have older rows behind it.
      if (!oldest || lastPage.length < PAGE_SIZE) return undefined;
      return oldest.createdAt;
    },
    // The socket owns invalidation; a timer refetching history would fight it.
    staleTime: Number.POSITIVE_INFINITY,
  });
