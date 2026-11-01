import { useState } from "react";
import { Channel } from "../../../shared/channels";
import { bridge, hasShell } from "../../bridge/client";
import type { Artwork } from "../../api/gallery";
import styles from "./Inspector.module.css";

/**
 * The only surface that requests the `display` variant. Export and reveal both go through the
 * three-channel contract, so this panel is also the manual test of the bridge in a packaged app.
 */

export type InspectorProps = {
  artwork: Artwork | null;
  onClose: () => void;
};

export function Inspector({ artwork, onClose }: InspectorProps): React.JSX.Element {
  const [note, setNote] = useState<string | null>(null);
  const [exportedPath, setExportedPath] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const exportOne = async (): Promise<void> => {
    if (!artwork) return;
    setBusy(true);
    setNote(null);
    try {
      const bytes = new TextEncoder().encode(JSON.stringify(artwork, null, 2));
      const result = await bridge[Channel.saveExport]({
        suggestedName: `${artwork.id}.json`,
        bytes,
      });
      if (result) {
        setExportedPath(result.path);
        setNote(`Saved to ${result.path}`);
      } else {
        setNote("Export cancelled");
      }
    } catch (error) {
      setNote(error instanceof Error ? `Export failed: ${error.message}` : "Export failed");
    } finally {
      setBusy(false);
    }
  };

  const reveal = async (): Promise<void> => {
    if (!exportedPath) return;
    try {
      await bridge[Channel.revealInFolder]({ path: exportedPath });
      setNote("Revealed in Explorer");
    } catch (error) {
      setNote(error instanceof Error ? `Reveal failed: ${error.message}` : "Reveal failed");
    }
  };

  if (!artwork) {
    return (
      <aside className={styles.aside} aria-label="Selected artwork">
        <div className={styles.empty}>
          <p className={styles.emptyTitle}>Nothing selected</p>
          <p className={styles.emptyBody}>
            Pick a work to load its <code>display</code> variant. The grid never requests it.
          </p>
          <p className={styles.emptyMeta}>
            bridge: {hasShell ? "electron (validated IPC)" : "browser fallback"}
          </p>
        </div>
      </aside>
    );
  }

  return (
    <aside className={styles.aside} aria-label="Selected artwork">
      <div className={styles.header}>
        <div>
          <h2 className={styles.title}>{artwork.title}</h2>
          <p className={styles.artist}>{artwork.artist}</p>
        </div>
        <button type="button" className={styles.close} onClick={onClose} aria-label="Close details">
          ✕
        </button>
      </div>

      <div className={styles.preview}>
        <img
          className={styles.display}
          src={artwork.art.display}
          alt={`${artwork.title} by ${artwork.artist}`}
          decoding="async"
          fetchPriority="high"
        />
      </div>

      <dl className={styles.facts}>
        <div>
          <dt>Status</dt>
          <dd className={styles.status} data-status={artwork.status}>
            {artwork.status}
          </dd>
        </div>
        <div>
          <dt>Source ratio</dt>
          <dd>
            {artwork.width} × {artwork.height}
          </dd>
        </div>
        <div>
          <dt>Updated</dt>
          <dd>{new Date(artwork.updatedAt).toLocaleString()}</dd>
        </div>
        <div>
          <dt>Id</dt>
          <dd className={styles.mono}>{artwork.id}</dd>
        </div>
      </dl>

      <div className={styles.actions}>
        <button type="button" className={styles.primary} onClick={() => void exportOne()} disabled={busy}>
          {busy ? "Exporting…" : "Export this work"}
        </button>
        <button
          type="button"
          className={styles.secondary}
          onClick={() => void reveal()}
          disabled={!exportedPath}
        >
          Reveal in folder
        </button>
      </div>

      {note ? (
        <p className={styles.note} role="status">
          {note}
        </p>
      ) : null}
    </aside>
  );
}
