import { useEffect, useState } from "react";
import type { InfiniteData } from "@tanstack/react-query";
import { messagesQueryKey, type Message } from "../api/messages";
import { fetchWorkspace, postPresence } from "../api/backend";
import { liveWorkspace } from "../api/liveWorkspace";
import { findChannelById, guildOfChannel } from "../api/workspace";
import { guildNotificationLevel } from "../api/serverSettings";
import { replaceWorkspace } from "../api/liveWorkspace";
import { effectivePresence } from "../api/profile";
import { queryClient } from "../api/queryClient";
import { startRealtime } from "../api/realtime";
import { bridge } from "../bridge/client";
import { initShellSync, useShellState } from "../shell/useShellState";
import { useSettingsStore } from "../state/settingsStore";
import { getSelfHandle, getSelfId } from "../state/identity";
import { handleVoicePeer, handleVoiceSignal } from "../state/voiceSession";
import { useWorkspaceStore } from "../state/workspaceStore";
import { Workspace } from "./Workspace";
import { useAppearance } from "./useAppearance";
import styles from "./App.module.css";

const TYPING_TTL_MS = 4_000;

function notifyIncomingMessage(message: Message): void {
  const settings = useSettingsStore.getState();
  if (
    !settings.notifications.enabled ||
    settings.status.presence === "dnd" ||
    typeof window === "undefined" ||
    !("Notification" in window) ||
    window.Notification.permission !== "granted" ||
    message.authorId === getSelfId() ||
    document.hasFocus()
  ) {
    return;
  }

  const workspace = liveWorkspace();
  const guild = guildOfChannel(workspace, message.channelId);
  const mentioned = message.mentions.includes(getSelfHandle());
  if (
    (guild && guildNotificationLevel(guild) === "none") ||
    (guild && guildNotificationLevel(guild) === "mentions" && !mentioned) ||
    (settings.notifications.mentionsOnly && !mentioned)
  ) {
    return;
  }

  const author = workspace.members.find((member) => member.id === message.authorId);
  const channel = findChannelById(workspace, message.channelId);
  const title = channel
    ? `${author?.name ?? "New message"} · #${channel.name}`
    : author?.name ?? "New message";
  const body =
    message.body || (message.attachments.length > 0 ? "Sent an attachment" : "Sent a message");

  try {
    const notification = new window.Notification(title, { body });
    notification.onclick = () => {
      useWorkspaceStore.getState().openChannel(message.channelId);
      window.focus();
      notification.close();
    };
  } catch (error) {
    console.warn("[aegis] could not display a desktop notification", error);
  }
}

type Boot =
  | { state: "loading" }
  | { state: "ready" }
  | { state: "error"; message: string };

/**
 * Boot: the shell mirror, the theme, the backend handshake, and the socket wiring.
 *
 * The rail, the feed and the member list are pure views over three stores (query cache,
 * workspace store, shell mirror); this component deliberately owns no layout of its own.
 */
export function App(): React.JSX.Element {
  useEffect(() => initShellSync(), []);

  const focused = useShellState((state) => state.focused);
  const presenceChoice = useSettingsStore((state) => state.status.presence);

  // Theme, accent, density and the rest are document-level facts; the hook owns all of them.
  useAppearance();

  const [boot, setBoot] = useState<Boot>({ state: "loading" });
  const [attempt, setAttempt] = useState(0);

  /**
   * The first request the app makes. A failure is a first-class screen, not a blank rail: a
   * backend that is not running looks exactly like an account with no servers otherwise.
   */
  useEffect(() => {
    let cancelled = false;
    setBoot({ state: "loading" });

    void fetchWorkspace()
      .then((next) => {
        if (cancelled) return;
        replaceWorkspace(next);
        setBoot({ state: "ready" });
      })
      .catch((error: unknown) => {
        if (cancelled) return;

        setBoot({
          state: "error",
          message: error instanceof Error ? error.message : "The backend did not answer.",
        });
      });

    return () => {
      cancelled = true;
    };
  }, [attempt]);

  /** Presence is a server fact too: tell the backend which dot this member should have. */
  useEffect(() => {
    if (boot.state !== "ready") return;
    void postPresence(effectivePresence(presenceChoice)).catch(() => {
      /* the next status change retries */
    });
  }, [boot.state, presenceChoice]);

  /**
   * Socket wiring lives here, not in a component, because it is app-lifetime: it must survive
   * channel switches and be torn down exactly once. StrictMode mounts this twice in dev, which
   * is exactly how a leaked listener gets caught before it reaches the packaged build.
   */
  useEffect(() => {
    if (boot.state !== "ready") return;

    const typingTimers = new Set<number>();

    const stop = startRealtime({
      onMessage: (message) => {
        notifyIncomingMessage(message);
        // Patch, never invalidate: a refetch would discard the paged history behind the reader.
        queryClient.setQueryData<InfiniteData<Message[], string | null>>(
          messagesQueryKey(message.channelId),
          (previous) => {
            if (!previous) return previous;
            const [newest, ...older] = previous.pages;
            if (newest?.some((entry) => entry.id === message.id)) return previous;
            return { ...previous, pages: [[...(newest ?? []), message], ...older] };
          },
        );

        useWorkspaceStore
          .getState()
          .receive(message.channelId, message.createdAt, message.mentions.length);
      },

      /*
       * A reaction arrives as the whole updated row. It is swapped in place rather than invalidated:
       * invalidating would refetch every page and throw away the history the reader has scrolled
       * into, which is far too high a price for one pill.
       */
      onReaction: (message) => {
        queryClient.setQueryData<InfiniteData<Message[], string | null>>(
          messagesQueryKey(message.channelId),
          (previous) => {
            if (!previous) return previous;
            let touched = false;
            const pages = previous.pages.map((page) =>
              page.map((entry) => {
                if (entry.id !== message.id) return entry;
                touched = true;
                return message;
              }),
            );
            return touched ? { ...previous, pages } : previous;
          },
        );
      },

      onTyping: (channelId, memberId) => {
        const store = useWorkspaceStore.getState();
        const current = store.typing[channelId] ?? [];
        if (!current.includes(memberId)) store.setTyping(channelId, [...current, memberId]);

        const timer = window.setTimeout(() => {
          typingTimers.delete(timer);
          const live = useWorkspaceStore.getState();
          const remaining = live.typing[channelId] ?? [];
          if (remaining.includes(memberId)) {
            live.setTyping(
              channelId,
              remaining.filter((id) => id !== memberId),
            );
          }
        }, TYPING_TTL_MS);

        typingTimers.add(timer);
      },

      onPresence: (memberId, presence) => {
        useWorkspaceStore.getState().setPresence(memberId, presence);
      },
      onVoicePeer: (channelId, memberId, joined) =>
        handleVoicePeer(channelId, memberId, joined),
      onVoiceSignal: (channelId, memberId, signal) =>
        handleVoiceSignal(channelId, memberId, signal),
    });

    return () => {
      stop();
      typingTimers.forEach((timer) => window.clearTimeout(timer));
      typingTimers.clear();
    };
  }, [boot.state]);


  if (boot.state === "loading") {
    return (
      <div className={styles.boot} data-testid="boot-screen">
        <UpdateNotice />
        <div className={styles.bootPanel} aria-busy="true">
          <span className={styles.bootMark} aria-hidden="true" />
          <h1 className={styles.bootTitle}>Connecting</h1>
          <p className={styles.bootBody}>Reaching the Aegis backend…</p>
        </div>
      </div>
    );
  }

  if (boot.state === "error") {
    return (
      <div className={styles.boot} data-testid="boot-error">
        <UpdateNotice />
        <div className={styles.bootPanel} role="alert">
          <span className={styles.bootMark} data-error="true" aria-hidden="true" />
          <h1 className={styles.bootTitle}>Backend unavailable</h1>
          <p className={styles.bootBody}>{boot.message}</p>
          <button
            type="button"
            className={styles.bootRetry}
            data-testid="boot-retry"
            onClick={() => setAttempt((value) => value + 1)}
          >
            Try again
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className={styles.shell} data-focused={focused}>
      <UpdateNotice />
      <Workspace />
    </div>
  );
}

function UpdateNotice(): React.JSX.Element | null {
  const updater = useShellState((state) => state.updater);
  const [dismissed, setDismissed] = useState(false);
  const [busy, setBusy] = useState(false);
  const [actionError, setActionError] = useState("");

  useEffect(() => {
    setDismissed(false);
    setActionError("");
  }, [updater.state, updater.version]);

  if (updater.state === "idle" || updater.state === "checking" || dismissed) return null;

  const message =
    updater.state === "available"
      ? `Update ${updater.version ?? ""} found. Downloading in the background…`
      : updater.state === "downloading"
        ? `Downloading update${updater.version ? ` ${updater.version}` : ""}… ${updater.percent ?? 0}%`
        : updater.state === "ready"
          ? `Update ${updater.version ?? ""} is ready. Restart Aegis Shield to install it.`
          : updater.message ?? "Aegis Shield couldn't complete the update. Try again.";

  async function runUpdateAction(
    channel: "system:checkForUpdates" | "system:installUpdate",
  ): Promise<void> {
    setBusy(true);
    setActionError("");
    try {
      await bridge[channel]({});
    } catch (error) {
      setActionError(error instanceof Error ? error.message : "The update action failed.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <aside
      className={styles.updateNotice}
      data-error={updater.state === "error"}
      role={updater.state === "error" ? "alert" : "status"}
    >
      <p className={styles.updateText}>{message}</p>
      {actionError && <p className={styles.updateError}>{actionError}</p>}
      <div className={styles.updateActions}>
        {updater.state === "ready" ? (
          <>
            <button
              type="button"
              className={styles.updateButton}
              disabled={busy}
              onClick={() => void runUpdateAction("system:installUpdate")}
            >
              Restart and install
            </button>
            <button
              type="button"
              className={styles.updateDismiss}
              onClick={() => setDismissed(true)}
            >
              Later
            </button>
          </>
        ) : updater.state === "error" ? (
          <button
            type="button"
            className={styles.updateButton}
            disabled={busy}
            onClick={() => void runUpdateAction("system:checkForUpdates")}
          >
            Check again
          </button>
        ) : null}
      </div>
    </aside>
  );
}
