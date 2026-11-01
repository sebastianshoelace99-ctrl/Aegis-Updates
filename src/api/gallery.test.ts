import { describe, expect, it } from "vitest";
import { fetchArtworks } from "./gallery";

describe("gallery mock", () => {
  it("produces the same 240 plates on every call", async () => {
    const [first, second] = await Promise.all([fetchArtworks(), fetchArtworks()]);

    // Guards the shared-PRNG refactor: if the seed or the draw order drifts, the packaged
    // gallery silently changes and every previous screenshot stops matching.
    expect(second).toEqual(first);
    expect(first).toHaveLength(240);
    expect(first[0]?.id).toBe("art_001");
    expect(first[239]?.id).toBe("art_240");
    expect(new Set(first.map((artwork) => artwork.id)).size).toBe(240);
  });
});
