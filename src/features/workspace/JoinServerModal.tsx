import { useEffect, useState } from "react";
import { redeemGuildInvite } from "../../api/backend";
import { replaceWorkspace } from "../../api/liveWorkspace";
import { useUiStore } from "../../state/uiStore";
import { useWorkspaceStore } from "../../state/workspaceStore";
import { CloseGlyph } from "../../ui/Glyphs";
import { useDialog } from "../../ui/useDialog";
import shell from "../settings/SettingsModal.module.css";
import styles from "./JoinServerModal.module.css";

function inviteCodeFrom(value: string): string {
  const trimmed = value.trim();
  if (!trimmed) return "";
  if (trimmed.startsWith("aegis://")) {
    try {
      return new URL(trimmed).searchParams.get("code") ?? "";
    } catch {
      return "";
    }
  }
  return trimmed;
}

export function JoinServerModal(): React.JSX.Element | null {
  const open = useUiStore((state) => state.joinServerOpen);
  const initialCode = useUiStore((state) => state.joinServerCode);
  const close = useUiStore((state) => state.closeJoinServer);
  const [code, setCode] = useState(initialCode);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const { ref, onBackdrop } = useDialog(close, { dismissible: !busy });

  useEffect(() => {
    if (open) setCode(initialCode);
  }, [initialCode, open]);

  if (!open) return null;

  const submit = async (event: React.FormEvent<HTMLFormElement>): Promise<void> => {
    event.preventDefault();
    const inviteCode = inviteCodeFrom(code);
    if (!/^[A-Za-z0-9_-]{43}$/.test(inviteCode)) {
      setError("Paste a valid Aegis invite link or code.");
      return;
    }

    setBusy(true);
    setError(null);
    try {
      const result = await redeemGuildInvite(inviteCode);
      replaceWorkspace(result.workspace);
      const guild = result.workspace.guilds.find((entry) => entry.id === result.guildId);
      const firstChannel = guild?.channels[0];
      close();
      if (firstChannel) useWorkspaceStore.getState().openChannel(firstChannel.id);
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : "Could not join this server.");
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className={shell.overlay} onMouseDown={onBackdrop}>
      <div
        ref={ref}
        className={`${shell.dialog} ${styles.dialog}`}
        role="dialog"
        aria-modal="true"
        aria-labelledby="join-server-title"
        tabIndex={-1}
      >
        <header className={shell.head}>
          <div>
            <h2 id="join-server-title" className={shell.title}>
              Join a server
            </h2>
            <p className={shell.subtitle}>Use an invite link from someone you trust.</p>
          </div>
          <button
            type="button"
            className={shell.close}
            onClick={close}
            aria-label="Close join server"
            disabled={busy}
          >
            <CloseGlyph />
          </button>
        </header>

        <form className={styles.content} onSubmit={(event) => void submit(event)}>
          <label className={shell.field}>
            <span className={shell.fieldLabel}>Invite link or code</span>
            <input
              className={shell.input}
              value={code}
              onChange={(event) => {
                setCode(event.target.value);
                setError(null);
              }}
              placeholder="aegis://invite?code=..."
              autoComplete="off"
              spellCheck={false}
              autoFocus
            />
          </label>
          <p className={shell.hint} data-error={error !== null} role={error ? "alert" : undefined}>
            {error ?? "Invite links expire after 7 days and can be used more than once."}
          </p>
          <footer className={styles.footer}>
            <button type="button" className={shell.ghost} onClick={close} disabled={busy}>
              Cancel
            </button>
            <button type="submit" className={shell.primary} disabled={busy}>
              {busy ? "Joining…" : "Join server"}
            </button>
          </footer>
        </form>
      </div>
    </div>
  );
}
