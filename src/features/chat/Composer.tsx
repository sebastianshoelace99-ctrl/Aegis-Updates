import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { dmPartner, resolveChannel } from "../../api/dms";
import {
  guildMembers,
  guildOfChannel,
  memberById,
} from "../../api/workspace";
import { signalTyping } from "../../api/realtime";
import { uploadAttachment } from "../../api/uploads";
import {
  MAX_ATTACHMENT_BYTES,
  MAX_ATTACHMENTS,
  formatBytes,
  type FileAttachment,
} from "../../../shared/messages";
import { useLiveWorkspace } from "../../state/useLiveWorkspace";
import { getSelfId } from "../../state/identity";
import { useSettingsStore } from "../../state/settingsStore";
import { useWorkspaceStore } from "../../state/workspaceStore";
import { CloseGlyph, PaperclipGlyph, SendGlyph } from "../../ui/Glyphs";
import styles from "./Composer.module.css";

/**
 * The composer.
 *
 * Autosize is done with the `rows` attribute, not `style.height`: a growing textarea normally
 * means an inline style, and `style-src 'self'` rules that out. `rows` is a presentation
 * attribute, so the box still grows with the draft and the CSP stays strict.
 *
 * `@` completion is real: ArrowUp/Down move, Enter or Tab accepts, Escape dismisses. Without
 * the key handling the menu would just be an unclickable hint.
 *
 * Attachments upload as soon as they are chosen, not when the message is sent. Sending therefore
 * only has to carry ids, a retry never re-uploads a 100 MB file, and the progress bar is honest
 * about which part of the work is still outstanding.
 */

export type ComposerProps = {
  channelId: string;
  value: string;
  onChange: (value: string) => void;
  /** Resolves true when the message became a server row; false leaves the draft intact. */
  onSend: (body: string, attachments: FileAttachment[]) => Promise<boolean>;
};

type DraftAttachment = {
  key: string;
  file: File;
  status: "uploading" | "done" | "failed";
  /** 0..1, straight from `XMLHttpRequest.upload.onprogress`. */
  progress: number;
  uploaded: FileAttachment | null;
  error: string | null;
  abort: (() => void) | null;
};

const MAX_ROWS = 6;
const MAX_SUGGESTIONS = 6;
const EMPTY_TYPING: string[] = [];

let draftSequence = 0;

function newDraft(file: File): DraftAttachment {
  draftSequence += 1;
  return {
    key: `draft-${draftSequence}`,
    file,
    status: "uploading",
    progress: 0,
    uploaded: null,
    error: null,
    abort: null,
  };
}

function describe(cause: unknown): string {
  return cause instanceof Error && cause.message.length > 0 ? cause.message : "The upload failed.";
}

export function Composer({ channelId, value, onChange, onSend }: ComposerProps): React.JSX.Element {
  const textareaRef = useRef<HTMLTextAreaElement | null>(null);
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const caretRef = useRef<number | null>(null);
  /** Throttled so a burst of keystrokes is one event, not one per character. */
  const typingSentAt = useRef(0);
  const [mention, setMention] = useState<{ query: string; start: number } | null>(null);
  const [highlight, setHighlight] = useState(0);

  const [queue, setQueue] = useState<DraftAttachment[]>([]);
  const queueRef = useRef<DraftAttachment[]>([]);
  /** Serialised uploads: ten parallel 100 MB POSTs is a self-inflicted denial of service. */
  const backlog = useRef<DraftAttachment[]>([]);
  const pumping = useRef(false);
  const [error, setError] = useState<string | null>(null);
  const [dragging, setDragging] = useState(false);

  const typing = useWorkspaceStore((state) => state.typing[state.channelId] ?? EMPTY_TYPING);
  const selfName = useSettingsStore((state) => state.profile.displayName);
  const live = useLiveWorkspace();


  const nameOf = (member: { id: string; name: string }): string =>
    member.id === getSelfId() ? selfName : member.name;

  /*
   * `resolveChannel` instead of `findChannelById`: a DM is not in the graph, and the composer still
   * has to know what it is addressing. The partner is what a DM is addressed by, so the box says
   * "Message @handle" rather than "Message #channel".
   */
  const channel = useMemo(() => resolveChannel(live, channelId), [channelId, live]);
  const guild = useMemo(() => guildOfChannel(live, channelId), [channelId, live]);
  const partner = useMemo(() => dmPartner(live, channelId), [channelId, live]);
  const placeholder = partner
    ? `Message @${partner.handle}`
    : `Message #${channel?.name ?? "channel"}`;

  const candidates = useMemo(() => {
    if (!mention) return [];
    const query = mention.query.toLowerCase();
    const roster = guild ? guildMembers(live, guild) : live.members;

    return roster
      .filter(
        (member) =>
          query.length === 0 ||
          member.handle.startsWith(query) ||
          nameOf(member).toLowerCase().startsWith(query),
      )
      .slice(0, MAX_SUGGESTIONS);
  }, [guild, live, mention]);

  useEffect(() => setHighlight(0), [mention?.query]);

  // Restore the caret after a completion, once React has written the new value.
  useEffect(() => {
    const element = textareaRef.current;
    const target = caretRef.current;
    if (!element || target === null) return;
    caretRef.current = null;
    element.focus();
    element.setSelectionRange(target, target);
  }, [value]);

  const syncMention = (next: string, caret: number): void => {
    const before = next.slice(0, caret);
    const match = /(?:^|\s)@([a-z0-9-]*)$/i.exec(before);
    if (!match) {
      setMention(null);
      return;
    }
    const query = match[1] ?? "";
    setMention({ query, start: caret - query.length - 1 });
  };

  const accept = (handle: string): void => {
    if (!mention) return;
    const element = textareaRef.current;
    const caret = element?.selectionStart ?? value.length;
    const next = `${value.slice(0, mention.start)}@${handle} ${value.slice(caret)}`;
    caretRef.current = mention.start + handle.length + 2;
    onChange(next);
    setMention(null);
  };

  const patch = useCallback((key: string, next: Partial<DraftAttachment>): void => {
    // Keep the ref in step with the state: `remove` and the upload pump both read it, and an
    // abort handle that only exists in state cannot cancel anything.
    queueRef.current = queueRef.current.map((entry) =>
      entry.key === key ? { ...entry, ...next } : entry,
    );
    setQueue(queueRef.current);
  }, []);

  /**
   * One upload at a time.
   *
   * The backlog is a ref rather than state because it is a work queue, not something the UI
   * renders: the tray renders `queue`, and an item leaves the backlog the moment it starts.
   */
  const pump = useCallback((): void => {
    if (pumping.current) return;
    pumping.current = true;

    void (async () => {
      try {
        for (;;) {
          const item = backlog.current.shift();
          if (!item) break;
          // Removed while it was waiting: do not spend bandwidth on it.
          if (!queueRef.current.some((entry) => entry.key === item.key)) continue;

          const task = uploadAttachment(item.file, (ratio) =>
            patch(item.key, { progress: ratio }),
          );
          patch(item.key, { abort: task.abort });

          try {
            const uploaded = await task.promise;
            patch(item.key, { status: "done", progress: 1, uploaded });
          } catch (cause) {
            patch(item.key, { status: "failed", error: describe(cause) });
          }
        }
      } finally {
        pumping.current = false;
      }
    })();
  }, [patch]);

  const addFiles = useCallback(
    (files: readonly File[]): void => {
      if (files.length === 0) return;
      setError(null);

      const room = MAX_ATTACHMENTS - queueRef.current.length;
      if (room <= 0) {
        setError(`A message can carry at most ${MAX_ATTACHMENTS} files.`);
        return;
      }

      const taken = new Set(
        queueRef.current.map((entry) => `${entry.file.name}:${entry.file.size}`),
      );
      const accepted: DraftAttachment[] = [];
      const problems: string[] = [];

      for (const file of files) {
        if (accepted.length >= room) break;
        const signature = `${file.name}:${file.size}`;
        if (taken.has(signature)) {
          problems.push(`"${file.name}" is already attached.`);
          continue;
        }
        if (file.size === 0) {
          problems.push(`"${file.name}" is empty.`);
          continue;
        }
        if (file.size > MAX_ATTACHMENT_BYTES) {
          problems.push(
            `"${file.name}" is ${formatBytes(file.size)}; the limit is ${formatBytes(MAX_ATTACHMENT_BYTES)}.`,
          );
          continue;
        }

        taken.add(signature);
        accepted.push(newDraft(file));
      }

      if (files.length > room) {
        problems.push(`Only ${MAX_ATTACHMENTS} files fit in one message.`);
      }

      if (accepted.length > 0) {
        queueRef.current = [...queueRef.current, ...accepted];
        setQueue(queueRef.current);
        backlog.current.push(...accepted);
        pump();
      }

      setError(problems[0] ?? null);
    },
    [pump],
  );

  const remove = useCallback((key: string): void => {
    const target = queueRef.current.find((entry) => entry.key === key);
    target?.abort?.();
    queueRef.current = queueRef.current.filter((entry) => entry.key !== key);
    backlog.current = backlog.current.filter((entry) => entry.key !== key);
    setQueue(queueRef.current);
    setError(null);
  }, []);

  // A channel switch is a new message: keeping the queue would attach a file to the wrong place.
  useEffect(() => {
    for (const entry of queueRef.current) entry.abort?.();
    queueRef.current = [];
    backlog.current = [];
    setQueue([]);
    setError(null);
  }, [channelId]);

  const submit = (): void => {
    const uploading = queue.some((entry) => entry.status === "uploading");
    const ready = queue.flatMap((entry) => (entry.uploaded ? [entry.uploaded] : []));
    const failed = queue.some((entry) => entry.status === "failed");

    if (uploading) {
      setError("Wait for the uploads to finish, then send.");
      return;
    }
    if (value.trim().length === 0 && ready.length === 0) return;
    if (failed && ready.length === 0) {
      setError("Remove the failed files, or attach different ones.");
      return;
    }

    setMention(null);
    setError(null);

    void (async () => {
      const sent = await onSend(value.trim(), ready);
      if (!sent) return;
      onChange("");
      queueRef.current = [];
      setQueue([]);
      textareaRef.current?.focus();
    })();
  };

  const onKeyDown = (event: React.KeyboardEvent<HTMLTextAreaElement>): void => {
    if (mention && candidates.length > 0) {
      if (event.key === "ArrowDown") {
        event.preventDefault();
        setHighlight((previous) => (previous + 1) % candidates.length);
        return;
      }
      if (event.key === "ArrowUp") {
        event.preventDefault();
        setHighlight((previous) => (previous - 1 + candidates.length) % candidates.length);
        return;
      }
      if (event.key === "Enter" || event.key === "Tab") {
        event.preventDefault();
        const chosen = candidates[highlight];
        if (chosen) accept(chosen.handle);
        return;
      }
      if (event.key === "Escape") {
        event.preventDefault();
        setMention(null);
        return;
      }
    }

    if (event.key === "Enter" && !event.shiftKey) {
      event.preventDefault();
      submit();
      return;
    }

    if (event.key === "Escape") {
      textareaRef.current?.blur();
    }
  };

  const lines = value.length === 0 ? 1 : value.split("\n").length;
  const rows = Math.min(MAX_ROWS, Math.max(1, lines));

  const hasUploading = queue.some((entry) => entry.status === "uploading");
  const readyCount = queue.filter((entry) => entry.status === "done").length;
  const canSend = !hasUploading && (value.trim().length > 0 || readyCount > 0);
  const limitLabel = formatBytes(MAX_ATTACHMENT_BYTES);

  const typingNames = typing
    .map((memberId) => {
      const member = memberById(live, memberId);
      return member ? nameOf(member) : undefined;
    })
    .filter((name): name is string => Boolean(name));

  return (
    <div
      className={styles.composer}
      data-dragging={dragging}
      onDragOver={(event) => {
        if (!event.dataTransfer.types.includes("Files")) return;
        event.preventDefault();
        setDragging(true);
      }}
      onDragLeave={(event) => {
        if (event.currentTarget.contains(event.relatedTarget as Node | null)) return;
        setDragging(false);
      }}
      onDrop={(event) => {
        if (event.dataTransfer.files.length === 0) return;
        event.preventDefault();
        setDragging(false);
        addFiles(Array.from(event.dataTransfer.files));
      }}
    >
      {dragging ? (
        <div className={styles.drop} aria-hidden="true">
          <PaperclipGlyph />
          <span>Drop files to attach</span>
        </div>
      ) : null}

      <div className={styles.typing} aria-live="polite">
        {typingNames.length > 0
          ? `${typingNames.join(", ")} ${typingNames.length === 1 ? "is" : "are"} typing…`
          : "\u00a0"}
      </div>

      <div className={styles.box}>
        {mention && candidates.length > 0 ? (
          <ul className={styles.menu} role="listbox" aria-label="Mention suggestions">
            {candidates.map((member, index) => (
              <li key={member.id}>
                <button
                  type="button"
                  role="option"
                  aria-selected={index === highlight}
                  className={styles.menuItem}
                  data-active={index === highlight}
                  onMouseEnter={() => setHighlight(index)}
                  onClick={() => accept(member.handle)}
                >
                  <span className={styles.menuName}>{nameOf(member)}</span>
                  <span className={styles.menuHandle}>@{member.handle}</span>
                </button>
              </li>
            ))}
          </ul>
        ) : null}

        {queue.length > 0 ? (
          <ul className={styles.tray} aria-label="Attachments">
            {queue.map((entry) => (
              <li key={entry.key} className={styles.chip} data-status={entry.status}>
                <span className={styles.chipGlyph} aria-hidden="true">
                  <PaperclipGlyph />
                </span>
                <span className={styles.chipText}>
                  <span className={styles.chipName} title={entry.file.name}>
                    {entry.file.name}
                  </span>
                  <span className={styles.chipMeta}>
                    {formatBytes(entry.file.size)}
                    {entry.status === "uploading"
                      ? ` · ${Math.round(entry.progress * 100)}%`
                      : null}
                    {entry.status === "failed" ? ` · ${entry.error ?? "Upload failed"}` : null}
                  </span>
                </span>
                {entry.status === "uploading" ? (
                  <progress
                    className={styles.progress}
                    max={1}
                    value={entry.progress}
                    aria-label={`Uploading ${entry.file.name}`}
                  />
                ) : null}
                <button
                  type="button"
                  className={styles.chipRemove}
                  onClick={() => remove(entry.key)}
                  aria-label={`Remove ${entry.file.name}`}
                >
                  <CloseGlyph />
                </button>
              </li>
            ))}
          </ul>
        ) : null}

        <div className={styles.row}>
          <textarea
          ref={textareaRef}
          className={styles.input}
          value={value}
          rows={rows}
          placeholder={placeholder}
          aria-label={placeholder}
          data-testid="composer-input"
          onChange={(event) => {
            onChange(event.target.value);
            syncMention(event.target.value, event.target.selectionStart);

            if (event.target.value.trim().length > 0) {
              const now = Date.now();
              if (now - typingSentAt.current > 2_500) {
                typingSentAt.current = now;
                signalTyping(channelId);
              }
            }
          }}
          onKeyDown={onKeyDown}
          onClick={(event) => syncMention(value, event.currentTarget.selectionStart)}
          onPaste={(event) => {
            const files = Array.from(event.clipboardData.files);
            if (files.length === 0) return;
            event.preventDefault();
            addFiles(files);
          }}
          onBlur={() => setMention(null)}
          />

          <div className={styles.actions}>
            <button
              type="button"
              className={styles.attach}
              onClick={() => fileInputRef.current?.click()}
              aria-label="Attach files"
              title={`Attach files (up to ${limitLabel} each)`}
              data-testid="composer-attach"
            >
              <PaperclipGlyph />
            </button>
            <button
              type="button"
              className={styles.send}
              disabled={!canSend}
              onClick={submit}
              aria-label="Send message"
              title="Send (Enter)"
              data-testid="composer-send"
            >
              <SendGlyph />
            </button>
          </div>
        </div>
      </div>

      {error ? (
        <p className={styles.error} role="alert">
          {error}
        </p>
      ) : (
        <p className={styles.hint}>
          {MAX_ATTACHMENTS} files max · {limitLabel} each · drag, paste or clip to attach
        </p>
      )}

      <input
        ref={fileInputRef}
        className={styles.fileInput}
        type="file"
        multiple
        tabIndex={-1}
        aria-hidden="true"
        data-testid="composer-file-input"
        onChange={(event) => {
          const files = Array.from(event.target.files ?? []);
          // Reset first: picking the same file twice must still fire a change event.
          event.target.value = "";
          addFiles(files);
        }}
      />
    </div>
  );
}
