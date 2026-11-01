import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { searchMessages } from "../../api/backend";
import { findChannelById, memberById } from "../../api/workspace";
import { useLiveWorkspace } from "../../state/useLiveWorkspace";
import { useUiStore } from "../../state/uiStore";
import { useWorkspaceStore } from "../../state/workspaceStore";
import styles from "./SearchModal.module.css";

export function SearchModal(): React.JSX.Element | null {
  const open = useUiStore((state) => state.searchOpen);
  const guildId = useUiStore((state) => state.searchGuildId);
  const closeSearch = useUiStore((state) => state.closeSearch);
  const openChannel = useWorkspaceStore((state) => state.openChannel);
  const live = useLiveWorkspace();
  const [draft, setDraft] = useState("");
  const [term, setTerm] = useState("");
  const query = useQuery({
    queryKey: ["message-search", guildId, term],
    queryFn: () => searchMessages(term, guildId ?? undefined),
    enabled: open && term.length >= 2,
  });

  if (!open || !guildId) return null;

  return (
    <div
      className={styles.backdrop}
      role="presentation"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) closeSearch();
      }}
    >
      <section
        className={styles.dialog}
        role="dialog"
        aria-modal="true"
        aria-labelledby="message-search-title"
      >
        <div className={styles.header}>
          <h2 id="message-search-title">Search messages</h2>
          <button type="button" className={styles.close} onClick={closeSearch} aria-label="Close search">
            ×
          </button>
        </div>
        <form
          className={styles.form}
          onSubmit={(event) => {
            event.preventDefault();
            const next = draft.trim();
            if (next.length >= 2) setTerm(next);
          }}
        >
          <input
            className={styles.input}
            autoFocus
            value={draft}
            minLength={2}
            maxLength={100}
            placeholder="Search this server"
            aria-label="Search messages"
            onChange={(event) => setDraft(event.target.value)}
          />
          <button type="submit" className={styles.submit} disabled={draft.trim().length < 2}>
            Search
          </button>
        </form>

        <div className={styles.results} aria-live="polite">
          {term.length === 0 ? (
            <p className={styles.hint}>Search terms must contain at least two characters.</p>
          ) : query.isPending ? (
            <p className={styles.hint}>Searching permitted channel history…</p>
          ) : query.isError ? (
            <p className={styles.error} role="alert">
              {query.error instanceof Error ? query.error.message : "Search failed."}
            </p>
          ) : query.data?.length === 0 ? (
            <p className={styles.hint}>No matching messages found.</p>
          ) : (
            query.data?.map((message) => {
              const channel = findChannelById(live, message.channelId);
              const author = memberById(live, message.authorId);
              return (
                <button
                  type="button"
                  key={message.id}
                  className={styles.result}
                  onClick={() => {
                    openChannel(message.channelId, undefined, message.id);
                    closeSearch();
                  }}
                >
                  <span className={styles.meta}>
                    <strong>{author?.name ?? "Former member"}</strong>
                    <span>#{channel?.name ?? "channel"}</span>
                    <time dateTime={message.createdAt}>
                      {new Date(message.createdAt).toLocaleString()}
                    </time>
                  </span>
                  <span className={styles.body}>
                    {message.body || (message.attachments.length > 0 ? "[Attachment]" : "")}
                  </span>
                </button>
              );
            })
          )}
        </div>
      </section>
    </div>
  );
}
