import { parseBio } from "../api/bio";
import styles from "./RichText.module.css";

/**
 * Bio text with links, but no HTML.
 *
 * `parseBio` only emits text, line breaks and absolute http(s) URLs, so a pasted `<script>` is
 * rendered as characters and a `javascript:` URL is never a token. `target="_blank"` goes through
 * the window's `setWindowOpenHandler`, which opens http(s) in the real browser and denies the rest.
 */
export function RichText({ text, className }: { text: string; className?: string }): React.JSX.Element {
  const tokens = parseBio(text);

  return (
    <span className={className}>
      {tokens.map((token, index) => {
        if (token.kind === "break") return <br key={`break-${index}`} />;
        if (token.kind === "link") {
          return (
            <a
              key={`link-${index}`}
              className={styles.link}
              href={token.href}
              target="_blank"
              rel="noreferrer noopener"
            >
              {token.value}
            </a>
          );
        }
        return <span key={`text-${index}`}>{token.value}</span>;
      })}
    </span>
  );
}
