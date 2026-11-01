import { useCallback, useEffect, useRef, type MouseEvent } from "react";

/**
 * One dialog behaviour, shared by settings, server settings and the profile card.
 *
 * Three things are easy to get wrong and are handled here once: the dialog itself takes focus,
 * Tab cycles inside it, and focus returns to whatever opened it. The Escape/backdrop path is
 * optional because a create-in-progress must not be dismissible.
 */

const FOCUSABLE =
  'a[href], button:not([disabled]), textarea:not([disabled]), input:not([disabled]), select:not([disabled]), [tabindex]:not([tabindex="-1"])';

export type DialogOptions = { dismissible?: boolean };

export function useDialog(
  onClose: () => void,
  { dismissible = true }: DialogOptions = {},
): {
  ref: React.RefObject<HTMLDivElement | null>;
  onBackdrop: (event: MouseEvent<HTMLDivElement>) => void;
} {
  const ref = useRef<HTMLDivElement | null>(null);
  const closeRef = useRef(onClose);
  closeRef.current = onClose;

  useEffect(() => {
    const previous = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const dialog = ref.current;
    dialog?.focus();

    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key === "Escape") {
        if (!dismissible) return;
        event.preventDefault();
        closeRef.current();
        return;
      }

      if (event.key !== "Tab" || !ref.current) return;

      const nodes = [...ref.current.querySelectorAll<HTMLElement>(FOCUSABLE)].filter(
        (node) => node.offsetParent !== null,
      );

      if (nodes.length === 0) {
        event.preventDefault();
        ref.current.focus();
        return;
      }

      const first = nodes[0];
      const last = nodes[nodes.length - 1];
      if (!first || !last) return;

      if (event.shiftKey && (document.activeElement === first || document.activeElement === ref.current)) {
        event.preventDefault();
        last.focus();
        return;
      }

      if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    };

    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("keydown", onKeyDown);
      previous?.focus();
    };
  }, [dismissible]);

  const onBackdrop = useCallback(
    (event: MouseEvent<HTMLDivElement>) => {
      if (dismissible && event.target === event.currentTarget) closeRef.current();
    },
    [dismissible],
  );

  return { ref, onBackdrop };
}
