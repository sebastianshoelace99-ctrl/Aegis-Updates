import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  QUICK_REACTIONS,
  formatBytes,
  hasReacted,
  type ArtworkAttachment,
  type Attachment,
  type FileAttachment,
  type Message,
} from "../../api/messages";
import { downloadUrl, uploadUrl } from "../../api/uploads";
import { guildOfChannel, highestRole, memberById, type Member, type Workspace } from "../../api/workspace";
import { dmPartner, resolveChannel } from "../../api/dms";
import type { ClockChoice } from "../../api/profile";
import { getSelfHandle, getSelfId } from "../../state/identity";
import { useLiveWorkspace } from "../../state/useLiveWorkspace";
import { useMemberIdentity } from "../../state/useIdentity";
import { useSettingsStore } from "../../state/settingsStore";
import { Avatar } from "../../ui/Avatar";
import { ChatGlyph, HashGlyph, LinkGlyph } from "../../ui/Glyphs";
import { ratioKey } from "../../ui/ratio";
import styles from "./MessageFeed.module.css";

export type PendingMessage = Message & { status: "sending" | "failed" };

/** A run of messages from one author within this window renders as one block. */
const CONTINUATION_MS = 7 * 60 * 1000;
/** Distance from the bottom that still counts as "reading the present". */
const STICK_DISTANCE = 80;
/** Distance from the top that pulls the next page. */
const LOAD_OLDER_DISTANCE = 160;

/** Built once per choice: `Intl` formatters are expensive and a row is not. */
const TIME_FORMATS: Record<ClockChoice, Intl.DateTimeFormat> = {
  auto: new Intl.DateTimeFormat(undefined, { hour: "2-digit", minute: "2-digit" }),
  "12h": new Intl.DateTimeFormat(undefined, { hour: "numeric", minute: "2-digit", hour12: true }),
  "24h": new Intl.DateTimeFormat(undefined, { hour: "2-digit", minute: "2-digit", hourCycle: "h23" }),
};

const dayFormat = new Intl.DateTimeFormat(undefined, {
  weekday: "long",
  month: "short",
  day: "numeric",
});

const UNKNOWN_MEMBER: Member = {
  id: "unknown",
  name: "Unknown",
  handle: "unknown",
  role: "artist",
  presence: "offline",
  accent: 7,
};

function dayKey(iso: string): string {
  return iso.slice(0, 10);
}

function authorOf(target: Workspace, authorId: string): Member {
  return memberById(target, authorId) ?? UNKNOWN_MEMBER;
}

/** Highlights `@handle` tokens. Self-mentions get the louder treatment, as Discord does. */
function renderBody(body: string): React.ReactNode {
  const pattern = /@([a-z][a-z0-9-]*)/gi;
  const nodes: React.ReactNode[] = [];
  let last = 0;
  let index = 0;

  for (const match of body.matchAll(pattern)) {
    const start = match.index ?? 0;
    if (start > last) nodes.push(body.slice(last, start));

    const handle = (match[1] ?? "").toLowerCase();
    nodes.push(
      <span
        key={`mention-${index}`}
        className={styles.mention}
        data-self={handle === getSelfHandle()}
      >
        {match[0]}
      </span>,
    );

    last = start + match[0].length;
    index += 1;
  }

  if (last < body.length) nodes.push(body.slice(last));
  return <>{nodes}</>;
}

/** A gallery plate from a pre-upload row. Kept so old history never renders as a broken card. */
function ArtworkView({ item }: { item: ArtworkAttachment }): React.JSX.Element {
  return (
    <figure className={styles.attachment} data-ratio={ratioKey(item.width, item.height)}>
      <img src={item.thumb} alt={item.title} loading="lazy" decoding="async" />
    </figure>
  );
}

/**
 * One uploaded file, rendered by what it is.
 *
 * Images and media stream from the backend with `Range` support, so a 100 MB video can be
 * scrubbed without downloading it twice. Everything else is deliberately *not* previewed: the
 * server marks it as an attachment and this card links to it, which is the difference between
 * "open the PDF you were sent" and "execute the SVG you were sent".
 */
function FileView({ item }: { item: FileAttachment }): React.JSX.Element {
  const src = uploadUrl(item.uploadId);
  const href = downloadUrl(item.uploadId);
  const size = formatBytes(item.size);

  const caption = (
    <figcaption className={styles.fileCaption}>
      <span className={styles.fileName}>{item.name}</span>
      <span className={styles.fileMeta}>{size}</span>
    </figcaption>
  );

  if (item.mime.startsWith("image/") && item.mime !== "image/svg+xml") {
    return (
      <figure className={styles.fileImage}>
        <a className={styles.fileImageLink} href={href} title={`Download ${item.name}`}>
          <img src={src} alt={item.name} loading="lazy" decoding="async" />
        </a>
        {caption}
      </figure>
    );
  }

  if (item.mime.startsWith("video/")) {
    return (
      <figure className={styles.fileMedia}>
        <video src={src} controls preload="metadata" aria-label={item.name} />
        {caption}
      </figure>
    );
  }

  if (item.mime.startsWith("audio/")) {
    return (
      <figure className={styles.fileMedia}>
        <audio src={src} controls preload="metadata" aria-label={item.name} />
        {caption}
      </figure>
    );
  }

  return (
    <a
      className={styles.fileCard}
      href={href}
      download={item.name}
      title={`Download ${item.name}`}
    >
      <span className={styles.fileGlyph} aria-hidden="true">
        <LinkGlyph />
      </span>
      <span className={styles.fileBody}>
        <span className={styles.fileName}>{item.name}</span>
        <span className={styles.fileMeta}>
          {size} · {item.mime}
        </span>
      </span>
    </a>
  );
}

function Attachments({ items }: { items: readonly Attachment[] }): React.JSX.Element {
  return (
    <div
      className={styles.attachments}
      data-count={items.length}
      data-kind={items.some((item) => item.kind === "file") ? "files" : "artwork"}
    >
      {items.map((item, index) =>
        item.kind === "file" ? (
          <FileView key={`file-${item.uploadId}`} item={item} />
        ) : (
          // Two plates can share an artwork but not a thumb, so both are in the key.
          <ArtworkView key={`art-${item.artworkId}-${item.thumb}-${index}`} item={item} />
        ),
      )}
    </div>
  );
}

/**
 * The reaction strip: one pill per glyph, then the quick picker.
 *
 * The picker is local state rather than a store value. It belongs to one row on one screen, and
 * making "which popover is open" a global fact would buy nothing.
 *
 * Shift-click is the super reaction. Discord charges for that animation; here it is the same
 * request with one extra flag, which is the point of the build.
 */
function Reactions({
  message,
  onReact,
}: {
  message: Message;
  onReact: (emoji: string, burst?: boolean) => void;
}): React.JSX.Element {
  const [picking, setPicking] = useState(false);
  const self = getSelfId();

  return (
    <div className={styles.reactions}>
      {message.reactions.map((reaction) => {
        const mine = hasReacted(reaction, self);
        return (
          <button
            key={reaction.emoji}
            type="button"
            className={styles.reaction}
            data-mine={mine}
            data-burst={reaction.burst}
            aria-pressed={mine}
            aria-label={`${reaction.emoji}, ${reaction.userIds.length} ${
              reaction.userIds.length === 1 ? "reaction" : "reactions"
            }. Shift-click for a super reaction.`}
            onClick={(event) => onReact(reaction.emoji, event.shiftKey)}
          >
            <span className={styles.reactionGlyph} aria-hidden="true">
              {reaction.emoji}
            </span>
            <span className={styles.reactionCount}>{reaction.userIds.length}</span>
          </button>
        );
      })}

      <button
        type="button"
        className={styles.reactionAdd}
        aria-expanded={picking}
        aria-label="Add a reaction"
        title="Add a reaction - hold Shift for a super reaction"
        onClick={() => setPicking((open) => !open)}
      >
        <span aria-hidden="true">+</span>
      </button>

      {picking ? (
        <div className={styles.reactionPicker} role="menu" aria-label="Quick reactions">
          {QUICK_REACTIONS.map((emoji) => (
            <button
              key={emoji}
              type="button"
              role="menuitem"
              className={styles.reactionChoice}
              onClick={(event) => {
                onReact(emoji, event.shiftKey);
                setPicking(false);
              }}
            >
              {emoji}
            </button>
          ))}
        </div>
      ) : null}
    </div>
  );
}

type RowProps = {
  message: Message;
  showHeader: boolean;
  pendingStatus?: "sending" | "failed" | undefined;
  onRetry: (id: string) => void;
  onReact: (emoji: string, burst?: boolean) => void;
  roleColor?: number | undefined;
  /** True for a row that arrived in this render window; drives the one-shot static flicker. */
  fresh?: boolean | undefined;
};

function Row({
  message,
  showHeader,
  pendingStatus,
  onRetry,
  onReact,
  roleColor,
  fresh = false,
}: RowProps): React.JSX.Element {
  const live = useLiveWorkspace();
  const author = authorOf(live, message.authorId);
  const identity = useMemberIdentity(author);
  const mentioned = message.mentions.includes(getSelfHandle());
  const isSelf = message.authorId === getSelfId();
  const clock = useSettingsStore((state) => state.appearance.clock);
  const timeFormat = TIME_FORMATS[clock];

  if (message.kind === "system") {
    return (
      <div className={styles.system} data-testid="message-row" data-message-id={message.id}>
        <span className={styles.systemMark} aria-hidden="true" />
        <span>
          <strong className={styles.systemAuthor}>{author.name}</strong> {message.body}
        </span>
      </div>
    );
  }

  return (
    <div
      className={styles.row}
      data-continuation={!showHeader}
      data-mentioned={mentioned}
      data-pending={pendingStatus}
      data-fresh={fresh}
      data-testid="message-row"
      data-message-id={message.id}
    >
      <div className={styles.gutter}>
        {showHeader ? (
          <Avatar name={identity.name} accent={identity.accent} image={identity.avatar} size="md" />
        ) : (
          <time className={styles.hoverTime} dateTime={message.createdAt}>
            {timeFormat.format(new Date(message.createdAt))}
          </time>
        )}
      </div>

      <div className={styles.content}>
        {showHeader ? (
          <div className={styles.meta}>
            <span
              className={`${styles.author} ${roleColor !== undefined ? `role-color-${roleColor}` : ""}`}
            >
              {identity.name}
            </span>
            <time className={styles.time} dateTime={message.createdAt}>
              {timeFormat.format(new Date(message.createdAt))}
            </time>
            {message.editedAt ? <span className={styles.edited}>(edited)</span> : null}
          </div>
        ) : null}

        {message.body.length > 0 ? (
          /*
           * The bubble is a wrapper, not a new layout: ECHO-net sets its padding, radius and
           * alignment tokens to zero, so the paragraph renders exactly where it did before. Themes
           * that want messenger bubbles get them from the same tokens.
           */
          <div className={styles.bubble} data-self={isSelf}>
            <p className={styles.body}>{renderBody(message.body)}</p>
          </div>
        ) : null}

        {message.attachments.length > 0 ? <Attachments items={message.attachments} /> : null}

        {/* Always mounted, even with no reactions and no send permission: the strip is how a row
            gets its first reaction, and the add control styles itself away until hover. */}
        {pendingStatus ? null : <Reactions message={message} onReact={onReact} />}

        {pendingStatus ? (
          <span className={styles.status} data-status={pendingStatus}>
            {pendingStatus === "sending" ? "Sending…" : "Not delivered"}
            {pendingStatus === "failed" ? (
              <button type="button" className={styles.retry} onClick={() => onRetry(message.id)}>
                Retry
              </button>
            ) : null}
          </span>
        ) : null}
      </div>
    </div>
  );
}

export type MessageFeedProps = {
  channelId: string;
  messages: readonly Message[];
  jumpToMessageId: string | null;
  onJumpHandled: () => void;
  pending: readonly PendingMessage[];
  isPending: boolean;
  error: unknown;
  /** Read marker from before the channel was opened. Draws the "new messages" divider. */
  newSince?: string | undefined;
  hasOlder: boolean;
  isFetchingOlder: boolean;
  onLoadOlder: () => void;
  onReload: () => void;
  onRetry: (id: string) => void;
  /** Toggle one glyph on one message. `burst` is the super reaction. */
  onReact: (message: Message, emoji: string, burst?: boolean) => void;
};

type Item = {
  key: string;
  message: Message;
  showHeader: boolean;
  dayBreak: boolean;
  newDivider: boolean;
  /** Arrived within the last few seconds: the row earns one brief static flicker. */
  fresh: boolean;
  pendingStatus?: "sending" | "failed";
};

export function MessageFeed({
  channelId,
  messages,
  jumpToMessageId,
  onJumpHandled,
  pending,
  isPending,
  error,
  newSince,
  hasOlder,
  isFetchingOlder,
  onLoadOlder,
  onReload,
  onRetry,
  onReact,
}: MessageFeedProps): React.JSX.Element {
  const viewportRef = useRef<HTMLDivElement | null>(null);
  const frame = useRef(0);
  const anchor = useRef<{ height: number; count: number } | null>(null);
  const previousCount = useRef(0);
  const [atBottom, setAtBottom] = useState(true);
  const live = useLiveWorkspace();

  // A DM is not in the graph. `resolveChannel` answers for both, so the feed keeps one path.
  const channel = useMemo(() => resolveChannel(live, channelId), [channelId, live]);
  const partner = useMemo(() => dmPartner(live, channelId), [channelId, live]);
  const guild = useMemo(() => guildOfChannel(live, channelId), [channelId, live]);

  const items = useMemo<Item[]>(() => {
    const combined: Array<{ message: Message; pendingStatus?: "sending" | "failed" }> = [
      ...messages.map((message) => ({ message })),
      ...pending.map((entry) => ({ message: entry as Message, pendingStatus: entry.status })),
    ];

    let dividerPlaced = false;

    return combined.map((entry, index) => {
      const previous = combined[index - 1]?.message;
      const dayBreak =
        !previous || dayKey(previous.createdAt) !== dayKey(entry.message.createdAt);
      const gap = previous
        ? Date.parse(entry.message.createdAt) - Date.parse(previous.createdAt)
        : Number.POSITIVE_INFINITY;

      // Discord's grouping rule: new author, new day, a long pause, or after a system line.
      const showHeader =
        !previous ||
        dayBreak ||
        previous.kind === "system" ||
        entry.message.kind === "system" ||
        previous.authorId !== entry.message.authorId ||
        gap > CONTINUATION_MS;

      const newDivider =
        !dividerPlaced && newSince !== undefined && entry.message.createdAt > newSince;
      if (newDivider) dividerPlaced = true;

      return {
        key: entry.message.id,
        message: entry.message,
        showHeader,
        dayBreak,
        newDivider,
        fresh: Date.now() - Date.parse(entry.message.createdAt) < 5_000,
        pendingStatus: entry.pendingStatus,
      };
    });
  }, [messages, pending, newSince]);

  const scrollToBottom = useCallback((behavior: ScrollBehavior = "auto") => {
    const element = viewportRef.current;
    if (!element) return;
    element.scrollTo({ top: element.scrollHeight, behavior });

    if (behavior !== "auto") return;

    /*
     * `content-visibility: auto` lays offscreen rows out at their `contain-intrinsic-size`
     * estimate, so the first `scrollHeight` is short of the real one and the view settles a few
     * pixels above the end. Correct after layout - twice, because the first frame can still be
     * pre-layout on a cold start.
     */
    requestAnimationFrame(() => {
      requestAnimationFrame(() => {
        const settled = viewportRef.current;
        if (settled) settled.scrollTop = settled.scrollHeight;
      });
    });
  }, []);

  const onScroll = useCallback(() => {
    if (frame.current !== 0) return;
    frame.current = requestAnimationFrame(() => {
      frame.current = 0;
      const element = viewportRef.current;
      if (!element) return;

      const distance = element.scrollHeight - element.scrollTop - element.clientHeight;
      setAtBottom(distance < STICK_DISTANCE);

      if (element.scrollTop < LOAD_OLDER_DISTANCE && hasOlder && !isFetchingOlder) {
        // Remember the pre-fetch height so the prepend can be absorbed below.
        anchor.current = { height: element.scrollHeight, count: items.length };
        onLoadOlder();
      }
    });
  }, [hasOlder, isFetchingOlder, onLoadOlder, items.length]);

  useEffect(
    () => () => {
      if (frame.current !== 0) cancelAnimationFrame(frame.current);
    },
    [],
  );

  // Follow the present on first paint, and on any growth while the reader is at the bottom.
  useEffect(() => {
    const total = items.length;
    const firstPaint = previousCount.current === 0 && total > 0;
    const grew = total > previousCount.current;
    previousCount.current = total;

    if (!jumpToMessageId && (firstPaint || (grew && atBottom))) scrollToBottom("auto");
  }, [items.length, atBottom, jumpToMessageId, scrollToBottom]);

  /**
   * Anchored prepend: after older messages arrive, shift `scrollTop` by exactly the height that
   * was added above, so the row the reader was looking at does not move. This is the whole
   * reason `fetchNextPage` is allowed to run without resetting scroll.
   */
  useEffect(() => {
    const element = viewportRef.current;
    const saved = anchor.current;
    if (!element || !saved || items.length === saved.count) return;

    const delta = element.scrollHeight - saved.height;
    if (delta > 0) element.scrollTop += delta;
    anchor.current = null;
  }, [items.length]);

  useEffect(() => {
    if (!jumpToMessageId || isPending || isFetchingOlder) return;

    const target = Array.from(
      viewportRef.current?.querySelectorAll<HTMLElement>("[data-message-id]") ?? [],
    ).find((element) => element.dataset.messageId === jumpToMessageId);
    if (target) {
      target.scrollIntoView({ block: "center", behavior: "smooth" });
      onJumpHandled();
    } else if (hasOlder) {
      onLoadOlder();
    } else {
      onJumpHandled();
    }
  }, [
    jumpToMessageId,
    isPending,
    isFetchingOlder,
    hasOlder,
    messages,
    onLoadOlder,
    onJumpHandled,
  ]);

  return (
    <div className={styles.wrap}>
      <div
        ref={viewportRef}
        className={styles.viewport}
        onScroll={onScroll}
        role="log"
        aria-label="Messages"
        data-testid="message-feed"
      >
        {isFetchingOlder ? <div className={styles.older}>Loading earlier messages…</div> : null}

        {!hasOlder && channel ? (
          <div className={styles.banner}>
            <span className={styles.bannerMark}>
              {partner ? <ChatGlyph /> : <HashGlyph />}
            </span>
            <h3 className={styles.bannerTitle}>
              {partner
                ? `This is the beginning of your conversation with ${partner.name}`
                : `Welcome to #${channel.name}`}
            </h3>
            <p className={styles.bannerBody}>
              {partner ? `Only you and @${partner.handle} can read this conversation.` : channel.topic}
            </p>
          </div>
        ) : null}

        {isPending
          ? Array.from({ length: 8 }, (_, index) => (
              <div key={`skeleton-${index}`} className={styles.skeletonRow} aria-hidden="true">
                <span className={styles.skeletonAvatar} />
                <span className={styles.skeletonLines}>
                  <span className={styles.skeletonLine} />
                  <span className={styles.skeletonLine} data-short="true" />
                </span>
              </div>
            ))
          : null}

        {error ? (
          <div className={styles.error} role="alert">
            <p className={styles.errorTitle}>Could not load this conversation</p>
            <p className={styles.errorBody}>
              {error instanceof Error ? error.message : "Unknown transport error"}
            </p>
            <button type="button" className={styles.errorAction} onClick={onReload}>
              Try again
            </button>
          </div>
        ) : null}

        {items.map((item) => (
          <div key={item.key} className={styles.item}>
            {item.dayBreak ? (
              <div className={styles.dayDivider}>
                <span>{dayFormat.format(new Date(item.message.createdAt))}</span>
              </div>
            ) : null}

            {item.newDivider ? (
              <div className={styles.newDivider} data-testid="new-divider">
                <span>New messages</span>
              </div>
            ) : null}

            <Row
              message={item.message}
              showHeader={item.showHeader}
              pendingStatus={item.pendingStatus}
              fresh={item.fresh}
              onRetry={onRetry}
              onReact={(emoji, burst) => onReact(item.message, emoji, burst)}
              roleColor={guild ? highestRole(guild, item.message.authorId)?.color : undefined}
            />
          </div>
        ))}
      </div>

      {!atBottom ? (
        <button
          type="button"
          className={styles.jump}
          onClick={() => scrollToBottom("smooth")}
          data-testid="jump-to-present"
        >
          Jump to present
        </button>
      ) : null}
    </div>
  );
}
