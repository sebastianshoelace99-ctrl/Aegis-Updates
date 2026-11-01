import { useCallback, useMemo, useState } from "react";
import { useInfiniteQuery, useQueryClient, type InfiniteData } from "@tanstack/react-query";
import {
  flattenPages,
  mentionedHandles,
  messagesInfiniteQuery,
  messagesQueryKey,
  reactToMessage,
  sendMessage,
  type Attachment,
  type FileAttachment,
  type Message,
} from "../../api/messages";
import { useWorkspaceStore } from "../../state/workspaceStore";
import { getSelfId } from "../../state/identity";
import { Composer } from "./Composer";
import { MessageFeed, type PendingMessage } from "./MessageFeed";
import styles from "./ChatRoute.module.css";

let optimisticSequence = 0;

/** Messages only ever carry file attachments from this client; artwork plates are legacy rows. */
function filesOf(attachments: readonly Attachment[]): FileAttachment[] {
  return attachments.filter((item): item is FileAttachment => item.kind === "file");
}

/**
 * An optimistic row is a full `Message` plus a status, not a parallel shape. Keeping one type
 * means the feed has exactly one renderer, so a pending row cannot drift visually from a
 * confirmed one - the only difference is the status marker.
 */
function optimisticMessage(
  channelId: string,
  body: string,
  attachments: FileAttachment[],
): PendingMessage {
  optimisticSequence += 1;
  return {
    id: `optimistic-${optimisticSequence}`,
    channelId,
    authorId: getSelfId(),
    body,
    createdAt: new Date().toISOString(),
    kind: "user",
    attachments,
    mentions: mentionedHandles(body),
    replyToId: null,
    editedAt: null,
    reactions: [],
    status: "sending",
  };
}

export function ChatRoute(): React.JSX.Element {
  const channelId = useWorkspaceStore((state) => state.channelId);
  const draft = useWorkspaceStore((state) => state.drafts[state.channelId] ?? "");
  const setDraft = useWorkspaceStore((state) => state.setDraft);
  const markRead = useWorkspaceStore((state) => state.markRead);
  const newSince = useWorkspaceStore(
    (state) => state.previousReadAt[state.channelId] ?? state.read[state.channelId]?.lastReadAt,
  );

  const client = useQueryClient();
  const query = useInfiniteQuery(messagesInfiniteQuery(channelId));
  const messages = useMemo(
    () => (query.data ? flattenPages(query.data.pages) : []),
    [query.data],
  );
  const [pending, setPending] = useState<PendingMessage[]>([]);

  const send = useCallback(
    async (body: string, attachments: FileAttachment[] = []): Promise<boolean> => {
      const optimistic = optimisticMessage(channelId, body, attachments);
      setPending((previous) => [...previous, optimistic]);

      try {
        const message = await sendMessage(channelId, body, attachments);
        setPending((previous) => previous.filter((entry) => entry.id !== optimistic.id));

        // Patch the cache instead of invalidating: a refetch would drop the paged history
        // the reader already scrolled to, which is the one thing a feed must never do.
        client.setQueryData<InfiniteData<Message[], string | null>>(
          messagesQueryKey(channelId),
          (previous) => {
            if (!previous) return previous;
            const [newest, ...older] = previous.pages;
            // The SSE echo of this POST can land before the response does. Appending it twice
            // would render two identical rows, so the id is the guard.
            if (newest?.some((entry) => entry.id === message.id)) return previous;
            return { ...previous, pages: [[...(newest ?? []), message], ...older] };
          },
        );

        markRead(channelId, message.createdAt);
        return true;
      } catch {
        setPending((previous) =>
          previous.map((entry) =>
            entry.id === optimistic.id ? { ...entry, status: "failed" } : entry,
          ),
        );
        return false;
      }
    },
    [channelId, client, markRead],
  );

  const retry = useCallback(
    (id: string) => {
      const target = pending.find((entry) => entry.id === id);
      if (!target) return;
      // Remove first, then send: the send path re-adds a fresh optimistic row, and doing both
      // inside one state updater would double-fire under StrictMode. The attachments are already
      // on the server, so a retry never re-uploads them.
      setPending((previous) => previous.filter((entry) => entry.id !== id));
      void send(target.body, filesOf(target.attachments));
    },
    [pending, send],
  );

  /**
   * Reactions are fire-and-forget: the pill is the feedback, and a failure simply leaves it where it
   * was. The reply carries the whole row, so this cache swap is the same one the SSE echo performs.
   * Whichever arrives first wins, and they cannot disagree, because both are the server's row.
   */
  const react = useCallback(
    (message: Message, emoji: string, burst = false) => {
      void reactToMessage(message.channelId, message.id, emoji, burst)
        .then((updated) => {
          client.setQueryData<InfiniteData<Message[], string | null>>(
            messagesQueryKey(updated.channelId),
            (previous) => {
              if (!previous) return previous;
              return {
                ...previous,
                pages: previous.pages.map((page) =>
                  page.map((entry) => (entry.id === updated.id ? updated : entry)),
                ),
              };
            },
          );
        })
        .catch(() => {
          /* Leave the pill alone; the next echo or refetch reconciles. */
        });
    },
    [client],
  );

  return (
    <div className={styles.route}>
      <MessageFeed
        channelId={channelId}
        messages={messages}
        pending={pending}
        isPending={query.isPending}
        error={query.isError ? query.error : null}
        newSince={newSince}
        hasOlder={Boolean(query.hasNextPage)}
        isFetchingOlder={query.isFetchingNextPage}
        onLoadOlder={() => void query.fetchNextPage()}
        onReload={() => void query.refetch()}
        onRetry={retry}
        onReact={react}
      />
      <Composer
        channelId={channelId}
        value={draft}
        onChange={(next) => setDraft(channelId, next)}
        onSend={send}
      />
    </div>
  );
}
