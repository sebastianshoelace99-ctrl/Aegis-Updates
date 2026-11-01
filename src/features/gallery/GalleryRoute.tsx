import { useCallback, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Channel } from "../../../shared/channels";
import { galleryQuery, type Artwork } from "../../api/gallery";
import { bridge } from "../../bridge/client";
import { VirtualGrid } from "../../ui/VirtualGrid";
import { ArtworkCard } from "./ArtworkCard";
import { Inspector } from "./Inspector";
import styles from "./Gallery.module.css";

/**
 * A media channel: the 240-plate virtualised grid plus its inspector.
 *
 * The native capabilities live here rather than in the shell chrome because this is the only
 * place they mean anything - a native open dialog stages artwork, and "export" exports what is
 * actually on screen. All three frozen IPC methods are still exercised from the UI.
 */

const SKELETON_CELLS = 12;

type Imported = { path: string; name: string };

export function GalleryRoute(): React.JSX.Element {
  const { data, isPending, isError, error, refetch } = useQuery(galleryQuery);
  const client = useQueryClient();
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [imported, setImported] = useState<Imported[]>([]);
  const [note, setNote] = useState<string | null>(null);

  const onOpen = useCallback((id: string) => setSelectedId(id), []);
  const getKey = useCallback((artwork: Artwork) => artwork.id, []);
  const renderItem = useCallback(
    (artwork: Artwork) => <ArtworkCard artwork={artwork} onOpen={onOpen} />,
    [onOpen],
  );

  const items = data ?? [];
  const selected = items.find((artwork) => artwork.id === selectedId) ?? null;

  const addArtwork = useCallback(async () => {
    try {
      const files = await bridge[Channel.openImageDialog]({ multiple: true });
      if (files.length === 0) {
        setNote("No files chosen");
        return;
      }
      setImported((previous) => [...files, ...previous].slice(0, 6));
      setNote(`Staged ${files.length} file${files.length === 1 ? "" : "s"} via the native dialog`);
    } catch (error_) {
      setNote(error_ instanceof Error ? `Dialog failed: ${error_.message}` : "Dialog failed");
    }
  }, []);

  const exportGallery = useCallback(async () => {
    const artworks = client.getQueryData(galleryQuery.queryKey) ?? [];
    const bytes = new TextEncoder().encode(
      JSON.stringify({ exportedAt: new Date().toISOString(), artworks }, null, 2),
    );

    try {
      const result = await bridge[Channel.saveExport]({
        suggestedName: "aegis-gallery.json",
        bytes,
      });
      setNote(result ? `Exported to ${result.path}` : "Export cancelled");
    } catch (error_) {
      setNote(error_ instanceof Error ? `Export failed: ${error_.message}` : "Export failed");
    }
  }, [client]);

  const reveal = useCallback(async (path: string) => {
    try {
      await bridge[Channel.revealInFolder]({ path });
      setNote(`Revealed ${path}`);
    } catch {
      // A browser build has no filesystem to reveal; the fallback already no-ops.
      setNote("Nothing to reveal outside the desktop shell");
    }
  }, []);

  return (
    <div className={styles.layout}>
      <section className={styles.left} aria-label="Gallery">
        <div className={styles.toolbar}>
          <div className={styles.toolbarLeft}>
            <span className={styles.count}>
              {isPending ? "Loading…" : `${items.length} works`}
            </span>
            <span className={styles.hint}>virtualised · thumbnails only</span>
          </div>

          <div className={styles.toolbarActions}>
            <button type="button" className={styles.toolbarButton} onClick={() => void addArtwork()}>
              Add artwork…
            </button>
            <button
              type="button"
              className={styles.toolbarButtonPrimary}
              onClick={() => void exportGallery()}
            >
              Export
            </button>
          </div>
        </div>

        {note || imported.length > 0 ? (
          <div className={styles.notice} role="status">
            <span className={styles.noticeText}>{note}</span>
            <div className={styles.chips}>
              {imported.map((file) => (
                <button
                  key={file.path || file.name}
                  type="button"
                  className={styles.chip}
                  onClick={() => void reveal(file.path)}
                  title={file.path || file.name}
                >
                  <span>{file.name}</span>
                </button>
              ))}
            </div>
          </div>
        ) : null}

        {isPending ? (
          <div className={styles.skeletons} aria-busy="true" aria-label="Loading artwork">
            {Array.from({ length: SKELETON_CELLS }, (_, index) => (
              <div key={index} className={styles.skeletonCell}>
                <div className={styles.skeletonCard} />
              </div>
            ))}
          </div>
        ) : isError ? (
          <div className={styles.errorState} role="alert">
            <p className={styles.errorTitle}>Could not load the gallery</p>
            <p className={styles.errorBody}>
              {error instanceof Error ? error.message : "Unknown error"}
            </p>
            <button type="button" className={styles.retry} onClick={() => void refetch()}>
              Try again
            </button>
          </div>
        ) : (
          <VirtualGrid
            items={items}
            label="Artwork"
            getKey={getKey}
            renderItem={renderItem}
          />
        )}
      </section>

      <Inspector artwork={selected} onClose={() => setSelectedId(null)} />
    </div>
  );
}
