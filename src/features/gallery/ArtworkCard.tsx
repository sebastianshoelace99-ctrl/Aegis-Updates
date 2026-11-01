import { memo, useState } from "react";
import type { Artwork } from "../../api/gallery";
import { ratioKey } from "../../ui/ratio";
import styles from "./ArtworkCard.module.css";

/**
 * Memoised by the identity that actually changes (id + updatedAt), per docs/02 section 8
 * rule 5. `onOpen` must be referentially stable at the call site or the memo is pointless.
 */

export type ArtworkCardProps = {
  artwork: Artwork;
  onOpen: (id: string) => void;
};

function ArtworkCardBase({ artwork, onOpen }: ArtworkCardProps): React.JSX.Element {
  const [loaded, setLoaded] = useState(false);

  return (
    <button
      type="button"
      className={styles.card}
      onClick={() => onOpen(artwork.id)}
      aria-label={`${artwork.title} by ${artwork.artist}, status ${artwork.status}`}
    >
      <span className={styles.media} data-ratio={ratioKey(artwork.width, artwork.height)}>
        {/* LQIP first: it is tiny, so it paints while the thumb is still decoding. */}
        <img className={styles.blur} src={artwork.art.blur} alt="" aria-hidden="true" />
        <img
          className={styles.thumb}
          src={artwork.art.thumb}
          alt=""
          loading="lazy"
          decoding="async"
          data-loaded={loaded}
          onLoad={() => setLoaded(true)}
        />
      </span>

      <span className={styles.meta}>
        <span className={styles.title}>{artwork.title}</span>
        <span className={styles.artist}>{artwork.artist}</span>
        <span className={styles.status} data-status={artwork.status}>
          {artwork.status}
        </span>
      </span>
    </button>
  );
}

export const ArtworkCard = memo(
  ArtworkCardBase,
  (prev, next) =>
    prev.artwork.id === next.artwork.id &&
    prev.artwork.updatedAt === next.artwork.updatedAt &&
    prev.onOpen === next.onOpen,
);
