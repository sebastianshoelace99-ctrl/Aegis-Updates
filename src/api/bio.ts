/**
 * Bio parsing, kept pure and separate from React.
 *
 * A bio may contain hyperlinks, but "allow hyperlinks" must not mean "render whatever HTML was
 * pasted". This tokenizer finds absolute http(s) URLs and returns structured tokens; React then
 * renders text as text and links as `<a rel="noreferrer noopener">`. `javascript:` and `data:`
 * can never become a token because the pattern only matches http and https.
 */

export type BioToken =
  | { kind: "text"; value: string }
  | { kind: "break" }
  | { kind: "link"; value: string; href: string };

const URL_PATTERN = /https?:\/\/[^\s<>"']+/gi;
/** Sentence punctuation belongs to the sentence, not the URL. */
const TRAILING_PUNCTUATION = /[.,;:!?)\]}]+$/;

function pushText(tokens: BioToken[], value: string): void {
  if (value.length === 0) return;

  const lines = value.split(/\r?\n/);
  lines.forEach((line, index) => {
    if (index > 0) tokens.push({ kind: "break" });
    if (line.length > 0) tokens.push({ kind: "text", value: line });
  });
}

export function parseBio(text: string): BioToken[] {
  const tokens: BioToken[] = [];
  const source = text.slice(0, 2000);
  let last = 0;

  for (const match of source.matchAll(URL_PATTERN)) {
    const start = match.index ?? 0;
    const raw = match[0];
    const trailing = TRAILING_PUNCTUATION.exec(raw)?.[0] ?? "";
    const url = trailing.length > 0 ? raw.slice(0, -trailing.length) : raw;

    // A bare scheme is not a link; leave it in the surrounding text.
    if (!/^https?:\/\/\S+$/i.test(url)) continue;

    pushText(tokens, source.slice(last, start));
    tokens.push({ kind: "link", value: url, href: url });
    if (trailing.length > 0) pushText(tokens, trailing);

    last = start + raw.length;
  }

  pushText(tokens, source.slice(last));
  return tokens;
}
