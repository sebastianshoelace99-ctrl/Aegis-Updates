import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import styles from "./VirtualGrid.module.css";

/**
 * Windowed grid over a uniform row pitch (docs/02 section 8, rule 1). Only the visible rows
 * plus `overscanRows` are mounted; a raw `.map()` over artwork is a review rejection.
 *
 * Row pitch and minimum column width are read from CSS custom properties, so the layout and
 * the arithmetic cannot drift apart. Offsets are produced by rendering N empty full-width
 * rows rather than a `transform` - that keeps every style in a stylesheet, which is what lets
 * index.html keep `style-src 'self'` with no 'unsafe-inline'.
 */

type Metrics = {
  width: number;
  height: number;
  row: number;
  minColumn: number;
  scrollTop: number;
};

export type VirtualGridProps<T> = {
  items: readonly T[];
  label: string;
  overscanRows?: number;
  getKey: (item: T) => string;
  renderItem: (item: T) => ReactNode;
};

const FALLBACK = { row: 300, minColumn: 264 };
const MAX_COLUMNS = 8;

export function VirtualGrid<T>({
  items,
  label,
  overscanRows = 1,
  getKey,
  renderItem,
}: VirtualGridProps<T>) {
  const viewportRef = useRef<HTMLDivElement | null>(null);
  const frame = useRef(0);
  const [metrics, setMetrics] = useState<Metrics>({
    width: 0,
    height: 0,
    row: FALLBACK.row,
    minColumn: FALLBACK.minColumn,
    scrollTop: 0,
  });

  useEffect(() => {
    const element = viewportRef.current;
    if (!element) return;

    const measure = (): void => {
      const computed = getComputedStyle(element);
      const row = Number.parseFloat(computed.getPropertyValue("--grid-row")) || FALLBACK.row;
      const minColumn =
        Number.parseFloat(computed.getPropertyValue("--grid-min")) || FALLBACK.minColumn;

      setMetrics((prev) =>
        prev.width === element.clientWidth &&
        prev.height === element.clientHeight &&
        prev.row === row &&
        prev.minColumn === minColumn
          ? prev
          : {
              ...prev,
              width: element.clientWidth,
              height: element.clientHeight,
              row,
              minColumn,
            },
      );
    };

    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    return () => observer.disconnect();
  }, []);

  const onScroll = useCallback(() => {
    if (frame.current !== 0) return;
    frame.current = requestAnimationFrame(() => {
      frame.current = 0;
      const element = viewportRef.current;
      if (!element) return;
      const scrollTop = element.scrollTop;
      setMetrics((prev) => (prev.scrollTop === scrollTop ? prev : { ...prev, scrollTop }));
    });
  }, []);

  useEffect(
    () => () => {
      if (frame.current !== 0) cancelAnimationFrame(frame.current);
    },
    [],
  );

  const columns = Math.max(
    1,
    Math.min(MAX_COLUMNS, Math.floor(metrics.width / metrics.minColumn) || 1),
  );
  const rowCount = Math.ceil(items.length / columns);
  const firstRow = Math.max(0, Math.floor(metrics.scrollTop / metrics.row) - overscanRows);
  const lastRow = Math.min(
    rowCount,
    Math.ceil((metrics.scrollTop + metrics.height) / metrics.row) + overscanRows,
  );
  const visible = items.slice(firstRow * columns, lastRow * columns);
  const trailing = Math.max(0, rowCount - lastRow);

  return (
    <div
      ref={viewportRef}
      className={styles.viewport}
      onScroll={onScroll}
      tabIndex={0}
      role="list"
      aria-label={label}
    >
      <div className={styles.grid} data-cols={columns}>
        {Array.from({ length: firstRow }, (_, index) => (
          <div key={`lead-${index}`} className={styles.spacer} aria-hidden="true" />
        ))}

        {visible.map((item) => (
          <div key={getKey(item)} className={styles.cell} role="listitem">
            {renderItem(item)}
          </div>
        ))}

        {Array.from({ length: trailing }, (_, index) => (
          <div key={`trail-${index}`} className={styles.spacer} aria-hidden="true" />
        ))}
      </div>
    </div>
  );
}
