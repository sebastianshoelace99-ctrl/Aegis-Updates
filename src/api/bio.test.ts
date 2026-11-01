import { describe, expect, it } from "vitest";
import { parseBio } from "./bio";

const kinds = (text: string): string[] => parseBio(text).map((token) => token.kind);

describe("bio parsing", () => {
  it("turns an absolute http(s) URL into a link token", () => {
    const tokens = parseBio("Portfolio: https://example.test/plates");

    expect(tokens).toEqual([
      { kind: "text", value: "Portfolio: " },
      { kind: "link", value: "https://example.test/plates", href: "https://example.test/plates" },
    ]);
  });

  it("leaves sentence punctuation outside the link", () => {
    const tokens = parseBio("See https://example.test/a.");

    expect(tokens[1]).toEqual({
      kind: "link",
      value: "https://example.test/a",
      href: "https://example.test/a",
    });
    expect(tokens[2]).toEqual({ kind: "text", value: "." });
  });

  it("keeps line breaks as explicit tokens", () => {
    expect(kinds("one\ntwo\r\nthree")).toEqual([
      "text",
      "break",
      "text",
      "break",
      "text",
    ]);
  });

  it("never links javascript or bare www text", () => {
    expect(parseBio("javascript:alert(1)").every((token) => token.kind === "text")).toBe(true);
    expect(parseBio("www.example.test").every((token) => token.kind === "text")).toBe(true);
  });

  it("renders markup as characters, not as HTML", () => {
    const tokens = parseBio("<script>alert(1)</script>");
    expect(kinds("<script>alert(1)</script>")).toEqual(["text"]);
    expect(tokens[0]).toEqual({ kind: "text", value: "<script>alert(1)</script>" });
  });
});
